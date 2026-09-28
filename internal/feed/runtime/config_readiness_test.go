package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hikariming/ghfind/internal/backend"
)

func TestReadinessReportsProcessModeSeparatelyFromBuildAndDependencies(t *testing.T) {
	for _, mode := range []backend.FeedMode{backend.FeedModeOff, backend.FeedModeBaseline} {
		t.Run(string(mode), func(t *testing.T) {
			dependencyErr := error(nil)
			checks := 0
			handler := WithHealth(http.NotFoundHandler(), Config{Mode: mode, StoreProfile: "postgres", WriterEpoch: 7}, "same-image-sha", "feed-api", func(ctx context.Context) error {
				checks++
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("readiness lost its dependency deadline")
				}
				return dependencyErr
			})
			for _, failed := range []bool{false, true, false} {
				dependencyErr = nil
				if failed {
					dependencyErr = errors.New("dependency unavailable")
				}
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, httptest.NewRequest("GET", "/readyz", nil))
				want := http.StatusOK
				if failed {
					want = http.StatusServiceUnavailable
				}
				var body map[string]any
				if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if response.Code != want || response.Header().Get("Cache-Control") != "no-store" || body["ready"] != !failed || body["mode"] != string(mode) {
					t.Fatalf("mode/readiness mismatch: status=%d body=%v", response.Code, body)
				}
				if body["version"] != "same-image-sha" || body["contractVersion"] != "1" || body["storageWriterVersion"] != float64(backend.FeedStorageWriterVersion) || body["writerEpoch"] != float64(7) {
					t.Fatalf("mode changed the independent identity fields: %v", body)
				}
			}
			if checks != 3 {
				t.Fatalf("expected live dependency checks, got %d", checks)
			}
		})
	}
}
