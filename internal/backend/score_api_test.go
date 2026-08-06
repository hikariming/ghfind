package backend

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeScoreReadStore struct {
	fakeScoreStore
	detail     *StoredScoreDetail
	percentile *ScorePercentile
	readCalls  int
}

func (s *fakeScoreReadStore) GetStoredScore(context.Context, string) (*StoredScoreDetail, error) {
	s.readCalls++
	return s.detail, nil
}

func (s *fakeScoreReadStore) GetScorePercentile(context.Context, float64) (*ScorePercentile, error) {
	return s.percentile, nil
}

type fakeScoreReadScanStore struct {
	fakeScoreReadStore
	persisted int
}

func (s *fakeScoreReadScanStore) PersistCollectedScan(context.Context, ScanJob, ScanResult) (bool, error) {
	s.persisted++
	return true, nil
}

func (s *fakeScoreReadScanStore) GetCollectedScan(context.Context, string) (*ScanResult, error) {
	return nil, nil
}

type fakeScoreStatusStore struct {
	*fakeStatusStore
	cached *ScanResult
}

func (s *fakeScoreStatusStore) GetCachedScan(context.Context, string) (*ScanResult, error) {
	return s.cached, nil
}

func (s *fakeScoreStatusStore) SetCachedScan(context.Context, string, ScanResult) error { return nil }

func canonicalScoreDetail() *StoredScoreDetail {
	return &StoredScoreDetail{
		Username:          "octocat",
		FinalScore:        88.2,
		Tier:              "顶级",
		Tags:              Tags{ZH: []string{}, EN: []string{}},
		RoastLine:         RoastLine{},
		ScoreVersion:      canonicalScoreVersion,
		CollectionVersion: goCanonicalCollectionVersion,
		SnapshotHash:      strings.Repeat("a", 64),
		ScannedAt:         1,
	}
}

func TestScoreUsesCanonicalIndexBeforeRateLimitOrQueue(t *testing.T) {
	store := &fakeScoreReadStore{detail: canonicalScoreDetail()}
	statuses := &fakeStatusStore{limit: RateLimitResult{Success: true, Limit: 10, Remaining: 9, ResetAt: time.Now().Add(time.Minute)}}
	server := NewAPIServer(Config{PublicSiteURL: "https://ghfind.example"}, store, statuses, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/score/OctoCat", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != scoreRatedCache || statuses.publicLimits != 0 {
		t.Fatalf("status=%d cache=%q limits=%d body=%s", response.Code, response.Header().Get("Cache-Control"), statuses.publicLimits, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"source":"indexed"`) || !strings.Contains(response.Body.String(), `"tier_key":"elite"`) {
		t.Fatalf("body=%s", response.Body.String())
	}
}

func TestScoreReturnsLegacyOnlyAfterQuickPathCannotRun(t *testing.T) {
	legacy := canonicalScoreDetail()
	legacy.ScoreVersion, legacy.CollectionVersion, legacy.SnapshotHash, legacy.LegacyFallback = "v5", "", "", true
	store := &fakeScoreReadStore{detail: legacy}
	now := time.Unix(1_700_000_000, 0).UTC()
	statuses := &fakeStatusStore{limit: RateLimitResult{Success: true, Limit: 10, Remaining: 9, ResetAt: now.Add(time.Minute)}}
	server := NewAPIServer(Config{PublicSiteURL: "https://ghfind.example"}, store, statuses, &fakePublisher{})
	server.clock = func() time.Time { return now }
	request := httptest.NewRequest(http.MethodGet, "/api/score/octocat", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("RateLimit-Limit") != "10" || !strings.Contains(response.Body.String(), `"source":"legacy_v5_v5_v3"`) {
		t.Fatalf("status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
}

func TestScoreCachedQuickResultPersistsBeforeResponding(t *testing.T) {
	store := &fakeScoreReadScanStore{}
	now := time.Unix(1_700_000_000, 0).UTC()
	metrics := RawMetrics{Username: "octocat", AccountAgeYears: 4, NonemptyOriginalRepoCount: 1, ContributionYearsActive: 2}
	cached := &ScanResult{Metrics: metrics, Scoring: Score(metrics)}
	statuses := &fakeScoreStatusStore{fakeStatusStore: &fakeStatusStore{limit: RateLimitResult{Success: true, Limit: 10, Remaining: 9, ResetAt: now.Add(time.Minute)}}, cached: cached}
	server := NewAPIServer(Config{PublicSiteURL: "https://ghfind.example"}, store, statuses, &fakePublisher{})
	server.clock = func() time.Time { return now }
	request := httptest.NewRequest(http.MethodGet, "/api/score/octocat", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || store.persisted != 1 || response.Header().Get("RateLimit-Remaining") != "9" || !strings.Contains(response.Body.String(), `"cached":true`) {
		t.Fatalf("status=%d persisted=%d headers=%v body=%s", response.Code, store.persisted, response.Header(), response.Body.String())
	}
}
