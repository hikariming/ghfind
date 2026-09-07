package backend

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const metricsContentType = "text/plain; version=0.0.4; charset=utf-8"

type metricKey struct {
	name   string
	labels string
}

// BackendMetrics is intentionally dependency-free so both the API and worker
// can expose operational counters without pulling a Prometheus client into the
// migration branch.
type BackendMetrics struct {
	mu       sync.Mutex
	counters map[metricKey]float64
	gauges   map[metricKey]float64
}

func NewBackendMetrics() *BackendMetrics {
	return &BackendMetrics{counters: map[metricKey]float64{}, gauges: map[metricKey]float64{}}
}

func (m *BackendMetrics) SetGauge(name string, labels map[string]string, value float64) {
	if m == nil || name == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gauges[metricKey{name: name, labels: prometheusLabels(labels)}] = value
}

func (m *BackendMetrics) IncCounter(name string, labels map[string]string) {
	m.AddCounter(name, labels, 1)
}

func (m *BackendMetrics) AddCounter(name string, labels map[string]string, value float64) {
	if m == nil || name == "" || value == 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.counters[metricKey{name: name, labels: prometheusLabels(labels)}] += value
}

func (m *BackendMetrics) ObserveDuration(name string, labels map[string]string, duration time.Duration) {
	if m == nil || name == "" {
		return
	}
	seconds := duration.Seconds()
	m.AddCounter(name+"_seconds_sum", labels, seconds)
	m.IncCounter(name+"_seconds_count", labels)
}

func (m *BackendMetrics) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", metricsContentType)
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(m.Prometheus()))
	})
}

func (m *BackendMetrics) Prometheus() string {
	if m == nil {
		return ""
	}
	m.mu.Lock()
	type metricSample struct {
		key   metricKey
		value float64
		kind  string
	}
	snapshot := make([]metricSample, 0, len(m.counters)+len(m.gauges))
	for key, value := range m.counters {
		snapshot = append(snapshot, metricSample{key: key, value: value, kind: "counter"})
	}
	for key, value := range m.gauges {
		snapshot = append(snapshot, metricSample{key: key, value: value, kind: "gauge"})
	}
	m.mu.Unlock()

	sort.Slice(snapshot, func(i, j int) bool {
		if snapshot[i].key.name != snapshot[j].key.name {
			return snapshot[i].key.name < snapshot[j].key.name
		}
		return snapshot[i].key.labels < snapshot[j].key.labels
	})
	var builder strings.Builder
	seen := map[string]bool{}
	for _, metric := range snapshot {
		seenKey := metric.kind + "\x00" + metric.key.name
		if !seen[seenKey] {
			seen[seenKey] = true
			_, _ = fmt.Fprintf(&builder, "# TYPE %s %s\n", metric.key.name, metric.kind)
		}
		_, _ = fmt.Fprintf(&builder, "%s%s %s\n", metric.key.name, metric.key.labels, strconv.FormatFloat(metric.value, 'f', -1, 64))
	}
	return builder.String()
}

func prometheusLabels(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}
	keys := make([]string, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+`="`+escapePrometheusLabel(labels[key])+`"`)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func escapePrometheusLabel(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, "\n", `\n`)
	return strings.ReplaceAll(value, `"`, `\"`)
}

func (m *BackendMetrics) recordAPIJobAdmission(kind, result string) {
	m.IncCounter("ghfind_api_job_admissions_total", map[string]string{"kind": kind, "result": result})
}

func (m *BackendMetrics) recordAPIScanWait(result string) {
	m.IncCounter("ghfind_api_scan_waits_total", map[string]string{"result": result})
}

func (m *BackendMetrics) recordWorkerJobStarted(kind string) {
	m.IncCounter("ghfind_worker_jobs_started_total", map[string]string{"kind": kind})
}

func (m *BackendMetrics) recordWorkerJobCompleted(kind, result string, duration time.Duration) {
	m.IncCounter("ghfind_worker_jobs_completed_total", map[string]string{"kind": kind, "result": result})
	m.ObserveDuration("ghfind_worker_job_duration", map[string]string{"kind": kind}, duration)
}

func (m *BackendMetrics) recordWorkerJobRetry(kind string, duration time.Duration) {
	m.IncCounter("ghfind_worker_jobs_retried_total", map[string]string{"kind": kind})
	m.ObserveDuration("ghfind_worker_job_duration", map[string]string{"kind": kind}, duration)
}

func (m *BackendMetrics) recordWorkerJobFailed(kind, result string, duration time.Duration) {
	m.IncCounter("ghfind_worker_jobs_failed_total", map[string]string{"kind": kind, "result": result})
	m.ObserveDuration("ghfind_worker_job_duration", map[string]string{"kind": kind}, duration)
}

func (m *BackendMetrics) recordWorkerJobDeadLettered(kind string) {
	m.IncCounter("ghfind_worker_jobs_dead_lettered_total", map[string]string{"kind": kind})
}

func (m *BackendMetrics) recordFeedRequest(result string, duration time.Duration) {
	m.IncCounter("ghfind_feed_requests_total", map[string]string{"algorithm": FeedAlgorithmVersion, "result": result})
	m.ObserveDuration("ghfind_feed_request_duration", map[string]string{"algorithm": FeedAlgorithmVersion}, duration)
}

func (m *BackendMetrics) recordFeedCandidates(counts map[string]int) {
	for source, count := range counts {
		m.AddCounter("ghfind_feed_candidates_total", map[string]string{"source": source}, float64(count))
	}
}

func (m *BackendMetrics) recordFeedServed(items []FeedRankedItem) {
	for _, item := range items {
		for _, source := range item.CandidateSources {
			m.IncCounter("ghfind_feed_served_total", map[string]string{
				"source": source, "exploration": strconv.FormatBool(item.Exploration),
			})
		}
	}
}

func (m *BackendMetrics) recordFeedEvents(eventType FeedEventType, result string, count int) {
	if count > 0 {
		m.AddCounter("ghfind_feed_events_total", map[string]string{"type": string(eventType), "result": result}, float64(count))
	}
}

func (m *BackendMetrics) recordFeedProjectionLag(projection string, lag time.Duration) {
	if lag < 0 {
		lag = 0
	}
	m.SetGauge("ghfind_feed_projection_lag_seconds", map[string]string{"projection": projection}, lag.Seconds())
}

func (m *BackendMetrics) recordFeedCatalogOrphans(count int64) {
	m.SetGauge("ghfind_feed_catalog_orphans", nil, float64(count))
}

func (m *BackendMetrics) recordGorseShadow(duration time.Duration, overlap float64, result string) {
	m.ObserveDuration("ghfind_feed_gorse_shadow_duration", map[string]string{"result": result}, duration)
	if overlap >= 0 {
		m.SetGauge("ghfind_feed_gorse_overlap_ratio", nil, overlap)
	}
}

func (m *BackendMetrics) recordGorseOverlap(overlap float64) {
	m.SetGauge("ghfind_feed_gorse_overlap_ratio", nil, overlap)
}
