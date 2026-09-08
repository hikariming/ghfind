package runtime

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/hikariming/ghfind/internal/backend"
)

func TestCFWorkerReadinessIncludesArchiveBinding(t *testing.T) {
	const bridge = "local-worker-test-bridge-key-at-least-32"
	const executor = "local-worker-test-executor-key-at-least-32"
	const source = "local-worker-test-source-key-at-least-32"
	var archiveDown atomic.Bool
	var archiveCalls atomic.Int32
	adapter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Feed-Contract", "1")
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/internal/feed/v1/health":
			if r.Header.Get("Authorization") != "Bearer "+bridge {
				t.Error("incorrect bridge credential")
			}
			json.NewEncoder(w).Encode(backend.FeedBridgeHealthResponse{Ready: true, WriterEpoch: 1, WritesEnabled: true, ContractVersion: "1"})
		case "/internal/feed/source/v1/health":
			if r.Header.Get("Authorization") != "Bearer "+source {
				t.Error("incorrect source credential")
			}
			w.Write([]byte(`{"ready":true,"contractVersion":"1"}`))
		case "/internal/feed/archive/v1/health":
			archiveCalls.Add(1)
			if r.Header.Get("Authorization") != "Bearer "+executor {
				t.Error("incorrect archive credential")
			}
			if archiveDown.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.Write([]byte(`{"ready":true,"contractVersion":"1","writerEpoch":1}`))
		default:
			t.Errorf("unexpected readiness mutation or path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer adapter.Close()
	store, err := backend.NewCFFeedStore(adapter.URL, bridge, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := WorkerConfig{Config: Config{StoreProfile: "cf_d1_r2", WriterEpoch: 1}, Enabled: true, ExecutorSecret: executor, SourceSecret: source, SourceEndpoint: adapter.URL, CleanupEndpoint: adapter.URL, ArchiveEndpoint: adapter.URL}
	handler, err := WorkerHandler(c, "readiness-contract-test", store)
	if err != nil {
		t.Fatal(err)
	}
	probe := func(path string, status int) {
		t.Helper()
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest("GET", path, nil))
		if recorder.Code != status {
			t.Fatalf("%s: got %d, want %d", path, recorder.Code, status)
		}
		if recorder.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("health caching must remain disabled")
		}
		var identity struct {
			Version              string `json:"version"`
			ContractVersion      string `json:"contractVersion"`
			StorageWriterVersion int    `json:"storageWriterVersion"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &identity); err != nil {
			t.Fatal(err)
		}
		if identity.Version != "readiness-contract-test" || identity.ContractVersion != "1" || identity.StorageWriterVersion != 2 {
			t.Fatalf("missing distinct runtime/HTTP/storage writer identity on %s status %d: %+v", path, status, identity)
		}
	}
	probe("/readyz", http.StatusOK)
	archiveDown.Store(true)
	probe("/readyz", http.StatusServiceUnavailable)
	probe("/healthz", http.StatusOK)
	archiveDown.Store(false)
	probe("/readyz", http.StatusOK)
	if archiveCalls.Load() != 3 {
		t.Fatal("readiness must probe actual archive binding on every call")
	}
}
