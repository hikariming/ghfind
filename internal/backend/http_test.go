package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeScoreStore struct {
	total *int
	err   error
}

func (s fakeScoreStore) ScoreCount(context.Context) (*int, error) { return s.total, s.err }

type fakeScanStore struct {
	fakeScoreStore
	scan *ScanResult
	err  error
}

func (s *fakeScanStore) PersistCollectedScan(context.Context, ScanJob, ScanResult) (bool, error) {
	return true, s.err
}
func (s *fakeScanStore) GetCollectedScan(context.Context, string) (*ScanResult, error) {
	return s.scan, s.err
}

type fakeDiscoveryStore struct {
	fakeScoreStore
	result DiscoverySearchResult
	err    error
	query  string
}

func (s *fakeDiscoveryStore) SearchDiscovery(_ context.Context, query string) (DiscoverySearchResult, error) {
	s.query = query
	return s.result, s.err
}

type fakeLeaderboardStore struct {
	fakeScoreStore
	entries []LeaderboardEntry
	err     error
	view    string
	window  string
}

type fakeDeveloperStore struct {
	fakeScoreStore
	categories []FacetCategory
	entries    []LeaderboardEntry
	err        error
	typeSeen   string
	valueSeen  string
}

type fakeBadgeStore struct {
	fakeScoreStore
	data     BadgeData
	err      error
	username string
}

type fakeFacetRankStore struct {
	fakeScoreStore
	data     *FacetRankData
	err      error
	username string
}

type fakeCampaignStore struct {
	fakeScoreStore
	entries  []LeaderboardEntry
	err      error
	campaign string
}

func (s *fakeCampaignStore) GetCampaignLeaderboard(_ context.Context, campaign string) ([]LeaderboardEntry, error) {
	s.campaign = campaign
	return s.entries, s.err
}

func (s *fakeFacetRankStore) GetFacetRank(_ context.Context, username string) (*FacetRankData, error) {
	s.username = username
	return s.data, s.err
}

func (s *fakeBadgeStore) GetBadgeData(_ context.Context, username string, _ time.Time) (BadgeData, error) {
	s.username = username
	return s.data, s.err
}

func (s *fakeDeveloperStore) GetFacetCategories(_ context.Context, facetType string) ([]FacetCategory, error) {
	s.typeSeen = facetType
	return s.categories, s.err
}

func (s *fakeDeveloperStore) GetDevelopersByFacet(_ context.Context, facetType, value string) ([]LeaderboardEntry, error) {
	s.typeSeen = facetType
	s.valueSeen = value
	return s.entries, s.err
}

func (s *fakeLeaderboardStore) GetLeaderboard(_ context.Context, view, window string) ([]LeaderboardEntry, error) {
	s.view = view
	s.window = window
	return s.entries, s.err
}

type fakeStatusStore struct {
	values              map[string]JobStatus
	putErr              error
	getErr              error
	stats               *int
	leaderboards        map[string][]LeaderboardEntry
	facetCats           map[string][]FacetCategory
	facetLists          map[string][]LeaderboardEntry
	limit               RateLimitResult
	limitErr            error
	publicLimits        int
	campaignLimits      int
	campaignRevision    *int64
	campaignRevisionErr error
}

type fakeScanAdmissionStatus struct {
	*fakeStatusStore
	cached         *ScanResult
	flightAcquired bool
	released       []string
}

func (s *fakeScanAdmissionStatus) GetCachedScan(context.Context, string) (*ScanResult, error) {
	return s.cached, nil
}
func (s *fakeScanAdmissionStatus) SetCachedScan(_ context.Context, _ string, scan ScanResult) error {
	s.cached = &scan
	return nil
}
func (s *fakeScanAdmissionStatus) TryAcquireScanFlight(context.Context, string) (bool, error) {
	return s.flightAcquired, nil
}
func (s *fakeScanAdmissionStatus) ReleaseScanFlight(_ context.Context, username string) error {
	s.released = append(s.released, username)
	return nil
}

func (s *fakeStatusStore) Put(_ context.Context, status JobStatus) error {
	if s.putErr != nil {
		return s.putErr
	}
	if s.values == nil {
		s.values = map[string]JobStatus{}
	}
	s.values[status.ID] = status
	return nil
}

func (s *fakeStatusStore) Get(_ context.Context, id string) (*JobStatus, error) {
	if s.getErr != nil {
		return nil, s.getErr
	}
	value, ok := s.values[id]
	if !ok {
		return nil, nil
	}
	return &value, nil
}

func (s *fakeStatusStore) Ping(context.Context) error { return nil }
func (s *fakeStatusStore) GetStats(context.Context) (*int, error) {
	return s.stats, nil
}
func (s *fakeStatusStore) SetStats(_ context.Context, value int) error {
	s.stats = &value
	return nil
}
func (s *fakeStatusStore) GetLeaderboard(_ context.Context, view, window string) ([]LeaderboardEntry, bool, error) {
	value, ok := s.leaderboards[view+":"+window]
	return value, ok, nil
}
func (s *fakeStatusStore) SetLeaderboard(_ context.Context, view, window string, entries []LeaderboardEntry) error {
	if s.leaderboards == nil {
		s.leaderboards = map[string][]LeaderboardEntry{}
	}
	s.leaderboards[view+":"+window] = entries
	return nil
}
func (s *fakeStatusStore) GetFacetCategories(_ context.Context, facetType string) ([]FacetCategory, bool, error) {
	value, ok := s.facetCats[facetType]
	return value, ok, nil
}
func (s *fakeStatusStore) SetFacetCategories(_ context.Context, facetType string, categories []FacetCategory) error {
	if s.facetCats == nil {
		s.facetCats = map[string][]FacetCategory{}
	}
	s.facetCats[facetType] = categories
	return nil
}
func (s *fakeStatusStore) GetFacetDevelopers(_ context.Context, facetType, value string) ([]LeaderboardEntry, bool, error) {
	entries, ok := s.facetLists[facetType+":"+value]
	return entries, ok, nil
}
func (s *fakeStatusStore) SetFacetDevelopers(_ context.Context, facetType, value string, entries []LeaderboardEntry) error {
	if s.facetLists == nil {
		s.facetLists = map[string][]LeaderboardEntry{}
	}
	s.facetLists[facetType+":"+value] = entries
	return nil
}
func (s *fakeStatusStore) LimitPublicRead(context.Context, string, time.Time) (RateLimitResult, error) {
	s.publicLimits++
	return s.limit, s.limitErr
}
func (s *fakeStatusStore) LimitCampaignLeaderboardRead(context.Context, string, time.Time) (RateLimitResult, error) {
	s.campaignLimits++
	return s.limit, s.limitErr
}
func (s *fakeStatusStore) LimitScanPrincipal(context.Context, string, time.Time) (RateLimitResult, error) {
	s.publicLimits++
	return s.limit, s.limitErr
}
func (s *fakeStatusStore) LimitScanNetwork(context.Context, string, time.Time) (RateLimitResult, error) {
	s.publicLimits++
	return s.limit, s.limitErr
}
func (s *fakeStatusStore) GetCampaignLeaderboardRevision(context.Context, string) (*int64, error) {
	return s.campaignRevision, s.campaignRevisionErr
}

type fakePublisher struct {
	published []ScoreSnapshotJob
	scans     []ScanJob
	err       error
}

func (p *fakePublisher) PublishScoreSnapshot(_ context.Context, job ScoreSnapshotJob) error {
	p.published = append(p.published, job)
	return p.err
}
func (p *fakePublisher) PublishRetry(context.Context, ScoreSnapshotJob, time.Duration) error {
	return nil
}
func (p *fakePublisher) PublishDead(context.Context, ScoreSnapshotJob, string) error { return nil }
func (p *fakePublisher) PublishScan(_ context.Context, job ScanJob) error {
	p.scans = append(p.scans, job)
	return p.err
}
func (p *fakePublisher) PublishScanRetry(context.Context, ScanJob, time.Duration) error { return nil }
func (p *fakePublisher) PublishScanDead(context.Context, ScanJob, string) error         { return nil }
func (p *fakePublisher) Ping(context.Context) error                                     { return nil }
func (p *fakePublisher) Close() error                                                   { return nil }

func TestStatsPreservesPublicResponseAndCacheHeader(t *testing.T) {
	total := 42
	server := NewAPIServer(Config{}, fakeScoreStore{total: &total}, &fakeStatusStore{}, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if got := response.Header().Get("Cache-Control"); got != statsCacheControl {
		t.Fatalf("Cache-Control = %q", got)
	}
	var body struct {
		Total  *int `json:"total"`
		Cached bool `json:"cached"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Total == nil || *body.Total != 42 || body.Cached {
		t.Fatalf("body = %#v", body)
	}
}

func TestStatsReturnsExistingUpstashValueAsCached(t *testing.T) {
	total := 99
	statuses := &fakeStatusStore{stats: &total}
	server := NewAPIServer(Config{}, fakeScoreStore{}, statuses, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var body struct {
		Total  int  `json:"total"`
		Cached bool `json:"cached"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Total != 99 || !body.Cached {
		t.Fatalf("body = %#v", body)
	}
}

func TestScoreSnapshotJobAdmissionIsAuthenticatedAndIdempotent(t *testing.T) {
	statuses := &fakeStatusStore{}
	publisher := &fakePublisher{}
	server := NewAPIServer(
		Config{AdminSecret: "admin-secret"},
		fakeScoreStore{},
		statuses,
		publisher,
	)
	server.clock = func() time.Time { return time.Unix(1_700_000_000, 0) }
	makeRequest := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/internal/jobs/score-snapshot", strings.NewReader(`{"username":"OctoCat"}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Admin-Secret", "admin-secret")
		request.Header.Set("Idempotency-Key", "same-request")
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		return response
	}
	first := makeRequest()
	if first.Code != http.StatusAccepted {
		t.Fatalf("first status = %d, body = %s", first.Code, first.Body.String())
	}
	second := makeRequest()
	if second.Code != http.StatusAccepted {
		t.Fatalf("second status = %d, body = %s", second.Code, second.Body.String())
	}
	if len(publisher.published) != 1 {
		t.Fatalf("published = %d, want 1", len(publisher.published))
	}
	if publisher.published[0].Username != "octocat" {
		t.Fatalf("username = %q", publisher.published[0].Username)
	}
	if location := first.Header().Get("Location"); location == "" || location != second.Header().Get("Location") {
		t.Fatalf("locations = %q / %q", location, second.Header().Get("Location"))
	}
}

func TestAPIMetricsExposeJobAdmissionCounters(t *testing.T) {
	statuses := &fakeStatusStore{}
	server := NewAPIServer(Config{AdminSecret: "admin-secret"}, fakeScoreStore{}, statuses, &fakePublisher{})
	request := httptest.NewRequest(http.MethodPost, "/api/internal/jobs/score-snapshot", strings.NewReader(`{"username":"octocat"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Admin-Secret", "admin-secret")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("admission status=%d body=%s", response.Code, response.Body.String())
	}

	metricsResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(metricsResponse, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if metricsResponse.Code != http.StatusOK {
		t.Fatalf("metrics status=%d", metricsResponse.Code)
	}
	want := `ghfind_api_job_admissions_total{kind="score_snapshot.v1",result="queued"} 1`
	if !strings.Contains(metricsResponse.Body.String(), want) {
		t.Fatalf("missing metric %q in:\n%s", want, metricsResponse.Body.String())
	}
}

func TestScoreSnapshotJobRejectsMissingAdminSecret(t *testing.T) {
	server := NewAPIServer(Config{AdminSecret: "admin-secret"}, fakeScoreStore{}, &fakeStatusStore{}, &fakePublisher{})
	request := httptest.NewRequest(http.MethodPost, "/api/internal/jobs/score-snapshot", strings.NewReader(`{"username":"octocat"}`))
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestScanReturnsWorkerPersistedResultWithoutNextBusinessFallback(t *testing.T) {
	jobID, err := scanIdempotencyJobID("same-scan", "octocat")
	if err != nil {
		t.Fatal(err)
	}
	metrics := RawMetrics{Username: "octocat", AccountAgeYears: 4, ContributionYearsActive: 3, NonemptyOriginalRepoCount: 1, DaysSinceLastActivity: floatPointer(1)}
	scan := &ScanResult{Metrics: metrics, TopRepos: []TopRepo{}, RecentPRs: []RecentPR{}, FloodPRTitles: []string{}, ImpactRepos: []ImpactRepo{}, VerifiedImpactPRs: []RecentPR{}, SignatureWork: BuildRecentSignatureWork(nil, nil), PinnedRepos: []string{}, Organizations: []string{}}
	scan.Scoring = Score(metrics)
	statuses := &fakeStatusStore{limit: RateLimitResult{Success: true, Limit: 10, Remaining: 9, ResetAt: time.Now().Add(time.Minute)}, values: map[string]JobStatus{jobID: {ID: jobID, Kind: ScanJobKind, Username: "octocat", State: JobCompleted}}}
	store := &fakeScanStore{scan: scan}
	server := NewAPIServer(Config{CLIAPIKey: "machine"}, store, statuses, &fakePublisher{})
	request := httptest.NewRequest(http.MethodPost, "/api/scan", strings.NewReader(`{"username":"OctoCat"}`))
	request.Header.Set("Authorization", "Bearer machine")
	request.Header.Set("Idempotency-Key", "same-scan")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Cached   bool       `json:"cached"`
		Coverage string     `json:"coverage"`
		Metrics  RawMetrics `json:"metrics"`
		Scoring  Scoring    `json:"scoring"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Cached || body.Coverage != "quick" || body.Metrics.Username != "octocat" || body.Scoring.FinalScore != scan.Scoring.FinalScore {
		t.Fatalf("body=%#v", body)
	}
}

func TestScanCacheAndFlightLockReuseExistingUpstashContracts(t *testing.T) {
	metrics := RawMetrics{Username: "octocat", AccountAgeYears: 4, ContributionYearsActive: 3, NonemptyOriginalRepoCount: 1, DaysSinceLastActivity: floatPointer(1)}
	scan := &ScanResult{Metrics: metrics, TopRepos: []TopRepo{}, RecentPRs: []RecentPR{}, FloodPRTitles: []string{}, ImpactRepos: []ImpactRepo{}, VerifiedImpactPRs: []RecentPR{}, SignatureWork: BuildRecentSignatureWork(nil, nil), PinnedRepos: []string{}, Organizations: []string{}}
	scan.Scoring = Score(metrics)
	base := &fakeStatusStore{limit: RateLimitResult{Success: true, Limit: 10, Remaining: 9, ResetAt: time.Now().Add(time.Minute)}}
	cacheStatus := &fakeScanAdmissionStatus{fakeStatusStore: base, cached: scan}
	publisher := &fakePublisher{}
	server := NewAPIServer(Config{CLIAPIKey: "machine"}, &fakeScanStore{scan: scan}, cacheStatus, publisher)
	request := httptest.NewRequest(http.MethodPost, "/api/scan", strings.NewReader(`{"username":"OctoCat"}`))
	request.Header.Set("Authorization", "Bearer machine")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || len(publisher.scans) != 0 || !strings.Contains(response.Body.String(), `"cached":true`) {
		t.Fatalf("cache response=%d body=%s jobs=%#v", response.Code, response.Body.String(), publisher.scans)
	}

	cacheStatus.cached = nil
	cacheStatus.flightAcquired = true
	server.scanWait = time.Millisecond
	server.scanPoll = time.Millisecond
	request = httptest.NewRequest(http.MethodPost, "/api/scan", strings.NewReader(`{"username":"OctoCat","campaign":"advx"}`))
	request.Header.Set("Authorization", "Bearer machine")
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || len(publisher.scans) != 1 || !publisher.scans[0].FlightLock || publisher.scans[0].LookupHash == "" || publisher.scans[0].LookupHash == "0.0.0.0" || publisher.scans[0].Campaign != "advx" {
		t.Fatalf("flight response=%d body=%s jobs=%#v", response.Code, response.Body.String(), publisher.scans)
	}
	if location := response.Header().Get("Location"); !strings.HasPrefix(location, "/api/scan/jobs/job_") {
		t.Fatalf("Location=%q", location)
	}
}

func TestPublicScanJobStatusReturnsWorkerResultAndHidesInternalJobs(t *testing.T) {
	metrics := RawMetrics{Username: "octocat", AccountAgeYears: 4, ContributionYearsActive: 3, NonemptyOriginalRepoCount: 1, DaysSinceLastActivity: floatPointer(1)}
	scan := &ScanResult{Metrics: metrics, TopRepos: []TopRepo{}, RecentPRs: []RecentPR{}, FloodPRTitles: []string{}, ImpactRepos: []ImpactRepo{}, VerifiedImpactPRs: []RecentPR{}, SignatureWork: BuildRecentSignatureWork(nil, nil), PinnedRepos: []string{}, Organizations: []string{}}
	scan.Scoring = Score(metrics)
	statuses := &fakeStatusStore{values: map[string]JobStatus{
		"job_aaaaaaaaaaaaaaaa": {ID: "job_aaaaaaaaaaaaaaaa", Kind: ScanJobKind, Username: "octocat", State: JobCompleted},
		"job_bbbbbbbbbbbbbbbb": {ID: "job_bbbbbbbbbbbbbbbb", Kind: ScoreSnapshotJobKind, Username: "octocat", State: JobCompleted},
	}}
	server := NewAPIServer(Config{}, &fakeScanStore{scan: scan}, statuses, &fakePublisher{})

	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/scan/jobs/job_aaaaaaaaaaaaaaaa", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Status JobStatus     `json:"status"`
		Result *scanResponse `json:"result"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Status.Kind != ScanJobKind || body.Result == nil || body.Result.Metrics.Username != "octocat" || body.Result.Coverage != "quick" {
		t.Fatalf("body=%#v", body)
	}

	hidden := httptest.NewRecorder()
	server.Handler().ServeHTTP(hidden, httptest.NewRequest(http.MethodGet, "/api/scan/jobs/job_bbbbbbbbbbbbbbbb", nil))
	if hidden.Code != http.StatusNotFound {
		t.Fatalf("internal job status=%d body=%s", hidden.Code, hidden.Body.String())
	}
}

func TestSearchUsersKeepsEmptyResultShapeForBlankQuery(t *testing.T) {
	server := NewAPIServer(Config{}, fakeScoreStore{}, &fakeStatusStore{}, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/search-users?q=%20", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var body DiscoverySearchResult
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Users) != 0 || len(body.Repos) != 0 || len(body.Facets) != 0 {
		t.Fatalf("body = %#v", body)
	}
}

func TestSearchUsersUsesGoDiscoveryStore(t *testing.T) {
	discovery := &fakeDiscoveryStore{result: DiscoverySearchResult{
		Users:  []UserSuggestion{{Username: "octocat", FinalScore: 80, Tier: "顶级"}},
		Repos:  []RepoSuggestion{},
		Facets: []FacetSuggestion{},
	}}
	server := NewAPIServer(Config{}, discovery, &fakeStatusStore{}, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/search-users?q=oct", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if discovery.query != "oct" {
		t.Fatalf("query = %q", discovery.query)
	}
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=0, s-maxage=300, stale-while-revalidate=600" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestLeaderboardPreservesViewWindowAndPaginationContract(t *testing.T) {
	leaderboards := &fakeLeaderboardStore{entries: []LeaderboardEntry{
		{Username: "top", FinalScore: 99},
		{Username: "next", FinalScore: 88},
	}}
	server := NewAPIServer(Config{}, leaderboards, &fakeStatusStore{}, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/leaderboard?view=score&window=7d&limit=1&offset=1", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if leaderboards.view != "score" || leaderboards.window != "7d" {
		t.Fatalf("query = %s/%s", leaderboards.view, leaderboards.window)
	}
	var body struct {
		Entries    []LeaderboardEntry `json:"entries"`
		Total      int                `json:"total"`
		Limit      int                `json:"limit"`
		Offset     int                `json:"offset"`
		NextOffset *int               `json:"nextOffset"`
		Cached     bool               `json:"cached"`
		View       string             `json:"view"`
		Window     string             `json:"window"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Entries) != 1 || body.Entries[0].Username != "next" || body.Total != 2 || body.Limit != 1 || body.Offset != 1 || body.NextOffset != nil || body.Cached || body.View != "score" || body.Window != "7d" {
		t.Fatalf("body = %#v", body)
	}
}

func TestLeaderboardRejectsPartialNumericPaginationValues(t *testing.T) {
	leaderboards := &fakeLeaderboardStore{entries: []LeaderboardEntry{{Username: "top", FinalScore: 99}}}
	server := NewAPIServer(Config{}, leaderboards, &fakeStatusStore{}, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/leaderboard?limit=1junk&offset=1junk", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Limit  int `json:"limit"`
		Offset int `json:"offset"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Limit != leaderboardLimit || body.Offset != 0 {
		t.Fatalf("pagination = %#v", body)
	}
}

func TestDeveloperDirectoryPreservesCategoryAndCacheContract(t *testing.T) {
	store := &fakeDeveloperStore{categories: []FacetCategory{{Value: "Rust", Count: 12}}}
	statuses := &fakeStatusStore{}
	server := NewAPIServer(Config{}, store, statuses, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/developers?type=language", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if store.typeSeen != "language" || len(statuses.facetCats["language"]) != 1 {
		t.Fatalf("store type=%q cached=%#v", store.typeSeen, statuses.facetCats)
	}
	if got := response.Header().Get("Cache-Control"); got != developersCacheControl {
		t.Fatalf("Cache-Control = %q", got)
	}
	var body struct {
		Type       string          `json:"type"`
		Categories []FacetCategory `json:"categories"`
		Total      int             `json:"total"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Type != "language" || body.Total != 1 || body.Categories[0].Value != "Rust" {
		t.Fatalf("body = %#v", body)
	}
}

func TestDeveloperDirectoryPreservesBucketPaginationAndValidation(t *testing.T) {
	store := &fakeDeveloperStore{entries: []LeaderboardEntry{
		{Username: "top", FinalScore: 99},
		{Username: "next", FinalScore: 88},
	}}
	server := NewAPIServer(Config{}, store, &fakeStatusStore{}, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/developers?type=repo&value=openai/gpt&limit=1&offset=1", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if store.typeSeen != "repo" || store.valueSeen != "openai/gpt" {
		t.Fatalf("store query = %q/%q", store.typeSeen, store.valueSeen)
	}
	var body struct {
		Entries []LeaderboardEntry `json:"entries"`
		Total   int                `json:"total"`
		Limit   int                `json:"limit"`
		Offset  int                `json:"offset"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Entries) != 1 || body.Entries[0].Username != "next" || body.Total != 2 || body.Limit != 1 || body.Offset != 1 {
		t.Fatalf("body = %#v", body)
	}

	invalidRequest := httptest.NewRequest(http.MethodGet, "/api/developers?type=team", nil)
	invalidResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(invalidResponse, invalidRequest)
	if invalidResponse.Code != http.StatusBadRequest || !strings.Contains(invalidResponse.Body.String(), `"error":"invalid_type"`) {
		t.Fatalf("invalid type response = %d %s", invalidResponse.Code, invalidResponse.Body.String())
	}
}

func TestBadgeDataUsesStrictPathUsernameAndKeepsNullFallback(t *testing.T) {
	score := 88.5
	tier := "顶级"
	delta := 1.2
	store := &fakeBadgeStore{data: BadgeData{FinalScore: &score, Tier: &tier, Delta: &delta}}
	server := NewAPIServer(Config{}, store, &fakeStatusStore{}, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/embed/badge/OctoCat", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || store.username != "octocat" {
		t.Fatalf("status=%d username=%q", response.Code, store.username)
	}
	var body BadgeData
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.FinalScore == nil || *body.FinalScore != score || body.Tier == nil || *body.Tier != tier || body.Delta == nil || *body.Delta != delta {
		t.Fatalf("body = %#v", body)
	}

	invalidRequest := httptest.NewRequest(http.MethodGet, "/api/embed/badge/@octocat", nil)
	invalidResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(invalidResponse, invalidRequest)
	if invalidResponse.Code != http.StatusOK || store.username != "octocat" || !strings.Contains(invalidResponse.Body.String(), `"final_score":null`) {
		t.Fatalf("invalid response=%d %s", invalidResponse.Code, invalidResponse.Body.String())
	}
}

func TestFacetRankPreservesRateLimitAndNullContracts(t *testing.T) {
	store := &fakeFacetRankStore{data: &FacetRankData{
		FacetType: "language", FacetValue: "Go", Rank: 2, Total: 10,
		Ahead: &FacetRankAhead{Username: "hubot", FinalScore: 95},
	}}
	statuses := &fakeStatusStore{limit: RateLimitResult{
		Success: true, Limit: 10, Remaining: 9, ResetAt: time.Now().Add(time.Minute),
	}}
	server := NewAPIServer(Config{}, store, statuses, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/facet-rank/OctoCat", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || store.username != "octocat" {
		t.Fatalf("status=%d username=%q", response.Code, store.username)
	}
	if got := response.Header().Get("Cache-Control"); got != facetRankCacheControl {
		t.Fatalf("Cache-Control=%q", got)
	}
	if !strings.Contains(response.Body.String(), `"facetValue":"Go"`) {
		t.Fatalf("body=%s", response.Body.String())
	}

	statuses.limit = RateLimitResult{Success: false, Limit: 10, Remaining: 0, ResetAt: time.Now().Add(time.Minute)}
	blockedResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(blockedResponse, request)
	if blockedResponse.Code != http.StatusTooManyRequests || !strings.Contains(blockedResponse.Body.String(), `"error":"rate_limited"`) {
		t.Fatalf("blocked=%d %s", blockedResponse.Code, blockedResponse.Body.String())
	}
}

func TestCampaignLeaderboardPreservesPaginationRateBudgetAndLiveCache(t *testing.T) {
	store := &fakeCampaignStore{entries: []LeaderboardEntry{
		{Username: "top", FinalScore: 99}, {Username: "next", FinalScore: 88},
	}}
	statuses := &fakeStatusStore{limit: RateLimitResult{Success: true, Limit: 10, Remaining: 9, ResetAt: time.Now().Add(time.Minute)}}
	server := NewAPIServer(Config{}, store, statuses, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/campaigns/advx/leaderboard?limit=1", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || store.campaign != "advx" || statuses.publicLimits != 1 {
		t.Fatalf("status=%d campaign=%q public_limits=%d", response.Code, store.campaign, statuses.publicLimits)
	}
	if got := response.Header().Get("Cache-Control"); got != campaignLeaderboardCacheControl {
		t.Fatalf("Cache-Control=%q", got)
	}
	if !strings.Contains(response.Body.String(), `"username":"top"`) || !strings.Contains(response.Body.String(), `"nextOffset":1`) {
		t.Fatalf("body=%s", response.Body.String())
	}

	liveRequest := httptest.NewRequest(http.MethodGet, "/api/campaigns/advx/leaderboard?limit=1&live=1", nil)
	liveResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(liveResponse, liveRequest)
	if liveResponse.Code != http.StatusOK || statuses.campaignLimits != 1 || liveResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("live status=%d campaign_limits=%d cache=%q", liveResponse.Code, statuses.campaignLimits, liveResponse.Header().Get("Cache-Control"))
	}

	canonicalRequest := httptest.NewRequest(http.MethodGet, "/api/campaigns/advx/leaderboard?limit=0100&utm=x", nil)
	canonicalResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(canonicalResponse, canonicalRequest)
	if canonicalResponse.Code != http.StatusPermanentRedirect || canonicalResponse.Header().Get("Location") != "http://example.com/api/campaigns/advx/leaderboard" {
		t.Fatalf("canonical=%d location=%q", canonicalResponse.Code, canonicalResponse.Header().Get("Location"))
	}
}
