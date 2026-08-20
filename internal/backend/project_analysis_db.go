package backend

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// This file mirrors the persistence contract of src/lib/project-analysis-db.ts
// against the existing Turso database. It never creates tables: the Next
// runtime owns the schema, so the Go side only reads and writes rows.

type ProjectBoard = string

const (
	ProjectBoardTreasure ProjectBoard = "treasure"
	ProjectBoardClassic  ProjectBoard = "classic"
	ProjectBoardAll      ProjectBoard = "all"
)

var ErrProjectAnalysisRunNotFound = errors.New("project analysis run not found")

// ProjectAnalysisRun mirrors the run record mapped by mapRun in the
// TypeScript persistence layer. Timestamps are Unix milliseconds.
type ProjectAnalysisRun struct {
	ID                string
	RepoKey           string
	CanonicalURL      string
	RequestedRef      *string
	ResolvedCommitSHA *string
	IdempotencyKey    string
	Status            ProjectAnalysisStatus
	Phase             string
	Progress          int
	Activities        []ProjectAnalysisActivity
	MosooAgentID      *string
	MosooThreadID     *string
	MosooRunID        *string
	SchemaVersion     string
	RubricVersion     string
	AgentVersion      string
	SkillVersion      string
	VerificationLevel *string
	ErrorCode         *string
	ErrorMessage      *string
	CreateAttempts    int
	CreateRetryAt     *int64
	CreatedAt         int64
	UpdatedAt         int64
	StartedAt         *int64
	CompletedAt       *int64
}

type ProjectAssessment struct {
	RepoKey            string
	LatestAnalysisID   string
	ProjectType        string
	Lifecycle          string
	ProductScore       float64
	PainScore          float64
	EffectivenessScore float64
	ExperienceScore    float64
	ValueDensityScore  float64
	CommunityStrength  float64
	Confidence         float64
	VerificationLevel  string
	Unknowns           []string
	Risks              []ProjectRisk
	ExposureBand       string
	Stars              *int64
	TreasureEligible   bool
	ClassicEligible    bool
	ResolvedCommitSHA  string
	AnalyzedAt         int64
	UpdatedAt          int64
	Analysis           *ProjectAnalysisArtifact
	ReportMarkdown     string
}

type TreasureHistoryEntry struct {
	ID                        string
	RepoKey                   string
	AnalysisID                string
	Status                    string
	SelectedAt                int64
	ProductScoreSnapshot      float64
	ConfidenceSnapshot        float64
	VerificationLevelSnapshot string
	StarsSnapshot             *int64
	ExposureSnapshot          string
	Reason                    string
	ResolvedCommitSHA         string
	GraduatedAt               *int64
	RemovedAt                 *int64
	RemovedReason             *string
}

type CreateProjectAnalysisRunInput struct {
	ID            string
	RepoKey       string
	CanonicalURL  string
	RequestedRef  *string
	SchemaVersion string
	RubricVersion string
	AgentVersion  string
	SkillVersion  string
}

type ReusableProjectAnalysisRunInput struct {
	RepoKey       string
	RequestedRef  *string
	SchemaVersion string
	RubricVersion string
	AgentVersion  string
	SkillVersion  string
}

type AttachMosooThreadInput struct {
	AnalysisID string
	AgentID    string
	ThreadID   string
	RunID      string
}

type UpdateProjectAnalysisStateInput struct {
	AnalysisID string
	Status     ProjectAnalysisStatus
	Phase      string
	Progress   int
	RunID      *string
	Activities []ProjectAnalysisActivity
}

type FinalizeProjectAnalysisInput struct {
	AnalysisID     string
	Analysis       *ProjectAnalysisArtifact
	AnalysisJSON   string
	EvidenceJSON   string
	ReportMarkdown string
	Hashes         ProjectAnalysisArtifactHashes
}

type ProjectAnalysisArtifactHashes struct {
	Analysis string
	Evidence string
	Report   string
}

// projectAnalysisRunColumns keeps every run query independent of the physical
// column order of the Next-owned table.
const projectAnalysisRunColumns = `id, repo_key, canonical_url, requested_ref, resolved_commit_sha,
	idempotency_key, status, phase, progress, activities_json,
	mosoo_agent_id, mosoo_thread_id, mosoo_run_id,
	schema_version, rubric_version, agent_version, skill_version,
	verification_level, error_code, error_message,
	create_attempts, create_retry_at, created_at, updated_at, started_at, completed_at`

// projectAnalysisRunColumnsPrefixed is the same column list qualified for the
// reuse join against project_assessments.
const projectAnalysisRunColumnsPrefixed = `pr.id, pr.repo_key, pr.canonical_url, pr.requested_ref, pr.resolved_commit_sha,
	pr.idempotency_key, pr.status, pr.phase, pr.progress, pr.activities_json,
	pr.mosoo_agent_id, pr.mosoo_thread_id, pr.mosoo_run_id,
	pr.schema_version, pr.rubric_version, pr.agent_version, pr.skill_version,
	pr.verification_level, pr.error_code, pr.error_message,
	pr.create_attempts, pr.create_retry_at, pr.created_at, pr.updated_at, pr.started_at, pr.completed_at`

// projectAnalysisTerminalStatuses cannot be transitioned out of.
const projectAnalysisTerminalStatuses = "'completed', 'failed', 'cancelled', 'expired'"

func scanProjectAnalysisRun(scanner rowScanner) (*ProjectAnalysisRun, error) {
	var (
		run               ProjectAnalysisRun
		requestedRef      sql.NullString
		resolvedCommitSHA sql.NullString
		activitiesJSON    string
		mosooAgentID      sql.NullString
		mosooThreadID     sql.NullString
		mosooRunID        sql.NullString
		verificationLevel sql.NullString
		errorCode         sql.NullString
		errorMessage      sql.NullString
		createRetryAt     sql.NullInt64
		startedAt         sql.NullInt64
		completedAt       sql.NullInt64
	)
	err := scanner.Scan(
		&run.ID, &run.RepoKey, &run.CanonicalURL, &requestedRef, &resolvedCommitSHA,
		&run.IdempotencyKey, &run.Status, &run.Phase, &run.Progress, &activitiesJSON,
		&mosooAgentID, &mosooThreadID, &mosooRunID,
		&run.SchemaVersion, &run.RubricVersion, &run.AgentVersion, &run.SkillVersion,
		&verificationLevel, &errorCode, &errorMessage,
		&run.CreateAttempts, &createRetryAt, &run.CreatedAt, &run.UpdatedAt, &startedAt, &completedAt,
	)
	if err != nil {
		return nil, err
	}
	run.RequestedRef = nullableString(requestedRef)
	run.ResolvedCommitSHA = nullableString(resolvedCommitSHA)
	run.MosooAgentID = nullableString(mosooAgentID)
	run.MosooThreadID = nullableString(mosooThreadID)
	run.MosooRunID = nullableString(mosooRunID)
	run.VerificationLevel = nullableString(verificationLevel)
	run.ErrorCode = nullableString(errorCode)
	run.ErrorMessage = nullableString(errorMessage)
	run.CreateRetryAt = nullableInt64(createRetryAt)
	run.StartedAt = nullableInt64(startedAt)
	run.CompletedAt = nullableInt64(completedAt)
	// A malformed activities payload must not block state reads; mirror the
	// TypeScript fallback to an empty activity list.
	run.Activities = []ProjectAnalysisActivity{}
	if trimmed := strings.TrimSpace(activitiesJSON); trimmed != "" {
		var activities []ProjectAnalysisActivity
		if err := json.Unmarshal([]byte(trimmed), &activities); err == nil && activities != nil {
			run.Activities = activities
		}
	}
	return &run, nil
}

func nullableInt64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func (s *TursoStore) selectProjectAnalysisRun(ctx context.Context, analysisID string) (*ProjectAnalysisRun, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+projectAnalysisRunColumns+` FROM project_analysis_runs WHERE id = ? LIMIT 1`, analysisID)
	run, err := scanProjectAnalysisRun(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("select project analysis run: %w", err)
	}
	return run, nil
}

// CreateProjectAnalysisRun mirrors createProjectAnalysisRun: INSERT OR IGNORE
// keyed by active_key guarantees at most one non-terminal run per repository,
// ref, and rubric. created reports whether this call inserted the row.
func (s *TursoStore) CreateProjectAnalysisRun(ctx context.Context, input CreateProjectAnalysisRunInput) (*ProjectAnalysisRun, bool, error) {
	now := time.Now().UnixMilli()
	key := ProjectAnalysisActiveKey(input.RepoKey, input.RequestedRef, input.RubricVersion)
	idempotencyKey := "ghfind-project-" + input.ID
	result, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO project_analysis_runs (
			id, repo_key, canonical_url, requested_ref, active_key,
			idempotency_key, status, phase, progress,
			schema_version, rubric_version, agent_version, skill_version,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, ?, ?, ?, ?, ?)`,
		input.ID,
		strings.ToLower(input.RepoKey),
		input.CanonicalURL,
		input.RequestedRef,
		key,
		idempotencyKey,
		input.SchemaVersion,
		input.RubricVersion,
		input.AgentVersion,
		input.SkillVersion,
		now,
		now,
	)
	if err != nil {
		return nil, false, fmt.Errorf("insert project analysis run: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, false, fmt.Errorf("read project analysis run rows affected: %w", err)
	}
	row := s.db.QueryRowContext(ctx,
		`SELECT `+projectAnalysisRunColumns+` FROM project_analysis_runs WHERE active_key = ? LIMIT 1`, key)
	run, err := scanProjectAnalysisRun(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, fmt.Errorf("failed to create or find analysis run")
	}
	if err != nil {
		return nil, false, fmt.Errorf("select project analysis run by active key: %w", err)
	}
	return run, affected == 1, nil
}

func (s *TursoStore) GetProjectAnalysisRun(ctx context.Context, analysisID string) (*ProjectAnalysisRun, error) {
	return s.selectProjectAnalysisRun(ctx, analysisID)
}

// FindReusableCompletedProjectAnalysisRun mirrors
// findReusableCompletedProjectAnalysisRun: a completed run is only reusable
// when a current assessment still points at it and every artifact is stored.
func (s *TursoStore) FindReusableCompletedProjectAnalysisRun(ctx context.Context, input ReusableProjectAnalysisRunInput) (*ProjectAnalysisRun, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+projectAnalysisRunColumnsPrefixed+`
		FROM project_analysis_runs AS pr
		JOIN project_assessments AS pa ON pa.latest_analysis_id = pr.id
		WHERE pr.repo_key = ?
		  AND (pr.requested_ref = ? OR (pr.requested_ref IS NULL AND ? IS NULL))
		  AND pr.schema_version = ?
		  AND pr.rubric_version = ?
		  AND pr.agent_version = ?
		  AND pr.skill_version = ?
		  AND pr.status = 'completed'
		  AND pr.analysis_json IS NOT NULL
		  AND pr.report_markdown IS NOT NULL
		  AND pr.evidence_json IS NOT NULL
		ORDER BY pr.completed_at DESC
		LIMIT 1`,
		strings.ToLower(input.RepoKey),
		input.RequestedRef,
		input.RequestedRef,
		input.SchemaVersion,
		input.RubricVersion,
		input.AgentVersion,
		input.SkillVersion,
	)
	if err != nil {
		return nil, fmt.Errorf("find reusable project analysis run: %w", err)
	}
	defer rows.Close()
	if rows.Next() {
		run, err := scanProjectAnalysisRun(rows)
		if err != nil {
			return nil, fmt.Errorf("scan reusable project analysis run: %w", err)
		}
		return run, nil
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("find reusable project analysis run: %w", err)
	}
	return nil, nil
}

// ReserveProjectAnalysisExecutionSlot mirrors reserveProjectAnalysisExecutionSlot,
// including the create-thread lease reclaim branch.
func (s *TursoStore) ReserveProjectAnalysisExecutionSlot(ctx context.Context, analysisID string, maximumConcurrentRuns int, leaseDuration time.Duration) (bool, error) {
	current, err := s.selectProjectAnalysisRun(ctx, analysisID)
	if err != nil {
		return false, err
	}
	if current == nil {
		return false, ErrProjectAnalysisRunNotFound
	}
	now := time.Now().UnixMilli()
	leaseUntil := now + maxInt64(1_000, leaseDuration.Milliseconds())

	if current.Status == ProjectAnalysisStatusCreatingThread && current.MosooThreadID == nil {
		if current.CreateRetryAt != nil && *current.CreateRetryAt > now {
			return false, nil
		}
		reclaimed, err := s.db.ExecContext(ctx,
			`UPDATE project_analysis_runs
			SET create_attempts = create_attempts + 1, create_retry_at = ?, updated_at = ?
			WHERE id = ? AND status = 'creating_thread' AND mosoo_thread_id IS NULL
			  AND (create_retry_at IS NULL OR create_retry_at <= ?)`,
			leaseUntil, now, analysisID, now,
		)
		if err != nil {
			return false, fmt.Errorf("reclaim project analysis create slot: %w", err)
		}
		affected, err := reclaimed.RowsAffected()
		if err != nil {
			return false, fmt.Errorf("read reclaim rows affected: %w", err)
		}
		return affected == 1, nil
	}
	if current.Status != ProjectAnalysisStatusQueued {
		return false, nil
	}

	result, err := s.db.ExecContext(ctx,
		`UPDATE project_analysis_runs
		SET status = 'creating_thread', phase = 'creating_thread', progress = 5,
		    create_attempts = create_attempts + 1, create_retry_at = ?,
		    started_at = COALESCE(started_at, ?), updated_at = ?
		WHERE id = ? AND status = 'queued'
		  AND (create_retry_at IS NULL OR create_retry_at <= ?)
		  AND (
		    SELECT COUNT(*) FROM project_analysis_runs
		    WHERE status IN ('creating_thread', 'running', 'finalizing')
		  ) < ?`,
		leaseUntil,
		now,
		now,
		analysisID,
		now,
		maxInt(1, maximumConcurrentRuns),
	)
	if err != nil {
		return false, fmt.Errorf("reserve project analysis execution slot: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read reservation rows affected: %w", err)
	}
	return affected == 1, nil
}

// ScheduleProjectAnalysisCreateRetry parks a create-thread attempt back into
// the queue until nextRetryAt, mirroring scheduleProjectAnalysisCreateRetry.
func (s *TursoStore) ScheduleProjectAnalysisCreateRetry(ctx context.Context, analysisID string, nextRetryAt int64) (*ProjectAnalysisRun, error) {
	now := time.Now().UnixMilli()
	result, err := s.db.ExecContext(ctx,
		`UPDATE project_analysis_runs
		SET status = 'queued', phase = 'queued', progress = 0,
		    create_retry_at = ?, updated_at = ?
		WHERE id = ? AND status = 'creating_thread' AND mosoo_thread_id IS NULL`,
		maxInt64(now, nextRetryAt), now, analysisID,
	)
	if err != nil {
		return nil, fmt.Errorf("schedule project analysis create retry: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("read schedule rows affected: %w", err)
	}
	if affected != 1 {
		return nil, nil
	}
	return s.selectProjectAnalysisRun(ctx, analysisID)
}

// AttachMosooThread mirrors attachMosooThread: the run starts running with
// classifying as its first phase.
func (s *TursoStore) AttachMosooThread(ctx context.Context, input AttachMosooThreadInput) error {
	now := time.Now().UnixMilli()
	result, err := s.db.ExecContext(ctx,
		`UPDATE project_analysis_runs
		SET status = 'running', phase = 'classifying', progress = 10,
		    mosoo_agent_id = ?, mosoo_thread_id = ?, mosoo_run_id = ?,
		    create_retry_at = NULL,
		    started_at = COALESCE(started_at, ?), updated_at = ?
		WHERE id = ? AND status IN ('queued', 'creating_thread', 'running')`,
		input.AgentID, input.ThreadID, input.RunID, now, now, input.AnalysisID,
	)
	if err != nil {
		return fmt.Errorf("attach Mosoo thread: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read attach rows affected: %w", err)
	}
	if affected != 1 {
		return fmt.Errorf("analysis run cannot accept a Mosoo Thread")
	}
	return nil
}

// PrepareProjectAnalysisRetry requeues a stuck running or failed run under a
// fresh idempotency key, mirroring prepareProjectAnalysisRetry.
func (s *TursoStore) PrepareProjectAnalysisRetry(ctx context.Context, analysisID, expectedThreadID, nextIdempotencyKey string) (*ProjectAnalysisRun, error) {
	current, err := s.selectProjectAnalysisRun(ctx, analysisID)
	if err != nil {
		return nil, err
	}
	if current == nil || current.MosooThreadID == nil || *current.MosooThreadID != expectedThreadID {
		return nil, nil
	}
	now := time.Now().UnixMilli()
	result, err := s.db.ExecContext(ctx,
		`UPDATE project_analysis_runs
		SET active_key = ?, idempotency_key = ?, status = 'queued',
		    phase = 'queued', progress = 0,
		    create_attempts = 0, create_retry_at = NULL,
		    mosoo_thread_id = NULL, mosoo_run_id = NULL,
		    activities_json = '[]',
		    error_code = NULL, error_message = NULL, completed_at = NULL,
		    updated_at = ?
		WHERE id = ? AND mosoo_thread_id = ?
		  AND status IN ('running', 'failed')`,
		ProjectAnalysisActiveKey(current.RepoKey, current.RequestedRef, current.RubricVersion),
		nextIdempotencyKey,
		now,
		analysisID,
		expectedThreadID,
	)
	if err != nil {
		return nil, fmt.Errorf("prepare project analysis retry: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("read retry rows affected: %w", err)
	}
	if affected != 1 {
		return nil, nil
	}
	return s.selectProjectAnalysisRun(ctx, analysisID)
}

// UpdateProjectAnalysisState mirrors updateProjectAnalysisState, including the
// terminal-state guard and progress clamping.
func (s *TursoStore) UpdateProjectAnalysisState(ctx context.Context, input UpdateProjectAnalysisStateInput) error {
	var activitiesJSON *string
	if input.Activities != nil {
		encoded, err := json.Marshal(input.Activities)
		if err != nil {
			return fmt.Errorf("encode project analysis activities: %w", err)
		}
		text := string(encoded)
		activitiesJSON = &text
	}
	progress := maxInt(0, minInt(100, input.Progress))
	_, err := s.db.ExecContext(ctx,
		`UPDATE project_analysis_runs
		SET status = ?, phase = ?, progress = ?,
		    mosoo_run_id = COALESCE(?, mosoo_run_id),
		    activities_json = COALESCE(?, activities_json), updated_at = ?
		WHERE id = ? AND status NOT IN (`+projectAnalysisTerminalStatuses+`)`,
		input.Status,
		input.Phase,
		progress,
		input.RunID,
		activitiesJSON,
		time.Now().UnixMilli(),
		input.AnalysisID,
	)
	if err != nil {
		return fmt.Errorf("update project analysis state: %w", err)
	}
	return nil
}

// FailProjectAnalysis mirrors failProjectAnalysis: the active key is released
// so a fresh run can be created, and the message is truncated to 2000 runes.
func (s *TursoStore) FailProjectAnalysis(ctx context.Context, analysisID, errorCode, errorMessage, status string, activities []ProjectAnalysisActivity) error {
	if status == "" {
		status = ProjectAnalysisStatusFailed
	}
	var activitiesJSON *string
	if activities != nil {
		encoded, err := json.Marshal(activities)
		if err != nil {
			return fmt.Errorf("encode project analysis activities: %w", err)
		}
		text := string(encoded)
		activitiesJSON = &text
	}
	if utf8.RuneCountInString(errorMessage) > projectErrorMessageMaxLength {
		runes := []rune(errorMessage)
		errorMessage = string(runes[:projectErrorMessageMaxLength])
	}
	now := time.Now().UnixMilli()
	_, err := s.db.ExecContext(ctx,
		`UPDATE project_analysis_runs
		SET status = ?, active_key = NULL, error_code = ?, error_message = ?,
		    activities_json = COALESCE(?, activities_json),
		    create_retry_at = NULL, completed_at = ?, updated_at = ?
		WHERE id = ? AND status NOT IN (`+projectAnalysisTerminalStatuses+`)`,
		status,
		errorCode,
		errorMessage,
		activitiesJSON,
		now,
		now,
		analysisID,
	)
	if err != nil {
		return fmt.Errorf("fail project analysis: %w", err)
	}
	return nil
}

func treasureReason(analysis *ProjectAnalysisArtifact) string {
	return fmt.Sprintf("%s 产品价值 %d，%s",
		analysis.Project.Summary, analysis.Scores.ProductScore, analysis.Exposure.Rationale)
}

// newTreasureEntryID produces a random opaque identifier like the TypeScript
// randomUUID call; the value is never parsed.
func newTreasureEntryID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", fmt.Errorf("generate treasure entry id: %w", err)
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(id[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}

// FinalizeProjectAnalysis mirrors finalizeProjectAnalysis: the assessment
// upsert, the treasure insert or graduation, and the run completion write are
// one transaction. Redelivery is safe because a completed run returns as-is.
func (s *TursoStore) FinalizeProjectAnalysis(ctx context.Context, input FinalizeProjectAnalysisInput) (*ProjectAnalysisRun, error) {
	run, err := s.selectProjectAnalysisRun(ctx, input.AnalysisID)
	if err != nil {
		return nil, err
	}
	if run == nil {
		return nil, ErrProjectAnalysisRunNotFound
	}
	if run.Status == ProjectAnalysisStatusCompleted {
		return run, nil
	}
	if run.Status == ProjectAnalysisStatusFailed ||
		run.Status == ProjectAnalysisStatusCancelled ||
		run.Status == ProjectAnalysisStatusExpired {
		return nil, fmt.Errorf("terminal analysis run cannot be finalized")
	}

	now := time.Now().UnixMilli()
	analysis := input.Analysis
	eligibility := DeriveProjectBoardEligibility(analysis)
	analyzedAt, err := time.Parse(time.RFC3339Nano, analysis.AnalyzedAt)
	if err != nil {
		return nil, artifactErrorf("analyzed_at must be an ISO 8601 datetime with offset")
	}
	repoKey := strings.ToLower(analysis.Repository.RepoKey)
	unknownsJSON, err := json.Marshal(analysis.Unknowns)
	if err != nil {
		return nil, fmt.Errorf("encode analysis unknowns: %w", err)
	}
	risksJSON, err := json.Marshal(analysis.Risks)
	if err != nil {
		return nil, fmt.Errorf("encode analysis risks: %w", err)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin project analysis finalization: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.ExecContext(ctx,
		`INSERT INTO project_assessments (
			repo_key, latest_analysis_id, project_type, lifecycle,
			product_score, pain_score, effectiveness_score, experience_score,
			value_density_score, confidence, verification_level,
			community_strength, unknowns_json, risks_json, exposure_band, stars,
			treasure_eligible, classic_eligible, resolved_commit_sha,
			rubric_version, analyzed_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(repo_key) DO UPDATE SET
			latest_analysis_id = excluded.latest_analysis_id,
			project_type = excluded.project_type,
			lifecycle = excluded.lifecycle,
			product_score = excluded.product_score,
			pain_score = excluded.pain_score,
			effectiveness_score = excluded.effectiveness_score,
			experience_score = excluded.experience_score,
			value_density_score = excluded.value_density_score,
			community_strength = excluded.community_strength,
			confidence = excluded.confidence,
			verification_level = excluded.verification_level,
			unknowns_json = excluded.unknowns_json,
			risks_json = excluded.risks_json,
			exposure_band = excluded.exposure_band,
			stars = excluded.stars,
			treasure_eligible = excluded.treasure_eligible,
			classic_eligible = excluded.classic_eligible,
			resolved_commit_sha = excluded.resolved_commit_sha,
			rubric_version = excluded.rubric_version,
			analyzed_at = excluded.analyzed_at,
			updated_at = excluded.updated_at`,
		repoKey,
		input.AnalysisID,
		analysis.Project.ProjectType,
		analysis.Project.Lifecycle,
		analysis.Scores.ProductScore,
		analysis.Scores.Pain.Score,
		analysis.Scores.Effectiveness.Score,
		analysis.Scores.Experience.Score,
		analysis.Scores.ValueDensity.Score,
		analysis.Confidence,
		analysis.VerificationLevel,
		analysis.CommunityStrength.Score,
		string(unknownsJSON),
		string(risksJSON),
		analysis.Exposure.Band,
		analysis.Exposure.Stars,
		boolToInt(eligibility.TreasureEligible),
		boolToInt(eligibility.ClassicEligible),
		analysis.Repository.ResolvedCommitSHA,
		analysis.RubricVersion,
		analyzedAt.UnixMilli(),
		now,
	)
	if err != nil {
		return nil, fmt.Errorf("upsert project assessment: %w", err)
	}

	if eligibility.TreasureEligible {
		entryID, err := newTreasureEntryID()
		if err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO treasure_entries (
				id, repo_key, analysis_id, status, selected_at,
				product_score_snapshot, confidence_snapshot,
				verification_level_snapshot, stars_snapshot, exposure_snapshot,
				reason, resolved_commit_sha
			) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
			entryID,
			repoKey,
			input.AnalysisID,
			now,
			analysis.Scores.ProductScore,
			analysis.Confidence,
			analysis.VerificationLevel,
			analysis.Exposure.Stars,
			analysis.Exposure.Band,
			treasureReason(analysis),
			analysis.Repository.ResolvedCommitSHA,
		)
		if err != nil {
			return nil, fmt.Errorf("insert treasure entry: %w", err)
		}
	} else if analysis.Exposure.Band == "established" || analysis.Exposure.Band == "mainstream" {
		_, err = tx.ExecContext(ctx,
			`UPDATE treasure_entries
			SET status = 'graduated', graduated_at = ?
			WHERE repo_key = ? AND status = 'active'`,
			now, repoKey,
		)
		if err != nil {
			return nil, fmt.Errorf("graduate treasure entry: %w", err)
		}
	}

	completion, err := tx.ExecContext(ctx,
		`UPDATE project_analysis_runs
		SET repo_key = ?, canonical_url = ?, resolved_commit_sha = ?, active_key = NULL,
		    status = 'completed', phase = 'completed', progress = 100,
		    verification_level = ?, analysis_json = ?, report_markdown = ?,
		    evidence_json = ?, analysis_sha256 = ?, report_sha256 = ?,
		    evidence_sha256 = ?, completed_at = ?, updated_at = ?
		WHERE id = ? AND status NOT IN (`+projectAnalysisTerminalStatuses+`)`,
		repoKey,
		analysis.Repository.CanonicalURL,
		analysis.Repository.ResolvedCommitSHA,
		analysis.VerificationLevel,
		input.AnalysisJSON,
		input.ReportMarkdown,
		input.EvidenceJSON,
		input.Hashes.Analysis,
		input.Hashes.Report,
		input.Hashes.Evidence,
		now,
		now,
		input.AnalysisID,
	)
	if err != nil {
		return nil, fmt.Errorf("complete project analysis run: %w", err)
	}
	affected, err := completion.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("read completion rows affected: %w", err)
	}
	if affected != 1 {
		return nil, fmt.Errorf("analysis finalization lost its state race")
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit project analysis finalization: %w", err)
	}

	completed, err := s.selectProjectAnalysisRun(ctx, input.AnalysisID)
	if err != nil {
		return nil, err
	}
	if completed == nil {
		return nil, fmt.Errorf("completed analysis run disappeared")
	}
	return completed, nil
}

const projectAssessmentSelect = `
	SELECT pa.repo_key, pa.latest_analysis_id, pa.product_score, pa.pain_score,
	       pa.effectiveness_score, pa.experience_score, pa.value_density_score,
	       pa.community_strength, pa.confidence, pa.unknowns_json, pa.risks_json,
	       pa.stars, pa.treasure_eligible, pa.classic_eligible,
	       pa.resolved_commit_sha, pa.analyzed_at,
	       pa.updated_at,
	       pr.analysis_json, pr.report_markdown
	FROM project_assessments AS pa
	JOIN project_analysis_runs AS pr ON pr.id = pa.latest_analysis_id`

// scanProjectAssessment mirrors mapAssessment: type, lifecycle, verification
// level, and exposure band come from the stored analysis artifact, not the
// denormalized columns.
func scanProjectAssessment(scanner rowScanner) (*ProjectAssessment, error) {
	var (
		assessment     ProjectAssessment
		unknownsJSON   string
		risksJSON      string
		stars          sql.NullInt64
		treasureFlag   int
		classicFlag    int
		analysisJSON   string
		reportMarkdown sql.NullString
	)
	err := scanner.Scan(
		&assessment.RepoKey, &assessment.LatestAnalysisID,
		&assessment.ProductScore, &assessment.PainScore,
		&assessment.EffectivenessScore, &assessment.ExperienceScore,
		&assessment.ValueDensityScore, &assessment.CommunityStrength,
		&assessment.Confidence, &unknownsJSON, &risksJSON,
		&stars, &treasureFlag, &classicFlag,
		&assessment.ResolvedCommitSHA, &assessment.AnalyzedAt, &assessment.UpdatedAt,
		&analysisJSON, &reportMarkdown,
	)
	if err != nil {
		return nil, err
	}
	analysis, err := parseProjectAnalysisArtifact(analysisJSON)
	if err != nil {
		return nil, fmt.Errorf("parse stored analysis artifact: %w", err)
	}
	assessment.ProjectType = analysis.Project.ProjectType
	assessment.Lifecycle = analysis.Project.Lifecycle
	assessment.VerificationLevel = analysis.VerificationLevel
	assessment.ExposureBand = analysis.Exposure.Band
	assessment.Unknowns = []string{}
	_ = json.Unmarshal([]byte(unknownsJSON), &assessment.Unknowns)
	assessment.Risks = []ProjectRisk{}
	_ = json.Unmarshal([]byte(risksJSON), &assessment.Risks)
	assessment.Stars = nullableInt64(stars)
	assessment.TreasureEligible = treasureFlag == 1
	assessment.ClassicEligible = classicFlag == 1
	assessment.Analysis = analysis
	assessment.ReportMarkdown = reportMarkdown.String
	return &assessment, nil
}

// ListFeedProjectAssessments provides a stable keyset scan for the rebuildable
// Feed projection. It deliberately avoids product-score ordering and OFFSET:
// concurrent analysis completions cannot move rows between pages and create a
// silent omission during reconciliation.
func (s *TursoStore) ListFeedProjectAssessments(ctx context.Context, afterRepoKey string, limit int) ([]ProjectAssessment, error) {
	if err := s.ensureCurrentProjectEligibility(ctx); err != nil {
		return nil, fmt.Errorf("ensure current project eligibility: %w", err)
	}
	limit = maxInt(1, minInt(100, limit))
	rows, err := s.db.QueryContext(ctx, projectAssessmentSelect+`
		WHERE pa.repo_key > ? ORDER BY pa.repo_key ASC LIMIT ?`, strings.ToLower(strings.TrimSpace(afterRepoKey)), limit)
	if err != nil {
		return nil, fmt.Errorf("list Feed project assessments: %w", err)
	}
	defer rows.Close()
	assessments := []ProjectAssessment{}
	for rows.Next() {
		assessment, err := scanProjectAssessment(rows)
		if err != nil {
			return nil, fmt.Errorf("scan Feed project assessment: %w", err)
		}
		assessments = append(assessments, *assessment)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list Feed project assessments: %w", err)
	}
	return assessments, nil
}

func (s *TursoStore) GetProjectAssessment(ctx context.Context, repoKey string) (*ProjectAssessment, error) {
	if err := s.ensureCurrentProjectEligibility(ctx); err != nil {
		return nil, fmt.Errorf("ensure current project eligibility: %w", err)
	}
	row := s.db.QueryRowContext(ctx,
		projectAssessmentSelect+` WHERE pa.repo_key = ? LIMIT 1`, strings.ToLower(repoKey))
	assessment, err := scanProjectAssessment(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get project assessment: %w", err)
	}
	return assessment, nil
}

// ListProjectBoard mirrors listProjectBoard: eligibility flag first, then
// product score, confidence, and analysis time, all descending. The "all"
// board lists every assessment regardless of eligibility so completed
// analyses are always discoverable.
func (s *TursoStore) ListProjectBoard(ctx context.Context, board ProjectBoard, limit, offset int) ([]ProjectAssessment, error) {
	if err := s.ensureCurrentProjectEligibility(ctx); err != nil {
		return nil, fmt.Errorf("ensure current project eligibility: %w", err)
	}
	where := ""
	if board != ProjectBoardAll {
		eligibilityColumn := "treasure_eligible"
		if board != ProjectBoardTreasure {
			eligibilityColumn = "classic_eligible"
		}
		where = "WHERE pa." + eligibilityColumn + " = 1"
	}
	limit = maxInt(1, minInt(100, limit))
	offset = maxInt(0, offset)
	rows, err := s.db.QueryContext(ctx,
		projectAssessmentSelect+`
		`+where+`
		ORDER BY pa.product_score DESC, pa.confidence DESC, pa.analyzed_at DESC
		LIMIT ? OFFSET ?`,
		limit, offset,
	)
	if err != nil {
		return nil, fmt.Errorf("list project board: %w", err)
	}
	defer rows.Close()
	assessments := []ProjectAssessment{}
	for rows.Next() {
		assessment, err := scanProjectAssessment(rows)
		if err != nil {
			return nil, fmt.Errorf("scan project board row: %w", err)
		}
		assessments = append(assessments, *assessment)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list project board: %w", err)
	}
	return assessments, nil
}

var projectEligibilityState struct {
	sync.Mutex
	reconciled bool
}

// ensureCurrentProjectEligibility mirrors ensureCurrentProjectEligibility: a
// once-per-process lazy reconcile of stored board flags against the current
// rubric rules. A failure leaves the latch open so the next read retries,
// matching the TypeScript promise-reset behavior.
func (s *TursoStore) ensureCurrentProjectEligibility(ctx context.Context) error {
	projectEligibilityState.Lock()
	defer projectEligibilityState.Unlock()
	if projectEligibilityState.reconciled {
		return nil
	}
	if err := s.reconcileStoredProjectEligibility(ctx); err != nil {
		return err
	}
	projectEligibilityState.reconciled = true
	return nil
}

// reconcileStoredProjectEligibility mirrors reconcileStoredProjectEligibility:
// every stored assessment's flags are recomputed from its artifact, entries an
// admin removed stay suppressed, and newly eligible repos get an active entry.
func (s *TursoStore) reconcileStoredProjectEligibility(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT pa.repo_key, pa.latest_analysis_id, pa.treasure_eligible, pa.classic_eligible, pr.analysis_json
		FROM project_assessments AS pa
		JOIN project_analysis_runs AS pr ON pr.id = pa.latest_analysis_id
		ORDER BY pa.updated_at ASC`)
	if err != nil {
		return fmt.Errorf("list stored assessments: %w", err)
	}
	type storedAssessment struct {
		repoKey          string
		latestAnalysisID string
		treasureEligible int
		classicEligible  int
		analysisJSON     string
	}
	stored := []storedAssessment{}
	for rows.Next() {
		var item storedAssessment
		if err := rows.Scan(&item.repoKey, &item.latestAnalysisID, &item.treasureEligible, &item.classicEligible, &item.analysisJSON); err != nil {
			rows.Close()
			return fmt.Errorf("scan stored assessment: %w", err)
		}
		stored = append(stored, item)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("list stored assessments: %w", err)
	}
	rows.Close()

	removed := map[string]bool{}
	removedRows, err := s.db.QueryContext(ctx,
		`SELECT repo_key, analysis_id FROM treasure_entries WHERE status = 'removed'`)
	if err != nil {
		return fmt.Errorf("list removed treasure entries: %w", err)
	}
	for removedRows.Next() {
		var repoKey, analysisID string
		if err := removedRows.Scan(&repoKey, &analysisID); err != nil {
			removedRows.Close()
			return fmt.Errorf("scan removed treasure entry: %w", err)
		}
		removed[repoKey+"\x00"+analysisID] = true
	}
	if err := removedRows.Err(); err != nil {
		return fmt.Errorf("list removed treasure entries: %w", err)
	}
	removedRows.Close()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin eligibility reconcile: %w", err)
	}
	defer tx.Rollback()
	now := time.Now().UnixMilli()
	for _, item := range stored {
		var analysis ProjectAnalysisArtifact
		if err := json.Unmarshal([]byte(item.analysisJSON), &analysis); err != nil {
			continue
		}
		eligibility := DeriveProjectBoardEligibility(&analysis)
		treasureEligible := eligibility.TreasureEligible && !removed[item.repoKey+"\x00"+item.latestAnalysisID]
		classicEligible := eligibility.ClassicEligible
		if item.treasureEligible != boolToInt(treasureEligible) || item.classicEligible != boolToInt(classicEligible) {
			if _, err := tx.ExecContext(ctx, `
				UPDATE project_assessments
				SET treasure_eligible = ?, classic_eligible = ?, updated_at = ?
				WHERE repo_key = ? AND latest_analysis_id = ?`,
				boolToInt(treasureEligible), boolToInt(classicEligible), now,
				item.repoKey, item.latestAnalysisID); err != nil {
				return fmt.Errorf("update stored eligibility: %w", err)
			}
		}
		if !treasureEligible {
			continue
		}
		entryID, err := newTreasureEntryID()
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT OR IGNORE INTO treasure_entries (
				id, repo_key, analysis_id, status, selected_at,
				product_score_snapshot, confidence_snapshot,
				verification_level_snapshot, stars_snapshot, exposure_snapshot,
				reason, resolved_commit_sha
			) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
			entryID, item.repoKey, item.latestAnalysisID, now,
			analysis.Scores.ProductScore, analysis.Confidence,
			analysis.VerificationLevel, analysis.Exposure.Stars, analysis.Exposure.Band,
			treasureReason(&analysis), analysis.Repository.ResolvedCommitSHA); err != nil {
			return fmt.Errorf("insert reconciled treasure entry: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit eligibility reconcile: %w", err)
	}
	return nil
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// ListReconciliableProjectAnalysisRuns mirrors
// listReconciliableProjectAnalysisRuns: in-flight runs plus queued runs whose
// create retry has come due, oldest update first.
func (s *TursoStore) ListReconciliableProjectAnalysisRuns(ctx context.Context, limit int) ([]ProjectAnalysisRun, error) {
	limit = maxInt(1, minInt(100, limit))
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+projectAnalysisRunColumns+` FROM project_analysis_runs
		WHERE status IN ('running', 'finalizing')
		   OR (
		     status IN ('queued', 'creating_thread')
		     AND (create_retry_at IS NULL OR create_retry_at <= ?)
		   )
		ORDER BY updated_at ASC LIMIT ?`,
		time.Now().UnixMilli(), limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list reconciliable project analysis runs: %w", err)
	}
	defer rows.Close()
	runs := []ProjectAnalysisRun{}
	for rows.Next() {
		run, err := scanProjectAnalysisRun(rows)
		if err != nil {
			return nil, fmt.Errorf("scan reconciliable project analysis run: %w", err)
		}
		runs = append(runs, *run)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list reconciliable project analysis runs: %w", err)
	}
	return runs, nil
}

func (s *TursoStore) ListTreasureHistory(ctx context.Context, repoKey string) ([]TreasureHistoryEntry, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, repo_key, analysis_id, status, selected_at,
		        product_score_snapshot, confidence_snapshot,
		        verification_level_snapshot, stars_snapshot, exposure_snapshot,
		        reason, resolved_commit_sha, graduated_at, removed_at, removed_reason
		FROM treasure_entries
		WHERE repo_key = ? ORDER BY selected_at DESC`,
		strings.ToLower(repoKey),
	)
	if err != nil {
		return nil, fmt.Errorf("list treasure history: %w", err)
	}
	defer rows.Close()
	entries := []TreasureHistoryEntry{}
	for rows.Next() {
		var (
			entry         TreasureHistoryEntry
			stars         sql.NullInt64
			graduatedAt   sql.NullInt64
			removedAt     sql.NullInt64
			removedReason sql.NullString
		)
		if err := rows.Scan(
			&entry.ID, &entry.RepoKey, &entry.AnalysisID, &entry.Status, &entry.SelectedAt,
			&entry.ProductScoreSnapshot, &entry.ConfidenceSnapshot,
			&entry.VerificationLevelSnapshot, &stars, &entry.ExposureSnapshot,
			&entry.Reason, &entry.ResolvedCommitSHA, &graduatedAt, &removedAt, &removedReason,
		); err != nil {
			return nil, fmt.Errorf("scan treasure history row: %w", err)
		}
		entry.StarsSnapshot = nullableInt64(stars)
		entry.GraduatedAt = nullableInt64(graduatedAt)
		entry.RemovedAt = nullableInt64(removedAt)
		entry.RemovedReason = nullableString(removedReason)
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list treasure history: %w", err)
	}
	return entries, nil
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
