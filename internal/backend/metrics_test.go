package backend

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMetricsExposePrometheusCounters(t *testing.T) {
	metrics := NewBackendMetrics()
	metrics.IncCounter("ghfind_test_total", map[string]string{"kind": `scan"one`, "result": "queued"})
	metrics.ObserveDuration("ghfind_test_duration", map[string]string{"kind": "scan.quick.v1"}, 1500*time.Millisecond)

	body := metrics.Prometheus()
	for _, want := range []string{
		`# TYPE ghfind_test_duration_seconds_count counter`,
		`ghfind_test_duration_seconds_count{kind="scan.quick.v1"} 1`,
		`ghfind_test_duration_seconds_sum{kind="scan.quick.v1"} 1.5`,
		`ghfind_test_total{kind="scan\"one",result="queued"} 1`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("metrics missing %q in:\n%s", want, body)
		}
	}
}

func TestMetricsHandlerIsNoStoreText(t *testing.T) {
	metrics := NewBackendMetrics()
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	response := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != metricsContentType {
		t.Fatalf("Content-Type=%q", got)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q", got)
	}
}
