package agentcli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"testing"
)

func TestReleaseVersionPrecedence(t *testing.T) {
	data, err := os.ReadFile("../../tests/fixtures/cli/versions.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Latest     string `json:"latest"`
		Current    string `json:"current"`
		Newer      bool   `json:"newer"`
		Comparable bool   `json:"comparable"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tt := range cases {
		t.Run(tt.Latest+"_vs_"+tt.Current, func(t *testing.T) {
			newer, comparable := isNewerVersion(tt.Latest, tt.Current)
			if newer != tt.Newer || comparable != tt.Comparable {
				t.Fatalf("got newer=%v comparable=%v; want %v %v", newer, comparable, tt.Newer, tt.Comparable)
			}
		})
	}
}

func TestPrereleaseUpdateCheckAndInstall(t *testing.T) {
	previous := Version
	Version = "v1.0.0-rc.1"
	t.Cleanup(func() { Version = previous })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/latest" {
			t.Errorf("unexpected download during dry run: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(latestRelease{TagName: "v1.0.0"})
	}))
	defer server.Close()
	info, err := CheckUpdate(context.Background(), server.Client(), server.URL+"/latest")
	if err != nil {
		t.Fatal(err)
	}
	if !info.UpdateAvailable || info.Status != "update_available" {
		t.Fatalf("unexpected check: %+v", info)
	}
	// Windows binary self-update remains unsupported.
	if runtime.GOOS == "windows" {
		return
	}
	result, err := InstallUpdate(context.Background(), server.Client(), UpdateInstallOptions{
		ReleaseURL: server.URL + "/latest", AssetURL: server.URL + "/asset", TargetPath: t.TempDir() + "/ghfind", DryRun: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.UpdateAvailable || result.Status != "dry_run" {
		t.Fatalf("unexpected install: %+v", result)
	}
}
