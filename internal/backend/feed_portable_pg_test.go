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
	if _, err := store.db.ExecContext(ctx, `INSERT INTO feed.project_submission_evidence(repo_key,source_kind,source_id,submitted_at,analysis_id) VALUES($1,'verified_backfill','controlled-test-receipt',now(),$2)`, projection.RepoKey, projection.AnalysisID); err != nil {
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
	withdrawnRequest := record
	withdrawnRequest.ID = "request-withdrawal-race"
	if _, err := store.db.ExecContext(ctx, `UPDATE feed.projects SET publishable=false WHERE repo_key=$1`, projection.RepoKey); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveFeedRequest(ctx, withdrawnRequest); !errors.Is(err, ErrFeedCatalogChanged) {
		t.Fatal("commit accepted withdrawn project", err)
	}
	var recorded int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.requests WHERE id=$1`, withdrawnRequest.ID).Scan(&recorded); err != nil || recorded != 0 {
		t.Fatal("failed page partially audited", recorded, err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE feed.projects SET publishable=true WHERE repo_key=$1`, projection.RepoKey); err != nil {
		t.Fatal(err)
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
	altered := event
	altered.Input.Type = FeedEventDetailOpen
	if _, err := store.AppendFeedEvents(eventCtx, 42, []AcceptedFeedEvent{altered}); !errors.Is(err, ErrFeedEventConflict) {
		t.Fatal("altered event replay accepted", err)
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
	testPortableJobsAndProposals(t, ctx, store, recreated)
	testPortableBehavior(t, ctx, store, recreated)
}

// Called within the same disposable database test; it cannot race a second
// schema reset. Covers restart/redelivery leases using a real PostgreSQL clock.
func testPortableJobsAndProposals(t *testing.T, ctx context.Context, store *PostgresFeedStore, user *FeedUser) {
	t.Helper()
	event, source := executorSourceFixture(t, "analysis-portable-job", 100)
	executor, err := NewFeedExecutor(store, store, source, store.writerEpoch, "executor-secret-test-0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	status, err := executor.Execute(ctx, event)
	if err != nil || status != "completed" {
		t.Fatalf("durable executor %s %v", status, err)
	}
	status, err = executor.Execute(ctx, event)
	if err != nil || status != "duplicate" || source.reads != 1 {
		t.Fatalf("durable replay %s %v reads%d", status, err, source.reads)
	}
	var version int64
	if err := store.db.QueryRowContext(ctx, `SELECT source_version FROM feed.project_submission_evidence WHERE repo_key=$1 AND analysis_id=$2`, event.AggregateKey, event.AnalysisID).Scan(&version); err != nil || version != 100 {
		t.Fatalf("source version %d %v", version, err)
	}
	conflict := event
	conflict.SourceVersion++
	if _, err := store.ClaimFeedJob(ctx, FeedJobClaimRequest{store.writerEpoch, conflict, "conflict", 90}); !errors.Is(err, ErrFeedJobConflict) {
		t.Fatal("mutated envelope reused event identity", err)
	}
	pending, _ := executorSourceFixture(t, "analysis-portable-pending", 101)
	first, err := store.ClaimFeedJob(ctx, FeedJobClaimRequest{store.writerEpoch, pending, "owner-a", 90})
	if err != nil || first.Status != "leased" {
		t.Fatal(first, err)
	}
	second, err := store.ClaimFeedJob(ctx, FeedJobClaimRequest{store.writerEpoch, pending, "owner-b", 90})
	if err != nil || second.Status != "busy" {
		t.Fatal(second, err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE feed.jobs SET lease_until=now()-interval '1 second' WHERE event_id=$1`, pending.EventID); err != nil {
		t.Fatal(err)
	}
	second, err = store.ClaimFeedJob(ctx, FeedJobClaimRequest{store.writerEpoch, pending, "owner-b", 90})
	if err != nil || second.Status != "leased" || second.Attempts != 2 {
		t.Fatal(second, err)
	}
	if err := store.CompleteFeedJob(ctx, FeedJobFinishRequest{WriterEpoch: store.writerEpoch, EventID: pending.EventID, LeaseOwner: "owner-a"}); !errors.Is(err, ErrFeedJobLease) {
		t.Fatal("expired worker acked", err)
	}
	if err := store.FailFeedJob(ctx, FeedJobFinishRequest{WriterEpoch: store.writerEpoch, EventID: pending.EventID, LeaseOwner: "owner-b", ErrorCode: "test_failure"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE feed.jobs SET attempts=8,status='leased',lease_until=now()-interval '1 second' WHERE event_id=$1`, pending.EventID); err != nil {
		t.Fatal(err)
	}
	final, err := store.ClaimFeedJob(ctx, FeedJobClaimRequest{store.writerEpoch, pending, "owner-c", 90})
	if err != nil || final.Status != "dead_letter" {
		t.Fatal(final, err)
	}
	input := FeedTagProposalInput{ID: "7f2c0529-4f65-453a-944d-ea3ef6f44df5", RepoKey: event.AggregateKey, Namespace: "use_case", Slug: "new-proposal", LabelEN: "New proposal", Evidence: []string{"readme-contract"}}
	userCtx := withFeedProfileVersion(ctx, user.ProfileVersion)
	proposal, err := store.ProposeFeedTag(userCtx, user.GitHubID, input)
	if err != nil || proposal.Status != "proposed" {
		t.Fatal(proposal, err)
	}
	retry, err := store.ProposeFeedTag(userCtx, user.GitHubID, input)
	if err != nil || retry.ProposalID != proposal.ProposalID {
		t.Fatal("proposal retry", retry, err)
	}
	input.LabelEN = "changed"
	if _, err := store.ProposeFeedTag(userCtx, user.GitHubID, input); !errors.Is(err, ErrFeedProposalConflict) {
		t.Fatal("altered command accepted", err)
	}
	var approved int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.tag_definitions WHERE id='use_case:new-proposal'`).Scan(&approved); err != nil || approved != 0 {
		t.Fatal("proposal granted canonical status", err)
	}
}

func testPortableBehavior(t *testing.T, ctx context.Context, store *PostgresFeedStore, user *FeedUser) {
	t.Helper()
	candidates, counts, err := store.LoadFeedCandidates(ctx, *user, 240)
	if err != nil || len(candidates) == 0 {
		t.Fatalf("behavior fixture candidates %d %v", len(candidates), err)
	}
	items := RankFeedCandidates(candidates, FeedRankOptions{Limit: 20, Seed: "behavior", OwnerCap: 2})
	record := FeedRequestRecord{ID: "behavior-request", User: *user, Seed: "behavior", CandidateCounts: counts, Degraded: []string{}, Items: items}
	if err := store.SaveFeedRequest(ctx, record); err != nil {
		t.Fatal(err)
	}
	repo := items[0].Project.RepoKey
	truth, falsity := true, false
	set := func(patch FeedStatePatch) FeedProjectState {
		t.Helper()
		current, err := store.GetFeedUser(ctx, user.GitHubID)
		if err != nil {
			t.Fatal(err)
		}
		patch.RequestID = record.ID
		state, err := store.SetFeedProjectState(withFeedProfileVersion(ctx, current.ProfileVersion), user.GitHubID, repo, patch, time.Now().UTC())
		if err != nil {
			t.Fatal(err)
		}
		return state
	}
	set(FeedStatePatch{Saved: &truth})
	saved, err := store.GetFeedUser(ctx, user.GitHubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Preferences) == 0 || saved.Preferences[0].Source != "behavior" {
		t.Fatal("save did not materialize preference", saved.Preferences)
	}
	set(FeedStatePatch{Saved: &falsity})
	cleared, err := store.GetFeedUser(ctx, user.GitHubID)
	if err != nil || len(cleared.Preferences) != 0 {
		t.Fatal("unsave retained saved signal", cleared, err)
	}
	event := AcceptedFeedEvent{Input: FeedEventInput{ID: "7f2c0529-4f65-453a-944d-ea3ef6f44da0", Type: FeedEventGitHubOutbound, RepoKey: repo, OccurredAt: time.Now().UTC()}, RequestID: record.ID, Metadata: map[string]any{"rank": items[0].Rank, "algorithmVersion": FeedAlgorithmVersion}}
	result, err := store.AppendFeedEvents(withFeedProfileVersion(ctx, cleared.ProfileVersion), user.GitHubID, []AcceptedFeedEvent{event})
	if err != nil || result.Accepted != 1 {
		t.Fatal(result, err)
	}
	first, _ := store.GetFeedUser(ctx, user.GitHubID)
	if len(first.Preferences) == 0 {
		t.Fatal("outbound did not materialize preference")
	}
	event.Input.ID = "7f2c0529-4f65-453a-944d-ea3ef6f44da1"
	if _, err := store.AppendFeedEvents(withFeedProfileVersion(ctx, first.ProfileVersion), user.GitHubID, []AcceptedFeedEvent{event}); err != nil {
		t.Fatal(err)
	}
	repeated, _ := store.GetFeedUser(ctx, user.GitHubID)
	if repeated.ProfileVersion != first.ProfileVersion {
		t.Fatal("repeated outbound amplified profile")
	}
	event.Input.ID = "7f2c0529-4f65-453a-944d-ea3ef6f44da2"
	event.Input.Type = FeedEventDetailOpen
	if _, err := store.AppendFeedEvents(withFeedProfileVersion(ctx, repeated.ProfileVersion), user.GitHubID, []AcceptedFeedEvent{event}); err != nil {
		t.Fatal(err)
	}
	opened, _ := store.GetFeedUser(ctx, user.GitHubID)
	if opened.ProfileVersion != first.ProfileVersion {
		t.Fatal("detail_open became positive feedback")
	}
	pref := FeedPreference{TagID: first.Preferences[0].TagID, Value: -1, Source: "explicit", Strength: 1, TaxonomyVersion: first.TaxonomyVersion}
	explicit, err := store.ReplaceExplicitFeedPreferences(withFeedProfileVersion(ctx, opened.ProfileVersion), user.GitHubID, opened.TaxonomyVersion, []FeedPreference{pref})
	if err != nil {
		t.Fatal(err)
	}
	found := 0
	for _, p := range explicit.Preferences {
		if p.TagID == pref.TagID {
			found++
			if p.Source != "explicit" || p.Value != -1 {
				t.Fatal("behavior overrode explicit preference", p)
			}
		}
	}
	if found != 1 {
		t.Fatal("duplicate sources for explicit tag", explicit.Preferences)
	}
	set(FeedStatePatch{Saved: &truth})
	state := set(FeedStatePatch{NotInterested: &truth})
	if state.Saved || !state.NotInterested {
		t.Fatal("negative state failed to clear saved", state)
	}
}
