package backend

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/hikariming/ghfind/internal/feedmigration"
)

// This test is opt-in because the normal unit suite has no database service.
// CI/staging can set FEED_TEST_DATABASE_URL to a disposable pgvector database;
// the test performs real migrations and validates the highest-risk transaction
// contracts rather than mocking database/sql.
func TestPostgresFeedStoreIntegration(t *testing.T) {
	databaseURL := os.Getenv("FEED_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("FEED_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := feedmigration.Run(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	store, err := OpenPostgresFeedStore(Config{FeedDatabaseURL: databaseURL})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.Ping(ctx); err != nil {
		t.Fatalf("strict Feed readiness after migration: %v", err)
	}
	leaseNow := time.Now().UTC()
	acquired, err := store.AcquireFeedReconcileLease(ctx, "integration-worker-a", leaseNow, time.Minute)
	if err != nil || !acquired {
		t.Fatalf("first projection lease acquired=%v err=%v", acquired, err)
	}
	acquired, err = store.AcquireFeedReconcileLease(ctx, "integration-worker-b", leaseNow, time.Minute)
	if err != nil || acquired {
		t.Fatalf("competing projection lease acquired=%v err=%v", acquired, err)
	}
	renewed, err := store.RenewFeedReconcileLease(ctx, "integration-worker-a", leaseNow.Add(30*time.Second), time.Minute)
	if err != nil || !renewed {
		t.Fatalf("projection lease renewed=%v err=%v", renewed, err)
	}
	acquired, err = store.AcquireFeedReconcileLease(ctx, "integration-worker-b", leaseNow.Add(70*time.Second), time.Minute)
	if err != nil || acquired {
		t.Fatalf("renewed lease excluded competitor acquired=%v err=%v", acquired, err)
	}
	if err := store.ReleaseFeedReconcileLease(ctx, "integration-worker-a"); err != nil {
		t.Fatal(err)
	}
	acquired, err = store.AcquireFeedReconcileLease(ctx, "integration-worker-b", leaseNow, time.Minute)
	if err != nil || !acquired {
		t.Fatalf("released projection lease acquired=%v err=%v", acquired, err)
	}
	if err := store.ReleaseFeedReconcileLease(ctx, "integration-worker-b"); err != nil {
		t.Fatal(err)
	}
	acquired, err = store.AcquireFeedReconcileLease(ctx, "integration-worker-a", leaseNow, time.Minute)
	if err != nil || !acquired {
		t.Fatalf("expired-renewal setup acquired=%v err=%v", acquired, err)
	}
	renewed, err = store.RenewFeedReconcileLease(ctx, "integration-worker-a", leaseNow.Add(2*time.Minute), time.Minute)
	if err != nil || renewed {
		t.Fatalf("expired projection lease renewed=%v err=%v", renewed, err)
	}
	if err := store.ReleaseFeedReconcileLease(ctx, "integration-worker-a"); err != nil {
		t.Fatal(err)
	}

	assessment := validFeedAssessment()
	projection, err := BuildFeedProjectProjection(assessment, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertFeedProject(ctx, projection); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertFeedProject(ctx, projection); err != nil {
		t.Fatalf("idempotent project replay: %v", err)
	}
	// Two current assessments can propose the same explicit namespace/slug.
	// Reviewing one must activate both; unchanged sibling projects must not
	// wait for an unrelated reproject before they become recall candidates.
	secondAssessment := validFeedAssessment()
	secondAssessment.RepoKey = "other/another-tool"
	secondAssessment.LatestAnalysisID = "analysis-feed-2"
	secondAssessment.ResolvedCommitSHA = strings.Repeat("b", 40)
	secondAssessment.Analysis.AnalysisID = secondAssessment.LatestAnalysisID
	secondAssessment.Analysis.Repository.RepoKey = secondAssessment.RepoKey
	secondAssessment.Analysis.Repository.CanonicalURL = "https://github.com/other/another-tool"
	secondAssessment.Analysis.Repository.ResolvedCommitSHA = secondAssessment.ResolvedCommitSHA
	secondAssessment.Analysis.Project.Name = "Another Tool"
	secondProjection, err := BuildFeedProjectProjection(secondAssessment, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertFeedProject(ctx, secondProjection); err != nil {
		t.Fatalf("project with matching tag proposal: %v", err)
	}
	var proposals, activeUnreviewed int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.tag_proposals WHERE status='proposed'`).Scan(&proposals); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.project_tags pt JOIN feed.tag_proposals p ON p.canonical_tag_id=pt.tag_id WHERE p.status='proposed'`).Scan(&activeUnreviewed); err != nil {
		t.Fatal(err)
	}
	if proposals != 2 || activeUnreviewed != 0 {
		t.Fatalf("proposal governance mismatch: proposed=%d active=%d", proposals, activeUnreviewed)
	}
	var proposalID, descriptorBeforeReview string
	if err := store.db.QueryRowContext(ctx, `SELECT id FROM feed.tag_proposals
	  WHERE status='proposed' AND source_ref=$1`, projection.RepoKey).Scan(&proposalID); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT descriptor FROM feed.projects WHERE repo_key=$1`, projection.RepoKey).Scan(&descriptorBeforeReview); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(descriptorBeforeReview, "Developer productivity") {
		t.Fatalf("proposed tag leaked into semantic descriptor: %s", descriptorBeforeReview)
	}
	review, err := store.ReviewFeedTagProposal(ctx, FeedTagReviewInput{ProposalID: proposalID, Action: "create", Operator: "integration-test", Reason: "canonical test tag"})
	if err != nil || review.CanonicalTagID != "use_case:developer-productivity" {
		t.Fatalf("tag review mismatch: result=%#v err=%v", review, err)
	}
	var activeReviewed int
	var descriptorAfterReview string
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.project_tags
	  WHERE repo_key IN ($1,$2) AND tag_id=$3`, projection.RepoKey, secondProjection.RepoKey, review.CanonicalTagID).Scan(&activeReviewed); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT descriptor FROM feed.projects WHERE repo_key=$1`, projection.RepoKey).Scan(&descriptorAfterReview); err != nil {
		t.Fatal(err)
	}
	if activeReviewed != 2 || !strings.Contains(descriptorAfterReview, "use_case:developer-productivity") {
		t.Fatalf("reviewed tag did not activate descriptor: active=%d descriptor=%s", activeReviewed, descriptorAfterReview)
	}

	user, err := store.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "octocat"})
	if err != nil {
		t.Fatal(err)
	}
	candidates, counts, err := store.LoadFeedCandidates(ctx, *user, 240)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 || counts["quality"] != 2 {
		t.Fatalf("candidate projection mismatch: candidates=%#v counts=%#v", candidates, counts)
	}
	gorseCandidates, err := store.LoadGorseFeedCandidates(ctx, *user, []string{projection.ItemID, "unknown:item"}, 60)
	if err != nil || len(gorseCandidates) != 1 || !containsString(gorseCandidates[0].Sources, "gorse") {
		t.Fatalf("Gorse candidate hydration mismatch: candidates=%#v err=%v", gorseCandidates, err)
	}
	hidden, err := store.FinalizeFeedProjectReconcile(ctx, []string{"different/project"}, time.Now().UTC())
	if err != nil || hidden != 2 {
		t.Fatalf("hide missing project: hidden=%d err=%v", hidden, err)
	}
	hiddenProject, _, err := store.GetFeedProjectForGorse(ctx, projection.RepoKey)
	if err != nil || hiddenProject == nil || hiddenProject.Publishable {
		t.Fatalf("hidden project projection mismatch: project=%#v err=%v", hiddenProject, err)
	}
	hashes, err := store.FeedProjectSourceHashes(ctx, []string{projection.RepoKey})
	if err != nil || hashes[projection.RepoKey] != "" {
		t.Fatalf("missing project incorrectly satisfied source-hash fast path: hashes=%#v err=%v", hashes, err)
	}
	if err := store.UpsertFeedProject(ctx, projection); err != nil {
		t.Fatalf("restore reappeared project: %v", err)
	}
	restoredProject, _, err := store.GetFeedProjectForGorse(ctx, projection.RepoKey)
	if err != nil || restoredProject == nil || !restoredProject.Publishable {
		t.Fatalf("restored project projection mismatch: project=%#v err=%v", restoredProject, err)
	}
	enabled := true
	if _, err := store.ModerateFeedProject(ctx, FeedProjectModerationInput{RepoKey: projection.RepoKey, Action: "risk_override", Enabled: &enabled, Operator: "integration-test", Reason: "must reject"}); err == nil {
		t.Fatal("non-risk project accepted a risk override")
	}
	removed, err := store.ModerateFeedProject(ctx, FeedProjectModerationInput{RepoKey: projection.RepoKey, Action: "remove", Operator: "integration-test", Reason: "moderation test"})
	if err != nil || removed.Publishable || !removed.AdminRemoved || !removed.Changed {
		t.Fatalf("project removal mismatch: result=%#v err=%v", removed, err)
	}
	restored, err := store.ModerateFeedProject(ctx, FeedProjectModerationInput{RepoKey: projection.RepoKey, Action: "restore", Operator: "integration-test", Reason: "moderation test"})
	if err != nil || !restored.Publishable || restored.AdminRemoved || !restored.Changed || restored.ProjectionVersion <= removed.ProjectionVersion {
		t.Fatalf("project restore mismatch: result=%#v err=%v", restored, err)
	}
	pending, err := store.ListPendingFeedEmbeddings(ctx, "integration-embedding", 1)
	if err != nil || len(pending) != 1 || pending[0].Kind != "project" {
		t.Fatalf("pending project embedding mismatch: pending=%#v err=%v", pending, err)
	}
	for attempt := 0; attempt < 8; attempt++ {
		dead, failureErr := store.RecordFeedEmbeddingFailure(ctx, pending[0], "integration-embedding", context.DeadlineExceeded, time.Now().UTC())
		if failureErr != nil {
			t.Fatal(failureErr)
		}
		if dead != (attempt == 7) {
			t.Fatalf("embedding dead-letter state on attempt %d = %v", attempt+1, dead)
		}
	}
	var deadLettered bool
	if err := store.db.QueryRowContext(ctx, `SELECT dead_lettered_at IS NOT NULL FROM feed.projection_failures
	  WHERE projection='embedding:integration-embedding' AND source_ref=$1`, "project:"+projection.RepoKey).Scan(&deadLettered); err != nil || !deadLettered {
		t.Fatalf("embedding DLQ mismatch: dead=%v err=%v", deadLettered, err)
	}
	for {
		targets, err := store.ListPendingFeedEmbeddings(ctx, "activation-v1", 100)
		if err != nil {
			t.Fatal(err)
		}
		if len(targets) == 0 {
			break
		}
		for _, target := range targets {
			if err := store.SaveFeedEmbedding(ctx, target, "activation-v1", []float64{1, 0}); err != nil {
				t.Fatal(err)
			}
		}
	}
	active, err := store.ActivateFeedEmbeddingModel(ctx, "activation-v1")
	if err != nil || !active {
		t.Fatalf("activate complete embedding model: active=%v err=%v", active, err)
	}
	v2Targets, err := store.ListPendingFeedEmbeddings(ctx, "activation-v2", 100)
	if err != nil || len(v2Targets) < 2 {
		t.Fatalf("second embedding model targets=%d err=%v", len(v2Targets), err)
	}
	if err := store.SaveFeedEmbedding(ctx, v2Targets[0], "activation-v2", []float64{0, 1}); err != nil {
		t.Fatal(err)
	}
	active, err = store.ActivateFeedEmbeddingModel(ctx, "activation-v2")
	if err != nil || active {
		t.Fatalf("partial embedding model activated: active=%v err=%v", active, err)
	}
	var activeModel string
	if err := store.db.QueryRowContext(ctx, `SELECT active_model FROM feed.embedding_model_state WHERE singleton=true`).Scan(&activeModel); err != nil || activeModel != "activation-v1" {
		t.Fatalf("active embedding model changed during partial rebuild: model=%q err=%v", activeModel, err)
	}

	saved := true
	if _, err := store.SetFeedProjectState(ctx, 42, projection.RepoKey, FeedStatePatch{Saved: &saved}, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetFeedProjectState(ctx, 42, projection.RepoKey, FeedStatePatch{Saved: &saved}, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	var saveEvents int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.events WHERE github_id=42 AND event_type='save'`).Scan(&saveEvents); err != nil {
		t.Fatal(err)
	}
	if saveEvents != 1 {
		t.Fatalf("idempotent state emitted %d save events", saveEvents)
	}
	notInterested := true
	if _, err := store.SetFeedProjectState(ctx, 42, projection.RepoKey, FeedStatePatch{NotInterested: &notInterested}, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	gorseCandidates, err = store.LoadGorseFeedCandidates(ctx, *user, []string{projection.ItemID}, 60)
	if err != nil || len(gorseCandidates) != 0 {
		t.Fatalf("Gorse hydration bypassed not-interested filter: candidates=%#v err=%v", gorseCandidates, err)
	}
	notInterested = false
	if _, err := store.SetFeedProjectState(ctx, 42, projection.RepoKey, FeedStatePatch{NotInterested: &notInterested}, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	event := AcceptedFeedEvent{Input: FeedEventInput{ID: "123e4567-e89b-12d3-a456-426614174000", Type: FeedEventImpression, RepoKey: projection.RepoKey, OccurredAt: time.Now().UTC()}, Metadata: map[string]any{"rank": 0}}
	first, err := store.AppendFeedEvents(ctx, 42, []AcceptedFeedEvent{event})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.AppendFeedEvents(ctx, 42, []AcceptedFeedEvent{event})
	if err != nil {
		t.Fatal(err)
	}
	if first.Accepted != 1 || second.Duplicate != 1 {
		t.Fatalf("event idempotency mismatch: first=%#v second=%#v", first, second)
	}
	shadowRequestID := "request_integration_shadow"
	if err := store.SaveFeedRequest(ctx, FeedRequestRecord{ID: shadowRequestID, User: *user, Seed: "integration",
		CandidateCounts: map[string]int{"quality": 1}, Items: []FeedRankedItem{{Project: candidates[0].Project, Rank: 0, Propensity: 1}}}); err != nil {
		t.Fatal(err)
	}
	shadowCreatedAt := time.Now().UTC().Add(-8 * 24 * time.Hour)
	if _, err := store.db.ExecContext(ctx, `UPDATE feed.requests SET created_at=$2 WHERE id=$1`, shadowRequestID, shadowCreatedAt); err != nil {
		t.Fatal(err)
	}
	positive := AcceptedFeedEvent{Input: FeedEventInput{ID: "223e4567-e89b-12d3-a456-426614174000", Type: FeedEventGitHubOutbound,
		RepoKey: projection.RepoKey, OccurredAt: shadowCreatedAt.Add(12 * time.Hour)}, RequestID: shadowRequestID, Metadata: map[string]any{}}
	if _, err := store.AppendFeedEvents(ctx, 42, []AcceptedFeedEvent{positive}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveGorseShadowResult(ctx, shadowRequestID, []string{projection.ItemID}, 20*time.Millisecond, ""); err != nil {
		t.Fatal(err)
	}
	evaluation, err := store.EvaluateGorseShadowOutcomes(ctx, time.Now().UTC(), 24*time.Hour, 10)
	if err != nil || evaluation.Evaluated != 1 || evaluation.WithPositives != 1 || evaluation.RecallSum != 1 {
		t.Fatalf("Gorse shadow evaluation mismatch: result=%#v err=%v", evaluation, err)
	}
	var evaluationWindowSeconds int
	if err := store.db.QueryRowContext(ctx, `SELECT evaluation_window_seconds FROM feed.gorse_shadow_results WHERE request_id=$1`, shadowRequestID).Scan(&evaluationWindowSeconds); err != nil || evaluationWindowSeconds != 86_400 {
		t.Fatalf("Gorse shadow evaluation window=%d err=%v", evaluationWindowSeconds, err)
	}
	rebuild, err := store.QueueFullGorseRebuild(ctx, FeedGorseRebuildInput{Operator: "integration-test", Reason: "verify replay"})
	if err != nil {
		t.Fatal(err)
	}
	if rebuild.RebuildID == "" || rebuild.Projects != 2 || rebuild.Users != 1 || rebuild.Events != 5 {
		t.Fatalf("Gorse rebuild mismatch: %#v", rebuild)
	}
	// A second rebuild is deliberately allowed and receives independent dedupe
	// keys; this is how operators recover a newly emptied Gorse database.
	secondRebuild, err := store.QueueFullGorseRebuild(ctx, FeedGorseRebuildInput{Operator: "integration-test", Reason: "verify repeatability"})
	if err != nil {
		t.Fatal(err)
	}
	if secondRebuild.RebuildID == rebuild.RebuildID || secondRebuild.Projects != rebuild.Projects || secondRebuild.Events != rebuild.Events {
		t.Fatalf("repeatable Gorse rebuild mismatch: first=%#v second=%#v", rebuild, secondRebuild)
	}
	deletionID, err := store.DeleteFeedProfile(ctx, 42, time.Now().UTC())
	if err != nil || deletionID == "" {
		t.Fatalf("delete Feed profile: id=%q err=%v", deletionID, err)
	}
	var tombstones int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.user_deletion_tombstones WHERE deletion_id=$1`, deletionID).Scan(&tombstones); err != nil || tombstones != 1 {
		t.Fatalf("deletion tombstone mismatch: count=%d err=%v", tombstones, err)
	}
	deletionRebuild, err := store.QueueFullGorseRebuild(ctx, FeedGorseRebuildInput{Operator: "integration-test", Reason: "verify deletion replay"})
	if err != nil || deletionRebuild.Deletions != 1 || deletionRebuild.Users != 0 || deletionRebuild.Events != 0 {
		t.Fatalf("Gorse deletion rebuild mismatch: result=%#v err=%v", deletionRebuild, err)
	}
	if err := store.MarkGorseUserDeleted(ctx, deletionID); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.user_deletion_tombstones WHERE deletion_id=$1`, deletionID).Scan(&tombstones); err != nil || tombstones != 0 {
		t.Fatalf("projected deletion tombstone mismatch: count=%d err=%v", tombstones, err)
	}
	highRiskAssessment := validFeedAssessment()
	highRiskAssessment.Analysis.AnalysisID = "analysis-feed-high-risk"
	highRiskAssessment.LatestAnalysisID = highRiskAssessment.Analysis.AnalysisID
	highRiskAssessment.Analysis.Risks = []ProjectRisk{{Severity: "high", Category: "security"}}
	highRiskAssessment.AnalyzedAt += int64(time.Hour / time.Millisecond)
	highRiskAssessment.Analysis.AnalyzedAt = time.UnixMilli(highRiskAssessment.AnalyzedAt).UTC().Format(time.RFC3339)
	highRiskProjection, err := BuildFeedProjectProjection(highRiskAssessment, nil)
	if err != nil || !highRiskProjection.RiskOverrideEligible || highRiskProjection.Publishable {
		t.Fatalf("high-risk projection mismatch: projection=%#v err=%v", highRiskProjection, err)
	}
	if err := store.UpsertFeedProject(ctx, highRiskProjection); err != nil {
		t.Fatal(err)
	}
	overridden, err := store.ModerateFeedProject(ctx, FeedProjectModerationInput{RepoKey: projection.RepoKey, Action: "risk_override", Enabled: &enabled, Operator: "integration-test", Reason: "reviewed high risk"})
	if err != nil || !overridden.Publishable || !overridden.RiskOverride {
		t.Fatalf("high-risk override mismatch: result=%#v err=%v", overridden, err)
	}
	criticalAssessment := validFeedAssessment()
	criticalAssessment.Analysis.AnalysisID = "analysis-feed-critical-risk"
	criticalAssessment.LatestAnalysisID = criticalAssessment.Analysis.AnalysisID
	criticalAssessment.Analysis.Risks = []ProjectRisk{{Severity: "critical", Category: "security"}}
	criticalAssessment.AnalyzedAt += int64(2 * time.Hour / time.Millisecond)
	criticalAssessment.Analysis.AnalyzedAt = time.UnixMilli(criticalAssessment.AnalyzedAt).UTC().Format(time.RFC3339)
	criticalProjection, err := BuildFeedProjectProjection(criticalAssessment, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertFeedProject(ctx, criticalProjection); err != nil {
		t.Fatal(err)
	}
	criticalProject, _, err := store.GetFeedProjectForGorse(ctx, projection.RepoKey)
	if err != nil || criticalProject == nil || criticalProject.Publishable {
		t.Fatalf("critical risk escaped hard gate: project=%#v err=%v", criticalProject, err)
	}
	if _, err := store.ModerateFeedProject(ctx, FeedProjectModerationInput{RepoKey: projection.RepoKey, Action: "risk_override", Enabled: &enabled, Operator: "integration-test", Reason: "must reject critical"}); err == nil {
		t.Fatal("critical risk accepted an admin override")
	}
	var retainedOverride bool
	if err := store.db.QueryRowContext(ctx, `SELECT admin_override FROM feed.projects WHERE repo_key=$1`, projection.RepoKey).Scan(&retainedOverride); err != nil || retainedOverride {
		t.Fatalf("risk override leaked across analysis versions: retained=%v err=%v", retainedOverride, err)
	}

	// v1/v2 artifacts carry a compatibility namespace only. They may be
	// reviewed, but an operator must explicitly classify that legacy label
	// instead of silently letting the old default participate in recommendations.
	legacyAssessment := validFeedAssessment()
	legacyAssessment.RepoKey = "legacy/old-tool"
	legacyAssessment.LatestAnalysisID = "analysis-feed-legacy"
	legacyAssessment.ResolvedCommitSHA = strings.Repeat("d", 40)
	legacyAssessment.Analysis.SchemaVersion = PreviousProjectAnalysisSchemaVersion
	legacyAssessment.Analysis.AnalysisID = legacyAssessment.LatestAnalysisID
	legacyAssessment.Analysis.Repository.RepoKey = legacyAssessment.RepoKey
	legacyAssessment.Analysis.Repository.CanonicalURL = "https://github.com/legacy/old-tool"
	legacyAssessment.Analysis.Repository.ResolvedCommitSHA = legacyAssessment.ResolvedCommitSHA
	legacyAssessment.Analysis.Project.ProductTags = []ProductTag{{
		Namespace: "use_case", Slug: "legacy-automation", Labels: ProductTagLabels{
			Zh: "旧版自动化", En: "Legacy automation",
		}, EvidenceIDs: []string{"source:legacy"},
	}}
	legacyProjection, err := BuildFeedProjectProjection(legacyAssessment, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertFeedProject(ctx, legacyProjection); err != nil {
		t.Fatalf("project legacy tag proposal: %v", err)
	}
	var legacyProposalID string
	var legacyInferred bool
	if err := store.db.QueryRowContext(ctx, `SELECT id,namespace_inferred FROM feed.tag_proposals
	  WHERE source_ref=$1 AND analysis_id=$2`, legacyProjection.RepoKey, legacyProjection.AnalysisID).
		Scan(&legacyProposalID, &legacyInferred); err != nil || !legacyInferred {
		t.Fatalf("legacy tag proposal identity: id=%q inferred=%v err=%v", legacyProposalID, legacyInferred, err)
	}
	if _, err := store.ReviewFeedTagProposal(ctx, FeedTagReviewInput{
		ProposalID: legacyProposalID, Action: "create", Operator: "integration-test", Reason: "must classify legacy tag",
	}); err == nil {
		t.Fatal("legacy proposal was approved without target namespace")
	}
	legacyReview, err := store.ReviewFeedTagProposal(ctx, FeedTagReviewInput{
		ProposalID: legacyProposalID, Action: "create", TargetNamespace: "domain", Operator: "integration-test", Reason: "classify legacy tag",
	})
	if err != nil || legacyReview.CanonicalTagID != "domain:legacy-automation" {
		t.Fatalf("explicit legacy tag classification mismatch: result=%#v err=%v", legacyReview, err)
	}
}
