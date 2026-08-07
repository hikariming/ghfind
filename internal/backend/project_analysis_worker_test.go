package backend

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// recordingProjectPublisher captures project analysis publishes for
// assertions; it never touches a broker.
type recordingProjectPublisher struct {
	mu        sync.Mutex
	published []string
	retries   []recordedProjectRetry
	dead      []string
}

type recordedProjectRetry struct {
	job   ProjectAnalysisJob
	delay time.Duration
}

func (p *recordingProjectPublisher) PublishProjectAnalysis(_ context.Context, job ProjectAnalysisJob) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.published = append(p.published, job.ID)
	return nil
}

func (p *recordingProjectPublisher) PublishProjectAnalysisRetry(_ context.Context, job ProjectAnalysisJob, delay time.Duration) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.retries = append(p.retries, recordedProjectRetry{job: job, delay: delay})
	return nil
}

func (p *recordingProjectPublisher) PublishProjectAnalysisDead(_ context.Context, job ProjectAnalysisJob, reason string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.dead = append(p.dead, job.ID+":"+reason)
	return nil
}

// fakeMosoo is a scripted Mosoo Public Thread API server. Each GET on a
// thread pops the next scripted run snapshot (the last one repeats), which
// lets one test walk a run from boot to completion.
type fakeMosoo struct {
	t *testing.T

	mu           sync.Mutex
	requests     int
	createCalls  int
	createKeys   []string
	createBodies []string
	onCreate     func(call int) (int, any)

	threadCalls map[string]int
	threadRuns  map[string][]map[string]any
	events      map[string]any
	files       map[string]any
	contents    map[string]string
}

func newFakeMosoo(t *testing.T) *fakeMosoo {
	t.Helper()
	return &fakeMosoo{
		t:           t,
		threadCalls: map[string]int{},
		threadRuns:  map[string][]map[string]any{},
		events:      map[string]any{},
		files:       map[string]any{},
		contents:    map[string]string{},
	}
}

func mosooThreadDoc(threadID, runID, runStatus string, runError map[string]any) map[string]any {
	var errorValue any
	if runError != nil {
		errorValue = runError
	}
	return map[string]any{
		"thread": map[string]any{
			"id":                  threadID,
			"agent_id":            "agent-1",
			"kind":                "cattle",
			"status":              "RUNNING",
			"client_external_ref": "analysis-1",
		},
		"run": map[string]any{
			"id":          runID,
			"status":      runStatus,
			"createdAt":   "2026-07-15T00:00:00.000Z",
			"startedAt":   "2026-07-15T00:00:01.000Z",
			"completedAt": nil,
			"updatedAt":   "2026-07-15T00:00:01.000Z",
			"trigger":     "user_prompt",
			"error":       errorValue,
		},
	}
}

func mosooEmptyEvents() map[string]any {
	return map[string]any{"events": []any{}, "truncated": false}
}

func mosooToolEvent(id, content, occurredAt string) map[string]any {
	return map[string]any{
		"id": id, "type": "tool.use.started", "status": "available",
		"content": content, "occurredAt": occurredAt, "durationMs": nil, "tokens": nil,
	}
}

func mosooArtifactFiles(analysisID string) map[string]any {
	entry := func(id, name string) map[string]any {
		return map[string]any{"id": id, "name": name, "kind": "artifact", "committed": true, "size": 20, "mimeType": nil}
	}
	return map[string]any{"files": []any{
		entry("f-analysis", "project-analysis-"+analysisID+".json"),
		entry("f-evidence", "runtime-evidence-"+analysisID+".json"),
		entry("f-report", "project-report-"+analysisID+".md"),
	}}
}

func (f *fakeMosoo) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.requests++
		path := r.URL.Path
		switch {
		case r.Method == http.MethodPost && path == "/agents/agent-1/threads":
			f.createCalls++
			raw, _ := io.ReadAll(r.Body)
			f.createKeys = append(f.createKeys, r.Header.Get("Idempotency-Key"))
			f.createBodies = append(f.createBodies, string(raw))
			status, payload := http.StatusOK, any(mosooThreadDoc("thread-1", "run-1", "running", nil))
			if f.onCreate != nil {
				status, payload = f.onCreate(f.createCalls)
			}
			writeMosooJSON(w, status, payload)
		case r.Method == http.MethodGet && strings.HasPrefix(path, "/threads/") && strings.HasSuffix(path, "/events"):
			threadID := strings.TrimSuffix(strings.TrimPrefix(path, "/threads/"), "/events")
			payload, ok := f.events[threadID]
			if !ok {
				payload = mosooEmptyEvents()
			}
			writeMosooJSON(w, http.StatusOK, payload)
		case r.Method == http.MethodGet && strings.HasPrefix(path, "/threads/") && strings.HasSuffix(path, "/files"):
			threadID := strings.TrimSuffix(strings.TrimPrefix(path, "/threads/"), "/files")
			payload, ok := f.files[threadID]
			if !ok {
				writeMosooJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"code": "not_found"}})
				return
			}
			writeMosooJSON(w, http.StatusOK, payload)
		case r.Method == http.MethodGet && strings.HasPrefix(path, "/threads/"):
			threadID := strings.TrimPrefix(path, "/threads/")
			runs := f.threadRuns[threadID]
			if len(runs) == 0 {
				writeMosooJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"code": "not_found"}})
				return
			}
			call := f.threadCalls[threadID]
			f.threadCalls[threadID] = call + 1
			if call >= len(runs) {
				call = len(runs) - 1
			}
			writeMosooJSON(w, http.StatusOK, runs[call])
		case r.Method == http.MethodGet && strings.HasPrefix(path, "/files/") && strings.HasSuffix(path, "/content"):
			fileID := strings.TrimSuffix(strings.TrimPrefix(path, "/files/"), "/content")
			content, ok := f.contents[fileID]
			if !ok {
				writeMosooJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"code": "not_found"}})
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(content))
		default:
			writeMosooJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"code": "not_found"}})
		}
	})
}

func validWorkerArtifacts(t *testing.T, analysisID, repoKey string) map[string]string {
	t.Helper()
	analysis, evidence := validProjectAnalysisMap(), validRuntimeEvidenceMap()
	analysis["analysis_id"] = analysisID
	evidence["analysis_id"] = analysisID
	analysis["repository"].(map[string]any)["repo_key"] = repoKey
	analysis["repository"].(map[string]any)["canonical_url"] = "https://github.com/" + repoKey
	evidence["repo_key"] = repoKey
	return map[string]string{
		"f-analysis": mustMarshalJSON(t, analysis),
		"f-evidence": mustMarshalJSON(t, evidence),
		"f-report":   "# Useful Tool\n\nA useful project.",
	}
}

func newTestProjectAnalysisWorker(t *testing.T, store *TursoStore, mosooURL string, mutate func(*Config)) (*ProjectAnalysisWorker, *recordingProjectPublisher) {
	t.Helper()
	config := Config{
		MosooAPIBase:                     mosooURL,
		MosooAPIToken:                    "test-token",
		MosooProjectAgentID:              "agent-1",
		MosooRequestTimeout:              15 * time.Second,
		ProjectAnalysisTimeout:           15 * time.Minute,
		ProjectAnalysisConcurrency:       3,
		ProjectAnalysisCreateMaxAttempts: 3,
		ProjectAnalysisCreateRetryBase:   5 * time.Second,
		MaxAttempts:                      5,
	}
	if mutate != nil {
		mutate(&config)
	}
	publisher := &recordingProjectPublisher{}
	worker := NewProjectAnalysisWorker(config, store, NewMosooClient(config), nil, publisher, nil)
	worker.poll = time.Millisecond
	return worker, publisher
}

func TestProjectAnalysisWorkerCompletesRun(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)

	mosoo := newFakeMosoo(t)
	mosoo.threadRuns["thread-1"] = []map[string]any{
		mosooThreadDoc("thread-1", "run-1", "running", nil),
		mosooThreadDoc("thread-1", "run-1", "completed", nil),
	}
	mosoo.events["thread-1"] = map[string]any{
		"events":    []any{mosooToolEvent("event-1", "git log --oneline", "2026-07-15T00:00:02.000Z")},
		"truncated": false,
	}
	mosoo.files["thread-1"] = mosooArtifactFiles("analysis-1")
	mosoo.contents = validWorkerArtifacts(t, "analysis-1", "owner/useful-tool")
	server := httptest.NewServer(mosoo.handler())
	defer server.Close()

	worker, _ := newTestProjectAnalysisWorker(t, store, server.URL, nil)
	disposition, reason := worker.process(context.Background(), ProjectAnalysisJob{ID: "analysis-1"})
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("disposition = %v reason = %q", disposition, reason)
	}

	run, err := store.GetProjectAnalysisRun(context.Background(), "analysis-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ProjectAnalysisStatusCompleted || run.Progress != 100 || run.Phase != "completed" {
		t.Fatalf("run = status %q phase %q progress %d", run.Status, run.Phase, run.Progress)
	}
	if run.MosooThreadID == nil || *run.MosooThreadID != "thread-1" {
		t.Fatalf("mosoo thread = %v", run.MosooThreadID)
	}
	foundHistory := false
	for _, activity := range run.Activities {
		if activity.Kind == "inspecting_history" {
			foundHistory = true
		}
	}
	if !foundHistory {
		t.Fatalf("activities = %#v", run.Activities)
	}
	assessment, err := store.GetProjectAssessment(context.Background(), "owner/useful-tool")
	if err != nil {
		t.Fatal(err)
	}
	if assessment == nil || assessment.LatestAnalysisID != "analysis-1" || assessment.ProductScore != 87 {
		t.Fatalf("assessment = %#v", assessment)
	}
	if len(mosoo.createBodies) != 1 {
		t.Fatalf("create calls = %d", len(mosoo.createBodies))
	}
	body := mosoo.createBodies[0]
	if !strings.Contains(body, `"userId":"ghfind"`) {
		t.Fatalf("create body = %s", body)
	}
	if !strings.Contains(body, "execution_mode: source_only") {
		t.Fatalf("create body = %s", body)
	}
	if mosoo.createKeys[0] != "ghfind-project-analysis-1" {
		t.Fatalf("idempotency key = %q", mosoo.createKeys[0])
	}
}

func TestProjectAnalysisWorkerUsesAllowlistedRuntimeMode(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)

	mosoo := newFakeMosoo(t)
	mosoo.threadRuns["thread-1"] = []map[string]any{
		mosooThreadDoc("thread-1", "run-1", "failed", map[string]any{"code": "agent.crashed", "message": "Agent crashed."}),
	}
	server := httptest.NewServer(mosoo.handler())
	defer server.Close()

	worker, _ := newTestProjectAnalysisWorker(t, store, server.URL, func(config *Config) {
		config.ProjectAnalysisRuntimeAllowlist = []string{"owner/useful-tool"}
	})
	disposition, _ := worker.process(context.Background(), ProjectAnalysisJob{ID: "analysis-1"})
	if disposition != workerCompleted {
		t.Fatalf("disposition = %v", disposition)
	}
	if len(mosoo.createBodies) != 1 || !strings.Contains(mosoo.createBodies[0], "execution_mode: allowlisted_runtime") {
		t.Fatalf("create bodies = %#v", mosoo.createBodies)
	}
	run, err := store.GetProjectAnalysisRun(context.Background(), "analysis-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ProjectAnalysisStatusFailed || run.ErrorCode == nil || *run.ErrorCode != "mosoo_run_failed" {
		t.Fatalf("run = status %q error %v", run.Status, run.ErrorCode)
	}
}

func TestProjectAnalysisWorkerCreateRetryBackoffAndExhaustion(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)

	mosoo := newFakeMosoo(t)
	mosoo.onCreate = func(int) (int, any) {
		return http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "internal_error", "message": "Public API request failed."},
		}
	}
	server := httptest.NewServer(mosoo.handler())
	defer server.Close()

	worker, publisher := newTestProjectAnalysisWorker(t, store, server.URL, func(config *Config) {
		config.ProjectAnalysisCreateMaxAttempts = 2
		config.ProjectAnalysisCreateRetryBase = time.Second
	})

	disposition, reason := worker.process(context.Background(), ProjectAnalysisJob{ID: "analysis-1"})
	if disposition != workerCompleted || reason != "deferred" {
		t.Fatalf("disposition = %v reason = %q", disposition, reason)
	}
	run, err := store.GetProjectAnalysisRun(context.Background(), "analysis-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ProjectAnalysisStatusQueued || run.CreateAttempts != 1 || run.CreateRetryAt == nil {
		t.Fatalf("run = status %q attempts %d retryAt %v", run.Status, run.CreateAttempts, run.CreateRetryAt)
	}
	if *run.CreateRetryAt <= time.Now().UnixMilli() {
		t.Fatalf("create retry is not in the future: %d", *run.CreateRetryAt)
	}
	// The parked delivery redrives itself through the delayed retry lane,
	// waking at the scheduled retry time without consuming the job's attempt
	// budget.
	if len(publisher.retries) != 1 {
		t.Fatalf("redrives = %#v", publisher.retries)
	}
	redrive := publisher.retries[0]
	if redrive.job.ID != "analysis-1" || redrive.job.Attempt != 0 {
		t.Fatalf("redrive job = %#v", redrive.job)
	}
	if redrive.delay <= 0 || redrive.delay > time.Second {
		t.Fatalf("redrive delay = %v", redrive.delay)
	}

	// Fast-forward the scheduled backoff: the next pass reclaims the slot and
	// exhausts the second (and final) create attempt.
	past := time.Now().Add(-time.Second).UnixMilli()
	if _, err := store.db.Exec(`UPDATE project_analysis_runs SET create_retry_at = ? WHERE id = ?`, past, "analysis-1"); err != nil {
		t.Fatal(err)
	}
	disposition, _ = worker.process(context.Background(), ProjectAnalysisJob{ID: "analysis-1"})
	if disposition != workerCompleted {
		t.Fatalf("disposition = %v", disposition)
	}
	run, err = store.GetProjectAnalysisRun(context.Background(), "analysis-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ProjectAnalysisStatusFailed || run.ErrorCode == nil || *run.ErrorCode != "mosoo_create_retry_exhausted" {
		t.Fatalf("run = status %q error %v", run.Status, run.ErrorCode)
	}
	if run.CreateAttempts != 2 || run.CreateRetryAt != nil {
		t.Fatalf("attempts = %d retryAt = %v", run.CreateAttempts, run.CreateRetryAt)
	}
	if mosoo.createCalls != 2 {
		t.Fatalf("create calls = %d", mosoo.createCalls)
	}
	// Exhaustion is terminal: no further redrive is published.
	if len(publisher.retries) != 1 {
		t.Fatalf("redrives after exhaustion = %#v", publisher.retries)
	}
}

func TestProjectAnalysisWorkerRedrivesSlotContentionPark(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	// Occupy every execution slot with a running analysis.
	for _, id := range []string{"busy-1", "busy-2", "busy-3"} {
		createTestRun(t, store, id, "owner/"+id, nil)
		if err := store.AttachMosooThread(context.Background(), AttachMosooThreadInput{
			AnalysisID: id, AgentID: "agent-1", ThreadID: "thread-" + id, RunID: "run-" + id,
		}); err != nil {
			t.Fatal(err)
		}
	}
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)

	mosoo := newFakeMosoo(t)
	server := httptest.NewServer(mosoo.handler())
	defer server.Close()

	worker, publisher := newTestProjectAnalysisWorker(t, store, server.URL, nil)
	disposition, reason := worker.process(context.Background(), ProjectAnalysisJob{ID: "analysis-1"})
	if disposition != workerCompleted || reason != "deferred" {
		t.Fatalf("disposition = %v reason = %q", disposition, reason)
	}
	// The run could not reserve a slot, so the delivery parks and republishes
	// the job on the fixed redrive interval instead of waiting for the
	// reconcile endpoint.
	if len(publisher.retries) != 1 {
		t.Fatalf("redrives = %#v", publisher.retries)
	}
	redrive := publisher.retries[0]
	if redrive.job.ID != "analysis-1" || redrive.job.Attempt != 0 {
		t.Fatalf("redrive job = %#v", redrive.job)
	}
	low := projectAnalysisDeferredRedriveDelay - projectAnalysisDeferredRedriveJitter
	high := projectAnalysisDeferredRedriveDelay + projectAnalysisDeferredRedriveJitter
	if redrive.delay < low || redrive.delay >= high {
		t.Fatalf("redrive delay = %v, want within [%v, %v)", redrive.delay, low, high)
	}
	// The parked run is untouched: still queued, no create attempt consumed,
	// and Mosoo was never called.
	run, err := store.GetProjectAnalysisRun(context.Background(), "analysis-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ProjectAnalysisStatusQueued || run.CreateAttempts != 0 {
		t.Fatalf("run = status %q attempts %d", run.Status, run.CreateAttempts)
	}
	if mosoo.createCalls != 0 {
		t.Fatalf("mosoo create calls = %d", mosoo.createCalls)
	}
}

func TestProjectAnalysisWorkerRetriesInactiveRuntimeOnce(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if err := store.AttachMosooThread(context.Background(), AttachMosooThreadInput{
		AnalysisID: "analysis-1", AgentID: "agent-1", ThreadID: "inactive-thread", RunID: "run-1",
	}); err != nil {
		t.Fatal(err)
	}

	mosoo := newFakeMosoo(t)
	mosoo.threadRuns["inactive-thread"] = []map[string]any{
		mosooThreadDoc("inactive-thread", "run-1", "failed", map[string]any{
			"code":    "runtime.inactive",
			"message": "Runtime session became inactive before the run completed.",
		}),
	}
	mosoo.onCreate = func(int) (int, any) {
		return http.StatusOK, mosooThreadDoc("retry-thread", "retry-run", "running", nil)
	}
	mosoo.threadRuns["retry-thread"] = []map[string]any{
		mosooThreadDoc("retry-thread", "retry-run", "completed", nil),
	}
	mosoo.files["retry-thread"] = mosooArtifactFiles("analysis-1")
	mosoo.contents = validWorkerArtifacts(t, "analysis-1", "owner/useful-tool")
	server := httptest.NewServer(mosoo.handler())
	defer server.Close()

	worker, _ := newTestProjectAnalysisWorker(t, store, server.URL, nil)
	disposition, _ := worker.process(context.Background(), ProjectAnalysisJob{ID: "analysis-1"})
	if disposition != workerCompleted {
		t.Fatalf("disposition = %v", disposition)
	}
	if len(mosoo.createKeys) != 1 || !strings.HasSuffix(mosoo.createKeys[0], "-retry-1") {
		t.Fatalf("create keys = %#v", mosoo.createKeys)
	}
	run, err := store.GetProjectAnalysisRun(context.Background(), "analysis-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ProjectAnalysisStatusCompleted {
		t.Fatalf("status = %q error %v", run.Status, run.ErrorCode)
	}
	if run.MosooThreadID == nil || *run.MosooThreadID != "retry-thread" {
		t.Fatalf("mosoo thread = %v", run.MosooThreadID)
	}
	if !strings.HasSuffix(run.IdempotencyKey, "-retry-1") {
		t.Fatalf("idempotency key = %q", run.IdempotencyKey)
	}
}

func TestProjectAnalysisWorkerExpiresTimedOutRun(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if err := store.AttachMosooThread(context.Background(), AttachMosooThreadInput{
		AnalysisID: "analysis-1", AgentID: "agent-1", ThreadID: "thread-1", RunID: "run-1",
	}); err != nil {
		t.Fatal(err)
	}
	stale := time.Now().Add(-20 * time.Minute).UnixMilli()
	if _, err := store.db.Exec(`UPDATE project_analysis_runs SET started_at = ? WHERE id = ?`, stale, "analysis-1"); err != nil {
		t.Fatal(err)
	}

	mosoo := newFakeMosoo(t)
	server := httptest.NewServer(mosoo.handler())
	defer server.Close()
	worker, _ := newTestProjectAnalysisWorker(t, store, server.URL, nil)
	disposition, _ := worker.process(context.Background(), ProjectAnalysisJob{ID: "analysis-1"})
	if disposition != workerCompleted {
		t.Fatalf("disposition = %v", disposition)
	}
	run, err := store.GetProjectAnalysisRun(context.Background(), "analysis-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ProjectAnalysisStatusExpired || run.ErrorCode == nil || *run.ErrorCode != "analysis_timeout" {
		t.Fatalf("run = status %q error %v", run.Status, run.ErrorCode)
	}
	if mosoo.requests != 0 {
		t.Fatalf("mosoo requests = %d", mosoo.requests)
	}
}

func TestProjectAnalysisWorkerFailsInvalidArtifacts(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if err := store.AttachMosooThread(context.Background(), AttachMosooThreadInput{
		AnalysisID: "analysis-1", AgentID: "agent-1", ThreadID: "thread-1", RunID: "run-1",
	}); err != nil {
		t.Fatal(err)
	}

	mosoo := newFakeMosoo(t)
	mosoo.threadRuns["thread-1"] = []map[string]any{
		mosooThreadDoc("thread-1", "run-1", "completed", nil),
	}
	mosoo.files["thread-1"] = mosooArtifactFiles("analysis-1")
	contents := validWorkerArtifacts(t, "analysis-1", "owner/useful-tool")
	// An artifact written for a different analysis must never finalize.
	contents["f-analysis"] = strings.Replace(contents["f-analysis"], "analysis-1", "analysis-other", 1)
	mosoo.contents = contents
	server := httptest.NewServer(mosoo.handler())
	defer server.Close()

	worker, _ := newTestProjectAnalysisWorker(t, store, server.URL, nil)
	disposition, _ := worker.process(context.Background(), ProjectAnalysisJob{ID: "analysis-1"})
	if disposition != workerCompleted {
		t.Fatalf("disposition = %v", disposition)
	}
	run, err := store.GetProjectAnalysisRun(context.Background(), "analysis-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ProjectAnalysisStatusFailed || run.ErrorCode == nil || *run.ErrorCode != "artifact_invalid" {
		t.Fatalf("run = status %q error %v", run.Status, run.ErrorCode)
	}
}

func TestProjectAnalysisWorkerFailsWaitingInput(t *testing.T) {
	store := openProjectAnalysisTestStore(t)
	createTestRun(t, store, "analysis-1", "owner/useful-tool", nil)
	if err := store.AttachMosooThread(context.Background(), AttachMosooThreadInput{
		AnalysisID: "analysis-1", AgentID: "agent-1", ThreadID: "thread-1", RunID: "run-1",
	}); err != nil {
		t.Fatal(err)
	}

	mosoo := newFakeMosoo(t)
	mosoo.threadRuns["thread-1"] = []map[string]any{
		mosooThreadDoc("thread-1", "run-1", "waiting_input", nil),
	}
	server := httptest.NewServer(mosoo.handler())
	defer server.Close()
	worker, _ := newTestProjectAnalysisWorker(t, store, server.URL, nil)
	disposition, _ := worker.process(context.Background(), ProjectAnalysisJob{ID: "analysis-1"})
	if disposition != workerCompleted {
		t.Fatalf("disposition = %v", disposition)
	}
	run, err := store.GetProjectAnalysisRun(context.Background(), "analysis-1")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != ProjectAnalysisStatusFailed || run.ErrorCode == nil || *run.ErrorCode != "unexpected_input_request" {
		t.Fatalf("run = status %q error %v", run.Status, run.ErrorCode)
	}
}
