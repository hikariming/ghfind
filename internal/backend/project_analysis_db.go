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
)

// Feed reads project assessments from the existing Turso tables written by the
// Worker (src/lib/project-analysis-db.ts). It never creates tables.

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

func nullableInt64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
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

// Feed projection never returns the long-form markdown report. Keeping that
// blob out of reconciliation queries materially reduces Turso transfer and
// allocation pressure without changing the authoritative assessment fields.
const feedProjectAssessmentSelect = `
	SELECT pa.repo_key, pa.latest_analysis_id, pa.product_score, pa.pain_score,
	       pa.effectiveness_score, pa.experience_score, pa.value_density_score,
	       pa.community_strength, pa.confidence, pa.unknowns_json, pa.risks_json,
	       pa.stars, pa.treasure_eligible, pa.classic_eligible,
	       pa.resolved_commit_sha, pa.analyzed_at,
	       pa.updated_at,
	       pr.analysis_json, NULL AS report_markdown
	FROM project_assessments AS pa
	JOIN project_analysis_runs AS pr ON pr.id = pa.latest_analysis_id`

// scanProjectAssessment mirrors mapAssessment: type, lifecycle, verification
// level, and exposure band come from the stored analysis artifact, not the
// denormalized columns.
func scanProjectAssessment(scanner interface{ Scan(...any) error }) (*ProjectAssessment, error) {
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
	limit = max(1, min(100, limit))
	rows, err := s.db.QueryContext(ctx, feedProjectAssessmentSelect+`
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

// ListFeedProjectAssessmentChanges reads only rows newer than a durable
// (updated_at, repo_key) high-water mark. Callers deliberately restart a few
// minutes before the mark, so equal-millisecond writes and clock skew are
// replayed through the source-hash idempotency guard instead of being missed.
func (s *TursoStore) ListFeedProjectAssessmentChanges(ctx context.Context, afterUpdatedAt int64, afterRepoKey string, limit int) ([]ProjectAssessment, error) {
	if err := s.ensureCurrentProjectEligibility(ctx); err != nil {
		return nil, fmt.Errorf("ensure current project eligibility: %w", err)
	}
	limit = max(1, min(100, limit))
	if afterUpdatedAt < 0 {
		afterUpdatedAt = 0
	}
	rows, err := s.db.QueryContext(ctx, feedProjectAssessmentSelect+`
		WHERE pa.updated_at > ? OR (pa.updated_at = ? AND pa.repo_key > ?)
		ORDER BY pa.updated_at ASC, pa.repo_key ASC LIMIT ?`, afterUpdatedAt, afterUpdatedAt,
		strings.ToLower(strings.TrimSpace(afterRepoKey)), limit)
	if err != nil {
		return nil, fmt.Errorf("list changed Feed project assessments: %w", err)
	}
	defer rows.Close()
	assessments := []ProjectAssessment{}
	for rows.Next() {
		assessment, err := scanProjectAssessment(rows)
		if err != nil {
			return nil, fmt.Errorf("scan changed Feed project assessment: %w", err)
		}
		assessments = append(assessments, *assessment)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list changed Feed project assessments: %w", err)
	}
	return assessments, nil
}

func (s *TursoStore) FeedProjectCatalogCount(ctx context.Context) (int64, error) {
	if err := s.ensureCurrentProjectEligibility(ctx); err != nil {
		return 0, fmt.Errorf("ensure current project eligibility: %w", err)
	}
	var count int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM project_assessments`).Scan(&count); err != nil {
		return 0, fmt.Errorf("count Feed project assessments: %w", err)
	}
	return count, nil
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
