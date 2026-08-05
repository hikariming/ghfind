package backend

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type roastFixtureStore struct {
	canonical *CanonicalRoastScan
	identity  *RoastScoreIdentity
	reads     int
	persisted []string
}

func (s *roastFixtureStore) ScoreCount(context.Context) (*int, error) { return nil, nil }
func (s *roastFixtureStore) GetCanonicalRoastScan(context.Context, string) (*CanonicalRoastScan, error) {
	s.reads++
	return s.canonical, nil
}
func (s *roastFixtureStore) GetLegacyRoast(context.Context, string, roastLanguage) (*StoredRoast, error) {
	return nil, nil
}
func (s *roastFixtureStore) GetArchivedRoast(context.Context, string, roastLanguage) (*StoredRoast, error) {
	return nil, nil
}
func (s *roastFixtureStore) GetRoastScoreIdentity(context.Context, string, string) (*RoastScoreIdentity, error) {
	return s.identity, nil
}
func (s *roastFixtureStore) GetRoastScannedAt(context.Context, string) (*int64, error) {
	return nil, nil
}
func (s *roastFixtureStore) PersistRoast(_ context.Context, _ string, report string, _ roastLanguage, _ RoastScoreIdentity, _ Tags, _ RoastLine, _ time.Time) (bool, error) {
	s.persisted = append(s.persisted, report)
	return true, nil
}
func (s *roastFixtureStore) GetRoastRank(context.Context, float64) (*RoastRank, error) {
	return &RoastRank{Below: 7, Total: 10, Rank: 3}, nil
}

type roastFixtureStatus struct {
	requestLimit RateLimitResult
	requestCalls int
	cache        *CachedRoast
	persisted    int
}

func (s *roastFixtureStatus) Put(context.Context, JobStatus) error { return nil }
func (s *roastFixtureStatus) Get(context.Context, string) (*JobStatus, error) {
	return nil, nil
}
func (s *roastFixtureStatus) Ping(context.Context) error { return nil }
func (s *roastFixtureStatus) LimitRoastRequest(context.Context, string, time.Time) (RateLimitResult, error) {
	s.requestCalls++
	return s.requestLimit, nil
}
func (s *roastFixtureStatus) LimitRoastRequestNetwork(context.Context, string, time.Time) (RateLimitResult, error) {
	return RateLimitResult{Success: true, Limit: 120, Remaining: 119, ResetAt: time.Now().Add(time.Minute)}, nil
}
func (s *roastFixtureStatus) LimitRoastGeneration(context.Context, string, time.Time) (RateLimitResult, error) {
	return RateLimitResult{Success: true}, nil
}
func (s *roastFixtureStatus) LimitRoastNetworkGeneration(context.Context, string, time.Time) (RateLimitResult, error) {
	return RateLimitResult{Success: true}, nil
}
func (s *roastFixtureStatus) GetCachedRoast(context.Context, string, roastLanguage) (*CachedRoast, error) {
	return s.cache, nil
}
func (s *roastFixtureStatus) SetCachedRoast(_ context.Context, _ string, _ roastLanguage, value CachedRoast) error {
	s.cache, s.persisted = &value, s.persisted+1
	return nil
}
func (s *roastFixtureStatus) ClearCachedRoast(context.Context, string, roastLanguage) error {
	return nil
}
func (s *roastFixtureStatus) TryAcquireRoastLock(context.Context, string, roastLanguage) (bool, error) {
	return true, nil
}
func (s *roastFixtureStatus) ReleaseRoastLock(context.Context, string, roastLanguage) error {
	return nil
}
func (s *roastFixtureStatus) HasRoastLock(context.Context, string, roastLanguage) (bool, error) {
	return false, nil
}

func roastFixtureScan() ScanResult {
	metrics := RawMetrics{Username: "octocat", Followers: 12, TotalStars: 500, AccountAgeYears: 3, ContributionYearsActive: 2, NonemptyOriginalRepoCount: 1, LastYearContributions: 20, DaysSinceLastActivity: floatPointer(1)}
	return ScanResult{Metrics: metrics, TopRepos: []TopRepo{}, RecentPRs: []RecentPR{}, FloodPRTitles: []string{}, ImpactRepos: []ImpactRepo{}, VerifiedImpactPRs: []RecentPR{}, SignatureWork: BuildRecentSignatureWork(nil, nil), Organizations: []string{}, PinnedRepos: []string{}, Scoring: Score(metrics)}
}

func TestRoastRateLimitsBeforeSnapshotReads(t *testing.T) {
	store := &roastFixtureStore{canonical: &CanonicalRoastScan{Scan: roastFixtureScan(), SnapshotHash: strings.Repeat("a", 64)}, identity: &RoastScoreIdentity{ScannedAt: 1, Token: "token"}}
	statuses := &roastFixtureStatus{requestLimit: RateLimitResult{Success: false, Limit: 20, Remaining: 0, ResetAt: time.Now().Add(time.Minute)}}
	server := NewAPIServer(Config{LLMAPIKey: "key"}, store, statuses, &fakePublisher{})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/roast", strings.NewReader(`{"username":"octocat"}`))
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusTooManyRequests || store.reads != 0 || statuses.requestCalls != 1 {
		t.Fatalf("status=%d reads=%d requestCalls=%d", response.Code, store.reads, statuses.requestCalls)
	}
}

func TestRoastStreamsFramesAndPersistsOnlyAfterReport(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"@@ADJUST 0@@\\n@@TAGS zh=工程|en=engineering@@\\n@@ROAST zh=有料|en=has receipts@@\\n## octocat — 80/100\\n报告正文\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer provider.Close()
	scan := roastFixtureScan()
	store := &roastFixtureStore{canonical: &CanonicalRoastScan{Scan: scan, SnapshotHash: strings.Repeat("a", 64)}, identity: &RoastScoreIdentity{ScannedAt: 1, Token: "token"}}
	statuses := &roastFixtureStatus{requestLimit: RateLimitResult{Success: true, Limit: 20, Remaining: 19, ResetAt: time.Now().Add(time.Minute)}}
	server := NewAPIServer(Config{LLMAPIKey: "key", LLMBaseURL: provider.URL, LLMModel: "fixture"}, store, statuses, &fakePublisher{})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/roast", strings.NewReader(`{"username":"octocat","lang":"zh"}`))
	server.Handler().ServeHTTP(response, request)
	body := response.Body.String()
	if response.Code != http.StatusOK || !strings.Contains(body, "\x1fT") || !strings.Contains(body, "\x1fM") || !strings.Contains(body, "## octocat") {
		t.Fatalf("status=%d body=%q", response.Code, body)
	}
	if len(store.persisted) != 1 || statuses.persisted != 1 {
		t.Fatalf("persisted=%#v cacheWrites=%d", store.persisted, statuses.persisted)
	}
	encoded := response.Header().Get("X-Roast-Meta")
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	var meta RoastMeta
	if err := json.Unmarshal(decoded, &meta); err != nil || len(meta.Tags.ZH) != 0 || meta.Percentile != nil {
		t.Fatalf("meta=%#v err=%v", meta, err)
	}
	frameStart := strings.Index(body, "\x1fM")
	frameEnd := strings.Index(body[frameStart:], "\n")
	frame, err := base64.StdEncoding.DecodeString(body[frameStart+2 : frameStart+frameEnd])
	if err != nil || !strings.Contains(string(frame), `"beat":70`) {
		t.Fatalf("stream should carry enriched meta frame=%q err=%v", frame, err)
	}
}

func TestRoastWithBYOKeyDoesNotPersistOrCacheProviderSecret(t *testing.T) {
	authorization := ""
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		authorization = request.Header.Get("Authorization")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"@@ADJUST 0@@\\n@@TAGS zh=自带|en=byo@@\\n@@ROAST zh=自带key|en=BYO key@@\\n## octocat — 80/100\\nBYO 正文\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer provider.Close()
	scan := roastFixtureScan()
	store := &roastFixtureStore{}
	statuses := &roastFixtureStatus{requestLimit: RateLimitResult{Success: true, Limit: 20, Remaining: 19, ResetAt: time.Now().Add(time.Minute)}}
	server := NewAPIServer(Config{}, store, statuses, &fakePublisher{})
	body, err := json.Marshal(map[string]any{
		"scan": scan,
		"lang": "zh",
		"byoKey": map[string]string{
			"baseURL": provider.URL,
			"apiKey":  "visitor-secret",
			"model":   "fixture",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/roast", bytes.NewReader(body))
	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "BYO 正文") {
		t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
	}
	if authorization != "Bearer visitor-secret" {
		t.Fatalf("provider authorization = %q", authorization)
	}
	if len(store.persisted) != 0 || statuses.persisted != 0 {
		t.Fatalf("BYO roast persisted store=%#v cacheWrites=%d", store.persisted, statuses.persisted)
	}
}

func TestRoastSafetySanitizesAcrossStreamChunksBeforeTheyReachClient(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"@@ADJUST 0@@\\n@@TAGS zh=模式PR|en=Pattern PR@@\\n@@ROAST zh=Apache 维护者 judge_\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"result 刷KPI@@\\n## octocat — 80/100\\nApache Maintainer 的 judge_result 是 PR Spammer。\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer provider.Close()
	scan := roastFixtureScan()
	scan.Metrics.CoreImpactPRCount = floatPointer(12)
	scan.Metrics.ImpactPRCount = 60
	scan.Metrics.RecentExternalDocLikePRRatio = floatPointer(0.1)
	scan.Metrics.PRRejectionRate = 0.1
	store := &roastFixtureStore{canonical: &CanonicalRoastScan{Scan: scan, SnapshotHash: strings.Repeat("a", 64)}, identity: &RoastScoreIdentity{ScannedAt: 1, Token: "token"}}
	statuses := &roastFixtureStatus{requestLimit: RateLimitResult{Success: true, Limit: 20, Remaining: 19, ResetAt: time.Now().Add(time.Minute)}}
	server := NewAPIServer(Config{LLMAPIKey: "key", LLMBaseURL: provider.URL, LLMModel: "fixture"}, store, statuses, &fakePublisher{})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/roast", strings.NewReader(`{"username":"octocat","lang":"zh"}`))
	server.Handler().ServeHTTP(response, request)
	body := response.Body.String()
	for _, forbidden := range []string{"judge_result", "judge_", "PR Spammer", "Apache Maintainer", "刷KPI"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("forbidden generated term %q leaked in %q", forbidden, body)
		}
	}
	if !strings.Contains(body, "Apache related repo contributor") || !strings.Contains(body, "Pattern PR") {
		t.Fatalf("safety output missing expected replacements: %q", body)
	}
}

func TestRoastPromptCarriesPublicRiskAndEvidenceGuardrailsWithoutUnsafeFields(t *testing.T) {
	scan := roastFixtureScan()
	scan.Metrics.ImpactPRCount = 60
	scan.Metrics.ImpactCommitCount = floatPointer(0)
	scan.Metrics.CoreImpactPRCount = floatPointer(12)
	scan.Metrics.DocLikeImpactPRCount = floatPointer(2)
	scan.Metrics.RecentExternalDocLikePRRatio = floatPointer(0.1)
	scan.Metrics.UnverifiedImpactPRCount = floatPointer(99)
	scan.Metrics.PRFloodSuspect = true
	scan.TopRepos = []TopRepo{{Name: "repo", NameWithOwner: stringPointer("owner/repo"), OpenIssues: 42, OpenIssueCount: floatPointer(3)}}
	messages := buildRoastPrompt(scan, roastLanguageEN)
	if len(messages) != 2 || !strings.Contains(messages[0].Content, "workflow-landed PRs") {
		t.Fatalf("messages=%#v", messages)
	}
	content := messages[1].Content
	for _, required := range []string{"impact_summary", "risk_notes", "factual_guardrails", "signature_work", "Strong-core fact"} {
		if !strings.Contains(content, required) {
			t.Fatalf("prompt missing %q: %s", required, content)
		}
	}
	for _, forbidden := range []string{"unverified_impact_pr_count", `"open_issues"`} {
		if strings.Contains(content, forbidden) {
			t.Fatalf("prompt leaked %q: %s", forbidden, content)
		}
	}
}
