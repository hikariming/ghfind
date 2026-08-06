package backend

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// This file mirrors the public contract of src/app/api/project-analyses and
// src/app/api/internal/project-analyses/reconcile while execution moves to the
// RabbitMQ-driven ProjectAnalysisWorker. Response fields, error codes, and
// messages stay byte-compatible with the TypeScript routes.

// ProjectAnalysisRunStore is the slice of the Turso store the API needs.
type ProjectAnalysisRunStore interface {
	GetProjectAnalysisRun(context.Context, string) (*ProjectAnalysisRun, error)
	FindReusableCompletedProjectAnalysisRun(context.Context, ReusableProjectAnalysisRunInput) (*ProjectAnalysisRun, error)
	CreateProjectAnalysisRun(context.Context, CreateProjectAnalysisRunInput) (*ProjectAnalysisRun, bool, error)
	GetProjectAssessment(context.Context, string) (*ProjectAssessment, error)
	ListProjectBoard(context.Context, ProjectBoard, int, int) ([]ProjectAssessment, error)
	ListTreasureHistory(context.Context, string) ([]TreasureHistoryEntry, error)
	ListReconciliableProjectAnalysisRuns(context.Context, int) ([]ProjectAnalysisRun, error)
}

// ProjectAnalysisRateLimiter is the dedicated 5-per-hour submission budget.
// A reusable result never consumes quota because the limiter only runs after
// the reuse check misses.
type ProjectAnalysisRateLimiter interface {
	LimitProjectAnalysis(context.Context, string, time.Time) (RateLimitResult, error)
}

type projectAnalysisRetryView struct {
	Attempt       int   `json:"attempt"`
	MaxAttempts   int   `json:"maxAttempts"`
	NextAttemptAt int64 `json:"nextAttemptAt"`
}

// projectAnalysisRetryState mirrors projectAnalysisRetryState: a retry object
// only exists while a queued run waits for its next creation attempt.
func projectAnalysisRetryState(run *ProjectAnalysisRun, maxAttempts int) *projectAnalysisRetryView {
	if run.Status == ProjectAnalysisStatusQueued && run.CreateAttempts > 0 && run.CreateRetryAt != nil {
		return &projectAnalysisRetryView{
			Attempt:       run.CreateAttempts,
			MaxAttempts:   maxAttempts,
			NextAttemptAt: *run.CreateRetryAt,
		}
	}
	return nil
}

type projectAnalysisErrorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// publicProjectAnalysisErrorMessage mirrors publicProjectAnalysisErrorMessage:
// internal failure detail never crosses the API boundary.
func publicProjectAnalysisErrorMessage(code string) string {
	if code == "artifact_invalid" {
		return "The generated assessment could not be verified. Please try again."
	}
	return "Project analysis could not be completed. Please try again."
}

type projectAssessmentView struct {
	RepoKey            string                   `json:"repoKey"`
	LatestAnalysisID   string                   `json:"latestAnalysisId"`
	ProjectType        string                   `json:"projectType"`
	Lifecycle          string                   `json:"lifecycle"`
	ProductScore       float64                  `json:"productScore"`
	PainScore          float64                  `json:"painScore"`
	EffectivenessScore float64                  `json:"effectivenessScore"`
	ExperienceScore    float64                  `json:"experienceScore"`
	ValueDensityScore  float64                  `json:"valueDensityScore"`
	CommunityStrength  float64                  `json:"communityStrength"`
	Confidence         float64                  `json:"confidence"`
	VerificationLevel  string                   `json:"verificationLevel"`
	Unknowns           []string                 `json:"unknowns"`
	Risks              []ProjectRisk            `json:"risks"`
	ExposureBand       string                   `json:"exposureBand"`
	Stars              *int64                   `json:"stars"`
	TreasureEligible   bool                     `json:"treasureEligible"`
	ClassicEligible    bool                     `json:"classicEligible"`
	ResolvedCommitSHA  string                   `json:"resolvedCommitSha"`
	AnalyzedAt         int64                    `json:"analyzedAt"`
	Analysis           *ProjectAnalysisArtifact `json:"analysis"`
	ReportMarkdown     string                   `json:"reportMarkdown"`
}

func newProjectAssessmentView(assessment *ProjectAssessment) *projectAssessmentView {
	if assessment == nil {
		return nil
	}
	unknowns := assessment.Unknowns
	if unknowns == nil {
		unknowns = []string{}
	}
	risks := assessment.Risks
	if risks == nil {
		risks = []ProjectRisk{}
	}
	return &projectAssessmentView{
		RepoKey:            assessment.RepoKey,
		LatestAnalysisID:   assessment.LatestAnalysisID,
		ProjectType:        assessment.ProjectType,
		Lifecycle:          assessment.Lifecycle,
		ProductScore:       assessment.ProductScore,
		PainScore:          assessment.PainScore,
		EffectivenessScore: assessment.EffectivenessScore,
		ExperienceScore:    assessment.ExperienceScore,
		ValueDensityScore:  assessment.ValueDensityScore,
		CommunityStrength:  assessment.CommunityStrength,
		Confidence:         assessment.Confidence,
		VerificationLevel:  assessment.VerificationLevel,
		Unknowns:           unknowns,
		Risks:              risks,
		ExposureBand:       assessment.ExposureBand,
		Stars:              assessment.Stars,
		TreasureEligible:   assessment.TreasureEligible,
		ClassicEligible:    assessment.ClassicEligible,
		ResolvedCommitSHA:  assessment.ResolvedCommitSHA,
		AnalyzedAt:         assessment.AnalyzedAt,
		Analysis:           assessment.Analysis,
		ReportMarkdown:     assessment.ReportMarkdown,
	}
}

type treasureHistoryView struct {
	ID                        string  `json:"id"`
	RepoKey                   string  `json:"repoKey"`
	AnalysisID                string  `json:"analysisId"`
	Status                    string  `json:"status"`
	SelectedAt                int64   `json:"selectedAt"`
	ProductScoreSnapshot      float64 `json:"productScoreSnapshot"`
	ConfidenceSnapshot        float64 `json:"confidenceSnapshot"`
	VerificationLevelSnapshot string  `json:"verificationLevelSnapshot"`
	StarsSnapshot             *int64  `json:"starsSnapshot"`
	ExposureSnapshot          string  `json:"exposureSnapshot"`
	Reason                    string  `json:"reason"`
	ResolvedCommitSHA         string  `json:"resolvedCommitSha"`
	GraduatedAt               *int64  `json:"graduatedAt"`
	RemovedAt                 *int64  `json:"removedAt"`
	RemovedReason             *string `json:"removedReason"`
}

// publicProjectAnalysisView mirrors PublicProjectAnalysisView field for field.
type publicProjectAnalysisView struct {
	AnalysisID      string                    `json:"analysisId"`
	RepoKey         string                    `json:"repoKey"`
	CanonicalURL    string                    `json:"canonicalUrl"`
	RequestedRef    *string                   `json:"requestedRef"`
	Status          ProjectAnalysisStatus     `json:"status"`
	Phase           string                    `json:"phase"`
	Progress        int                       `json:"progress"`
	Activities      []ProjectAnalysisActivity `json:"activities"`
	Error           *projectAnalysisErrorView `json:"error"`
	CreatedAt       int64                     `json:"createdAt"`
	UpdatedAt       int64                     `json:"updatedAt"`
	CompletedAt     *int64                    `json:"completedAt"`
	Retry           *projectAnalysisRetryView `json:"retry"`
	Assessment      *projectAssessmentView    `json:"assessment"`
	TreasureHistory []treasureHistoryView     `json:"treasureHistory"`
}

type createProjectAnalysisResponse struct {
	AnalysisID string                    `json:"analysisId"`
	RepoKey    string                    `json:"repoKey"`
	Status     ProjectAnalysisStatus     `json:"status"`
	Phase      string                    `json:"phase"`
	Progress   int                       `json:"progress"`
	Retry      *projectAnalysisRetryView `json:"retry"`
	StatusURL  string                    `json:"statusUrl"`
	Reused     bool                      `json:"reused,omitempty"`
}

func newCreateProjectAnalysisResponse(run *ProjectAnalysisRun, maxAttempts int, reused bool) createProjectAnalysisResponse {
	return createProjectAnalysisResponse{
		AnalysisID: run.ID,
		RepoKey:    run.RepoKey,
		Status:     run.Status,
		Phase:      run.Phase,
		Progress:   run.Progress,
		Retry:      projectAnalysisRetryState(run, maxAttempts),
		StatusURL:  "/api/project-analyses/" + run.ID,
		Reused:     reused,
	}
}

func reusableProjectAnalysisInput(repoKey string, requestedRef *string) ReusableProjectAnalysisRunInput {
	return ReusableProjectAnalysisRunInput{
		RepoKey:       repoKey,
		RequestedRef:  requestedRef,
		SchemaVersion: ProjectAnalysisSchemaVersion,
		RubricVersion: ProjectRubricVersion,
		AgentVersion:  ProjectAgentVersion,
		SkillVersion:  ProjectSkillVersion,
	}
}

// findReusableProjectAnalysis mirrors findReusableProjectAnalysisByIdentity:
// the Redis fingerprint index is checked first and only trusted when every
// identity field still matches; Turso is the fallback and the authority.
func (s *APIServer) findReusableProjectAnalysis(ctx context.Context, input ReusableProjectAnalysisRunInput) (*ProjectAnalysisRun, error) {
	fingerprint := ProjectAnalysisResultFingerprint(
		input.RepoKey, input.RequestedRef,
		input.SchemaVersion, input.RubricVersion, input.AgentVersion, input.SkillVersion,
	)
	if s.projectAnalysisCache != nil {
		if cachedID, err := s.projectAnalysisCache.GetCachedProjectAnalysisID(ctx, fingerprint); err == nil && cachedID != "" {
			cachedRun, runErr := s.projectAnalyses.GetProjectAnalysisRun(ctx, cachedID)
			assessment, assessmentErr := s.projectAnalyses.GetProjectAssessment(ctx, input.RepoKey)
			if runErr != nil || assessmentErr != nil {
				return nil, runErr
			}
			if cachedRun != nil && cachedRun.Status == ProjectAnalysisStatusCompleted &&
				assessment != nil && assessment.LatestAnalysisID == cachedRun.ID &&
				cachedRun.RepoKey == strings.ToLower(input.RepoKey) &&
				sameStringPointer(cachedRun.RequestedRef, input.RequestedRef) &&
				cachedRun.SchemaVersion == input.SchemaVersion &&
				cachedRun.RubricVersion == input.RubricVersion &&
				cachedRun.AgentVersion == input.AgentVersion &&
				cachedRun.SkillVersion == input.SkillVersion {
				return cachedRun, nil
			}
			_ = s.projectAnalysisCache.ClearCachedProjectAnalysisID(ctx, fingerprint)
		}
	}
	persisted, err := s.projectAnalyses.FindReusableCompletedProjectAnalysisRun(ctx, input)
	if err != nil {
		return nil, err
	}
	if persisted != nil && s.projectAnalysisCache != nil {
		_ = s.projectAnalysisCache.SetCachedProjectAnalysisID(ctx, fingerprint, persisted.ID)
	}
	return persisted, nil
}

func sameStringPointer(left, right *string) bool {
	if (left == nil) != (right == nil) {
		return false
	}
	return left == nil || *left == *right
}

// createProjectAnalysis mirrors POST /api/project-analyses: validate, reuse,
// rate-limit, create the durable run, and enqueue the worker job.
func (s *APIServer) createProjectAnalysis(w http.ResponseWriter, request *http.Request) {
	if s.projectAnalyses == nil || s.projectAnalysisPublisher == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "analysis_persistence_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	var body struct {
		RepositoryURL json.RawMessage `json:"repositoryUrl"`
		Ref           json.RawMessage `json:"ref"`
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, 16<<10))
	if err := decoder.Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid_body", "message": "Send a JSON request body.",
		}, nil)
		return
	}
	var repositoryURL string
	if len(body.RepositoryURL) == 0 || json.Unmarshal(body.RepositoryURL, &repositoryURL) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid_repository", "message": "repositoryUrl must be a string.",
		}, nil)
		return
	}
	var rawRef *string
	if len(body.Ref) > 0 && string(body.Ref) != "null" {
		var ref string
		if err := json.Unmarshal(body.Ref, &ref); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "invalid_ref", "message": "ref must be a string when provided.",
			}, nil)
			return
		}
		rawRef = &ref
	}
	repository, err := NormalizeGitHubRepository(repositoryURL)
	if errors.Is(err, ErrInvalidRepository) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid_repository", "message": "Pass a public GitHub repository URL or owner/repository.",
		}, nil)
		return
	}
	if err != nil {
		s.projectAnalysisStoreError(w, err)
		return
	}
	refInput := ""
	if rawRef != nil {
		refInput = *rawRef
	}
	requestedRef, err := NormalizeRequestedRef(refInput)
	if errors.Is(err, ErrInvalidRef) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid_ref", "message": "Invalid Git ref.",
		}, nil)
		return
	}
	if err != nil {
		s.projectAnalysisStoreError(w, err)
		return
	}

	reusable, err := s.findReusableProjectAnalysis(request.Context(), reusableProjectAnalysisInput(repository.RepoKey, requestedRef))
	if err != nil {
		s.projectAnalysisStoreError(w, err)
		return
	}
	if reusable != nil {
		location := "/api/project-analyses/" + reusable.ID
		writeJSON(w, http.StatusOK, newCreateProjectAnalysisResponse(reusable, s.config.ProjectAnalysisCreateMaxAttempts, true), map[string]string{
			"Cache-Control":             "no-store",
			"Location":                  location,
			"Idempotency-Key":           reusable.IdempotencyKey,
			"X-Project-Analysis-Reused": "true",
		})
		return
	}

	if s.projectAnalysisLimiter == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "rate_limit_unavailable"}, map[string]string{
			"Cache-Control": "no-store", "Retry-After": "15",
		})
		return
	}
	now := s.clock().UTC()
	limit, err := s.projectAnalysisLimiter.LimitProjectAnalysis(request.Context(), s.clientIP(request), now)
	if err != nil || limit.Unavailable {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "rate_limit_unavailable"}, map[string]string{
			"Cache-Control": "no-store", "Retry-After": "15",
		})
		return
	}
	headers := rateLimitHeaders(limit, now)
	if !limit.Success {
		headers["Cache-Control"] = "no-store"
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"error": "rate_limited", "message": "Too many project analyses. Retry later.",
		}, headers)
		return
	}

	analysisID, err := newProjectAnalysisID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "analysis_create_failed", "message": "Project analysis could not be created.",
		}, headers)
		return
	}
	run, created, err := s.projectAnalyses.CreateProjectAnalysisRun(request.Context(), CreateProjectAnalysisRunInput{
		ID:            analysisID,
		RepoKey:       repository.RepoKey,
		CanonicalURL:  repository.CanonicalURL,
		RequestedRef:  requestedRef,
		SchemaVersion: ProjectAnalysisSchemaVersion,
		RubricVersion: ProjectRubricVersion,
		AgentVersion:  ProjectAgentVersion,
		SkillVersion:  ProjectSkillVersion,
	})
	if err != nil {
		s.projectAnalysisStoreError(w, err)
		return
	}
	if created {
		job := ProjectAnalysisJob{ID: run.ID, Attempt: 0, RequestedAt: now.UnixMilli()}
		if err := s.projectAnalysisPublisher.PublishProjectAnalysis(request.Context(), job); err != nil {
			s.metrics.recordAPIJobAdmission(ProjectAnalysisJobKind, "publish_failed")
			headers["Cache-Control"] = "no-store"
			headers["Retry-After"] = "15"
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "broker_unavailable"}, headers)
			return
		}
		s.metrics.recordAPIJobAdmission(ProjectAnalysisJobKind, "queued")
	} else {
		s.metrics.recordAPIJobAdmission(ProjectAnalysisJobKind, "deduplicated")
	}
	location := "/api/project-analyses/" + run.ID
	headers["Cache-Control"] = "no-store"
	headers["Location"] = location
	headers["Idempotency-Key"] = run.IdempotencyKey
	writeJSON(w, http.StatusAccepted, newCreateProjectAnalysisResponse(run, s.config.ProjectAnalysisCreateMaxAttempts, false), headers)
}

// projectAnalysis mirrors GET /api/project-analyses/{id}: the worker owns
// reconciliation, so this handler only renders the durable public view.
func (s *APIServer) projectAnalysis(w http.ResponseWriter, request *http.Request) {
	if s.projectAnalyses == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "analysis_persistence_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	run, err := s.projectAnalyses.GetProjectAnalysisRun(request.Context(), request.PathValue("id"))
	if err != nil {
		s.projectAnalysisStoreError(w, err)
		return
	}
	if run == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "analysis_not_found", "message": "Project analysis was not found.",
		}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	var assessment *ProjectAssessment
	treasureHistory := []TreasureHistoryEntry{}
	if run.Status == ProjectAnalysisStatusCompleted {
		assessment, err = s.projectAnalyses.GetProjectAssessment(request.Context(), run.RepoKey)
		if err != nil {
			s.projectAnalysisStoreError(w, err)
			return
		}
		treasureHistory, err = s.projectAnalyses.ListTreasureHistory(request.Context(), run.RepoKey)
		if err != nil {
			s.projectAnalysisStoreError(w, err)
			return
		}
	}
	var errorView *projectAnalysisErrorView
	if run.ErrorCode != nil && run.ErrorMessage != nil {
		errorView = &projectAnalysisErrorView{
			Code:    *run.ErrorCode,
			Message: publicProjectAnalysisErrorMessage(*run.ErrorCode),
		}
	}
	activities := run.Activities
	if activities == nil {
		activities = []ProjectAnalysisActivity{}
	}
	history := make([]treasureHistoryView, 0, len(treasureHistory))
	for _, entry := range treasureHistory {
		history = append(history, treasureHistoryView{
			ID: entry.ID, RepoKey: entry.RepoKey, AnalysisID: entry.AnalysisID,
			Status: entry.Status, SelectedAt: entry.SelectedAt,
			ProductScoreSnapshot: entry.ProductScoreSnapshot, ConfidenceSnapshot: entry.ConfidenceSnapshot,
			VerificationLevelSnapshot: entry.VerificationLevelSnapshot, StarsSnapshot: entry.StarsSnapshot,
			ExposureSnapshot: entry.ExposureSnapshot, Reason: entry.Reason,
			ResolvedCommitSHA: entry.ResolvedCommitSHA, GraduatedAt: entry.GraduatedAt,
			RemovedAt: entry.RemovedAt, RemovedReason: entry.RemovedReason,
		})
	}
	writeJSON(w, http.StatusOK, publicProjectAnalysisView{
		AnalysisID:      run.ID,
		RepoKey:         run.RepoKey,
		CanonicalURL:    run.CanonicalURL,
		RequestedRef:    run.RequestedRef,
		Status:          run.Status,
		Phase:           run.Phase,
		Progress:        run.Progress,
		Activities:      activities,
		Error:           errorView,
		CreatedAt:       run.CreatedAt,
		UpdatedAt:       run.UpdatedAt,
		CompletedAt:     run.CompletedAt,
		Retry:           projectAnalysisRetryState(run, s.config.ProjectAnalysisCreateMaxAttempts),
		Assessment:      newProjectAssessmentView(assessment),
		TreasureHistory: history,
	}, map[string]string{"Cache-Control": "no-store"})
}

var reconcileBearerPattern = regexp.MustCompile(`(?i)^Bearer\s+(.+)$`)

// reconcileProjectAnalyses mirrors POST /api/internal/project-analyses/reconcile:
// candidates are re-enqueued for the worker instead of reconciled inline.
func (s *APIServer) reconcileProjectAnalyses(w http.ResponseWriter, request *http.Request) {
	if !s.reconcileAuthorized(request) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	if s.projectAnalyses == nil || s.projectAnalysisPublisher == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "analysis_persistence_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	runs, err := s.projectAnalyses.ListReconciliableProjectAnalysisRuns(request.Context(), 20)
	if err != nil {
		s.projectAnalysisStoreError(w, err)
		return
	}
	processed := 0
	completed := 0
	failed := 0
	for _, run := range runs {
		job := ProjectAnalysisJob{ID: run.ID, Attempt: 0, RequestedAt: s.clock().UTC().UnixMilli()}
		if err := s.projectAnalysisPublisher.PublishProjectAnalysis(request.Context(), job); err != nil {
			s.metrics.recordAPIJobAdmission(ProjectAnalysisJobKind, "publish_failed")
			failed++
			continue
		}
		processed++
		current, err := s.projectAnalyses.GetProjectAnalysisRun(request.Context(), run.ID)
		if err != nil || current == nil {
			continue
		}
		switch current.Status {
		case ProjectAnalysisStatusCompleted:
			completed++
		case ProjectAnalysisStatusFailed, ProjectAnalysisStatusCancelled, ProjectAnalysisStatusExpired:
			failed++
		}
	}
	writeJSON(w, http.StatusOK, map[string]int{
		"processed": processed,
		"completed": completed,
		"failed":    failed,
	}, map[string]string{"Cache-Control": "no-store"})
}

// projectBoards serves the treasure/classic/all board lists for frontend
// deploys whose server side cannot reach Turso directly. The query contract
// mirrors the boards page: board=treasure|classic|all, limit clamped to
// [1,100], offset ≥0.
func (s *APIServer) projectBoards(w http.ResponseWriter, request *http.Request) {
	if s.projectAnalyses == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "boards_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	board := ProjectBoardTreasure
	switch request.URL.Query().Get("board") {
	case "classic":
		board = ProjectBoardClassic
	case "all":
		board = ProjectBoardAll
	}
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(request.URL.Query().Get("offset"))
	entries, err := s.projectAnalyses.ListProjectBoard(request.Context(), board, limit, offset)
	if err != nil {
		s.projectAnalysisStoreError(w, err)
		return
	}
	views := make([]*projectAssessmentView, 0, len(entries))
	for index := range entries {
		views = append(views, newProjectAssessmentView(&entries[index]))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"board":   string(board),
		"entries": views,
	}, map[string]string{"Cache-Control": "no-store"})
}

// reconcileAuthorized mirrors the TypeScript authorized(): the bearer token or
// the x-reconcile-secret header must match one of the configured secrets, and
// an unconfigured endpoint stays closed.
func (s *APIServer) reconcileAuthorized(request *http.Request) bool {
	expected := []string{}
	if s.config.ProjectAnalysisReconcileSecret != "" {
		expected = append(expected, s.config.ProjectAnalysisReconcileSecret)
	}
	if s.config.CronSecret != "" {
		expected = append(expected, s.config.CronSecret)
	}
	if len(expected) == 0 {
		return false
	}
	presented := []string{}
	if match := reconcileBearerPattern.FindStringSubmatch(request.Header.Get("Authorization")); len(match) == 2 {
		presented = append(presented, match[1])
	}
	if value := request.Header.Get("x-reconcile-secret"); value != "" {
		presented = append(presented, value)
	}
	for _, candidate := range presented {
		for _, secret := range expected {
			if len(candidate) == len(secret) && subtle.ConstantTimeCompare([]byte(candidate), []byte(secret)) == 1 {
				return true
			}
		}
	}
	return false
}

// projectAnalysisStoreError mirrors the ProjectAnalysisDatabaseError branch of
// the TypeScript error responses.
func (s *APIServer) projectAnalysisStoreError(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{
		"error": "analysis_persistence_unavailable", "message": err.Error(),
	}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
}

// newProjectAnalysisID returns a random UUID like the TypeScript randomUUID
// call in createProjectAnalysis.
func newProjectAnalysisID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(id[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}
