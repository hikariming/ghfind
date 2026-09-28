package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/hikariming/ghfind/internal/backend"
	"github.com/hikariming/ghfind/internal/feed/auth"
)

func deletion(ctx context.Context, db *sql.DB, store *backend.PostgresFeedStore, origin string, signer *auth.Verifier, rep *report) error {
	rep.Deletion = map[string]any{"s3FailureObserved": false, "s3FailureRequests": int64(0), "cleanupAdapterReopened": false}
	var before int64
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.events WHERE github_id=$1`, highUser).Scan(&before); err != nil {
		return err
	}
	if before != 250000 {
		return errors.New("delete requires intact 250000-event synthetic high-volume user")
	}
	rep.Deletion["eventsBefore"] = before
	endpoint := os.Getenv("FEED_CAPACITY_S3_ENDPOINT")
	if endpoint != "http://127.0.0.1:59002" {
		return errors.New("deletion recovery requires dedicated loopback capacity MinIO on port59002")
	}
	keyID, secret := os.Getenv("FEED_CAPACITY_S3_ACCESS_KEY_ID"), os.Getenv("FEED_CAPACITY_S3_SECRET_ACCESS_KEY")
	if keyID == "" || secret == "" {
		return errors.New("explicit synthetic MinIO credentials required")
	}
	bucket := fmt.Sprintf("feed-capacity-%d", time.Now().UnixNano())
	config, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion("us-east-1"), awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(keyID, secret, "")))
	if err != nil {
		return err
	}
	client := s3.NewFromConfig(config, func(o *s3.Options) { o.BaseEndpoint = aws.String(endpoint); o.UsePathStyle = true })
	if _, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)}); err != nil {
		return err
	}
	var archiveKey string
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if archiveKey != "" {
			client.DeleteObject(cleanup, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: aws.String(archiveKey)})
		}
		client.DeleteBucket(cleanup, &s3.DeleteBucketInput{Bucket: aws.String(bucket)})
	}()
	objects, err := backend.NewFeedS3Objects(ctx, backend.FeedS3Config{Endpoint: endpoint, Region: "us-east-1", Bucket: bucket, AccessKeyID: keyID, SecretAccessKey: secret, UsePathStyle: true})
	if err != nil {
		return err
	}
	if err := store.UseArchiveObjects(objects); err != nil {
		return err
	}
	user, err := store.GetFeedUser(ctx, highUser)
	if err != nil || user == nil {
		return errors.New("high-volume user unavailable")
	}
	identity := backend.FeedArchiveIdentity{GitHubID: highUser, ProfileVersion: user.ProfileVersion, ArchiveID: "capacity-event-summary"}
	archiveKey, err = store.PutFeedArchive(ctx, identity, []byte(`{"fixture":"synthetic-capacity-v1","eventCount":250000}`))
	if err != nil {
		return err
	}
	// Observe the actual cascade query before cancelling the client. A mere
	// pre-handler timeout would not demonstrate transactional rollback.
	interrupted, cancel := context.WithCancel(ctx)
	result := make(chan observation, 1)
	go func() {
		obs, _ := call(interrupted, &http.Client{Timeout: 2 * time.Minute}, origin, "DELETE", "/api/feed/profile", highUser, signer)
		result <- obs
	}()
	sawCascade := false
	for i := 0; i < 600; i++ {
		var active bool
		if err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND query LIKE 'DELETE FROM feed.users WHERE github_id = $1%')`).Scan(&active); err != nil {
			cancel()
			return err
		}
		if active {
			sawCascade = true
			break
		}
		select {
		case early := <-result:
			cancel()
			rep.Deletion["unexpectedEarlyCompletion"] = early
			return errors.New("delete completed before cancellation injection was observed")
		default:
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case obs := <-result:
		rep.Deletion["cancelledAttempt"] = obs
	case <-time.After(5 * time.Second):
		return errors.New("cancelled request did not finish within5seconds")
	}
	rep.Deletion["cancellationObservedActiveCascade"] = sawCascade
	if !sawCascade {
		return errors.New("did not observe cascade execution before cancellation")
	}
	// A read lock waits for cancellation rollback to complete rather than mistaking
	// an old MVCC snapshot for durable recovery.
	var currentVersion int64
	if err := db.QueryRowContext(ctx, `SELECT profile_version FROM feed.users WHERE github_id=$1 FOR SHARE`, highUser).Scan(&currentVersion); err != nil {
		return err
	}
	var remaining, tombstones int64
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.events WHERE github_id=$1`, highUser).Scan(&remaining); err != nil {
		return err
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.user_deletion_tombstones WHERE github_id=$1`, highUser).Scan(&tombstones); err != nil {
		return err
	}
	rep.Deletion["rollbackPreservedEvents"] = remaining == before && tombstones == 0 && currentVersion == user.ProfileVersion
	if remaining != before || tombstones != 0 || currentVersion != user.ProfileVersion {
		return errors.New("cancelled delete did not preserve original generation")
	}
	actual, body := call(ctx, &http.Client{Timeout: 2 * time.Minute}, origin, "DELETE", "/api/feed/profile", highUser, signer)
	rep.Deletion["acceptedAttempt"] = actual
	var accepted struct {
		DeletionID string `json:"deletionId"`
		Status     string `json:"status"`
	}
	if err := json.Unmarshal(body, &accepted); err != nil {
		return err
	}
	rep.Deletion["acceptedResponse"] = accepted
	if actual.Status != 202 || accepted.Status != "queued" {
		return errors.New("high-volume delete did not return202 queued")
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.events WHERE github_id=$1`, highUser).Scan(&remaining); err != nil {
		return err
	}
	rep.Deletion["eventsAfter"] = remaining
	if remaining != 0 {
		return errors.New("deleted events survived")
	}
	if _, err := store.GetFeedArchive(ctx, identity); !errors.Is(err, backend.ErrFeedArchiveErased) {
		return errors.New("old generation archive remained readable")
	}
	lease, err := store.ClaimFeedCleanup(ctx, backend.FeedCleanupClaim{WriterEpoch: 1, LeaseOwner: "capacity-recovery", LeaseSeconds: 90})
	if err != nil || lease.DeletionID != accepted.DeletionID {
		return errors.New("cleanup lease unavailable")
	}
	command := backend.FeedCleanupCommand{WriterEpoch: 1, DeletionID: accepted.DeletionID, LeaseOwner: "capacity-recovery"}
	if progress, err := store.StepFeedCleanup(ctx, command); err != nil || progress.Phase != "archive" {
		return errors.New("primary checkpoint unavailable")
	}
	outage := newCapacityS3Outage(bucket, archiveKey)
	defer outage.server.Close()
	offline, err := backend.NewFeedS3Objects(ctx, backend.FeedS3Config{Endpoint: outage.server.URL, Region: "us-east-1", Bucket: bucket, AccessKeyID: keyID, SecretAccessKey: secret, UsePathStyle: true})
	if err != nil {
		return err
	}
	if err := store.UseArchiveObjects(offline); err != nil {
		return err
	}
	outageCtx, stopOutage := context.WithTimeout(ctx, 10*time.Second)
	_, outageErr := store.StepFeedCleanup(outageCtx, command)
	stopOutage()
	if err := outage.recordFailure(rep, outageErr); err != nil {
		return err
	}
	command.ErrorCode = capacityS3FailureCode
	if err := store.FailFeedCleanup(ctx, command); err != nil {
		return err
	}
	var persisted struct {
		Status    string `json:"status"`
		Phase     string `json:"phase"`
		Failures  int    `json:"failures"`
		ErrorCode string `json:"errorCode"`
	}
	if err := db.QueryRowContext(ctx, `SELECT cleanup_status,cleanup_phase,cleanup_failures,last_error FROM feed.user_deletion_tombstones WHERE deletion_id=$1`, accepted.DeletionID).Scan(&persisted.Status, &persisted.Phase, &persisted.Failures, &persisted.ErrorCode); err != nil {
		return err
	}
	rep.Deletion["cleanupPersistedFailure"] = persisted
	if persisted.Status != "queued" || persisted.Phase != "archive" || persisted.Failures < 1 || persisted.ErrorCode != capacityS3FailureCode {
		return errors.New("injected S3 failure was not durably queued at the archive checkpoint")
	}
	// Reopen the database adapter to prove recovery reads durable checkpoints.
	resumed, err := backend.OpenPostgresFeedStore(backend.Config{FeedDatabaseURL: os.Getenv("FEED_CAPACITY_DATABASE_URL")})
	if err != nil {
		return err
	}
	defer resumed.Close()
	if err := resumed.EnablePortableRuntime(1); err != nil {
		return err
	}
	if err := resumed.UseArchiveObjects(objects); err != nil {
		return err
	}
	reopenCtx, stopReopen := context.WithTimeout(ctx, 5*time.Second)
	reopenErr := resumed.Ping(reopenCtx)
	stopReopen()
	if reopenErr != nil {
		return reopenErr
	}
	rep.Deletion["cleanupAdapterReopened"] = true
	time.Sleep(2100 * time.Millisecond)
	executor, err := backend.NewFeedCleanupExecutor(resumed, 1, "capacity-cleanup-test-secret-0123456789abcdef")
	if err != nil {
		return err
	}
	recovered, err := executor.Execute(ctx)
	rep.Deletion["cleanupRecovery"] = recovered
	if err != nil {
		return err
	}
	if recovered.Status != "completed" || recovered.Steps > 8 || recovered.Processed > 800 {
		return errors.New("cleanup did not complete within fixed step bound")
	}
	var phase string
	var failures int
	if err := db.QueryRowContext(ctx, `SELECT cleanup_phase,cleanup_failures FROM feed.user_deletion_tombstones WHERE deletion_id=$1`, accepted.DeletionID).Scan(&phase, &failures); err != nil {
		return err
	}
	rep.Deletion["cleanupPhase"] = phase
	rep.Deletion["cleanupFailures"] = failures
	recreated, err := resumed.EnsureFeedUser(ctx, backend.OAuthSession{GitHubID: highUser, Login: "capacity-user-0"})
	if err != nil {
		return err
	}
	rep.Deletion["recreatedProfileVersion"] = recreated.ProfileVersion
	if recreated.ProfileVersion <= user.ProfileVersion {
		return errors.New("deletion generation reused")
	}
	if _, err := resumed.GetFeedArchive(ctx, identity); !errors.Is(err, backend.ErrFeedArchiveErased) {
		return errors.New("old archive resurrected after recreation")
	}
	return nil
}
