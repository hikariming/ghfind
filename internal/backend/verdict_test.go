package backend

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

type verdictFixtureStore struct {
	details map[string]*StoredScoreDetail
	reads   int
	records []MatchupInput
	bumps   int
}

func (s *verdictFixtureStore) ScoreCount(context.Context) (*int, error) { return nil, nil }
func (s *verdictFixtureStore) GetStoredScore(_ context.Context, username string) (*StoredScoreDetail, error) {
	s.reads++
	return s.details[username], nil
}
func (s *verdictFixtureStore) GetScorePercentile(context.Context, float64) (*ScorePercentile, error) {
	return nil, nil
}
func (s *verdictFixtureStore) RecordMatchup(_ context.Context, value MatchupInput) error {
	s.records = append(s.records, value)
	return nil
}
func (s *verdictFixtureStore) BumpMatchupView(context.Context, string, string) error {
	s.bumps++
	return nil
}

type verdictFixtureStatus struct {
	limit        VerdictRateLimitResult
	limitErr     error
	limits       int
	cached       *CachedVerdict
	locked       bool
	cacheWrites  int
	lockReleases int
}

func (s *verdictFixtureStatus) Put(context.Context, JobStatus) error { return nil }
func (s *verdictFixtureStatus) Get(context.Context, string) (*JobStatus, error) {
	return nil, nil
}
func (s *verdictFixtureStatus) Ping(context.Context) error { return nil }
func (s *verdictFixtureStatus) LimitVerdict(context.Context, string, time.Time) (VerdictRateLimitResult, error) {
	s.limits++
	return s.limit, s.limitErr
}
func (s *verdictFixtureStatus) GetCachedVerdict(context.Context, string, string) (*CachedVerdict, error) {
	return s.cached, nil
}
func (s *verdictFixtureStatus) SetCachedVerdict(_ context.Context, _ string, _ string, value CachedVerdict) error {
	s.cached = &value
	s.cacheWrites++
	return nil
}
func (s *verdictFixtureStatus) TryAcquireVerdictLock(context.Context, string, string) (bool, error) {
	return !s.locked, nil
}
func (s *verdictFixtureStatus) ReleaseVerdictLock(context.Context, string, string) error {
	s.lockReleases++
	return nil
}
func (s *verdictFixtureStatus) HasVerdictLock(context.Context, string, string) (bool, error) {
	return s.locked, nil
}

func verdictFixture(username string, score float64) *StoredScoreDetail {
	return &StoredScoreDetail{
		Username: username, FinalScore: score, Tier: "顶级",
		Tags:      Tags{ZH: []string{"工程"}, EN: []string{"engineering"}},
		RoastLine: RoastLine{ZH: "有料", EN: "has receipts"},
		SubScores: SubScores{AccountMaturity: 8, OriginalProjectQuality: 15, ContributionQuality: 21, EcosystemImpact: 16, CommunityInfluence: 6, ActivityAuthenticity: 14},
	}
}

func signedVerdictRequest(server *APIServer, body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/internal/vs-verdict", strings.NewReader(body))
	timestamp := strconv.FormatInt(server.clock().Unix(), 10)
	principal := "198.51.100.42"
	mac := hmac.New(sha256.New, []byte(server.config.VerdictGatewaySecret))
	_, _ = mac.Write([]byte(timestamp + "\n" + principal + "\n" + body))
	request.Header.Set("X-Ghfind-Gateway-Timestamp", timestamp)
	request.Header.Set("X-Ghfind-Client-IP", principal)
	request.Header.Set("X-Ghfind-Gateway-Signature", hex.EncodeToString(mac.Sum(nil)))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func TestVerdictRejectsUnsignedCallsBeforeRateLimitOrDatabase(t *testing.T) {
	store := &verdictFixtureStore{details: map[string]*StoredScoreDetail{"alice": verdictFixture("alice", 90), "bob": verdictFixture("bob", 80)}}
	statuses := &verdictFixtureStatus{limit: VerdictRateLimitResult{Success: true}}
	server := NewAPIServer(Config{VerdictGatewaySecret: "gateway-secret"}, store, statuses, &fakePublisher{})
	request := httptest.NewRequest(http.MethodPost, "/api/internal/vs-verdict", strings.NewReader(`{"a":"alice","b":"bob"}`))
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || statuses.limits != 0 || store.reads != 0 {
		t.Fatalf("status=%d limits=%d reads=%d", response.Code, statuses.limits, store.reads)
	}
}

func TestVerdictRateLimitsBeforeTursoReadsOrWrites(t *testing.T) {
	store := &verdictFixtureStore{details: map[string]*StoredScoreDetail{"alice": verdictFixture("alice", 90), "bob": verdictFixture("bob", 80)}}
	statuses := &verdictFixtureStatus{limit: VerdictRateLimitResult{Success: false}}
	server := NewAPIServer(Config{VerdictGatewaySecret: "gateway-secret"}, store, statuses, &fakePublisher{})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, signedVerdictRequest(server, `{"a":"alice","b":"bob"}`))
	if response.Code != http.StatusTooManyRequests || statuses.limits != 1 || store.reads != 0 || len(store.records) != 0 || store.bumps != 0 {
		t.Fatalf("status=%d limits=%d reads=%d records=%d bumps=%d", response.Code, statuses.limits, store.reads, len(store.records), store.bumps)
	}
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["reason"] != "rate_limited" || body["verdict"] != nil {
		t.Fatalf("body=%#v", body)
	}
}

func TestVerdictUsesExistingCacheAfterRecordingHumanView(t *testing.T) {
	store := &verdictFixtureStore{details: map[string]*StoredScoreDetail{"alice": verdictFixture("alice", 90), "bob": verdictFixture("bob", 80)}}
	winner := "alice"
	statuses := &verdictFixtureStatus{
		limit:  VerdictRateLimitResult{Success: true},
		cached: &CachedVerdict{Verdict: RoastLine{ZH: "缓存裁决", EN: "cached verdict"}, Advice: RoastLine{ZH: "缓存建议", EN: "cached advice"}, Winner: &winner, Bucket: "edge"},
	}
	server := NewAPIServer(Config{VerdictGatewaySecret: "gateway-secret"}, store, statuses, &fakePublisher{})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, signedVerdictRequest(server, `{"a":"Bob","b":"Alice"}`))
	if response.Code != http.StatusOK || len(store.records) != 1 || store.records[0].Source == nil || *store.records[0].Source != "template" || store.bumps != 1 || statuses.cacheWrites != 0 {
		t.Fatalf("status=%d records=%#v bumps=%d cacheWrites=%d", response.Code, store.records, store.bumps, statuses.cacheWrites)
	}
	if !strings.Contains(response.Body.String(), "缓存裁决") {
		t.Fatalf("body=%s", response.Body.String())
	}
}

func TestVerdictCallsLLMThenCachesAndPersistsResult(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer llm-key" {
			t.Fatalf("authorization=%q", request.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"@@VERDICT zh=有据可查|en=Receipts win@@\n@@ADVICE zh=补测试|en=Ship tests@@"}}]}`))
	}))
	defer provider.Close()
	store := &verdictFixtureStore{details: map[string]*StoredScoreDetail{"alice": verdictFixture("alice", 90), "bob": verdictFixture("bob", 70)}}
	statuses := &verdictFixtureStatus{limit: VerdictRateLimitResult{Success: true}}
	server := NewAPIServer(Config{VerdictGatewaySecret: "gateway-secret", LLMAPIKey: "llm-key", LLMBaseURL: provider.URL, LLMModel: "fixture"}, store, statuses, &fakePublisher{})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, signedVerdictRequest(server, `{"a":"alice","b":"bob"}`))
	if response.Code != http.StatusOK || statuses.cacheWrites != 1 || len(store.records) != 2 || store.records[1].Source == nil || *store.records[1].Source != "llm" || statuses.lockReleases != 1 {
		t.Fatalf("status=%d cacheWrites=%d records=%#v lockReleases=%d body=%s", response.Code, statuses.cacheWrites, store.records, statuses.lockReleases, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "Receipts win") {
		t.Fatalf("body=%s", response.Body.String())
	}
}

func TestVerdictDecisionAndControlLineParserMatchContract(t *testing.T) {
	decision := verdictFor(*verdictFixture("alice", 74), *verdictFixture("bob", 70.004))
	if decision.Bucket != "even" || decision.Winner != "a" || decision.DimensionWinners["contribution_quality"] != "tie" {
		t.Fatalf("decision=%#v", decision)
	}
	verdict, advice := parsePKVerdict("noise @@VERDICT zh=中文|en=English@@ @@ADVICE zh=建议|en=Advice@@")
	if verdict.ZH != "中文" || verdict.EN != "English" || advice.ZH != "建议" || advice.EN != "Advice" {
		t.Fatalf("verdict=%#v advice=%#v", verdict, advice)
	}
}
