package backend

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// openProjectAnalysisTestStore builds the three project analysis tables in a
// local libsql file, mirroring cmd/ghfind-mocks/schema.sql. The Go backend
// never runs DDL in production; this is test-only scaffolding.
func openProjectAnalysisTestStore(t *testing.T) *TursoStore {
	t.Helper()
	store, err := OpenTursoStore(Config{TursoURL: "file:" + filepath.Join(t.TempDir(), "project-analysis-test.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	for _, statement := range []string{
		`CREATE TABLE project_analysis_runs (
			id TEXT PRIMARY KEY,
			repo_key TEXT NOT NULL,
			canonical_url TEXT NOT NULL,
			requested_ref TEXT,
			resolved_commit_sha TEXT,
			active_key TEXT UNIQUE,
			idempotency_key TEXT NOT NULL UNIQUE,
			status TEXT NOT NULL,
			phase TEXT NOT NULL,
			progress INTEGER NOT NULL DEFAULT 0,
			activities_json TEXT NOT NULL DEFAULT '[]',
			mosoo_agent_id TEXT,
			mosoo_thread_id TEXT UNIQUE,
			mosoo_run_id TEXT,
			schema_version TEXT NOT NULL,
			rubric_version TEXT NOT NULL,
			agent_version TEXT NOT NULL,
			skill_version TEXT NOT NULL,
			verification_level TEXT,
			analysis_json TEXT,
			report_markdown TEXT,
			evidence_json TEXT,
			analysis_sha256 TEXT,
			report_sha256 TEXT,
			evidence_sha256 TEXT,
			error_code TEXT,
			error_message TEXT,
			create_attempts INTEGER NOT NULL DEFAULT 0,
			create_retry_at INTEGER,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE INDEX idx_project_analysis_runs_repo_created
			ON project_analysis_runs(repo_key, created_at DESC)`,
		`CREATE INDEX idx_project_analysis_runs_status_updated
			ON project_analysis_runs(status, updated_at)`,
		`CREATE TABLE project_assessments (
			repo_key TEXT PRIMARY KEY,
			latest_analysis_id TEXT NOT NULL,
			project_type TEXT NOT NULL,
			lifecycle TEXT NOT NULL,
			product_score REAL NOT NULL,
			pain_score REAL NOT NULL,
			effectiveness_score REAL NOT NULL,
			experience_score REAL NOT NULL,
			value_density_score REAL NOT NULL,
			community_strength REAL NOT NULL DEFAULT 0,
			confidence REAL NOT NULL,
			verification_level TEXT NOT NULL,
			unknowns_json TEXT NOT NULL,
			risks_json TEXT NOT NULL,
			exposure_band TEXT NOT NULL,
			stars INTEGER,
			treasure_eligible INTEGER NOT NULL DEFAULT 0,
			classic_eligible INTEGER NOT NULL DEFAULT 0,
			resolved_commit_sha TEXT NOT NULL,
			rubric_version TEXT NOT NULL,
			analyzed_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE INDEX idx_project_assessments_treasure
			ON project_assessments(treasure_eligible, product_score DESC, confidence DESC)`,
		`CREATE INDEX idx_project_assessments_classic
			ON project_assessments(classic_eligible, product_score DESC, confidence DESC)`,
		`CREATE INDEX idx_project_assessments_feed_updates
			ON project_assessments(updated_at, repo_key)`,
		`CREATE TABLE treasure_entries (
			id TEXT PRIMARY KEY,
			repo_key TEXT NOT NULL,
			analysis_id TEXT NOT NULL,
			status TEXT NOT NULL,
			selected_at INTEGER NOT NULL,
			product_score_snapshot REAL NOT NULL,
			confidence_snapshot REAL NOT NULL,
			verification_level_snapshot TEXT NOT NULL,
			stars_snapshot INTEGER,
			exposure_snapshot TEXT NOT NULL,
			reason TEXT NOT NULL,
			resolved_commit_sha TEXT NOT NULL,
			graduated_at INTEGER,
			removed_at INTEGER,
			removed_reason TEXT
		)`,
		`CREATE INDEX idx_treasure_entries_repo_selected
			ON treasure_entries(repo_key, selected_at DESC)`,
		`CREATE UNIQUE INDEX idx_treasure_entries_one_active
			ON treasure_entries(repo_key) WHERE status = 'active'`,
	} {
		if _, err := store.db.Exec(statement); err != nil {
			t.Fatalf("create project analysis test schema: %v", err)
		}
	}
	return store
}

func createTestRun(t *testing.T, store *TursoStore, id, repoKey string, requestedRef *string) (*ProjectAnalysisRun, bool) {
	t.Helper()
	run, created, err := store.CreateProjectAnalysisRun(context.Background(), CreateProjectAnalysisRunInput{
		ID:            id,
		RepoKey:       repoKey,
		CanonicalURL:  "https://github.com/" + repoKey,
		RequestedRef:  requestedRef,
		SchemaVersion: ProjectAnalysisSchemaVersion,
		RubricVersion: ProjectRubricVersion,
		AgentVersion:  ProjectAgentVersion,
		SkillVersion:  ProjectSkillVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	return run, created
}

// finalizeInput builds a finalize request from the shared fixtures, applying
// the same mutations to the raw JSON and the parsed artifact.
func finalizeInput(t *testing.T, analysisID string, mutate func(analysis, evidence map[string]any)) FinalizeProjectAnalysisInput {
	t.Helper()
	analysis, evidence := validProjectAnalysisMap(), validRuntimeEvidenceMap()
	analysis["analysis_id"] = analysisID
	evidence["analysis_id"] = analysisID
	if mutate != nil {
		mutate(analysis, evidence)
	}
	input := artifactsInput(t, analysis, evidence, "# Useful Tool\n\nA useful project.")
	input.ExpectedAnalysisID = analysisID
	input.ExpectedRepoKey = analysis["repository"].(map[string]any)["repo_key"].(string)
	parsed, err := ParseProjectAnalysisArtifacts(input)
	if err != nil {
		t.Fatal(err)
	}
	return FinalizeProjectAnalysisInput{
		AnalysisID:     analysisID,
		Analysis:       parsed.Analysis,
		AnalysisJSON:   input.AnalysisRaw,
		EvidenceJSON:   input.EvidenceRaw,
		ReportMarkdown: input.ReportMarkdown,
		Hashes:         ProjectAnalysisArtifactHashes{Analysis: "a-" + analysisID, Evidence: "e-" + analysisID, Report: "r-" + analysisID},
	}
}

func TestCreateProjectAnalysisRunDeduplicatesActiveRun(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	first, created := createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if !created || first.Status != "queued" || first.Phase != "queued" {
		t.Fatalf("first = %#v created=%v", first, created)
	}
	duplicate, created := createTestRun(t, store, "analysis-duplicate", "OWNER/USEFUL-TOOL", nil)
	if created || duplicate.ID != "analysis-1" {
		t.Fatalf("duplicate = %#v created=%v", duplicate, created)
	}
}

func TestProjectAnalysisLifecyclePersistsAssessmentAtomically(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	ctx := context.Background()
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)

	if err := store.AttachMosooThread(ctx, AttachMosooThreadInput{
		AnalysisID: "analysis-1",
		AgentID:    "01KXZBBD8VW1S3AF6GB5EEG13G",
		ThreadID:   "01KTESTTHREAD000000000000000",
		RunID:      "01KTESTRUN00000000000000000",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateProjectAnalysisState(ctx, UpdateProjectAnalysisStateInput{
		AnalysisID: "analysis-1",
		Status:     "running",
		Phase:      "inspecting",
		Progress:   40,
		Activities: []ProjectAnalysisActivity{
			{ID: "event-1", Kind: "inspecting_docs", OccurredAt: "2026-07-30T14:00:00.000Z"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	completed, err := store.FinalizeProjectAnalysis(ctx, finalizeInput(t, "analysis-1", nil))
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != "completed" || completed.Progress != 100 {
		t.Fatalf("completed = %#v", completed)
	}
	if completed.MosooThreadID == nil || *completed.MosooThreadID != "01KTESTTHREAD000000000000000" {
		t.Fatalf("mosoo thread = %v", completed.MosooThreadID)
	}
	if len(completed.Activities) != 1 || completed.Activities[0].Kind != "inspecting_docs" {
		t.Fatalf("activities = %#v", completed.Activities)
	}

	assessment, err := store.GetProjectAssessment(ctx, "OWNER/USEFUL-TOOL")
	if err != nil {
		t.Fatal(err)
	}
	if assessment == nil || assessment.RepoKey != "owner/useful-tool" ||
		assessment.ProductScore != 87 || !assessment.TreasureEligible || assessment.ClassicEligible ||
		assessment.ReportMarkdown != "# Useful Tool\n\nA useful project." ||
		assessment.ProjectType != "micro_tool" || assessment.ExposureBand != "low" {
		t.Fatalf("assessment = %#v", assessment)
	}
	if assessment.Analysis == nil || assessment.Analysis.Scores.ProductScore != 87 {
		t.Fatalf("assessment analysis = %#v", assessment.Analysis)
	}

	treasure, err := store.ListProjectBoard(ctx, ProjectBoardTreasure, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(treasure) != 1 || treasure[0].RepoKey != "owner/useful-tool" {
		t.Fatalf("treasure board = %#v", treasure)
	}
	classic, err := store.ListProjectBoard(ctx, ProjectBoardClassic, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(classic) != 0 {
		t.Fatalf("classic board = %#v", classic)
	}

	reusable, err := store.FindReusableCompletedProjectAnalysisRun(ctx, ReusableProjectAnalysisRunInput{
		RepoKey:       "OWNER/USEFUL-TOOL",
		SchemaVersion: ProjectAnalysisSchemaVersion,
		RubricVersion: ProjectRubricVersion,
		AgentVersion:  ProjectAgentVersion,
		SkillVersion:  ProjectSkillVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	if reusable == nil || reusable.ID != "analysis-1" || reusable.Status != "completed" {
		t.Fatalf("reusable = %#v", reusable)
	}
	ref := "main"
	missing, err := store.FindReusableCompletedProjectAnalysisRun(ctx, ReusableProjectAnalysisRunInput{
		RepoKey:       "owner/useful-tool",
		RequestedRef:  &ref,
		SchemaVersion: ProjectAnalysisSchemaVersion,
		RubricVersion: ProjectRubricVersion,
		AgentVersion:  ProjectAgentVersion,
		SkillVersion:  ProjectSkillVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	if missing != nil {
		t.Fatalf("ref-scoped reuse = %#v", missing)
	}

	// Terminal runs ignore further state updates.
	if err := store.UpdateProjectAnalysisState(ctx, UpdateProjectAnalysisStateInput{
		AnalysisID: "analysis-1", Status: "running", Phase: "inspecting", Progress: 10,
	}); err != nil {
		t.Fatal(err)
	}
	run, err := store.GetProjectAnalysisRun(ctx, "analysis-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != "completed" || run.Progress != 100 {
		t.Fatalf("post-terminal update run = %#v", run)
	}
}

func TestFinalizeGraduatesTreasureWhenExposureMatures(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	ctx := context.Background()
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if _, err := store.FinalizeProjectAnalysis(ctx, finalizeInput(t, "analysis-1", nil)); err != nil {
		t.Fatal(err)
	}

	ref := "main"
	createTestRun(t, store, "analysis-2", "owner/useful-tool", &ref)
	established := finalizeInput(t, "analysis-2", func(analysis, evidence map[string]any) {
		analysis["repository"].(map[string]any)["requested_ref"] = "main"
		analysis["confidence"] = 82
		analysis["project"].(map[string]any)["lifecycle"] = "stable_maintenance"
		analysis["exposure"].(map[string]any)["band"] = "established"
	})
	if _, err := store.FinalizeProjectAnalysis(ctx, established); err != nil {
		t.Fatal(err)
	}

	assessment, err := store.GetProjectAssessment(ctx, "owner/useful-tool")
	if err != nil {
		t.Fatal(err)
	}
	if assessment.TreasureEligible || !assessment.ClassicEligible || assessment.ExposureBand != "established" {
		t.Fatalf("assessment = %#v", assessment)
	}
	history, err := store.ListTreasureHistory(ctx, "owner/useful-tool")
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].Status != "graduated" || history[0].GraduatedAt == nil {
		t.Fatalf("history = %#v", history)
	}
	if history[0].ProductScoreSnapshot != 87 || history[0].ExposureSnapshot != "low" {
		t.Fatalf("snapshot = %#v", history[0])
	}
	if !strings.Contains(history[0].Reason, "产品价值 87") {
		t.Fatalf("reason = %q", history[0].Reason)
	}
}

func TestReserveExecutionSlotBoundsConcurrency(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	ctx := context.Background()
	createTestRun(t, store, "slot-1", "owner/slot-one", nil)
	createTestRun(t, store, "slot-2", "owner/slot-two", nil)

	reserved, err := store.ReserveProjectAnalysisExecutionSlot(ctx, "slot-1", 1, 30*time.Second)
	if err != nil || !reserved {
		t.Fatalf("first reservation = %v, %v", reserved, err)
	}
	reserved, err = store.ReserveProjectAnalysisExecutionSlot(ctx, "slot-2", 1, 30*time.Second)
	if err != nil || reserved {
		t.Fatalf("second reservation = %v, %v", reserved, err)
	}
	run, err := store.GetProjectAnalysisRun(ctx, "slot-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != "creating_thread" || run.CreateAttempts != 1 || run.CreateRetryAt == nil || run.StartedAt == nil {
		t.Fatalf("reserved run = %#v", run)
	}
	if err := store.FailProjectAnalysis(ctx, "slot-1", "test_complete", "Test slot released.", "", nil); err != nil {
		t.Fatal(err)
	}
	reserved, err = store.ReserveProjectAnalysisExecutionSlot(ctx, "slot-2", 1, 30*time.Second)
	if err != nil || !reserved {
		t.Fatalf("post-release reservation = %v, %v", reserved, err)
	}
	if err := store.FailProjectAnalysis(ctx, "slot-2", "test_complete", "Test slot released.", "", nil); err != nil {
		t.Fatal(err)
	}
}

func TestScheduleCreateRetryReleasesSlotWhileBackingOff(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	ctx := context.Background()
	createTestRun(t, store, "retry-slot-1", "owner/retry-slot-one", nil)
	createTestRun(t, store, "retry-slot-2", "owner/retry-slot-two", nil)

	reserved, err := store.ReserveProjectAnalysisExecutionSlot(ctx, "retry-slot-1", 1, 30*time.Second)
	if err != nil || !reserved {
		t.Fatalf("reservation = %v, %v", reserved, err)
	}
	scheduled, err := store.ScheduleProjectAnalysisCreateRetry(ctx, "retry-slot-1", time.Now().Add(time.Minute).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if scheduled == nil || scheduled.Status != "queued" || scheduled.CreateAttempts != 1 ||
		scheduled.CreateRetryAt == nil || *scheduled.CreateRetryAt <= time.Now().UnixMilli() {
		t.Fatalf("scheduled = %#v", scheduled)
	}
	reserved, err = store.ReserveProjectAnalysisExecutionSlot(ctx, "retry-slot-1", 1, 30*time.Second)
	if err != nil || reserved {
		t.Fatalf("backing-off reservation = %v, %v", reserved, err)
	}
	reserved, err = store.ReserveProjectAnalysisExecutionSlot(ctx, "retry-slot-2", 1, 30*time.Second)
	if err != nil || !reserved {
		t.Fatalf("sibling reservation = %v, %v", reserved, err)
	}
}

func TestFailReleasesActiveKeyAndTruncatesMessage(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	ctx := context.Background()
	run, created := createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if !created {
		t.Fatal("expected created run")
	}
	longMessage := strings.Repeat("错", 2_500)
	if err := store.FailProjectAnalysis(ctx, run.ID, "artifact_invalid", longMessage, "", nil); err != nil {
		t.Fatal(err)
	}
	failed, err := store.GetProjectAnalysisRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if failed.Status != "failed" || failed.ErrorCode == nil || *failed.ErrorCode != "artifact_invalid" ||
		failed.ErrorMessage == nil || len([]rune(*failed.ErrorMessage)) != 2_000 || failed.CompletedAt == nil {
		t.Fatalf("failed run = %#v", failed)
	}
	// The released active key lets an identical request create a fresh run.
	if _, created := createTestRun(t, store, "analysis-2", "owner/useful-tool", nil); !created {
		t.Fatal("active key was not released by fail")
	}
}

func TestPrepareRunRetryRequeuesWithFreshIdempotencyKey(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	ctx := context.Background()
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if err := store.AttachMosooThread(ctx, AttachMosooThreadInput{
		AnalysisID: "analysis-1", AgentID: "agent", ThreadID: "thread-1", RunID: "run-1",
	}); err != nil {
		t.Fatal(err)
	}

	// A mismatched thread id must not touch the run.
	unchanged, err := store.PrepareProjectAnalysisRetry(ctx, "analysis-1", "thread-other", "ghfind-project-analysis-1-retry-1")
	if err != nil || unchanged != nil {
		t.Fatalf("mismatched retry = %#v, %v", unchanged, err)
	}
	requeued, err := store.PrepareProjectAnalysisRetry(ctx, "analysis-1", "thread-1", "ghfind-project-analysis-1-retry-1")
	if err != nil {
		t.Fatal(err)
	}
	if requeued == nil || requeued.Status != "queued" || requeued.MosooThreadID != nil ||
		requeued.IdempotencyKey != "ghfind-project-analysis-1-retry-1" || requeued.CreateAttempts != 0 {
		t.Fatalf("requeued = %#v", requeued)
	}
	expectedKey := ProjectAnalysisActiveKey("owner/useful-tool", nil, ProjectRubricVersion)
	var storedKey string
	if err := store.db.QueryRow(`SELECT active_key FROM project_analysis_runs WHERE id = 'analysis-1'`).Scan(&storedKey); err != nil {
		t.Fatal(err)
	}
	if storedKey != expectedKey {
		t.Fatalf("active key = %q, want %q", storedKey, expectedKey)
	}
}

func TestReconciliableRunsCandidateQuery(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	ctx := context.Background()
	createTestRun(t, store, "run-queued", "owner/queued", nil)
	createTestRun(t, store, "run-backing-off", "owner/backing-off", nil)
	createTestRun(t, store, "run-running", "owner/running", nil)
	createTestRun(t, store, "run-failed", "owner/failed", nil)

	if _, err := store.db.Exec(
		`UPDATE project_analysis_runs SET create_retry_at = ? WHERE id = 'run-backing-off'`,
		time.Now().Add(time.Hour).UnixMilli(),
	); err != nil {
		t.Fatal(err)
	}
	if err := store.AttachMosooThread(ctx, AttachMosooThreadInput{
		AnalysisID: "run-running", AgentID: "agent", ThreadID: "thread-1", RunID: "run-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.FailProjectAnalysis(ctx, "run-failed", "test", "done", "", nil); err != nil {
		t.Fatal(err)
	}

	runs, err := store.ListReconciliableProjectAnalysisRuns(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, run := range runs {
		ids = append(ids, run.ID)
	}
	expected := map[string]bool{"run-queued": true, "run-running": true}
	if len(ids) != len(expected) {
		t.Fatalf("reconciliable ids = %v", ids)
	}
	for _, id := range ids {
		if !expected[id] {
			t.Fatalf("unexpected reconciliable run %q in %v", id, ids)
		}
	}

	// A due retry becomes a candidate again.
	if _, err := store.db.Exec(
		`UPDATE project_analysis_runs SET create_retry_at = ? WHERE id = 'run-backing-off'`,
		time.Now().Add(-time.Minute).UnixMilli(),
	); err != nil {
		t.Fatal(err)
	}
	runs, err = store.ListReconciliableProjectAnalysisRuns(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 3 {
		t.Fatalf("reconciliable after due retry = %d", len(runs))
	}

	// updated_at ASC is the drain order; pin distinct values to verify it.
	now := time.Now().UnixMilli()
	for index, id := range []string{"run-running", "run-queued", "run-backing-off"} {
		if _, err := store.db.Exec(
			`UPDATE project_analysis_runs SET updated_at = ? WHERE id = ?`,
			now+int64(index)*1_000, id,
		); err != nil {
			t.Fatal(err)
		}
	}
	runs, err = store.ListReconciliableProjectAnalysisRuns(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	order := []string{runs[0].ID, runs[1].ID, runs[2].ID}
	if order[0] != "run-running" || order[1] != "run-queued" || order[2] != "run-backing-off" {
		t.Fatalf("updated_at ASC order = %v", order)
	}
}

func TestListProjectBoardOrdersAndClamps(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	ctx := context.Background()
	for index, confidence := range []int{70, 90, 80} {
		id := fmt.Sprintf("analysis-%d", index)
		repoKey := fmt.Sprintf("owner/treasure-%d", index)
		createTestRun(t, store, id, repoKey, nil)
		input := finalizeInput(t, id, func(analysis, evidence map[string]any) {
			analysis["repository"].(map[string]any)["repo_key"] = repoKey
			analysis["repository"].(map[string]any)["canonical_url"] = "https://github.com/" + repoKey
			evidence["repo_key"] = repoKey
			analysis["confidence"] = confidence
		})
		if _, err := store.FinalizeProjectAnalysis(ctx, input); err != nil {
			t.Fatal(err)
		}
	}

	board, err := store.ListProjectBoard(ctx, ProjectBoardTreasure, 500, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(board) != 3 {
		t.Fatalf("board size = %d", len(board))
	}
	// Equal product scores order by confidence DESC.
	confidences := []int{int(board[0].Confidence), int(board[1].Confidence), int(board[2].Confidence)}
	if confidences[0] != 90 || confidences[1] != 80 || confidences[2] != 70 {
		t.Fatalf("confidence order = %v", confidences)
	}
	limited, err := store.ListProjectBoard(ctx, ProjectBoardTreasure, 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited) != 2 || int(limited[0].Confidence) != 80 {
		t.Fatalf("limited board = %#v", limited)
	}
}

func TestReconcileStoredProjectEligibilityRespectsManualRemoval(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	ctx := context.Background()
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if _, err := store.FinalizeProjectAnalysis(ctx, finalizeInput(t, "analysis-1", nil)); err != nil {
		t.Fatal(err)
	}
	// An admin removes the repo from the treasure board; the stored flag is
	// cleared and the entry marked removed.
	if _, err := store.db.ExecContext(ctx, `UPDATE project_assessments SET treasure_eligible = 0 WHERE repo_key = ?`, "owner/useful-tool"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE treasure_entries SET status = 'removed', removed_at = ?, removed_reason = 'manual' WHERE repo_key = ?`, time.Now().UnixMilli(), "owner/useful-tool"); err != nil {
		t.Fatal(err)
	}

	if err := store.reconcileStoredProjectEligibility(ctx); err != nil {
		t.Fatal(err)
	}
	assessment, err := store.GetProjectAssessment(ctx, "owner/useful-tool")
	if err != nil {
		t.Fatal(err)
	}
	if assessment.TreasureEligible {
		t.Fatal("manually removed repo regained treasure eligibility")
	}
	var activeEntries int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM treasure_entries WHERE repo_key = ? AND status = 'active'`, "owner/useful-tool").Scan(&activeEntries); err != nil {
		t.Fatal(err)
	}
	if activeEntries != 0 {
		t.Fatalf("reconcile re-created an active treasure entry for a removed repo: %d", activeEntries)
	}
}
