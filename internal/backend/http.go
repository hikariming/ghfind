package backend

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var (
	githubUsernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,38}$`)
	githubProfilePattern  = regexp.MustCompile(`(?i)github\.com/([^/?#]+)`)
)

type dependencyCheck = func(context.Context) error

// APIServer serves the Feed HTTP surface. NewAPIServer mounts it next to
// health/readiness probes; NewStandaloneFeedHandler reuses the same handlers
// for the portable Feed runtime.
type APIServer struct {
	config           Config
	scores           any
	feed             FeedServingStore
	feedSessions     FeedSessionStore
	feedSigner       *FeedSigner
	feedLimiter      FeedRateLimiter
	feedGorse        FeedGorseRecommender
	feedAuthenticate func(*http.Request, time.Time) *OAuthSession
	portableFeed     bool
	metrics          *BackendMetrics
	checks           []dependencyCheck
	clock            func() time.Time
}

// NewAPIServer wires the Feed API. source optionally provides Feed cold-start
// facets and project assessments; statuses optionally provides Feed rate limits.
func NewAPIServer(config Config, source any, statuses any, checks ...dependencyCheck) *APIServer {
	server := &APIServer{config: config, scores: source, checks: checks, clock: time.Now, metrics: NewBackendMetrics()}
	if limiter, ok := statuses.(FeedRateLimiter); ok {
		server.feedLimiter = limiter
	}
	return server
}

func (s *APIServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("GET /feed-readyz", s.feedReady)
	mux.Handle("GET /metrics", s.metrics.Handler())
	mux.HandleFunc("GET /api/feed/tags", withFeedRequestTimeout(s.feedTags))
	mux.HandleFunc("GET /api/feed/preferences", withFeedRequestTimeout(s.feedPreferences))
	mux.HandleFunc("PUT /api/feed/preferences", withFeedRequestTimeout(s.feedPreferences))
	mux.HandleFunc("GET /api/feed/projects", withFeedRequestTimeout(s.feedProjects))
	mux.HandleFunc("PUT /api/feed/projects/{owner}/{repo}/state", withFeedRequestTimeout(s.feedProjectState))
	mux.HandleFunc("POST /api/feed/events", withFeedRequestTimeout(s.feedEvents))
	mux.HandleFunc("DELETE /api/feed/profile", withFeedRequestTimeout(s.deleteFeedProfile))
	mux.HandleFunc("POST /api/internal/feed/projects/reconcile", s.reconcileFeedProjects)
	mux.HandleFunc("POST /api/internal/feed/tags/review", s.reviewFeedTagProposal)
	mux.HandleFunc("POST /api/internal/feed/gorse/rebuild", s.rebuildFeedGorse)
	mux.HandleFunc("POST /api/internal/feed/projects/moderate", s.moderateFeedProject)
	return withRequestLimits(mux)
}

func withFeedRequestTimeout(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		ctx, cancel := context.WithTimeout(request.Context(), 8*time.Second)
		defer cancel()
		next(w, request.WithContext(ctx))
	}
}

func (s *APIServer) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true}, nil)
}

func (s *APIServer) ready(w http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 4*time.Second)
	defer cancel()
	for _, check := range s.checks {
		if err := check(ctx); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "dependency_unavailable"}, map[string]string{"Cache-Control": "no-store"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ready": true}, map[string]string{"Cache-Control": "no-store"})
}

func (s *APIServer) authorized(request *http.Request) bool {
	if s.config.AdminSecret == "" {
		return false
	}
	presented := request.Header.Get("x-admin-secret")
	if len(presented) != len(s.config.AdminSecret) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(s.config.AdminSecret)) == 1
}

func normalizeGitHubUsername(value string) string {
	value = strings.TrimSpace(value)
	if match := githubProfilePattern.FindStringSubmatch(value); len(match) == 2 {
		value = match[1]
	}
	value = strings.TrimPrefix(value, "@")
	if !githubUsernamePattern.MatchString(value) || strings.HasSuffix(value, "-") || strings.Contains(value, "--") {
		return ""
	}
	return strings.ToLower(value)
}

func writeJSON(w http.ResponseWriter, status int, body any, headers map[string]string) {
	for key, value := range headers {
		w.Header().Set(key, value)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func withRequestLimits(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, request)
	})
}

func noStoreHeaders() map[string]string { return map[string]string{"Cache-Control": "no-store"} }
