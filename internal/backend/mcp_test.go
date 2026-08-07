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

type mcpFixtureStatus struct {
	*fakeStatusStore
	limit RateLimitResult
	calls int
}

func (s *mcpFixtureStatus) LimitMCP(context.Context, string, time.Time) (RateLimitResult, error) {
	s.calls++
	return s.limit, nil
}

type mcpCachedStatus struct {
	*mcpFixtureStatus
	cached *ScanResult
}

func (s *mcpCachedStatus) GetCachedScan(context.Context, string) (*ScanResult, error) {
	return s.cached, nil
}
func (s *mcpCachedStatus) SetCachedScan(_ context.Context, _ string, scan ScanResult) error {
	s.cached = &scan
	return nil
}

func postMCP(t *testing.T, server *APIServer, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	request.Header.Set("Accept", "application/json, text/event-stream")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	return response
}

func mcpSSEPayload(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("status=%d headers=%v body=%q", response.Code, response.Header(), response.Body.String())
	}
	encoded := strings.TrimSuffix(strings.TrimPrefix(response.Body.String(), "data: "), "\n\n")
	var payload map[string]any
	if err := json.Unmarshal([]byte(encoded), &payload); err != nil {
		t.Fatalf("decode SSE %q: %v", encoded, err)
	}
	return payload
}

func TestMCPInitializeAndToolsListKeepStatelessSSEContract(t *testing.T) {
	statuses := &mcpFixtureStatus{fakeStatusStore: &fakeStatusStore{}, limit: RateLimitResult{Success: true}}
	server := NewAPIServer(Config{}, fakeScoreStore{}, statuses, &fakePublisher{})
	initialize := mcpSSEPayload(t, postMCP(t, server, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`))
	result, ok := initialize["result"].(map[string]any)
	if !ok || result["protocolVersion"] != "2025-03-26" || result["serverInfo"].(map[string]any)["name"] != "ghfind" {
		t.Fatalf("initialize=%#v", initialize)
	}
	tools := mcpSSEPayload(t, postMCP(t, server, `{"jsonrpc":"2.0","id":"tools","method":"tools/list","params":{}}`))
	toolResult, ok := tools["result"].(map[string]any)
	if !ok || len(toolResult["tools"].([]any)) != 5 {
		t.Fatalf("tools=%#v", tools)
	}
	if statuses.calls != 0 {
		t.Fatalf("tools/list must not spend a tool-call budget: %d", statuses.calls)
	}
}

func TestMCPRateLimitsBeforeScoreReadAndReturnsToolError(t *testing.T) {
	store := &fakeScoreReadStore{detail: canonicalScoreDetail()}
	statuses := &mcpFixtureStatus{fakeStatusStore: &fakeStatusStore{}, limit: RateLimitResult{Success: false}}
	server := NewAPIServer(Config{}, store, statuses, &fakePublisher{})
	payload := mcpSSEPayload(t, postMCP(t, server, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"score_user","arguments":{"username":"octocat"}}}`))
	result := payload["result"].(map[string]any)
	if statuses.calls != 1 || store.readCalls != 0 || result["isError"] != true {
		t.Fatalf("payload=%#v calls=%d reads=%d", payload, statuses.calls, store.readCalls)
	}
	content := result["content"].([]any)[0].(map[string]any)["text"]
	if content != "rate_limited: too many requests, slow down and retry in a minute" {
		t.Fatalf("content=%q", content)
	}
}

func TestMCPScoreAndScanReuseCanonicalReadsAndScanCache(t *testing.T) {
	metrics := RawMetrics{Username: "octocat", AccountAgeYears: 4, NonemptyOriginalRepoCount: 1, ContributionYearsActive: 2}
	scan := &ScanResult{Metrics: metrics, TopRepos: []TopRepo{}, RecentPRs: []RecentPR{}, FloodPRTitles: []string{}, Scoring: Score(metrics)}
	store := &fakeScoreReadScanStore{fakeScoreReadStore: fakeScoreReadStore{detail: canonicalScoreDetail()}}
	statuses := &mcpCachedStatus{
		mcpFixtureStatus: &mcpFixtureStatus{fakeStatusStore: &fakeStatusStore{}, limit: RateLimitResult{Success: true}},
		cached:           scan,
	}
	server := NewAPIServer(Config{PublicSiteURL: "https://ghfind.example"}, store, statuses, &fakePublisher{})
	score := mcpSSEPayload(t, postMCP(t, server, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"score_user","arguments":{"username":"octocat"}}}`))
	scoreText := score["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(scoreText, `"source": "indexed"`) || store.readCalls != 1 {
		t.Fatalf("score=%s reads=%d", scoreText, store.readCalls)
	}
	scanPayload := mcpSSEPayload(t, postMCP(t, server, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"scan_user","arguments":{"username":"octocat"}}}`))
	scanText := scanPayload["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(scanText, `"username": "octocat"`) || store.persisted != 1 {
		t.Fatalf("scan=%s persisted=%d", scanText, store.persisted)
	}
}
