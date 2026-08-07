package backend

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const statsCacheControl = "public, s-maxage=60, stale-while-revalidate=300"

var (
	githubUsernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,38}$`)
	githubProfilePattern  = regexp.MustCompile(`(?i)github\.com/([^/?#]+)`)
)

type dependencyCheck func(context.Context) error

// APIServer owns Go-native public endpoints and authenticated job admission.
// The Next app reaches it through an external rewrite, preserving /api/* for
// existing browsers and SDKs.
type APIServer struct {
	config                   Config
	scores                   ScoreCountStore
	statuses                 JobStatusStore
	statsCache               StatsCache
	discovery                DiscoveryStore
	leaderboards             LeaderboardStore
	leaderboardCache         LeaderboardCache
	developers               DevelopersStore
	developerCache           DeveloperCache
	badges                   BadgeStore
	facetRanks               FacetRankStore
	rateLimiter              PublicRateLimiter
	campaigns                CampaignLeaderboardStore
	campaignSSE              *campaignSSEHub
	publisher                ScoreSnapshotPublisher
	scanResults              ScanResultStore
	scoreReads               ScoreReadStore
	scanPublisher            ScanJobPublisher
	scanCache                ScanCache
	scanOutcomes             ScanOutcomeStore
	lookupGate               LookupGate
	scanFlightGate           ScanFlightGate
	campaignRevisions        CampaignRevisionWriter
	interactions             InteractionStore
	matchups                 MatchupStore
	verdictLimiter           VerdictRateLimiter
	verdictCache             VerdictCache
	roasts                   RoastStore
	roastLimiter             RoastRateLimiter
	roastCache               RoastCache
	mcpLimiter               MCPRateLimiter
	projectAnalyses          ProjectAnalysisRunStore
	projectAnalysisCache     ProjectAnalysisResultCache
	projectAnalysisLimiter   ProjectAnalysisRateLimiter
	projectAnalysisPublisher ProjectAnalysisJobPublisher
	metrics                  *BackendMetrics
	githubOAuthOrigin        string
	githubAPIOrigin          string
	oauthHTTPClient          *http.Client
	llmHTTPClient            *http.Client
	checks                   []dependencyCheck
	clock                    func() time.Time
	scanWait                 time.Duration
	scanPoll                 time.Duration
	verdictWait              time.Duration
	verdictPoll              time.Duration
}

func NewAPIServer(
	config Config,
	scores ScoreCountStore,
	statuses JobStatusStore,
	publisher ScoreSnapshotPublisher,
	checks ...dependencyCheck,
) *APIServer {
	server := &APIServer{
		config: config, scores: scores, statuses: statuses, publisher: publisher,
		checks: checks, clock: time.Now, scanWait: 55 * time.Second, scanPoll: 250 * time.Millisecond,
		verdictWait: 45 * time.Second, verdictPoll: 500 * time.Millisecond,
		githubOAuthOrigin: "https://github.com", githubAPIOrigin: defaultGitHubAPIURL,
		oauthHTTPClient: &http.Client{Timeout: 10 * time.Second},
		llmHTTPClient: &http.Client{Timeout: verdictLLMTimeout},
		metrics:       NewBackendMetrics(),
	}
	if cache, ok := statuses.(StatsCache); ok {
		server.statsCache = cache
	}
	if discovery, ok := scores.(DiscoveryStore); ok {
		server.discovery = discovery
	}
	if leaderboards, ok := scores.(LeaderboardStore); ok {
		server.leaderboards = leaderboards
	}
	if cache, ok := statuses.(LeaderboardCache); ok {
		server.leaderboardCache = cache
	}
	if developers, ok := scores.(DevelopersStore); ok {
		server.developers = developers
	}
	if cache, ok := statuses.(DeveloperCache); ok {
		server.developerCache = cache
	}
	if badges, ok := scores.(BadgeStore); ok {
		server.badges = badges
	}
	if facetRanks, ok := scores.(FacetRankStore); ok {
		server.facetRanks = facetRanks
	}
	if limiter, ok := statuses.(PublicRateLimiter); ok {
		server.rateLimiter = limiter
	}
	if campaigns, ok := scores.(CampaignLeaderboardStore); ok {
		server.campaigns = campaigns
	}
	if revisions, ok := statuses.(CampaignRevisionStore); ok {
		server.campaignSSE = newCampaignSSEHub(revisions)
	}
	if scans, ok := scores.(ScanResultStore); ok {
		server.scanResults = scans
	}
	if scoreReads, ok := scores.(ScoreReadStore); ok {
		server.scoreReads = scoreReads
	}
	if outcomes, ok := scores.(ScanOutcomeStore); ok {
		server.scanOutcomes = outcomes
	}
	if scanPublisher, ok := publisher.(ScanJobPublisher); ok {
		server.scanPublisher = scanPublisher
	}
	if cache, ok := statuses.(ScanCache); ok {
		server.scanCache = cache
	}
	if gate, ok := statuses.(LookupGate); ok {
		server.lookupGate = gate
	}
	if gate, ok := statuses.(ScanFlightGate); ok {
		server.scanFlightGate = gate
	}
	if revisions, ok := statuses.(CampaignRevisionWriter); ok {
		server.campaignRevisions = revisions
	}
	if interactions, ok := scores.(InteractionStore); ok {
		server.interactions = interactions
	}
	if matchups, ok := scores.(MatchupStore); ok {
		server.matchups = matchups
	}
	if limiter, ok := statuses.(VerdictRateLimiter); ok {
		server.verdictLimiter = limiter
	}
	if cache, ok := statuses.(VerdictCache); ok {
		server.verdictCache = cache
	}
	if roasts, ok := scores.(RoastStore); ok {
		server.roasts = roasts
	}
	if limiter, ok := statuses.(RoastRateLimiter); ok {
		server.roastLimiter = limiter
	}
	if cache, ok := statuses.(RoastCache); ok {
		server.roastCache = cache
	}
	if limiter, ok := statuses.(MCPRateLimiter); ok {
		server.mcpLimiter = limiter
	}
	if analyses, ok := scores.(ProjectAnalysisRunStore); ok {
		server.projectAnalyses = analyses
	}
	if cache, ok := statuses.(ProjectAnalysisResultCache); ok {
		server.projectAnalysisCache = cache
	}
	if limiter, ok := statuses.(ProjectAnalysisRateLimiter); ok {
		server.projectAnalysisLimiter = limiter
	}
	if analysisPublisher, ok := publisher.(ProjectAnalysisJobPublisher); ok {
		server.projectAnalysisPublisher = analysisPublisher
	}
	return server
}

func (s *APIServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.ready)
	mux.Handle("GET /metrics", s.metrics.Handler())
	mux.HandleFunc("GET /api/stats", s.stats)
	mux.HandleFunc("GET /api/sitemap", s.sitemapInventory)
	mux.HandleFunc("GET /api/search-users", s.searchUsers)
	mux.HandleFunc("GET /api/leaderboard", s.leaderboard)
	mux.HandleFunc("GET /api/developers", s.developerDirectory)
	mux.HandleFunc("GET /api/projects", s.projects)
	mux.HandleFunc("GET /api/projects/{owner}/{repo}", s.projectDetail)
	mux.HandleFunc("GET /api/embed/badge/{username}", s.badgeData)
	mux.HandleFunc("GET /api/facet-rank/{username}", s.facetRank)
	mux.HandleFunc("GET /api/score/{username}", s.score)
	mux.HandleFunc("GET /api/profile/{username}/live", s.profileLiveScan)
	mux.HandleFunc("GET /api/profile/{username}", s.profile)
	mux.HandleFunc("GET /api/vs/{a}/{b}", s.vsMatchup)
	mux.HandleFunc("GET /api/vs/trending", s.trendingVsMatchups)
	mux.HandleFunc("GET /api/campaigns/{campaign}/leaderboard", s.campaignLeaderboard)
	mux.HandleFunc("GET /api/campaigns/{campaign}/leaderboard/events", s.campaignLeaderboardEvents)
	mux.HandleFunc("GET /api/scan/jobs/{id}", s.scanJobStatus)
	mux.HandleFunc("POST /api/scan", s.scan)
	mux.HandleFunc("POST /api/roast", s.roast)
	mux.HandleFunc("POST /api/project-analyses", s.createProjectAnalysis)
	mux.HandleFunc("GET /api/project-analyses/{id}", s.projectAnalysis)
	mux.HandleFunc("GET /api/project-boards", s.projectBoards)
	mux.HandleFunc("GET /api/internal/project-analyses/reconcile", s.reconcileProjectAnalyses)
	mux.HandleFunc("POST /api/internal/project-analyses/reconcile", s.reconcileProjectAnalyses)
	mux.HandleFunc("GET /api/auth/github", s.beginGitHubOAuth)
	mux.HandleFunc("GET /api/auth/callback/github", s.completeGitHubOAuth)
	mux.HandleFunc("POST /api/auth/signout", s.signOut)
	mux.HandleFunc("GET /api/me", s.me)
	mux.HandleFunc("GET /api/follows", s.follows)
	mux.HandleFunc("GET /api/follows/{username}", s.follow)
	mux.HandleFunc("PUT /api/follows/{username}", s.follow)
	mux.HandleFunc("DELETE /api/follows/{username}", s.follow)
	mux.HandleFunc("GET /api/profile-comments/{username}", s.profileComments)
	mux.HandleFunc("POST /api/profile-comments/{username}", s.profileComments)
	mux.HandleFunc("GET /api/profile-reactions/{username}", s.profileReactions)
	mux.HandleFunc("PUT /api/profile-reactions/{username}", s.profileReactions)
	mux.HandleFunc("DELETE /api/profile-reactions/{username}", s.profileReactions)
	mux.HandleFunc("GET /api/blog-comments/{slug}", s.blogComments)
	mux.HandleFunc("POST /api/blog-comments/{slug}", s.blogComments)
	mux.HandleFunc("GET /api/collection-comments/{slug}", s.collectionComments)
	mux.HandleFunc("POST /api/collection-comments/{slug}", s.collectionComments)
	mux.HandleFunc("POST /api/internal/vs-verdict", s.vsVerdict)
	mux.HandleFunc("POST /api/internal/jobs/score-snapshot", s.enqueueScoreSnapshot)
	mux.HandleFunc("GET /api/internal/jobs/{id}", s.jobStatus)
	mux.HandleFunc("POST /api/admin/backfill-facets", s.adminBackfillIndexes)
	mux.HandleFunc("POST /api/admin/backfill-repos", s.adminBackfillIndexes)
	mux.HandleFunc("POST /api/admin/backfill-profiles", s.adminBackfillProfiles)
	mux.HandleFunc("POST /api/admin/backfill-scores", s.adminBackfillScores)
	mux.HandleFunc("/mcp", s.mcp)
	return withRequestLimits(mux)
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

func (s *APIServer) stats(w http.ResponseWriter, request *http.Request) {
	if s.statsCache != nil {
		if total, err := s.statsCache.GetStats(request.Context()); err == nil && total != nil {
			writeJSON(w, http.StatusOK, struct {
				Total  *int `json:"total"`
				Cached bool `json:"cached"`
			}{Total: total, Cached: true}, map[string]string{"Cache-Control": statsCacheControl})
			return
		}
	}
	total, err := s.scores.ScoreCount(request.Context())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "stats_unavailable",
		}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	if total != nil && s.statsCache != nil {
		// Like the current Next implementation, a cache write is best-effort:
		// a healthy database response must never become a stats outage.
		_ = s.statsCache.SetStats(request.Context(), *total)
	}
	writeJSON(w, http.StatusOK, struct {
		Total  *int `json:"total"`
		Cached bool `json:"cached"`
	}{Total: total, Cached: false}, map[string]string{"Cache-Control": statsCacheControl})
}

func (s *APIServer) searchUsers(w http.ResponseWriter, request *http.Request) {
	query := request.URL.Query().Get("q")
	if strings.TrimSpace(query) == "" {
		writeJSON(w, http.StatusOK, emptyDiscovery(), map[string]string{
			"Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
		})
		return
	}
	if s.discovery == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "discovery_unavailable"}, map[string]string{
			"Cache-Control": "no-store", "Retry-After": "15",
		})
		return
	}
	result, err := s.discovery.SearchDiscovery(request.Context(), query)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "discovery_unavailable"}, map[string]string{
			"Cache-Control": "no-store", "Retry-After": "15",
		})
		return
	}
	writeJSON(w, http.StatusOK, result, map[string]string{
		"Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
	})
}

func (s *APIServer) leaderboard(w http.ResponseWriter, request *http.Request) {
	view := request.URL.Query().Get("view")
	if !validLeaderboardView(view) {
		view = "trending"
	}
	window := request.URL.Query().Get("window")
	if !validLeaderboardWindow(window) {
		window = "all"
	}
	limit := boundedQueryInt(request, "limit", leaderboardLimit, 1, leaderboardLimit)
	offset := boundedQueryInt(request, "offset", 0, 0, int(^uint(0)>>1))
	entries := []LeaderboardEntry{}
	cached := false
	if s.leaderboardCache != nil {
		if value, found, err := s.leaderboardCache.GetLeaderboard(request.Context(), view, window); err == nil && found {
			entries = value
			cached = true
		}
	}
	if !cached {
		if s.leaderboards == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "leaderboard_unavailable"}, map[string]string{
				"Cache-Control": "no-store", "Retry-After": "15",
			})
			return
		}
		value, err := s.leaderboards.GetLeaderboard(request.Context(), view, window)
		if err == nil {
			entries = value
			if len(entries) > 0 && s.leaderboardCache != nil {
				_ = s.leaderboardCache.SetLeaderboard(request.Context(), view, window, entries)
			}
		}
	}
	if entries == nil {
		entries = []LeaderboardEntry{}
	}
	if offset > len(entries) {
		offset = len(entries)
	}
	end := offset + limit
	if end > len(entries) {
		end = len(entries)
	}
	nextOffset := any(nil)
	if end < len(entries) {
		nextOffset = end
	}
	writeJSON(w, http.StatusOK, struct {
		Entries    []LeaderboardEntry `json:"entries"`
		Total      int                `json:"total"`
		Limit      int                `json:"limit"`
		Offset     int                `json:"offset"`
		NextOffset any                `json:"nextOffset"`
		Cached     bool               `json:"cached"`
		View       string             `json:"view"`
		Window     string             `json:"window"`
	}{entries[offset:end], len(entries), limit, offset, nextOffset, cached, view, window}, map[string]string{
		"Cache-Control": "public, s-maxage=120, stale-while-revalidate=600",
	})
}

func (s *APIServer) developerDirectory(w http.ResponseWriter, request *http.Request) {
	facetType := request.URL.Query().Get("type")
	if !validFacetType(facetType) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "invalid_type",
			"message": "invalid type",
			"hint":    "type must be one of language, org, repo.",
		}, nil)
		return
	}
	value := request.URL.Query().Get("value")
	if value == "" {
		categories := []FacetCategory{}
		if s.developerCache != nil {
			if cached, found, err := s.developerCache.GetFacetCategories(request.Context(), facetType); err == nil && found {
				categories = cached
				writeJSON(w, http.StatusOK, struct {
					Type       string          `json:"type"`
					Categories []FacetCategory `json:"categories"`
					Total      int             `json:"total"`
				}{facetType, categories, len(categories)}, map[string]string{"Cache-Control": developersCacheControl})
				return
			}
		}
		if s.developers != nil {
			if result, err := s.developers.GetFacetCategories(request.Context(), facetType); err == nil {
				categories = result
				if len(categories) > 0 && s.developerCache != nil {
					_ = s.developerCache.SetFacetCategories(request.Context(), facetType, categories)
				}
			}
		}
		writeJSON(w, http.StatusOK, struct {
			Type       string          `json:"type"`
			Categories []FacetCategory `json:"categories"`
			Total      int             `json:"total"`
		}{facetType, categories, len(categories)}, map[string]string{"Cache-Control": developersCacheControl})
		return
	}

	entries := []LeaderboardEntry{}
	if s.developerCache != nil {
		if cached, found, err := s.developerCache.GetFacetDevelopers(request.Context(), facetType, value); err == nil && found {
			entries = cached
			writeDeveloperPage(w, facetType, value, entries, request)
			return
		}
	}
	if s.developers != nil {
		if result, err := s.developers.GetDevelopersByFacet(request.Context(), facetType, value); err == nil {
			entries = result
			if len(entries) > 0 && s.developerCache != nil {
				_ = s.developerCache.SetFacetDevelopers(request.Context(), facetType, value, entries)
			}
		}
	}
	writeDeveloperPage(w, facetType, value, entries, request)
}

func (s *APIServer) badgeData(w http.ResponseWriter, request *http.Request) {
	username := strictGitHubUsername(request.PathValue("username"))
	if username == "" || s.badges == nil {
		writeJSON(w, http.StatusOK, BadgeData{}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	data, err := s.badges.GetBadgeData(request.Context(), username, s.clock().UTC())
	if err != nil {
		// The old renderer falls back to an unrated SVG on an unavailable store;
		// retain that public embedding behavior rather than leaking dependency
		// failures into Markdown image consumers.
		data = BadgeData{}
	}
	writeJSON(w, http.StatusOK, data, map[string]string{"Cache-Control": "no-store"})
}

func (s *APIServer) facetRank(w http.ResponseWriter, request *http.Request) {
	now := s.clock().UTC()
	if s.rateLimiter == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "rate_limit_unavailable"}, map[string]string{
			"Cache-Control": "no-store", "Retry-After": strconv.Itoa(rateLimitUnavailableRetry),
		})
		return
	}
	limit, err := s.rateLimiter.LimitPublicRead(request.Context(), s.clientPrincipal(request), now)
	if err != nil || !limit.Success {
		if err != nil {
			limit.Unavailable = true
		}
		headers := rateLimitHeaders(limit, now)
		headers["Cache-Control"] = "no-store"
		code := "rate_limited"
		status := http.StatusTooManyRequests
		if limit.Unavailable {
			code = "rate_limit_unavailable"
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]string{"error": code}, headers)
		return
	}
	username := strictGitHubUsername(request.PathValue("username"))
	result := (*FacetRankData)(nil)
	if username != "" && s.facetRanks != nil {
		result, _ = s.facetRanks.GetFacetRank(request.Context(), username)
	}
	writeJSON(w, http.StatusOK, struct {
		FacetRank *FacetRankData `json:"facetRank"`
	}{result}, map[string]string{"Cache-Control": facetRankCacheControl})
}

func (s *APIServer) campaignLeaderboard(w http.ResponseWriter, request *http.Request) {
	campaign := request.PathValue("campaign")
	if !validCampaign(campaign) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "campaign_not_found"}, nil)
		return
	}
	live := request.URL.Query().Get("live") == "1"
	now := s.clock().UTC()
	if s.rateLimiter == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "rate_limit_unavailable"}, map[string]string{
			"Cache-Control": "no-store", "Retry-After": strconv.Itoa(rateLimitUnavailableRetry),
		})
		return
	}
	var limitResult RateLimitResult
	var limitErr error
	if live {
		limitResult, limitErr = s.rateLimiter.LimitCampaignLeaderboardRead(request.Context(), s.clientPrincipal(request), now)
	} else {
		limitResult, limitErr = s.rateLimiter.LimitPublicRead(request.Context(), s.clientPrincipal(request), now)
	}
	if limitErr != nil || !limitResult.Success {
		if limitErr != nil {
			limitResult.Unavailable = true
		}
		headers := rateLimitHeaders(limitResult, now)
		headers["Cache-Control"] = "no-store"
		code := "rate_limited"
		status := http.StatusTooManyRequests
		if limitResult.Unavailable {
			code = "rate_limit_unavailable"
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]string{"error": code}, headers)
		return
	}
	limit := boundedQueryInt(request, "limit", 100, 1, campaignLeaderboardLimit)
	offset := boundedQueryInt(request, "offset", 0, 0, int(^uint(0)>>1))
	if offset >= campaignLeaderboardLimit {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_pagination"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	if location := canonicalCampaignLeaderboardURL(request, limit, offset, live); location != "" {
		w.Header().Set("Location", location)
		w.WriteHeader(http.StatusPermanentRedirect)
		return
	}
	entries := []LeaderboardEntry{}
	if s.campaigns != nil {
		if result, err := s.campaigns.GetCampaignLeaderboard(request.Context(), campaign); err == nil {
			entries = result
		}
	}
	if offset > len(entries) {
		offset = len(entries)
	}
	end := offset + limit
	if end > len(entries) {
		end = len(entries)
	}
	nextOffset := any(nil)
	if end < len(entries) {
		nextOffset = end
	}
	cacheControl := campaignLeaderboardCacheControl
	if live {
		cacheControl = "no-store"
	}
	writeJSON(w, http.StatusOK, struct {
		Entries    []LeaderboardEntry `json:"entries"`
		Total      int                `json:"total"`
		Limit      int                `json:"limit"`
		Offset     int                `json:"offset"`
		NextOffset any                `json:"nextOffset"`
		Campaign   string             `json:"campaign"`
	}{entries[offset:end], len(entries), limit, offset, nextOffset, campaign}, map[string]string{"Cache-Control": cacheControl})
}

func canonicalCampaignLeaderboardURL(request *http.Request, limit, offset int, live bool) string {
	parts := []string{}
	if limit != 100 {
		parts = append(parts, "limit="+strconv.Itoa(limit))
	}
	if offset != 0 {
		parts = append(parts, "offset="+strconv.Itoa(offset))
	}
	if live {
		parts = append(parts, "live=1")
	}
	canonical := strings.Join(parts, "&")
	if canonical == request.URL.RawQuery {
		return ""
	}
	prefix := request.URL.Scheme + "://" + request.Host
	if request.URL.Scheme == "" || request.Host == "" {
		scheme := strings.TrimSpace(strings.Split(request.Header.Get("x-forwarded-proto"), ",")[0])
		if scheme != "http" && scheme != "https" {
			if request.TLS != nil {
				scheme = "https"
			} else {
				scheme = "http"
			}
		}
		prefix = scheme + "://" + request.Host
	}
	if canonical == "" {
		return prefix + request.URL.Path
	}
	return prefix + request.URL.Path + "?" + canonical
}

func (s *APIServer) campaignLeaderboardEvents(w http.ResponseWriter, request *http.Request) {
	campaign := request.PathValue("campaign")
	if !validCampaign(campaign) {
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, request)
		return
	}
	if s.campaignSSE == nil {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Retry-After", strconv.Itoa(rateLimitUnavailableRetry))
		http.Error(w, "Live updates unavailable", http.StatusServiceUnavailable)
		return
	}
	listener, unsubscribe, err := s.campaignSSE.subscribe(request.Context(), campaign)
	if err != nil {
		w.Header().Set("Cache-Control", "no-store")
		if errors.Is(err, errCampaignStreamCap) {
			w.Header().Set("Retry-After", "10")
			http.Error(w, "Too many live streams", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Retry-After", strconv.Itoa(rateLimitUnavailableRetry))
		http.Error(w, "Live updates unavailable", http.StatusServiceUnavailable)
		return
	}
	defer unsubscribe()
	flusher, ok := w.(http.Flusher)
	if !ok {
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "Streaming unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	_, _ = w.Write([]byte("retry: 2000\n\n"))
	flusher.Flush()
	lifetime := time.NewTimer(campaignStreamLifetime)
	defer lifetime.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case <-lifetime.C:
			return
		case revision, open := <-listener:
			if !open {
				return
			}
			_, _ = fmt.Fprintf(w, "data: %d\n\n", revision)
			flusher.Flush()
		}
	}
}

func writeDeveloperPage(w http.ResponseWriter, facetType, value string, entries []LeaderboardEntry, request *http.Request) {
	limit := boundedQueryInt(request, "limit", leaderboardLimit, 1, leaderboardLimit)
	offset := boundedQueryInt(request, "offset", 0, 0, int(^uint(0)>>1))
	if offset > len(entries) {
		offset = len(entries)
	}
	end := offset + limit
	if end > len(entries) {
		end = len(entries)
	}
	nextOffset := any(nil)
	if end < len(entries) {
		nextOffset = end
	}
	writeJSON(w, http.StatusOK, struct {
		Type       string             `json:"type"`
		Value      string             `json:"value"`
		Entries    []LeaderboardEntry `json:"entries"`
		Total      int                `json:"total"`
		Limit      int                `json:"limit"`
		Offset     int                `json:"offset"`
		NextOffset any                `json:"nextOffset"`
	}{facetType, value, entries[offset:end], len(entries), limit, offset, nextOffset}, map[string]string{"Cache-Control": developersCacheControl})
}

func (s *APIServer) enqueueScoreSnapshot(w http.ResponseWriter, request *http.Request) {
	if !s.authorized(request) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	var input struct {
		Username unknownString `json:"username"`
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	username := normalizeGitHubUsername(input.Username.String())
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_username"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	jobID, err := idempotencyJobID(request.Header.Get("Idempotency-Key"), username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "job_id_generation_failed"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	if existing, err := s.statuses.Get(request.Context(), jobID); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "job_status_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	} else if existing != nil {
		s.metrics.recordAPIJobAdmission(ScoreSnapshotJobKind, "deduplicated")
		writeJSON(w, http.StatusAccepted, existing, map[string]string{
			"Cache-Control": "no-store",
			"Location":      "/api/internal/jobs/" + jobID,
		})
		return
	}
	now := s.clock().UTC()
	job := ScoreSnapshotJob{ID: jobID, Username: username, RequestedAt: now.UnixMilli()}
	queued := newJobStatus(job, JobQueued, "")
	queued.CreatedAt = now
	queued.UpdatedAt = now
	if err := s.statuses.Put(request.Context(), queued); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "job_status_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	if err := s.publisher.PublishScoreSnapshot(request.Context(), job); err != nil {
		s.metrics.recordAPIJobAdmission(ScoreSnapshotJobKind, "publish_failed")
		failed := queued
		failed.State = JobFailed
		failed.UpdatedAt = s.clock().UTC()
		failed.Error = "broker_unavailable"
		_ = s.statuses.Put(context.Background(), failed)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "broker_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	s.metrics.recordAPIJobAdmission(ScoreSnapshotJobKind, "queued")
	writeJSON(w, http.StatusAccepted, queued, map[string]string{
		"Cache-Control": "no-store",
		"Location":      "/api/internal/jobs/" + jobID,
	})
}

// scan keeps POST /api/scan's immediate-result contract while moving execution
// to the Go worker. Normal calls wait for their durable job; a bounded 202 is
// returned only when GitHub work outlives the former Vercel route budget.
func (s *APIServer) scan(w http.ResponseWriter, request *http.Request) {
	if s.scanResults == nil || s.scanPublisher == nil || s.rateLimiter == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "scan_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	var input struct {
		Username       unknownString `json:"username"`
		TurnstileToken unknownString `json:"turnstileToken"`
		Campaign       unknownString `json:"campaign"`
	}
	decoder := json.NewDecoder(io.LimitReader(request.Body, 16<<10))
	if err := decoder.Decode(&input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, nil)
		return
	}
	username := normalizeGitHubUsername(input.Username.String())
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_username"}, nil)
		return
	}
	if input.Campaign.String() != "" && input.Campaign.String() != "advx" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, nil)
		return
	}
	validMachine, absentMachine := s.machineAuthenticated(request)
	if !validMachine && !absentMachine {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"}, map[string]string{"Cache-Control": "no-store", "WWW-Authenticate": "Bearer"})
		return
	}
	now := s.clock().UTC()
	ip := s.clientIP(request)
	var session *anonymousSession
	principal := ip
	if absentMachine {
		if !s.verifyTurnstile(request.Context(), input.TurnstileToken.String(), ip) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "turnstile_failed"}, map[string]string{"Cache-Control": "no-store"})
			return
		}
		session = s.establishAnonymousSession(request, now)
		if session != nil {
			principal = "anon:" + session.ID
		}
	}
	principalLimit, err := s.rateLimiter.LimitScanPrincipal(request.Context(), principal, now)
	if err != nil || principalLimit.Unavailable {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "rate_limit_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	headers := rateLimitHeaders(principalLimit, now)
	if idempotencyKey := request.Header.Get("Idempotency-Key"); idempotencyKey != "" {
		headers["Idempotency-Key"] = idempotencyKey
	}
	if !principalLimit.Success {
		headers["Cache-Control"] = "no-store"
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate_limited"}, headers)
		return
	}
	networkLimit, err := s.rateLimiter.LimitScanNetwork(request.Context(), ip, now)
	if err != nil || networkLimit.Unavailable {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "rate_limit_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	if !networkLimit.Success {
		headers = rateLimitHeaders(networkLimit, now)
		headers["Cache-Control"] = "no-store"
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate_limited"}, headers)
		return
	}
	if s.scanCache != nil {
		// Cache availability is deliberately not an admission dependency. This
		// mirrors the existing best-effort cache read: a Redis miss/outage falls
		// through to the durable worker rather than making a valid scan fail.
		if cached, err := s.scanCache.GetCachedScan(request.Context(), username); err == nil && cached != nil {
			recordSuccessfulScanOutcome(request.Context(), s.scanOutcomes, s.lookupGate, s.campaignRevisions, cached.Metrics.Username, s.lookupIPHash(ip), input.Campaign.String(), now)
			s.attachAnonymousSession(w, request, session)
			writeJSON(w, http.StatusOK, scanPayload(*cached, true), headers)
			return
		}
	}

	flightLock := false
	if request.Header.Get("Idempotency-Key") == "" && s.scanFlightGate != nil && s.scanCache != nil {
		acquired, err := s.scanFlightGate.TryAcquireScanFlight(request.Context(), username)
		if err == nil {
			flightLock = acquired
			if !acquired {
				if cached := s.waitForCachedScan(request, username); cached != nil {
					recordSuccessfulScanOutcome(request.Context(), s.scanOutcomes, s.lookupGate, s.campaignRevisions, cached.Metrics.Username, s.lookupIPHash(ip), input.Campaign.String(), s.clock().UTC())
					s.attachAnonymousSession(w, request, session)
					writeJSON(w, http.StatusOK, scanPayload(*cached, true), headers)
					return
				}
				// The producer may have failed or its TTL may have elapsed. One
				// re-acquire attempt keeps the normal case single-flight while a
				// failed producer can never starve a later caller indefinitely.
				flightLock, _ = s.scanFlightGate.TryAcquireScanFlight(request.Context(), username)
			}
		}
	}
	jobID, err := scanIdempotencyJobID(request.Header.Get("Idempotency-Key"), username)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_idempotency_key"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	status, err := s.statuses.Get(request.Context(), jobID)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "job_status_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	if status == nil {
		job := ScanJob{ID: jobID, Username: username, RequestedAt: now.UnixMilli(), LookupHash: s.lookupIPHash(ip), Campaign: input.Campaign.String(), FlightLock: flightLock}
		status = &JobStatus{ID: job.ID, Kind: ScanJobKind, Username: username, State: JobQueued, CreatedAt: now, UpdatedAt: now}
		if err := s.statuses.Put(request.Context(), *status); err != nil {
			if flightLock && s.scanFlightGate != nil {
				_ = s.scanFlightGate.ReleaseScanFlight(context.Background(), username)
			}
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "job_status_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
			return
		}
		if err := s.scanPublisher.PublishScan(request.Context(), job); err != nil {
			s.metrics.recordAPIJobAdmission(ScanJobKind, "publish_failed")
			if flightLock && s.scanFlightGate != nil {
				_ = s.scanFlightGate.ReleaseScanFlight(context.Background(), username)
			}
			status.State, status.Error, status.UpdatedAt = JobFailed, "broker_unavailable", s.clock().UTC()
			_ = s.statuses.Put(context.Background(), *status)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "broker_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
			return
		}
		s.metrics.recordAPIJobAdmission(ScanJobKind, "queued")
	} else {
		s.metrics.recordAPIJobAdmission(ScanJobKind, "deduplicated")
		// An idempotency/status race found an existing producer. Do not leave a
		// new lock that no worker knows it has to release.
		if flightLock && s.scanFlightGate != nil {
			_ = s.scanFlightGate.ReleaseScanFlight(context.Background(), username)
		}
	}
	s.attachAnonymousSession(w, request, session)
	s.waitForScan(w, request, *status, headers, s.lookupIPHash(ip), input.Campaign.String())
}

func (s *APIServer) waitForCachedScan(request *http.Request, username string) *ScanResult {
	if s.scanCache == nil {
		return nil
	}
	deadline := time.NewTimer(s.scanWait)
	defer deadline.Stop()
	ticker := time.NewTicker(s.scanPoll)
	defer ticker.Stop()
	for {
		select {
		case <-request.Context().Done():
			return nil
		case <-deadline.C:
			return nil
		case <-ticker.C:
			scan, err := s.scanCache.GetCachedScan(request.Context(), username)
			if err == nil && scan != nil {
				return scan
			}
		}
	}
}

func (s *APIServer) waitForScan(w http.ResponseWriter, request *http.Request, status JobStatus, headers map[string]string, lookupHash, campaign string) {
	deadline := time.NewTimer(s.scanWait)
	defer deadline.Stop()
	ticker := time.NewTicker(s.scanPoll)
	defer ticker.Stop()
	for {
		if status.State == JobCompleted {
			s.metrics.recordAPIScanWait("completed")
			scan, err := s.scanResults.GetCollectedScan(request.Context(), status.ID)
			if err != nil || scan == nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "scan_failed"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
				return
			}
			recordSuccessfulScanOutcome(request.Context(), s.scanOutcomes, s.lookupGate, s.campaignRevisions, scan.Metrics.Username, lookupHash, campaign, s.clock().UTC())
			headers["Cache-Control"] = "no-store"
			writeJSON(w, http.StatusOK, scanPayload(*scan, false), headers)
			return
		}
		if status.State == JobFailed {
			s.metrics.recordAPIScanWait("failed")
			code, httpStatus := "scan_failed", http.StatusInternalServerError
			if strings.Contains(status.Error, ErrGitHubAccountNotFound.Error()) {
				code, httpStatus = "account_not_found", http.StatusNotFound
			}
			if strings.Contains(status.Error, ErrGitHubRateLimited.Error()) {
				code, httpStatus = "github_rate_limited", http.StatusServiceUnavailable
			}
			writeJSON(w, httpStatus, map[string]string{"error": code}, map[string]string{"Cache-Control": "no-store"})
			return
		}
		select {
		case <-request.Context().Done():
			return
		case <-deadline.C:
			s.metrics.recordAPIScanWait("timeout")
			writeJSON(w, http.StatusAccepted, status, map[string]string{"Cache-Control": "no-store", "Location": "/api/scan/jobs/" + status.ID})
			return
		case <-ticker.C:
			next, err := s.statuses.Get(request.Context(), status.ID)
			if err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "job_status_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
				return
			}
			if next != nil {
				status = *next
			}
		}
	}
}

type scanResponse struct {
	ScanResult
	Cached   bool   `json:"cached"`
	Coverage string `json:"coverage"`
}

func scanPayload(scan ScanResult, cached bool) scanResponse {
	return scanResponse{ScanResult: scan, Cached: cached, Coverage: "quick"}
}

func (s *APIServer) scanJobStatus(w http.ResponseWriter, request *http.Request) {
	if s.statuses == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "job_status_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	id := request.PathValue("id")
	if !validJobID(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_job_id"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	status, err := s.statuses.Get(request.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "job_status_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	if status == nil || status.Kind != ScanJobKind {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	response := struct {
		Status JobStatus     `json:"status"`
		Result *scanResponse `json:"result,omitempty"`
	}{Status: *status}
	if status.State == JobCompleted {
		if s.scanResults == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "scan_result_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
			return
		}
		scan, err := s.scanResults.GetCollectedScan(request.Context(), status.ID)
		if err != nil || scan == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "scan_result_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
			return
		}
		result := scanPayload(*scan, false)
		response.Result = &result
	}
	writeJSON(w, http.StatusOK, response, map[string]string{"Cache-Control": "no-store"})
}

func (s *APIServer) jobStatus(w http.ResponseWriter, request *http.Request) {
	if !s.authorized(request) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	id := request.PathValue("id")
	if !validJobID(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_job_id"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	status, err := s.statuses.Get(request.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "job_status_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	if status == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	writeJSON(w, http.StatusOK, status, map[string]string{"Cache-Control": "no-store"})
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

// unknownString lets JSON decoding reject non-string usernames without a panic.
type unknownString struct{ value string }

func (s *unknownString) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		return nil
	}
	if err := json.Unmarshal(data, &s.value); err != nil {
		return errors.New("must be a string")
	}
	return nil
}

func (s unknownString) String() string { return s.value }

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

// strictGitHubUsername mirrors the badge route's historical URL-segment
// validation. Unlike normalizeGitHubUsername it deliberately does not accept
// @handles or github.com URLs in a path segment.
func strictGitHubUsername(value string) string {
	value = strings.TrimSpace(value)
	if !githubUsernamePattern.MatchString(value) || strings.HasSuffix(value, "-") || strings.Contains(value, "--") {
		return ""
	}
	return strings.ToLower(value)
}

func idempotencyJobID(key, username string) (string, error) {
	return idempotencyJobIDForKind(ScoreSnapshotJobKind, key, username)
}

func scanIdempotencyJobID(key, username string) (string, error) {
	return idempotencyJobIDForKind(ScanJobKind, key, username)
}

func idempotencyJobIDForKind(kind, key, username string) (string, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return NewJobID()
	}
	if len(key) > 512 {
		return "", fmt.Errorf("idempotency key is too long")
	}
	digest := sha256.Sum256([]byte(kind + "\x00" + username + "\x00" + key))
	return "job_" + hex.EncodeToString(digest[:16]), nil
}

func validJobID(id string) bool {
	if len(id) < 8 || len(id) > 68 || !strings.HasPrefix(id, "job_") {
		return false
	}
	for _, character := range id[4:] {
		if !(character >= 'a' && character <= 'f') && !(character >= '0' && character <= '9') {
			return false
		}
	}
	return true
}

func boundedQueryInt(request *http.Request, name string, fallback, minimum, maximum int) int {
	raw := request.URL.Query().Get(name)
	if raw == "" {
		return fallback
	}
	// strconv.Atoi rejects partial values such as "1junk". fmt.Sscan would
	// accept their numeric prefix, which differs from the former Next route's
	// Number(...)/Number.isInteger parsing contract.
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
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
