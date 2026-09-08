package backend

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/hikariming/ghfind/internal/feedmigration"
)

func TestPortablePostgresContracts(t *testing.T) {
	dsn := os.Getenv("FEED_TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv("FEED_REQUIRE_POSTGRES_TESTS") == "1" {
			t.Fatal("FEED_TEST_DATABASE_URL required")
		}
		t.Skip("portable PostgreSQL contract requires explicit disposable database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
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
	if err := store.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	user, err := store.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "octocat"})
	if err != nil {
		t.Fatal(err)
	}
	projection, err := BuildFeedProjectProjection(validFeedAssessment(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertFeedProject(ctx, projection); err != nil {
		t.Fatal(err)
	}
	candidates, _, err := store.LoadFeedCandidates(ctx, *user, 240)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatal("unprovenanced candidate eligible")
	}
	available, err := store.AvailableFeedRepoKeys(ctx, 42, []string{projection.RepoKey})
	if err != nil || available[projection.RepoKey] {
		t.Fatalf("unprovenanced availability %+v %v", available, err)
	}
	if _, err := store.db.ExecContext(ctx, `INSERT INTO feed.project_submission_evidence(repo_key,source_kind,source_id,submitted_at) VALUES($1,'verified_backfill','controlled-test-receipt',now())`, projection.RepoKey); err != nil {
		t.Fatal(err)
	}
	candidates, _, err = store.LoadFeedCandidates(ctx, *user, 240)
	if err != nil || len(candidates) != 1 || !candidates[0].Project.SubmissionEvidence {
		t.Fatalf("eligible candidates %+v %v", candidates, err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	ranked := RankFeedCandidates(candidates, FeedRankOptions{Now: now, Limit: 20, Seed: "portable", OwnerCap: 2, ExplorationRate: .1})
	snapshot := FeedSession{ID: "session-portable", GitHubID: 42, TaxonomyVersion: user.TaxonomyVersion, ProfileVersion: user.ProfileVersion, AlgorithmVersion: FeedAlgorithmVersion, PageSize: 20, Items: ranked, CreatedAt: now, ExpiresAt: now.Add(FeedSessionTTL)}
	if err := store.PutFeedSession(ctx, snapshot, FeedSessionTTL); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.GetFeedSessionForUser(ctx, 42, snapshot.ID)
	if err != nil || len(loaded.Items) != 1 || loaded.Items[0].Features.ProductScore == 0 {
		t.Fatalf("snapshot %+v %v", loaded, err)
	}
	if _, err := store.GetFeedSessionForUser(ctx, 99, snapshot.ID); !errors.Is(err, ErrFeedSessionNotFound) {
		t.Fatal("cross actor snapshot", err)
	}
	record := FeedRequestRecord{ID: "request-portable", User: *user, Seed: "s", CandidateCounts: map[string]int{"latest": 1}, Degraded: []string{}, Items: ranked}
	if err := store.SaveFeedRequest(ctx, record); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveFeedRequest(ctx, record); err != nil {
		t.Fatal("idempotent request retry", err)
	}
	changed := record
	changed.Seed = "changed"
	if err := store.SaveFeedRequest(ctx, changed); err == nil {
		t.Fatal("different request payload accepted")
	}
	event := AcceptedFeedEvent{Input: FeedEventInput{ID: "7f2c0529-4f65-453a-944d-ea3ef6f44df4", Type: FeedEventImpression, RepoKey: projection.RepoKey, OccurredAt: now}, RequestID: record.ID, Metadata: map[string]any{"rank": 0, "algorithmVersion": FeedAlgorithmVersion}}
	eventCtx := withFeedProfileVersion(ctx, user.ProfileVersion)
	if result, err := store.AppendFeedEvents(eventCtx, 42, []AcceptedFeedEvent{event}); err != nil || result.Accepted != 1 {
		t.Fatalf("event %+v %v", result, err)
	}
	if _, err := store.GetFeedSessionForUser(ctx, 42, snapshot.ID); err != nil {
		t.Fatal("impression invalidated session", err)
	}
	if result, err := store.AppendFeedEvents(eventCtx, 42, []AcceptedFeedEvent{event}); err != nil || result.Duplicate != 1 {
		t.Fatalf("event retry %+v %v", result, err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE feed.runtime_control SET writer_epoch=2 WHERE singleton=true`); err != nil {
		t.Fatal(err)
	}
	if err := store.Ping(ctx); !errors.Is(err, ErrFeedWriterEpoch) {
		t.Fatal("stale process ready", err)
	}
	if _, err := store.EnsureFeedUser(ctx, OAuthSession{GitHubID: 43, Login: "other"}); !errors.Is(err, ErrFeedWriterEpoch) {
		t.Fatal("stale writer accepted", err)
	}
	if err := store.EnablePortableRuntime(2); err != nil {
		t.Fatal(err)
	}
	deletion, err := store.DeleteFeedProfile(eventCtx, 42, now)
	if err != nil {
		t.Fatal(err)
	}
	status, err := store.GetFeedDeletion(ctx, 42, deletion)
	if err != nil || status.Status != "queued" {
		t.Fatalf("deletion status %+v %v", status, err)
	}
	if _, err := store.GetFeedDeletion(ctx, 99, deletion); err == nil {
		t.Fatal("cross actor deletion exposed")
	}
	if _, err := store.GetFeedSessionForUser(ctx, 42, snapshot.ID); !errors.Is(err, ErrFeedSessionNotFound) {
		t.Fatal("deleted session survived", err)
	}
	recreated, err := store.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "octocat"})
	if err != nil {
		t.Fatal(err)
	}
	if recreated.ProfileVersion <= user.ProfileVersion {
		t.Fatal("deleted generation resurrected")
	}
	if _, err := store.ReplaceExplicitFeedPreferences(eventCtx, 42, user.TaxonomyVersion, nil); !errors.Is(err, ErrFeedProfileChanged) {
		t.Fatal("predeletion user update accepted", err)
	}
}
