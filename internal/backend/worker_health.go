package backend

import (
	"context"
	"net/http"
	"time"
)

// WorkerHealthHandler serves the worker's liveness and readiness probes on the
// same listener as its metrics. The API has /healthz and /readyz; the worker
// previously exposed only /metrics, so Railway and Docker could not restart a
// silently dead consumer. /readyz fails closed until every dependency pings
// cleanly: Turso (persistence), Upstash (job status), and RabbitMQ (consume
// and publish).
func NewWorkerHealthHandler(checks ...dependencyCheck) http.Handler {
	return NewWorkerHealthHandlerWithFeed(nil, checks...)
}

// NewWorkerHealthHandlerWithFeed keeps the original worker readiness limited
// to dependencies required by score/scan/analysis consumers. Feed readiness is
// exposed separately so orchestration can alert or gate Feed without restarting
// a worker that is still safely processing the original queues.
func NewWorkerHealthHandlerWithFeed(feedCheck dependencyCheck, checks ...dependencyCheck) http.Handler {
	mux := http.NewServeMux()
	handler := &workerHealthHandler{checks: checks, feedCheck: feedCheck}
	mux.HandleFunc("GET /healthz", handler.health)
	mux.HandleFunc("GET /readyz", handler.ready)
	if feedCheck != nil {
		mux.HandleFunc("GET /feed-readyz", handler.feedReady)
	}
	return mux
}

type workerHealthHandler struct {
	checks    []dependencyCheck
	feedCheck dependencyCheck
}

func (h *workerHealthHandler) feedReady(w http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 4*time.Second)
	defer cancel()
	if h.feedCheck == nil || h.feedCheck(ctx) != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ready": true}, map[string]string{"Cache-Control": "no-store"})
}

func (h *workerHealthHandler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true}, nil)
}

func (h *workerHealthHandler) ready(w http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 4*time.Second)
	defer cancel()
	for _, check := range h.checks {
		if err := check(ctx); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "dependency_unavailable"}, map[string]string{"Cache-Control": "no-store"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ready": true}, map[string]string{"Cache-Control": "no-store"})
}
