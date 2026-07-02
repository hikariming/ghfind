package agentcli

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCommandsJSONIncludesAgentGuidance(t *testing.T) {
	var stdout bytes.Buffer
	code := Execute([]string{"commands", "show", "roast", "--json"}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}

	var payload CommandInfo
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Name != "roast" {
		t.Fatalf("expected roast command, got %q", payload.Name)
	}
	if payload.AgentGuidance == "" || payload.ResponseSemantics == "" {
		t.Fatalf("expected agent guidance and response semantics in catalog")
	}
}

func TestCommandsShowAcceptsMultiWordCommand(t *testing.T) {
	var stdout bytes.Buffer
	code := Execute([]string{"commands", "show", "update", "check", "--json"}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}

	var payload CommandInfo
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Name != "update check" {
		t.Fatalf("expected update check command, got %q", payload.Name)
	}
}

func TestRoastCommandCallsScanThenRoast(t *testing.T) {
	var paths []string
	meta := map[string]any{
		"final_score": 71,
		"tier":        "人上人",
		"tier_label":  "优质贡献者",
		"delta":       3,
		"roast_line":  map[string]any{"zh": "中文点评", "en": "English roast"},
	}
	metaBytes, _ := json.Marshal(meta)
	encodedMeta := base64.StdEncoding.EncodeToString(metaBytes)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		switch r.URL.Path {
		case "/api/scan":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"metrics":{"username":"DemoDev"},
				"scoring":{"final_score":68,"tier":"NPC","tier_label":"普通账号"}
			}`))
		case "/api/roast":
			w.Header().Set(roastMetaHeader, encodedMeta)
			_, _ = w.Write([]byte("## Demo\nReport\n"))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	var stdout bytes.Buffer
	code := Execute([]string{"roast", "DemoDev", "--host", server.URL, "--lang", "zh", "-o", "json"}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}
	if len(paths) != 2 || paths[0] != "/api/scan" || paths[1] != "/api/roast" {
		t.Fatalf("unexpected paths: %#v", paths)
	}

	var payload map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["report"] != "## Demo\nReport" || payload["final_score"] != float64(71) {
		t.Fatalf("unexpected roast payload: %#v", payload)
	}
}

func TestDiscoveryCommandsCallGETAPIs(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.RequestURI())
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/stats":
			_, _ = w.Write([]byte(`{"total":123,"cached":true}`))
		case "/api/leaderboard":
			_, _ = w.Write([]byte(`{"entries":[],"cached":true,"view":"score","window":"7d"}`))
		case "/api/developers":
			_, _ = w.Write([]byte(`{"type":"language","categories":[]}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	commands := [][]string{
		{"stats", "--host", server.URL, "-o", "json"},
		{"leaderboard", "--host", server.URL, "--view", "score", "--window", "7d", "-o", "json"},
		{"developers", "--host", server.URL, "--type", "language", "-o", "json"},
	}
	for _, args := range commands {
		var stdout bytes.Buffer
		code := Execute(args, &stdout, &bytes.Buffer{})
		if code != 0 {
			t.Fatalf("%v returned %d", args, code)
		}
		if !json.Valid(stdout.Bytes()) {
			t.Fatalf("%v did not return json: %s", args, stdout.String())
		}
	}

	want := []string{
		"/api/stats",
		"/api/leaderboard?view=score&window=7d",
		"/api/developers?type=language",
	}
	for i := range want {
		if paths[i] != want[i] {
			t.Fatalf("path %d: want %q, got %q", i, want[i], paths[i])
		}
	}
}

func TestUpdateCheckReportsAvailableRelease(t *testing.T) {
	oldVersion := Version
	Version = "0.1.0"
	defer func() { Version = oldVersion }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/latest" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tag_name":"v0.2.0","html_url":"https://example.test/releases/v0.2.0"}`))
	}))
	defer server.Close()

	var stdout bytes.Buffer
	code := Execute([]string{"update", "check", "--release-url", server.URL + "/latest", "-o", "json"}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}

	var payload UpdateInfo
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.UpdateAvailable || payload.Name != "ghfind" || payload.LatestVersion != "v0.2.0" {
		t.Fatalf("unexpected update payload: %#v", payload)
	}
}

func TestUpdateInstallBinaryDryRunReportsAsset(t *testing.T) {
	oldVersion := Version
	Version = "0.1.0"
	defer func() { Version = oldVersion }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/latest" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"tag_name":"v0.2.0",
			"html_url":"https://example.test/releases/v0.2.0",
			"assets":[{"name":"custom","browser_download_url":"https://example.test/download/ghfind"}]
		}`))
	}))
	defer server.Close()

	var stdout bytes.Buffer
	code := Execute([]string{
		"update", "install",
		"--release-url", server.URL + "/latest",
		"--asset-url", "https://example.test/download/ghfind",
		"--dry-run",
		"-o", "json",
	}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}

	var payload UpdateInstallResult
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Method != "binary" || payload.Status != "dry_run" || payload.AssetURL == "" {
		t.Fatalf("unexpected install payload: %#v", payload)
	}
}

func TestUpdateInstallBinaryReplacesTarget(t *testing.T) {
	oldVersion := Version
	Version = "0.1.0"
	defer func() { Version = oldVersion }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"tag_name":"v0.2.0",
				"html_url":"https://example.test/releases/v0.2.0",
				"assets":[{"name":"custom","browser_download_url":"` + r.Host + `/asset"}]
			}`))
		case "/asset":
			_, _ = w.Write([]byte("new ghfind binary"))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), "ghfind")
	if err := os.WriteFile(target, []byte("old ghfind binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	var stdout bytes.Buffer
	code := Execute([]string{
		"update", "install",
		"--release-url", server.URL + "/latest",
		"--asset-url", server.URL + "/asset",
		"--target", target,
		"-o", "json",
	}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new ghfind binary" {
		t.Fatalf("target was not replaced: %q", string(data))
	}
}

func TestUpdatePackageManagerDryRunReportsCommand(t *testing.T) {
	var stdout bytes.Buffer
	code := Execute([]string{"update", "npm", "--dry-run", "-o", "json"}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}

	var payload UpdateInstallResult
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Method != "npm" || payload.Status != "dry_run" || len(payload.Command) == 0 {
		t.Fatalf("unexpected npm update payload: %#v", payload)
	}
}

func TestDevelopersRequiresFacetType(t *testing.T) {
	var stderr bytes.Buffer
	code := Execute([]string{"developers", "-o", "json"}, &bytes.Buffer{}, &stderr)
	if code == 0 {
		t.Fatal("expected validation failure")
	}
	if !bytes.Contains(stderr.Bytes(), []byte("invalid developers type")) {
		t.Fatalf("unexpected stderr: %s", stderr.String())
	}
}

func TestAuthStatusDoesNotContactServer(t *testing.T) {
	var stdout bytes.Buffer
	code := Execute([]string{"auth", "status", "--json"}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}

	var payload map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["host"] != DefaultHost {
		t.Fatalf("expected default host %q, got %v", DefaultHost, payload["host"])
	}
}

func TestScoreCommandCallsPublicScoreAPI(t *testing.T) {
	var calledPath string
	var method string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calledPath = r.URL.Path
		method = r.Method
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"source":"indexed",
			"username":"DemoDev",
			"final_score":68,
			"tier":"NPC",
			"tier_key":"npc",
			"sub_scores":{"contribution_quality":20}
		}`))
	}))
	defer server.Close()

	var stdout bytes.Buffer
	code := Execute([]string{"score", "DemoDev", "--host", server.URL, "-o", "json"}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}
	// score uses the cheap, cacheable public GET endpoint — NOT POST /api/scan.
	if calledPath != "/api/score/DemoDev" || method != "GET" {
		t.Fatalf("expected GET /api/score/DemoDev, got %s %q", method, calledPath)
	}

	var payload map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["final_score"] != float64(68) {
		t.Fatalf("unexpected score payload: %#v", payload)
	}
}

func TestVsCommandPostsToVerdict(t *testing.T) {
	var path, method string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, method = r.URL.Path, r.Method
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"winner":"a","bucket":"blowout","verdict":{"zh":"甲胜","en":"A wins"}}`))
	}))
	defer server.Close()

	var stdout bytes.Buffer
	code := Execute([]string{"vs", "a", "b", "--host", server.URL, "-o", "json"}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}
	if path != "/api/vs-verdict" || method != "POST" {
		t.Fatalf("expected POST /api/vs-verdict, got %s %q", method, path)
	}
}

func TestBadgeMarkdownLinksToProfile(t *testing.T) {
	var stdout bytes.Buffer
	code := Execute([]string{"badge", "torvalds", "--markdown", "--host", "https://ghfind.com"}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}
	want := "[![ghfind score](https://ghfind.com/api/badge/torvalds)](https://ghfind.com/u/torvalds)\n"
	if stdout.String() != want {
		t.Fatalf("unexpected badge markdown: %q", stdout.String())
	}
}

func TestSearchCommandGETs(t *testing.T) {
	var uri string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uri = r.URL.RequestURI()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"users":[{"username":"torvalds","final_score":94.6,"tier":"夯"}]}`))
	}))
	defer server.Close()

	var stdout bytes.Buffer
	code := Execute([]string{"search", "torv", "--host", server.URL, "-o", "json"}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}
	if uri != "/api/search-users?q=torv" {
		t.Fatalf("expected /api/search-users?q=torv, got %q", uri)
	}
}
