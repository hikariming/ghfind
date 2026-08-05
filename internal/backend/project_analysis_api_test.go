package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeProjectAnalysisStatusStore adds the project analysis limiter and the
// completed-result cache to the shared fake status store.
type fakeProjectAnalysisStatusStore struct {
	fakeStatusStore
	projectCache map[string]string
}

func (s *fakeProjectAnalysisStatusStore) LimitProjectAnalysis(context.Context, string, time.Time) (RateLimitResult, error) {
	return s.limit, s.limitErr
}

func (s *fakeProjectAnalysisStatusStore) GetCachedProjectAnalysisID(_ context.Context, fingerprint string) (string, error) {
	return s.projectCache[fingerprint], nil
}

func (s *fakeProjectAnalysisStatusStore) SetCachedProjectAnalysisID(_ context.Context, fingerprint, analysisID string) error {
	if s.projectCache == nil {
		s.projectCache = map[string]string{}
	}
	s.projectCache[fingerprint] = analysisID
	return nil
}

func (s *fakeProjectAnalysisStatusStore) ClearCachedProjectAnalysisID(_ context.Context, fingerprint string) error {
	delete(s.projectCache, fingerprint)
	return nil
}

type fakeProjectPublisher struct {
	fakePublisher
	analyses []ProjectAnalysisJob
}

func (p *fakeProjectPublisher) PublishProjectAnalysis(_ context.Context, job ProjectAnalysisJob) error {
	if p.err != nil {
		return p.err
	}
	p.analyses = append(p.analyses, job)
	return nil
}
func (p *fakeProjectPublisher) PublishProjectAnalysisRetry(context.Context, ProjectAnalysisJob, time.Duration) error {
	return nil
}
func (p *fakeProjectPublisher) PublishProjectAnalysisDead(context.Context, ProjectAnalysisJob, string) error {
	return nil
}

func newProjectAnalysisTestServer(t *testing.T, mutate func(*fakeProjectAnalysisStatusStore, *Config)) (*APIServer, *TursoStore, *fakeProjectAnalysisStatusStore, *fakeProjectPublisher) {
	t.Helper()
	store := openProjectAnalysisTestStore(t)
	statuses := &fakeProjectAnalysisStatusStore{}
	config := Config{ProjectAnalysisCreateMaxAttempts: 3}
	if mutate != nil {
		mutate(statuses, &config)
	}
	publisher := &fakeProjectPublisher{}
	return NewAPIServer(config, store, statuses, publisher), store, statuses, publisher
}

func postProjectAnalysis(t *testing.T, server *APIServer, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/project-analyses", strings.NewReader(body))
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	return response
}

func decodeProjectAnalysisBody(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestCreateProjectAnalysisValidation(t *testing.T) {
	server, _, statuses, _ := newProjectAnalysisTestServer(t, func(statuses *fakeProjectAnalysisStatusStore, _ *Config) {
		statuses.limit = RateLimitResult{Success: true, Limit: 5, Remaining: 4, ResetAt: time.Now().Add(time.Hour)}
	})
	_ = statuses
	cases := []struct {
		name    string
		body    string
		code    string
		message string
	}{
		{"invalid json", "{", "invalid_body", "Send a JSON request body."},
		{"repository not a string", `{"repositoryUrl": 42}`, "invalid_repository", "repositoryUrl must be a string."},
		{"invalid repository", `{"repositoryUrl": "not a repo"}`, "invalid_repository", "Pass a public GitHub repository URL or owner/repository."},
		{"ref not a string", `{"repositoryUrl": "owner/repo", "ref": 42}`, "invalid_ref", "ref must be a string when provided."},
		{"invalid ref", `{"repositoryUrl": "owner/repo", "ref": "-nope"}`, "invalid_ref", "Invalid Git ref."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := postProjectAnalysis(t, server, tc.body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d body = %s", response.Code, response.Body)
			}
			body := decodeProjectAnalysisBody(t, response)
			if body["error"] != tc.code || body["message"] != tc.message {
				t.Fatalf("body = %#v", body)
			}
		})
	}
}

func TestCreateProjectAnalysisEnqueuesAndDeduplicates(t *testing.T) {
	server, store, _, publisher := newProjectAnalysisTestServer(t, func(statuses *fakeProjectAnalysisStatusStore, _ *Config) {
		statuses.limit = RateLimitResult{Success: true, Limit: 5, Remaining: 4, ResetAt: time.Now().Add(time.Hour)}
	})

	response := postProjectAnalysis(t, server, `{"repositoryUrl": "owner/useful-tool"}`)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", response.Code, response.Body)
	}
	body := decodeProjectAnalysisBody(t, response)
	analysisID, _ := body["analysisId"].(string)
	if analysisID == "" || body["repoKey"] != "owner/useful-tool" ||
		body["status"] != "queued" || body["phase"] != "queued" ||
		body["statusUrl"] != "/api/project-analyses/"+analysisID {
		t.Fatalf("body = %#v", body)
	}
	if _, reused := body["reused"]; reused {
		t.Fatalf("fresh response must omit reused: %#v", body)
	}
	if retry, ok := body["retry"]; !ok || retry != nil {
		t.Fatalf("retry = %#v", body["retry"])
	}
	if got := response.Header().Get("Location"); got != "/api/project-analyses/"+analysisID {
		t.Fatalf("Location = %q", got)
	}
	if got := response.Header().Get("Idempotency-Key"); got != "ghfind-project-"+analysisID {
		t.Fatalf("Idempotency-Key = %q", got)
	}
	if got := response.Header().Get("RateLimit-Limit"); got != "5" {
		t.Fatalf("RateLimit-Limit = %q", got)
	}
	if len(publisher.analyses) != 1 || publisher.analyses[0].ID != analysisID {
		t.Fatalf("published = %#v", publisher.analyses)
	}

	// The active key returns the existing run without a second job.
	response = postProjectAnalysis(t, server, `{"repositoryUrl": "https://github.com/OWNER/useful-tool.git"}`)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", response.Code, response.Body)
	}
	body = decodeProjectAnalysisBody(t, response)
	if body["analysisId"] != analysisID {
		t.Fatalf("deduplicated analysisId = %#v", body)
	}
	if len(publisher.analyses) != 1 {
		t.Fatalf("published = %#v", publisher.analyses)
	}
	run, err := store.GetProjectAnalysisRun(context.Background(), analysisID)
	if err != nil || run == nil {
		t.Fatalf("run = %#v err = %v", run, err)
	}
}

func TestCreateProjectAnalysisReusesCompletedResultWithoutQuota(t *testing.T) {
	server, store, statuses, publisher := newProjectAnalysisTestServer(t, func(statuses *fakeProjectAnalysisStatusStore, _ *Config) {
		// The limiter would reject this request; a reuse hit never reaches it.
		statuses.limit = RateLimitResult{Success: false, Limit: 5, Remaining: 0, ResetAt: time.Now().Add(time.Hour)}
	})
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if _, err := store.FinalizeProjectAnalysis(context.Background(), finalizeInput(t, "analysis-1", nil)); err != nil {
		t.Fatal(err)
	}

	response := postProjectAnalysis(t, server, `{"repositoryUrl": "owner/useful-tool"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body)
	}
	body := decodeProjectAnalysisBody(t, response)
	if body["analysisId"] != "analysis-1" || body["reused"] != true || body["status"] != "completed" {
		t.Fatalf("body = %#v", body)
	}
	if got := response.Header().Get("X-Project-Analysis-Reused"); got != "true" {
		t.Fatalf("X-Project-Analysis-Reused = %q", got)
	}
	if got := response.Header().Get("Idempotency-Key"); got != "ghfind-project-analysis-1" {
		t.Fatalf("Idempotency-Key = %q", got)
	}
	if got := response.Header().Get("Location"); got != "/api/project-analyses/analysis-1" {
		t.Fatalf("Location = %q", got)
	}
	if len(publisher.analyses) != 0 {
		t.Fatalf("published = %#v", publisher.analyses)
	}
	if len(statuses.projectCache) == 0 {
		t.Fatal("reuse was not indexed in the result cache")
	}
}

func TestCreateProjectAnalysisRateLimited(t *testing.T) {
	server, _, _, publisher := newProjectAnalysisTestServer(t, func(statuses *fakeProjectAnalysisStatusStore, _ *Config) {
		statuses.limit = RateLimitResult{Success: false, Limit: 5, Remaining: 0, ResetAt: time.Now().Add(30 * time.Minute)}
	})
	response := postProjectAnalysis(t, server, `{"repositoryUrl": "owner/useful-tool"}`)
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d body = %s", response.Code, response.Body)
	}
	body := decodeProjectAnalysisBody(t, response)
	if body["error"] != "rate_limited" || body["message"] != "Too many project analyses. Retry later." {
		t.Fatalf("body = %#v", body)
	}
	if response.Header().Get("RateLimit-Limit") != "5" || response.Header().Get("Retry-After") == "" {
		t.Fatalf("headers = %#v", response.Header())
	}
	if len(publisher.analyses) != 0 {
		t.Fatalf("published = %#v", publisher.analyses)
	}
}

func TestGetProjectAnalysisView(t *testing.T) {
	server, store, _, _ := newProjectAnalysisTestServer(t, nil)

	request := httptest.NewRequest(http.MethodGet, "/api/project-analyses/missing", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d", response.Code)
	}
	body := decodeProjectAnalysisBody(t, response)
	if body["error"] != "analysis_not_found" || body["message"] != "Project analysis was not found." {
		t.Fatalf("body = %#v", body)
	}

	// A failed run exposes only the safe public error message.
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if err := store.FailProjectAnalysis(context.Background(), "analysis-1", "artifact_invalid", "internal detail: scores.product_score drifted", "", nil); err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodGet, "/api/project-analyses/analysis-1", nil)
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	body = decodeProjectAnalysisBody(t, response)
	errorView, ok := body["error"].(map[string]any)
	if !ok || errorView["code"] != "artifact_invalid" ||
		errorView["message"] != "The generated assessment could not be verified. Please try again." {
		t.Fatalf("error = %#v", body["error"])
	}
	if body["assessment"] != nil || body["retry"] != nil {
		t.Fatalf("body = %#v", body)
	}
	if history, ok := body["treasureHistory"].([]any); !ok || len(history) != 0 {
		t.Fatalf("treasureHistory = %#v", body["treasureHistory"])
	}

	// A completed run carries the assessment and the treasure history.
	createTestRun(t, store, "analysis-2", "owner/other-tool", nil)
	if _, err := store.FinalizeProjectAnalysis(context.Background(), finalizeInput(t, "analysis-2", func(analysis, evidence map[string]any) {
		analysis["repository"].(map[string]any)["repo_key"] = "owner/other-tool"
		analysis["repository"].(map[string]any)["canonical_url"] = "https://github.com/owner/other-tool"
		evidence["repo_key"] = "owner/other-tool"
	})); err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodGet, "/api/project-analyses/analysis-2", nil)
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body)
	}
	body = decodeProjectAnalysisBody(t, response)
	assessment, ok := body["assessment"].(map[string]any)
	if !ok {
		t.Fatalf("assessment = %#v", body["assessment"])
	}
	if assessment["repoKey"] != "owner/other-tool" || assessment["latestAnalysisId"] != "analysis-2" ||
		assessment["productScore"] != float64(87) || assessment["reportMarkdown"] == "" {
		t.Fatalf("assessment = %#v", assessment)
	}
	if body["error"] != nil || body["status"] != "completed" || body["progress"] != float64(100) {
		t.Fatalf("body = %#v", body)
	}
	if _, ok := body["completedAt"].(float64); !ok {
		t.Fatalf("completedAt = %#v", body["completedAt"])
	}
}

func TestReconcileProjectAnalyses(t *testing.T) {
	// Unconfigured secrets fail closed, mirroring the TypeScript authorized().
	server, _, _, _ := newProjectAnalysisTestServer(t, nil)
	request := httptest.NewRequest(http.MethodPost, "/api/internal/project-analyses/reconcile", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d", response.Code)
	}

	server, store, _, publisher := newProjectAnalysisTestServer(t, func(_ *fakeProjectAnalysisStatusStore, config *Config) {
		config.ProjectAnalysisReconcileSecret = "reconcile-secret"
	})
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	createTestRun(t, store, "analysis-2", "owner/other-tool", nil)

	request = httptest.NewRequest(http.MethodPost, "/api/internal/project-analyses/reconcile", nil)
	request.Header.Set("Authorization", "Bearer wrong")
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/internal/project-analyses/reconcile", nil)
	request.Header.Set("Authorization", "Bearer reconcile-secret")
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	body := decodeProjectAnalysisBody(t, response)
	if body["processed"] != float64(2) || body["completed"] != float64(0) || body["failed"] != float64(0) {
		t.Fatalf("body = %#v", body)
	}
	if len(publisher.analyses) != 2 {
		t.Fatalf("published = %#v", publisher.analyses)
	}

	// The explicit header is an equivalent credential.
	request = httptest.NewRequest(http.MethodPost, "/api/internal/project-analyses/reconcile", nil)
	request.Header.Set("x-reconcile-secret", "reconcile-secret")
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestProjectBoardsList(t *testing.T) {
	server, store, _, _ := newProjectAnalysisTestServer(t, nil)
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if _, err := store.FinalizeProjectAnalysis(context.Background(), finalizeInput(t, "analysis-1", nil)); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/project-boards?board=treasure&limit=10", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body)
	}
	body := decodeProjectAnalysisBody(t, response)
	if body["board"] != "treasure" {
		t.Fatalf("board = %#v", body)
	}
	entries, ok := body["entries"].([]any)
	if !ok || len(entries) != 1 {
		t.Fatalf("entries = %#v", body["entries"])
	}
	entry := entries[0].(map[string]any)
	if entry["repoKey"] != "owner/useful-tool" || entry["treasureEligible"] != true {
		t.Fatalf("entry = %#v", entry)
	}
	if entry["analysis"] == nil || entry["productScore"].(float64) <= 0 {
		t.Fatalf("entry missing assessment payload: %#v", entry)
	}

	classic := httptest.NewRecorder()
	server.Handler().ServeHTTP(classic, httptest.NewRequest(http.MethodGet, "/api/project-boards?board=classic", nil))
	classicBody := decodeProjectAnalysisBody(t, classic)
	if classicBody["board"] != "classic" {
		t.Fatalf("classic board = %#v", classicBody)
	}
}

func TestProjectBoardsAllListsEveryAssessment(t *testing.T) {
	server, store, _, _ := newProjectAnalysisTestServer(t, nil)
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if _, err := store.FinalizeProjectAnalysis(context.Background(), finalizeInput(t, "analysis-1", nil)); err != nil {
		t.Fatal(err)
	}
	// Force the assessment out of both boards; the "all" view must still show it.
	if _, err := store.db.ExecContext(context.Background(), `UPDATE project_assessments SET treasure_eligible = 0, classic_eligible = 0 WHERE repo_key = ?`, "owner/useful-tool"); err != nil {
		t.Fatal(err)
	}

	for _, board := range []string{"treasure", "classic", "all"} {
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/project-boards?board="+board, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d", board, response.Code)
		}
		entries := decodeProjectAnalysisBody(t, response)["entries"].([]any)
		if board == "all" && len(entries) != 1 {
			t.Fatalf("all board entries = %d, want 1 (eligibility must not filter)", len(entries))
		}
		if board != "all" && len(entries) != 0 {
			t.Fatalf("%s board entries = %d, want 0", board, len(entries))
		}
	}
}
