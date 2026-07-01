package agentcli

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientScanCallsWebsiteAPI(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/scan" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("missing bearer auth")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["username"] != "DemoDev" || body["turnstileToken"] != "turnstile" {
			t.Fatalf("unexpected request body: %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"metrics":{"username":"DemoDev"},"scoring":{"final_score":68}}`))
	}))
	defer server.Close()

	client := Client{Host: server.URL, APIKey: "secret", TurnstileToken: "turnstile", HTTP: server.Client()}
	scan, err := client.Scan(context.Background(), "DemoDev")
	if err != nil {
		t.Fatal(err)
	}
	if scan["metrics"].(map[string]any)["username"] != "DemoDev" {
		t.Fatalf("unexpected scan response: %#v", scan)
	}
}

func TestClientRoastParsesMetaFrames(t *testing.T) {
	meta := map[string]any{"final_score": 71.0, "tier": "人上人"}
	metaBytes, _ := json.Marshal(meta)
	encoded := base64.StdEncoding.EncodeToString(metaBytes)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/roast" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set(roastMetaHeader, encoded)
		_, _ = w.Write([]byte("\x1fTCalibrating\n\x1fM" + encoded + "\n## Demo\nReport\n"))
	}))
	defer server.Close()

	client := Client{Host: server.URL, HTTP: server.Client()}
	result, err := client.Roast(context.Background(), map[string]any{"metrics": map[string]any{"username": "DemoDev"}}, "zh")
	if err != nil {
		t.Fatal(err)
	}
	if result.Report != "## Demo\nReport" {
		t.Fatalf("unexpected report: %q", result.Report)
	}
	if len(result.Progress) != 1 || result.Progress[0] != "Calibrating" {
		t.Fatalf("unexpected progress: %#v", result.Progress)
	}
	if result.Meta["tier"] != "人上人" {
		t.Fatalf("unexpected meta: %#v", result.Meta)
	}
}

func TestClientDiscoveryGETs(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.RequestURI())
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	client := Client{Host: server.URL, HTTP: server.Client()}
	if _, err := client.Stats(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Leaderboard(context.Background(), "score", "7d"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Developers(context.Background(), "language", "Go"); err != nil {
		t.Fatal(err)
	}

	want := []string{
		"/api/stats",
		"/api/leaderboard?view=score&window=7d",
		"/api/developers?type=language&value=Go",
	}
	for i := range want {
		if paths[i] != want[i] {
			t.Fatalf("path %d: want %q, got %q", i, want[i], paths[i])
		}
	}
}
