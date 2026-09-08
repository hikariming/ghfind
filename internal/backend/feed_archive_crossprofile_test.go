package backend

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/hikariming/ghfind/internal/feedmigration"
)

// A single fixture checks the actual Go archive clients against workerd/R2 and
// PostgreSQL/MinIO. Per-sink crash injection remains in the companion tests.
func TestPortableArchiveBothProfiles(t *testing.T) {
	dsn, bridge, secret, executor := os.Getenv("FEED_TEST_DATABASE_URL"), os.Getenv("FEED_TEST_BRIDGE_ENDPOINT"), os.Getenv("FEED_TEST_BRIDGE_SECRET"), os.Getenv("FEED_TEST_EXECUTOR_SECRET")
	if dsn == "" || bridge == "" || secret == "" || executor == "" || os.Getenv("FEED_TEST_S3_ENDPOINT") == "" {
		if os.Getenv("FEED_REQUIRE_CROSSPROFILE_TESTS") == "1" {
			t.Fatal("both real archive profiles must be configured")
		}
		t.Skip("run scripts/test-feed-crossprofile.mjs with disposable PostgreSQL and S3")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	resetFeedIntegrationSchema(t, ctx, dsn)
	if err := feedmigration.Run(ctx, dsn); err != nil {
		t.Fatal(err)
	}
	pg, err := OpenPostgresFeedStore(Config{FeedDatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if err := pg.EnablePortableRuntime(1); err != nil {
		t.Fatal(err)
	}
	config := FeedS3Config{Endpoint: os.Getenv("FEED_TEST_S3_ENDPOINT"), Region: "us-east-1", Bucket: fmt.Sprintf("feed-shared-contract-%d", time.Now().UnixNano()), AccessKeyID: os.Getenv("FEED_TEST_S3_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("FEED_TEST_S3_SECRET_ACCESS_KEY"), UsePathStyle: true}
	objects, err := NewFeedS3Objects(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	client := objects.client.(*s3.Client)
	if _, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(config.Bucket)}); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		page, err := client.ListObjectsV2(cleanup, &s3.ListObjectsV2Input{Bucket: aws.String(config.Bucket), MaxKeys: aws.Int32(100)})
		if err != nil {
			t.Error(err)
			return
		}
		if aws.ToBool(page.IsTruncated) {
			t.Error("test teardown exceeded its bound")
			return
		}
		for _, object := range page.Contents {
			if _, err := client.DeleteObject(cleanup, &s3.DeleteObjectInput{Bucket: aws.String(config.Bucket), Key: object.Key}); err != nil {
				t.Error(err)
			}
		}
		if _, err := client.DeleteBucket(cleanup, &s3.DeleteBucketInput{Bucket: aws.String(config.Bucket)}); err != nil {
			t.Error(err)
		}
	}()
	if err := pg.UseArchiveObjects(objects); err != nil {
		t.Fatal(err)
	}
	cf, err := NewCFFeedStore(bridge, secret, nil)
	if err != nil {
		t.Fatal(err)
	}
	cfArchive, err := NewCFFeedArchiveStore(bridge, executor, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	cfCleanup, err := NewHTTPFeedCleanupStore(bridge, executor)
	if err != nil {
		t.Fatal(err)
	}
	for _, profile := range []struct {
		name    string
		store   FeedServingStore
		archive ArchiveStore
		cleanup FeedCleanupStore
	}{
		{"postgres", pg, pg, pg}, {"cf_d1_r2", cf, cfArchive, cfCleanup},
	} {
		t.Run(profile.name, func(t *testing.T) {
			if err := profile.archive.ArchiveReady(ctx); err != nil {
				t.Fatal(err)
			}
			user, err := profile.store.EnsureFeedUser(ctx, OAuthSession{GitHubID: 987654, Login: "archive-contract"})
			if err != nil {
				t.Fatal(err)
			}
			id := FeedArchiveIdentity{user.GitHubID, user.ProfileVersion, "shared-events"}
			body := []byte(`{"version":1,"events":[{"type":"outbound"}]}`)
			key, err := profile.archive.PutFeedArchive(ctx, id, body)
			if err != nil {
				t.Fatal(err)
			}
			if again, err := profile.archive.PutFeedArchive(ctx, id, body); err != nil || again != key {
				t.Fatalf("immutable retry: %s %v", again, err)
			}
			if _, err := profile.archive.PutFeedArchive(ctx, id, []byte(`{"changed":true}`)); !errors.Is(err, ErrFeedArchiveConflict) {
				t.Fatalf("changed payload: %v", err)
			}
			if got, err := profile.archive.GetFeedArchive(ctx, id); err != nil || !bytes.Equal(got, body) {
				t.Fatalf("read: %v", err)
			}
			if _, err := profile.archive.PutFeedArchive(ctx, FeedArchiveIdentity{user.GitHubID, user.ProfileVersion, "invalid"}, []byte(`not-json`)); err == nil {
				t.Fatal("invalid JSON accepted")
			}
			large := []byte(`"` + strings.Repeat("a", (4<<20)-2) + `"`)
			largeID := FeedArchiveIdentity{user.GitHubID, user.ProfileVersion, "maximum"}
			if _, err := profile.archive.PutFeedArchive(ctx, largeID, large); err != nil {
				t.Fatal("4MiB archive", err)
			}
			if got, err := profile.archive.GetFeedArchive(ctx, largeID); err != nil || !bytes.Equal(got, large) {
				t.Fatalf("4MiB read: %v", err)
			}
			if _, err := profile.archive.PutFeedArchive(ctx, largeID, append(large, ' ')); err == nil {
				t.Fatal("oversized archive accepted")
			}
			deletionID, err := profile.store.DeleteFeedProfile(withFeedProfileVersion(ctx, user.ProfileVersion), user.GitHubID, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := profile.archive.GetFeedArchive(ctx, id); !errors.Is(err, ErrFeedArchiveErased) {
				t.Fatalf("delete fence: %v", err)
			}
			fresh, err := profile.store.EnsureFeedUser(ctx, OAuthSession{GitHubID: user.GitHubID, Login: user.Login})
			if err != nil {
				t.Fatal(err)
			}
			if fresh.ProfileVersion <= user.ProfileVersion {
				t.Fatal("generation failed to advance")
			}
			newID := FeedArchiveIdentity{fresh.GitHubID, fresh.ProfileVersion, id.ArchiveID}
			if _, err := profile.archive.PutFeedArchive(ctx, newID, body); err != nil {
				t.Fatal(err)
			}
			cleanup, err := NewFeedCleanupExecutor(profile.cleanup, 1, strings.Repeat("c", 32))
			if err != nil {
				t.Fatal(err)
			}
			complete := false
			for i := 0; i < 5; i++ {
				out, err := cleanup.Execute(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if out.Status == "completed" && out.DeletionID == deletionID {
					complete = true
					break
				}
				if out.Status != "queued" && out.Status != "completed" {
					t.Fatalf("unexpected cleanup: %+v", out)
				}
			}
			if !complete {
				t.Fatal("bounded cleanup did not finish")
			}
			if _, err := profile.archive.PutFeedArchive(ctx, id, body); !errors.Is(err, ErrFeedProfileChanged) {
				t.Fatalf("old generation resurrection: %v", err)
			}
			if _, err := profile.archive.GetFeedArchive(ctx, id); !errors.Is(err, ErrFeedArchiveErased) {
				t.Fatalf("old generation visible: %v", err)
			}
			if got, err := profile.archive.GetFeedArchive(ctx, newID); err != nil || !bytes.Equal(got, body) {
				t.Fatalf("new generation: %v", err)
			}
		})
	}
}
