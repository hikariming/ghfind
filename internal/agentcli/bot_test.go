package agentcli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	testBotToken = "ghf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testCleanup  = "11111111-2222-3333-4444-555555555555"
)

type botCall struct {
	Method string
	Path   string
	Auth   string
	Body   map[string]any
}

// botServer answers each request with the next scripted reply.
func botServer(t *testing.T, replies []func(w http.ResponseWriter)) (*httptest.Server, *[]botCall) {
	t.Helper()
	calls := &[]botCall{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := botCall{Method: r.Method, Path: r.URL.Path, Auth: r.Header.Get("Authorization")}
		_ = json.NewDecoder(r.Body).Decode(&call.Body)
		*calls = append(*calls, call)
		if len(*calls) > len(replies) {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(500)
			return
		}
		replies[len(*calls)-1](w)
	}))
	t.Cleanup(server.Close)
	return server, calls
}

func reply(status int, body any) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
}

func runBotArgs(server *httptest.Server, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	full := append([]string{"bot"}, args...)
	full = append(full, "--bot-host", server.URL, "--api-key", testBotToken)
	code := Execute(full, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestBotRequiresPersonalToken(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Execute([]string{"bot", "status", "o/r", "--api-key", "machine-key", "--bot-host", "http://127.0.0.1:1"}, &stdout, &stderr)
	if code != 1 || !strings.Contains(stderr.String(), "personal API token") {
		t.Fatalf("expected personal token error, got %d %q", code, stderr.String())
	}
}

func TestBotSettingsSetPatchesOnlyGivenFields(t *testing.T) {
	server, calls := botServer(t, []func(http.ResponseWriter){reply(200, map[string]any{"settings": map[string]any{}})})
	code, _, stderr := runBotArgs(server, "settings", "set", "o/r", "--triage", "on", "--allowed-labels", "bug, feature")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	got := (*calls)[0]
	if got.Method != http.MethodPatch || got.Path != "/api/v1/repos/o/r/settings" || got.Auth != "Bearer "+testBotToken {
		t.Fatalf("unexpected call %+v", got)
	}
	labels, _ := got.Body["allowed_labels"].([]any)
	if got.Body["triage_enabled"] != true || len(labels) != 2 || len(got.Body) != 2 {
		t.Fatalf("unexpected patch %+v", got.Body)
	}
}

func TestBotErrorsCarryAPICode(t *testing.T) {
	server, _ := botServer(t, []func(http.ResponseWriter){reply(403, map[string]any{"error": "admin_required"})})
	code, _, stderr := runBotArgs(server, "pause", "o/r")
	if code != 1 || !strings.Contains(stderr, "admin_required") {
		t.Fatalf("expected admin_required, got %d %q", code, stderr)
	}
}

func TestBotScanOnlyTokenExplainsOptInWithoutRetrying(t *testing.T) {
	server, calls := botServer(t, []func(http.ResponseWriter){reply(403, map[string]any{"error": "token_scope_required"})})
	code, _, stderr := runBotArgs(server, "pause", "o/r")
	if code != 1 || !strings.Contains(stderr, "(token_scope_required)") || !strings.Contains(stderr, `create a new token with "Manage the ghfind Review bot" at https://ghfind.com/integrations`) {
		t.Fatalf("expected bot permission instructions, got %d %q", code, stderr)
	}
	if len(*calls) != 1 {
		t.Fatalf("must not retry an unauthorized action: %+v", *calls)
	}
}

func TestBotCleanupPreviewThenConfirm(t *testing.T) {
	botPoll = time.Millisecond
	token := testCleanup + ".bbbbbbbbbbbbbbbbbbbbbbbb"
	server, calls := botServer(t, []func(http.ResponseWriter){
		reply(202, map[string]any{"cleanup": map[string]any{"id": testCleanup, "state": "planning"}, "confirm_token": token}),
		reply(200, map[string]any{"cleanup": map[string]any{"id": testCleanup, "state": "planning"}}),
		reply(200, map[string]any{"cleanup": map[string]any{"id": testCleanup, "state": "planned", "summary": map[string]any{"review_labels": 2, "bot_active": true}}}),
		reply(202, map[string]any{"cleanup": map[string]any{"id": testCleanup, "state": "running"}}),
	})
	code, stdout, stderr := runBotArgs(server, "cleanup", "o/r", "--labels", "review", "--comments")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	if !strings.Contains(stdout, "ghfind bot cleanup confirm o/r "+token) || !strings.Contains(stdout, "review: labels 2") || !strings.Contains(stdout, "bot pause") {
		t.Fatalf("unexpected preview output %q", stdout)
	}
	if body := (*calls)[0].Body; body["labels"] != "review" || body["comments"] != true || body["delete_label_definitions"] != false {
		t.Fatalf("unexpected cleanup body %+v", body)
	}
	code, stdout, stderr = runBotArgs(server, "cleanup", "confirm", "o/r", token, "-o", "json")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	confirm := (*calls)[3]
	if confirm.Path != "/api/v1/repos/o/r/cleanups/"+testCleanup+"/confirm" || confirm.Body["token"] != token {
		t.Fatalf("unexpected confirm call %+v", confirm)
	}
	if !strings.Contains(stdout, `"state": "running"`) {
		t.Fatalf("unexpected confirm output %q", stdout)
	}
}

func TestBotValidatesArgumentsLocally(t *testing.T) {
	server, calls := botServer(t, nil)
	for _, args := range [][]string{{"status", "not-a-repo"}, {"backfill", "o/r", "-n", "500"}, {"cleanup", "confirm", "o/r", "nope"}, {"status", "o/r", "--bogus"}} {
		if code, _, _ := runBotArgs(server, args...); code != 1 {
			t.Fatalf("expected failure for %v", args)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("expected no requests, got %d", len(*calls))
	}
}

func TestCommandsShowBotCleanup(t *testing.T) {
	var stdout bytes.Buffer
	if code := Execute([]string{"commands", "show", "bot", "cleanup", "--json"}, &stdout, &bytes.Buffer{}); code != 0 {
		t.Fatalf("Execute returned %d", code)
	}
	var payload CommandInfo
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Name != "bot cleanup" || !strings.Contains(payload.AgentGuidance, "preview") {
		t.Fatalf("unexpected catalog entry %+v", payload)
	}
}

func TestBotRefusesPlainHTTPHost(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Execute([]string{"bot", "status", "o/r", "--api-key", testBotToken, "--bot-host", "http://evil.example"}, &stdout, &stderr)
	if code != 1 || !strings.Contains(stderr.String(), "https") {
		t.Fatalf("expected https error, got %d %q", code, stderr.String())
	}
	if host, err := botHost("http://localhost:8787/"); err != nil || host != "http://localhost:8787" {
		t.Fatalf("unexpected localhost result %q %v", host, err)
	}
}

func TestVersionWordAsFlagValue(t *testing.T) {
	_, opts, err := parseArgs([]string{"bot", "settings", "set", "o/r", "--prompt", "version"})
	if err != nil || opts.Version {
		t.Fatalf("version as a value must not trigger --version: %v %+v", err, opts.Version)
	}
	_, opts, _ = parseArgs([]string{"version"})
	if !opts.Version {
		t.Fatal("bare version command must still work")
	}
}

func TestBotWaitSurvivesQuotaPause(t *testing.T) {
	botPoll = time.Millisecond
	token := testCleanup + ".bbbbbbbbbbbbbbbbbbbbbbbb"
	server, _ := botServer(t, []func(http.ResponseWriter){
		reply(202, map[string]any{"cleanup": map[string]any{"id": testCleanup, "state": "running"}}),
		reply(503, map[string]any{"error": "github_rate_limited"}),
		reply(429, map[string]any{"error": "rate_limited"}),
		reply(200, map[string]any{"cleanup": map[string]any{"id": testCleanup, "state": "done"}}),
	})
	code, stdout, stderr := runBotArgs(server, "cleanup", "confirm", "o/r", token, "--wait", "-o", "json")
	if code != 0 || !strings.Contains(stdout, `"state": "done"`) {
		t.Fatalf("expected done after quota pause, got %d %q %q", code, stdout, stderr)
	}
}

func TestBotNoConfirmHintWhenNothingToClean(t *testing.T) {
	botPoll = time.Millisecond
	server, _ := botServer(t, []func(http.ResponseWriter){
		reply(202, map[string]any{"cleanup": map[string]any{"id": testCleanup, "state": "planning"}, "confirm_token": testCleanup + ".x"}),
		reply(200, map[string]any{"cleanup": map[string]any{"id": testCleanup, "state": "done", "result": "Nothing to clean up"}}),
	})
	code, stdout, _ := runBotArgs(server, "cleanup", "o/r", "--labels", "triage")
	if code != 0 || strings.Contains(stdout, "cleanup confirm") || !strings.Contains(stdout, "Nothing has been changed.") {
		t.Fatalf("unexpected output %d %q", code, stdout)
	}
}

func TestBotErrorShowsHTTPStatus(t *testing.T) {
	server, _ := botServer(t, []func(http.ResponseWriter){reply(404, map[string]any{"error": "not_found"})})
	_, _, stderr := runBotArgs(server, "status", "o/r")
	if !strings.Contains(stderr, "HTTP 404 (not_found)") {
		t.Fatalf("unexpected stderr %q", stderr)
	}
}
