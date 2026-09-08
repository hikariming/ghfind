package backend

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/hikariming/ghfind/internal/feedmigration"
)

// This contract uses a real disposable PostgreSQL database and real S3-compatible
// server. CI sets FEED_REQUIRE_S3_TESTS=1 so absent services fail, never skip-green.
func TestPortablePostgresS3Cleanup(t *testing.T) {
	dsn, endpoint := os.Getenv("FEED_TEST_DATABASE_URL"), os.Getenv("FEED_TEST_S3_ENDPOINT")
	if dsn == "" || endpoint == "" {
		if os.Getenv("FEED_REQUIRE_S3_TESTS") == "1" {
			t.Fatal("FEED_TEST_DATABASE_URL and FEED_TEST_S3_ENDPOINT required")
		}
		t.Skip("requires explicitly configured disposable PostgreSQL and S3")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	resetFeedIntegrationSchema(t, ctx, dsn)
	if err := feedmigration.Run(ctx, dsn); err != nil {
		t.Fatal(err)
	}
	if err := feedmigration.Run(ctx, dsn); err != nil {
		t.Fatal("migration replay", err)
	}
	store, err := OpenPostgresFeedStore(Config{FeedDatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.EnablePortableRuntime(1); err != nil {
		t.Fatal(err)
	}
	config := FeedS3Config{Endpoint: endpoint, Region: "us-east-1", Bucket: fmt.Sprintf("feed-contract-%d", time.Now().UnixNano()), AccessKeyID: os.Getenv("FEED_TEST_S3_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("FEED_TEST_S3_SECRET_ACCESS_KEY"), UsePathStyle: true}
	objects, err := NewFeedS3Objects(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	client := objects.client.(*s3.Client)
	if _, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(config.Bucket)}); err != nil {
		t.Fatal(err)
	}
	keys := []string{}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		for _, key := range keys {
			if _, err := client.DeleteObject(cleanup, &s3.DeleteObjectInput{Bucket: aws.String(config.Bucket), Key: aws.String(key)}); err != nil {
				t.Error("test object teardown", err)
			}
		}
		if _, err := client.DeleteBucket(cleanup, &s3.DeleteBucketInput{Bucket: aws.String(config.Bucket)}); err != nil {
			t.Error("test bucket teardown", err)
		}
	}()
	if err := store.UseArchiveObjects(objects); err != nil {
		t.Fatal(err)
	}
	if err := store.ArchiveReady(ctx); err != nil {
		t.Fatal(err)
	}
	user, err := store.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "octocat"})
	if err != nil {
		t.Fatal(err)
	}
	oldID := FeedArchiveIdentity{42, user.ProfileVersion, "events-old"}
	body := []byte(`{"contractVersion":1,"events":[{"type":"outbound"}]}`)
	key, err := store.PutFeedArchive(ctx, oldID, body)
	if err != nil {
		t.Fatal(err)
	}
	keys = append(keys, key)
	if again, err := store.PutFeedArchive(ctx, oldID, body); err != nil || again != key {
		t.Fatalf("immutable retry %s %v", again, err)
	}
	if _, err := store.PutFeedArchive(ctx, oldID, []byte(`{"changed":true}`)); !errors.Is(err, ErrFeedArchiveConflict) {
		t.Fatal("changed retry", err)
	}
	if got, err := store.GetFeedArchive(ctx, oldID); err != nil || string(got) != string(body) {
		t.Fatalf("read %s %v", got, err)
	}
	// Register an upload that pauses before network I/O. Cleanup must create a
	// blocker even though the object has never appeared in S3 listings.
	pendingID := FeedArchiveIdentity{42, user.ProfileVersion, "interrupted-upload"}
	pendingKey, _ := pendingID.Key()
	keys = append(keys, pendingKey)
	hash := fmt.Sprintf("%x", sha256.Sum256(body))
	mustSQL := func(query string, args ...any) {
		t.Helper()
		if _, err := store.db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	mustSQL(`INSERT INTO feed.archive_objects(object_key,github_id,profile_version,payload_hash,status) VALUES($1,42,$2,$3,'pending')`, pendingKey, user.ProfileVersion, hash)
	deletion, err := store.DeleteFeedProfile(withFeedProfileVersion(ctx, user.ProfileVersion), 42, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetFeedArchive(ctx, oldID); !errors.Is(err, ErrFeedArchiveErased) {
		t.Fatal("deletion visibility fence", err)
	}
	recreated, err := store.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "octocat"})
	if err != nil {
		t.Fatal(err)
	}
	if recreated.ProfileVersion <= user.ProfileVersion {
		t.Fatal("generation did not advance")
	}
	currentID := FeedArchiveIdentity{42, recreated.ProfileVersion, "events-new"}
	currentKey, err := store.PutFeedArchive(ctx, currentID, body)
	if err != nil {
		t.Fatal(err)
	}
	keys = append(keys, currentKey)
	lease, err := store.ClaimFeedCleanup(ctx, FeedCleanupClaim{1, "cleanup-test", 90})
	if err != nil || lease.Status != "leased" || lease.DeletionID != deletion {
		t.Fatalf("claim %+v %v", lease, err)
	}
	command := FeedCleanupCommand{WriterEpoch: 1, DeletionID: deletion, LeaseOwner: "cleanup-test"}
	if _, err := store.StepFeedCleanup(ctx, FeedCleanupCommand{WriterEpoch: 1, DeletionID: deletion, LeaseOwner: "imposter"}); !errors.Is(err, ErrFeedJobLease) {
		t.Fatal("unowned lease accepted", err)
	}
	if progress, err := store.StepFeedCleanup(ctx, command); err != nil || progress.Phase != "archive" {
		t.Fatalf("primary %+v %v", progress, err)
	}
	// A real connection failure leaves persisted state resumable.
	badConfig := config
	badConfig.Endpoint = "http://127.0.0.1:1"
	unavailable, err := NewFeedS3Objects(ctx, badConfig)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UseArchiveObjects(unavailable); err != nil {
		t.Fatal(err)
	}
	if _, err := store.StepFeedCleanup(ctx, command); err == nil {
		t.Fatal("S3 outage incorrectly completed")
	}
	command.ErrorCode = "archive_unavailable"
	if err := store.FailFeedCleanup(ctx, command); err != nil {
		t.Fatal(err)
	}
	if err := store.UseArchiveObjects(objects); err != nil {
		t.Fatal(err)
	}
	var failures int
	var phase, status string
	if err := store.db.QueryRowContext(ctx, `SELECT cleanup_failures,cleanup_phase,cleanup_status FROM feed.user_deletion_tombstones WHERE deletion_id=$1`, deletion).Scan(&failures, &phase, &status); err != nil || failures != 1 || phase != "archive" || status != "queued" {
		t.Fatalf("durable failure %d %s %s %v", failures, phase, status, err)
	}
	mustSQL(`UPDATE feed.user_deletion_tombstones SET cleanup_available_at=now() WHERE deletion_id=$1`, deletion)
	lease, err = store.ClaimFeedCleanup(ctx, FeedCleanupClaim{1, "cleanup-resumed", 90})
	if err != nil || lease.Failures != 1 || lease.Attempts != 2 {
		t.Fatalf("resume %+v %v", lease, err)
	}
	command.LeaseOwner = "cleanup-resumed"
	if err := store.ReleaseFeedCleanup(ctx, command); err != nil {
		t.Fatal(err)
	}
	executor, err := NewFeedCleanupExecutor(store, 1, strings.Repeat("e", 32))
	if err != nil {
		t.Fatal(err)
	}
	result, err := executor.Execute(ctx)
	if err != nil || result.Status != "completed" {
		t.Fatalf("resumed completion %+v %v", result, err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT cleanup_failures FROM feed.user_deletion_tombstones WHERE deletion_id=$1`, deletion).Scan(&failures); err != nil || failures != 1 {
		t.Fatalf("normal yield consumed retry budget %d %v", failures, err)
	}
	for _, erasedKey := range []string{key, pendingKey} {
		head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(config.Bucket), Key: aws.String(erasedKey)})
		if err != nil || aws.ToInt64(head.ContentLength) != 0 || head.Metadata["feed-state"] != "erased" {
			t.Fatalf("not physically erased %+v %v", head, err)
		}
		if err := objects.PutImmutable(ctx, erasedKey, body, hash); !errors.Is(err, ErrFeedArchiveErased) {
			t.Fatal("late upload resurrected data", err)
		}
	}
	if got, err := store.GetFeedArchive(ctx, currentID); err != nil || string(got) != string(body) {
		t.Fatalf("new generation erased %s %v", got, err)
	}
	if result, err := executor.Execute(ctx); err != nil || result.Status != "idle" {
		t.Fatalf("completion retry %+v %v", result, err)
	}
	// A larger archive yields at the fixed execution budget and resumes without
	// consuming retries. No step can process more than ten S3 objects.
	bulkUser, err := store.EnsureFeedUser(ctx, OAuthSession{GitHubID: 43, Login: "bulk"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 75; i++ {
		id := FeedArchiveIdentity{43, bulkUser.ProfileVersion, fmt.Sprintf("bounded-%03d", i)}
		k, _ := id.Key()
		keys = append(keys, k)
		mustSQL(`INSERT INTO feed.archive_objects(object_key,github_id,profile_version,payload_hash,status) VALUES($1,43,$2,$3,'pending')`, k, bulkUser.ProfileVersion, hash)
	}
	bulkDeletion, err := store.DeleteFeedProfile(withFeedProfileVersion(ctx, bulkUser.ProfileVersion), 43, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	first, err := executor.Execute(ctx)
	if err != nil || first.Status != "queued" || first.Steps != 8 || first.Processed > 70 {
		t.Fatalf("bounded yield %+v %v", first, err)
	}
	second, err := executor.Execute(ctx)
	if err != nil || second.Status != "completed" || first.Processed+second.Processed != 75 {
		t.Fatalf("bounded resume %+v %v", second, err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT cleanup_failures FROM feed.user_deletion_tombstones WHERE deletion_id=$1`, bulkDeletion).Scan(&failures); err != nil || failures != 0 {
		t.Fatalf("yield failures %d %v", failures, err)
	}
	// Exhaustion is durable and excludes automatic claims until explicit replay.
	exhaustedUser, err := store.EnsureFeedUser(ctx, OAuthSession{GitHubID: 44, Login: "exhausted"})
	if err != nil {
		t.Fatal(err)
	}
	exhaustedDeletion, err := store.DeleteFeedProfile(withFeedProfileVersion(ctx, exhaustedUser.ProfileVersion), 44, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		mustSQL(`UPDATE feed.user_deletion_tombstones SET cleanup_available_at=now() WHERE deletion_id=$1`, exhaustedDeletion)
		owner := fmt.Sprintf("failed-%d", i)
		l, err := store.ClaimFeedCleanup(ctx, FeedCleanupClaim{1, owner, 90})
		if err != nil || l.Status != "leased" {
			t.Fatalf("failure claim %+v %v", l, err)
		}
		if err := store.FailFeedCleanup(ctx, FeedCleanupCommand{WriterEpoch: 1, DeletionID: exhaustedDeletion, LeaseOwner: owner, ErrorCode: "test_injected_failure"}); err != nil {
			t.Fatal(err)
		}
	}
	if l, err := store.ClaimFeedCleanup(ctx, FeedCleanupClaim{1, "exhausted", 90}); err != nil || l.Status != "idle" {
		t.Fatalf("exhausted claimed %+v %v", l, err)
	}
	if err := store.ReplayFeedCleanup(ctx, exhaustedDeletion); err != nil {
		t.Fatal("operator replay", err)
	}
	if result, err := executor.Execute(ctx); err != nil || result.Status != "completed" {
		t.Fatalf("replay result %+v %v", result, err)
	}
	if err := store.ReplayFeedCleanup(ctx, exhaustedDeletion); !errors.Is(err, ErrFeedJobLease) {
		t.Fatal("completed job replay", err)
	}
	// Versioned buckets retain historic bytes after marker overwrite, so they are
	// rejected using the real service's versioning API.
	versionBucket := config.Bucket + "-versioned"
	if _, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(versionBucket)}); err != nil {
		t.Fatal(err)
	}
	defer client.DeleteBucket(context.Background(), &s3.DeleteBucketInput{Bucket: aws.String(versionBucket)})
	if _, err := client.PutBucketVersioning(ctx, &s3.PutBucketVersioningInput{Bucket: aws.String(versionBucket), VersioningConfiguration: &types.VersioningConfiguration{Status: types.BucketVersioningStatusEnabled}}); err != nil {
		t.Fatal(err)
	}
	versionedConfig := config
	versionedConfig.Bucket = versionBucket
	versioned, err := NewFeedS3Objects(ctx, versionedConfig)
	if err != nil {
		t.Fatal(err)
	}
	if err := versioned.Ping(ctx); err == nil {
		t.Fatal("versioned bucket readiness accepted")
	}
	// Even a previously enabled then suspended bucket can contain old versions.
	if _, err := client.PutBucketVersioning(ctx, &s3.PutBucketVersioningInput{Bucket: aws.String(versionBucket), VersioningConfiguration: &types.VersioningConfiguration{Status: types.BucketVersioningStatusSuspended}}); err != nil {
		t.Fatal(err)
	}
	if err := versioned.Ping(ctx); err == nil {
		t.Fatal("suspended versioned bucket accepted")
	}
}
