package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// These tests mirror src/lib/__tests__/mosoo-project-analysis.test.ts against
// the Go client.

func mosooTestRun() *ProjectAnalysisRun {
	return &ProjectAnalysisRun{
		ID:             "analysis-1",
		RepoKey:        "owner/repo",
		CanonicalURL:   "https://github.com/owner/repo",
		IdempotencyKey: "ghfind-project-analysis-1",
		SchemaVersion:  "ghfind.project-analysis.v2",
		RubricVersion:  "project-value-v1",
		AgentVersion:   "project-evaluator-v2",
		SkillVersion:   "ghfind-project-evaluator-v3",
	}
}

func mosooTestConfig(base string) Config {
	return Config{
		MosooAPIBase:        base,
		MosooAPIToken:       "test-token",
		MosooProjectAgentID: "agent-1",
		MosooRequestTimeout: 15 * time.Second,
	}
}

func mosooThreadResponse(kind, status string, runError map[string]any) map[string]any {
	var errorValue any
	if runError != nil {
		errorValue = runError
	}
	return map[string]any{
		"thread": map[string]any{
			"id":                  "thread-1",
			"agent_id":            "agent-1",
			"kind":                kind,
			"status":              "RUNNING",
			"client_external_ref": "analysis-1",
		},
		"run": map[string]any{
			"id":          "run-1",
			"status":      status,
			"createdAt":   "2026-07-15T00:00:00.000Z",
			"startedAt":   "2026-07-15T00:00:01.000Z",
			"completedAt": nil,
			"updatedAt":   "2026-07-15T00:00:01.000Z",
			"trigger":     "user_prompt",
			"error":       errorValue,
		},
	}
}

func writeMosooJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func TestMosooCreateThreadSendsVersionedPromptAndIdempotencyKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/agents/agent-1/threads" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("Idempotency-Key"); got != "ghfind-project-analysis-1" {
			t.Errorf("Idempotency-Key = %q", got)
		}
		var body struct {
			UserID string `json:"userId"`
			Input  struct {
				Type    string `json:"type"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		if body.UserID != "ghfind" {
			t.Errorf("userId = %q, want the configured Mosoo user id", body.UserID)
		}
		if len(body.Input.Content) != 1 {
			t.Fatalf("prompt content entries = %d", len(body.Input.Content))
		}
		prompt := body.Input.Content[0].Text
		for _, line := range []string{
			"[GHFIND_PROJECT_ANALYSIS_V2]",
			"analysis_id: analysis-1",
			"repository_url: https://github.com/owner/repo",
			"requested_ref: ",
			"execution_mode: source_only",
			"rubric_version: project-value-v1",
			"schema_version: ghfind.project-analysis.v2",
			"artifact_prefix: project-analysis-analysis-1",
			"locale: zh-CN",
		} {
			if !strings.Contains(prompt, line) {
				t.Errorf("prompt is missing %q:\n%s", line, prompt)
			}
		}
		writeMosooJSON(w, http.StatusOK, mosooThreadResponse("cattle", "running", nil))
	}))
	defer server.Close()

	client := NewMosooClient(mosooTestConfig(server.URL))
	snapshot, err := client.CreateProjectAnalysisThread(context.Background(), mosooTestRun(), "source_only")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ThreadID != "thread-1" || snapshot.RunID != "run-1" ||
		snapshot.RunStatus != "running" || snapshot.Kind != "cattle" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
}

func TestMosooCreateThreadRejectsPetAgent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeMosooJSON(w, http.StatusOK, mosooThreadResponse("pet", "running", nil))
	}))
	defer server.Close()
	client := NewMosooClient(mosooTestConfig(server.URL))
	_, err := client.CreateProjectAnalysisThread(context.Background(), mosooTestRun(), "source_only")
	var mosooErr *MosooError
	if !errors.As(err, &mosooErr) || mosooErr.Code != MosooInvalidResponse {
		t.Fatalf("error = %v", err)
	}
}

func TestMosooErrorMapping(t *testing.T) {
	cases := []struct {
		status        int
		code          string
		retryAfter    string
		expectedAfter int
	}{
		{http.StatusUnauthorized, MosooUnauthenticated, "", 0},
		{http.StatusForbidden, MosooForbidden, "", 0},
		{http.StatusNotFound, MosooForbidden, "", 0},
		{http.StatusConflict, MosooNotReady, "", 0},
		{http.StatusTooManyRequests, MosooRateLimited, "12", 12},
		{http.StatusInternalServerError, MosooUnavailable, "", 0},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("%d", tc.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if tc.retryAfter != "" {
					w.Header().Set("Retry-After", tc.retryAfter)
				}
				writeMosooJSON(w, tc.status, map[string]any{
					"error": map[string]any{"code": "upstream", "message": "Slow down"},
				})
			}))
			defer server.Close()
			client := NewMosooClient(mosooTestConfig(server.URL))
			_, err := client.GetProjectAnalysisSnapshot(context.Background(), "thread-1")
			var mosooErr *MosooError
			if !errors.As(err, &mosooErr) {
				t.Fatalf("error = %v", err)
			}
			if mosooErr.Code != tc.code {
				t.Fatalf("code = %q, want %q", mosooErr.Code, tc.code)
			}
			if mosooErr.RetryAfterSeconds != tc.expectedAfter {
				t.Fatalf("RetryAfterSeconds = %d, want %d", mosooErr.RetryAfterSeconds, tc.expectedAfter)
			}
			if mosooErr.Message != "Slow down" {
				t.Fatalf("message = %q", mosooErr.Message)
			}
			if strings.Contains(mosooErr.Error(), "test-token") {
				t.Fatal("error leaks the API token")
			}
		})
	}
}

func TestMosooActivitiesAreDeduplicatedAndSafe(t *testing.T) {
	events := []mosooEvent{
		{ID: "event-1", Type: "tool.use.started", Status: "available", Content: "git log --format='%H' && printenv SECRET_TOKEN", OccurredAt: "2026-07-15T00:00:01.000Z"},
		{ID: "event-2", Type: "tool.use.completed", Status: "available", Content: "git shortlog -sn", OccurredAt: "2026-07-15T00:00:02.000Z"},
		{ID: "event-3", Type: "tool.use.started", Status: "available", Content: "python skills/ghfind-project-evaluator/scripts/validate_artifacts.py", OccurredAt: "2026-07-15T00:00:03.000Z"},
	}
	activities := PublicProjectAnalysisActivities(events)
	if len(activities) != 2 {
		t.Fatalf("activities = %#v", activities)
	}
	if activities[0].Kind != "inspecting_history" || activities[0].ID != "event-1" {
		t.Fatalf("activities[0] = %#v", activities[0])
	}
	if activities[1].Kind != "validating" || activities[1].ID != "event-3" {
		t.Fatalf("activities[1] = %#v", activities[1])
	}
	encoded, err := json.Marshal(activities)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "SECRET_TOKEN") {
		t.Fatal("activities leak raw event content")
	}
}

func TestMosooActivitiesKeepOnlyLastEight(t *testing.T) {
	events := []mosooEvent{}
	for i := 0; i < 10; i++ {
		events = append(events, mosooEvent{
			ID:         fmt.Sprintf("event-%d", i),
			Type:       "tool.use.started",
			Status:     "available",
			Content:    fmt.Sprintf("git log -%d && sleep 0.%d", i, i),
			OccurredAt: fmt.Sprintf("2026-07-15T00:00:%02d.000Z", i),
		})
		// Break the adjacency so every event survives dedupe.
		events = append(events, mosooEvent{
			ID:         fmt.Sprintf("event-%d-docs", i),
			Type:       "tool.use.started",
			Status:     "available",
			Content:    "cat README.md",
			OccurredAt: fmt.Sprintf("2026-07-15T00:00:%02d.500Z", i),
		})
	}
	activities := PublicProjectAnalysisActivities(events)
	if len(activities) != 8 {
		t.Fatalf("len(activities) = %d", len(activities))
	}
	if activities[0].ID != "event-6" {
		t.Fatalf("oldest kept activity = %#v", activities[0])
	}
}

func TestMosooSnapshotMapsRunErrorAndActivities(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/threads/thread-1":
			writeMosooJSON(w, http.StatusOK, mosooThreadResponse("cattle", "failed", map[string]any{
				"code":    "runtime.inactive",
				"message": "Runtime session became inactive before the run completed.",
			}))
		case r.URL.Path == "/threads/thread-1/events":
			if r.URL.Query().Get("limit") != "100" {
				t.Errorf("events limit = %q", r.URL.RawQuery)
			}
			writeMosooJSON(w, http.StatusOK, map[string]any{
				"events": []map[string]any{{
					"id": "event-1", "type": "session_files.updated", "status": "available",
					"content": "Session files updated.", "occurredAt": "2026-07-15T00:00:02.000Z",
					"durationMs": 1, "tokens": nil,
				}},
				"truncated": false,
			})
		default:
			writeMosooJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"code": "not_found"}})
		}
	}))
	defer server.Close()
	client := NewMosooClient(mosooTestConfig(server.URL))
	snapshot, err := client.GetProjectAnalysisSnapshot(context.Background(), "thread-1")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.RunStatus != "failed" || snapshot.RunError == nil || snapshot.RunError.Code != "runtime.inactive" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	if len(snapshot.EventTypes) != 1 || snapshot.EventTypes[0] != "session_files.updated" {
		t.Fatalf("eventTypes = %#v", snapshot.EventTypes)
	}
	if len(snapshot.Activities) != 1 || snapshot.Activities[0].Kind != "saving" {
		t.Fatalf("activities = %#v", snapshot.Activities)
	}
}

func TestMosooSnapshotRejectsInvalidPayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/events") {
			writeMosooJSON(w, http.StatusOK, map[string]any{"events": []any{}, "truncated": false})
			return
		}
		writeMosooJSON(w, http.StatusOK, map[string]any{"thread": map[string]any{"id": "thread-1"}})
	}))
	defer server.Close()
	client := NewMosooClient(mosooTestConfig(server.URL))
	_, err := client.GetProjectAnalysisSnapshot(context.Background(), "thread-1")
	var mosooErr *MosooError
	if !errors.As(err, &mosooErr) || mosooErr.Code != MosooInvalidResponse {
		t.Fatalf("error = %v", err)
	}
}

func TestMosooReadArtifactsMatchesExactCommittedNames(t *testing.T) {
	contents := map[string]string{
		"analysis-file": "{\"analysis\":true}",
		"evidence-file": "{\"evidence\":true}",
		"report-file":   "# Report",
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/threads/thread-1/files" {
			writeMosooJSON(w, http.StatusOK, map[string]any{
				"files": []map[string]any{
					// Decoys: uncommitted, attachment, and near-miss names must
					// never satisfy the exact artifact lookup.
					{"id": "decoy-1", "name": "project-analysis-analysis-1.json", "kind": "artifact", "committed": false, "size": 20, "mimeType": nil},
					{"id": "decoy-2", "name": "project-analysis-analysis-1.json", "kind": "attachment", "committed": true, "size": 20, "mimeType": nil},
					{"id": "decoy-3", "name": "project-analysis-analysis-1.json.bak", "kind": "artifact", "committed": true, "size": 20, "mimeType": nil},
					{"id": "analysis-file", "name": "project-analysis-analysis-1.json", "kind": "artifact", "committed": true, "size": 20, "mimeType": "application/json"},
					{"id": "evidence-file", "name": "runtime-evidence-analysis-1.json", "kind": "artifact", "committed": true, "size": 20, "mimeType": "application/json"},
					{"id": "report-file", "name": "project-report-analysis-1.md", "kind": "artifact", "committed": true, "size": 20, "mimeType": "text/markdown"},
				},
			})
			return
		}
		for id, content := range contents {
			if r.URL.Path == "/files/"+id+"/content" {
				if r.URL.Query().Get("disposition") != "inline" {
					t.Errorf("disposition = %q", r.URL.RawQuery)
				}
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(content))
				return
			}
		}
		writeMosooJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"code": "not_found"}})
	}))
	defer server.Close()
	client := NewMosooClient(mosooTestConfig(server.URL))
	artifacts, err := client.ReadProjectAnalysisArtifacts(context.Background(), "thread-1", "analysis-1")
	if err != nil {
		t.Fatal(err)
	}
	if artifacts.AnalysisJSON != "{\"analysis\":true}" ||
		artifacts.EvidenceJSON != "{\"evidence\":true}" ||
		artifacts.ReportMarkdown != "# Report" {
		t.Fatalf("artifacts = %#v", artifacts)
	}
}

func TestMosooReadArtifactsReportsMissingArtifact(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeMosooJSON(w, http.StatusOK, map[string]any{
			"files": []map[string]any{
				{"id": "analysis-file", "name": "project-analysis-analysis-1.json", "kind": "artifact", "committed": true, "size": 20, "mimeType": nil},
			},
		})
	}))
	defer server.Close()
	client := NewMosooClient(mosooTestConfig(server.URL))
	_, err := client.ReadProjectAnalysisArtifacts(context.Background(), "thread-1", "analysis-1")
	var mosooErr *MosooError
	if !errors.As(err, &mosooErr) || mosooErr.Code != MosooArtifactMissing {
		t.Fatalf("error = %v", err)
	}
}

func TestMosooMissingTokenAndAgent(t *testing.T) {
	client := NewMosooClient(Config{MosooAPIBase: "http://127.0.0.1:1", MosooProjectAgentID: "agent-1", MosooRequestTimeout: time.Second})
	_, err := client.GetProjectAnalysisSnapshot(context.Background(), "thread-1")
	var mosooErr *MosooError
	if !errors.As(err, &mosooErr) || mosooErr.Code != MosooUnauthenticated {
		t.Fatalf("error = %v", err)
	}
	client = NewMosooClient(Config{MosooAPIBase: "http://127.0.0.1:1", MosooAPIToken: "token", MosooRequestTimeout: time.Second})
	_, err = client.CreateProjectAnalysisThread(context.Background(), mosooTestRun(), "source_only")
	if !errors.As(err, &mosooErr) || mosooErr.Code != MosooNotReady {
		t.Fatalf("error = %v", err)
	}
}
