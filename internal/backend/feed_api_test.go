package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type unavailableFeedRedis struct{ *fakeStatusStore }

func (u *unavailableFeedRedis) LimitFeed(context.Context, int64, string, time.Time) (RateLimitResult, error) {
	return RateLimitResult{Unavailable: true}, errors.New("redis down")
}
func (u *unavailableFeedRedis) PutFeedSession(context.Context, FeedSession, time.Duration) error {
	return errors.New("redis down")
}
func (u *unavailableFeedRedis) GetFeedSession(context.Context, string) (*FeedSession, error) {
	return nil, ErrFeedSessionNotFound
}
func (u *unavailableFeedRedis) DeleteFeedSession(context.Context, string) error { return nil }

type fakeFeedDataStore struct {
	user            FeedUser
	candidates      []FeedCandidate
	gorseCandidates []FeedCandidate
	requests        []FeedRequestRecord
	events          []AcceptedFeedEvent
}

func (f *fakeFeedDataStore) Ping(context.Context) error                           { return nil }
func (f *fakeFeedDataStore) ActiveTaxonomyVersion(context.Context) (int64, error) { return 1, nil }
func (f *fakeFeedDataStore) ListFeedTags(context.Context) ([]FeedTag, int64, error) {
	return []FeedTag{{ID: "domain:devtools", Namespace: "domain", Slug: "devtools", TaxonomyVersion: 1}}, 1, nil
}
func (f *fakeFeedDataStore) EnsureFeedUser(_ context.Context, session OAuthSession) (*FeedUser, error) {
	f.user.GitHubID, f.user.Login = session.GitHubID, session.Login
	if f.user.TaxonomyVersion == 0 {
		f.user.TaxonomyVersion = 1
	}
	if f.user.ProfileVersion == 0 {
		f.user.ProfileVersion = 1
	}
	copy := f.user
	return &copy, nil
}
func (f *fakeFeedDataStore) GetFeedUser(context.Context, int64) (*FeedUser, error) {
	copy := f.user
	return &copy, nil
}
func (f *fakeFeedDataStore) ReplaceExplicitFeedPreferences(_ context.Context, _ int64, version int64, preferences []FeedPreference) (*FeedUser, error) {
	f.user.TaxonomyVersion, f.user.Preferences = version, preferences
	f.user.ProfileVersion++
	copy := f.user
	return &copy, nil
}
func (f *fakeFeedDataStore) SeedFeedGraphPreferences(context.Context, int64, []DeveloperFacet) (bool, error) {
	return false, nil
}
func (f *fakeFeedDataStore) LoadFeedCandidates(context.Context, FeedUser, int) ([]FeedCandidate, map[string]int, error) {
	return append([]FeedCandidate(nil), f.candidates...), map[string]int{"quality": len(f.candidates)}, nil
}
func (f *fakeFeedDataStore) LoadGorseFeedCandidates(context.Context, FeedUser, []string, int) ([]FeedCandidate, error) {
	return append([]FeedCandidate(nil), f.gorseCandidates...), nil
}

type fakeFeedGorseRecommender struct {
	itemIDs []string
	err     error
}

func (f fakeFeedGorseRecommender) Recommend(context.Context, string, int) ([]string, error) {
	return f.itemIDs, f.err
}
func (f *fakeFeedDataStore) SaveFeedRequest(_ context.Context, record FeedRequestRecord) error {
	f.requests = append(f.requests, record)
	return nil
}
func (f *fakeFeedDataStore) SetFeedProjectState(_ context.Context, _ int64, key string, patch FeedStatePatch, _ time.Time) (FeedProjectState, error) {
	state := FeedProjectState{RepoKey: key}
	if patch.Saved != nil {
		state.Saved = *patch.Saved
	}
	if patch.NotInterested != nil {
		state.NotInterested = *patch.NotInterested
	}
	return state, nil
}
func (f *fakeFeedDataStore) AppendFeedEvents(_ context.Context, _ int64, events []AcceptedFeedEvent) (FeedEventAppendResult, error) {
	f.events = append(f.events, events...)
	return FeedEventAppendResult{Accepted: len(events)}, nil
}
func (f *fakeFeedDataStore) DeleteFeedProfile(context.Context, int64, time.Time) (string, error) {
	return "delete_1", nil
}
func (f *fakeFeedDataStore) UpsertFeedProject(context.Context, FeedProjectProjection) error {
	return nil
}
func (f *fakeFeedDataStore) FeedProjectSourceHashes(context.Context, []string) (map[string]string, error) {
	return map[string]string{}, nil
}
func (f *fakeFeedDataStore) AcquireFeedReconcileLease(context.Context, string, time.Time, time.Duration) (bool, error) {
	return true, nil
}
func (f *fakeFeedDataStore) ReleaseFeedReconcileLease(context.Context, string) error { return nil }
func (f *fakeFeedDataStore) FinalizeFeedProjectReconcile(context.Context, []string, time.Time) (int64, error) {
	return 0, nil
}
func (f *fakeFeedDataStore) MarkFeedReconcile(context.Context, string, time.Time, bool) error {
	return nil
}
func (f *fakeFeedDataStore) Close() error { return nil }

func feedAPITestServer(t *testing.T) (*APIServer, *fakeFeedDataStore, *MemoryFeedSessionStore) {
	t.Helper()
	now := time.Date(2026, 8, 13, 2, 0, 0, 0, time.UTC)
	store := &fakeFeedDataStore{}
	for index, key := range []string{"one/alpha", "two/beta", "three/gamma"} {
		owner, _, _ := strings.Cut(key, "/")
		store.candidates = append(store.candidates, feedCandidate(key, owner, float64(90-index), 90, "low", now))
	}
	config := Config{FeedMode: FeedModeBaseline, FeedSigningSecret: strings.Repeat("f", 32), AuthSecret: strings.Repeat("a", 32)}
	server := NewAPIServer(config, &fakeScanStore{}, &fakeStatusStore{}, &fakePublisher{})
	server.clock = func() time.Time { return now }
	sessions := NewMemoryFeedSessionStore()
	sessions.now = server.clock
	if err := server.UseFeed(store, sessions); err != nil {
		t.Fatal(err)
	}
	return server, store, sessions
}

func authenticatedFeedRequest(t *testing.T, server *APIServer, method, target string, body []byte, githubID int64) *http.Request {
	t.Helper()
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	signed, err := server.encodeSignedPayload("session", OAuthSession{GitHubID: githubID, Login: "octocat", ExpiresAt: server.clock().Add(time.Hour).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: oauthSessionCookie, Value: signed})
	request.Header.Set("Content-Type", "application/json")
	return request
}

func TestFeedProjectsRequiresOAuthAndProducesStableCursorPage(t *testing.T) {
	server, store, _ := feedAPITestServer(t)
	unauthenticated := httptest.NewRecorder()
	server.Handler().ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/feed/projects", nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status=%d body=%s", unauthenticated.Code, unauthenticated.Body.String())
	}

	first := httptest.NewRecorder()
	server.Handler().ServeHTTP(first, authenticatedFeedRequest(t, server, http.MethodGet, "/api/feed/projects?limit=2", nil, 42))
	if first.Code != http.StatusOK {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}
	var page feedProjectsResponse
	if err := json.Unmarshal(first.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.NextCursor == nil || page.RequestID == "" {
		t.Fatalf("unexpected first page: %#v", page)
	}
	if len(store.requests) != 1 || len(store.requests[0].Items) != 2 {
		t.Fatalf("request audit missing: %#v", store.requests)
	}

	second := httptest.NewRecorder()
	server.Handler().ServeHTTP(second, authenticatedFeedRequest(t, server, http.MethodGet, "/api/feed/projects?limit=2&cursor="+*page.NextCursor, nil, 42))
	if second.Code != http.StatusOK {
		t.Fatalf("second status=%d body=%s", second.Code, second.Body.String())
	}
	var next feedProjectsResponse
	if err := json.Unmarshal(second.Body.Bytes(), &next); err != nil {
		t.Fatal(err)
	}
	if len(next.Items) != 1 || next.NextCursor != nil || next.Items[0].Project.RepoKey == page.Items[0].Project.RepoKey {
		t.Fatalf("unexpected second page: %#v", next)
	}
	if len(store.requests) != 2 || store.requests[1].Items[0].Rank != 2 {
		t.Fatalf("global rank not audited: %#v", store.requests)
	}
}

func TestFeedDatabaseFailureDoesNotAffectCoreReadiness(t *testing.T) {
	config := Config{FeedMode: FeedModeBaseline, FeedSigningSecret: strings.Repeat("f", 32), AuthSecret: strings.Repeat("a", 32)}
	server := NewAPIServer(config, &fakeScanStore{}, &fakeStatusStore{}, &fakePublisher{}, func(context.Context) error { return nil })
	server.clock = func() time.Time { return time.Date(2026, 8, 13, 2, 0, 0, 0, time.UTC) }
	if err := server.UseFeed(nil, NewMemoryFeedSessionStore()); err != nil {
		t.Fatal(err)
	}

	ready := httptest.NewRecorder()
	server.Handler().ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusOK {
		t.Fatalf("core readiness = %d body=%s", ready.Code, ready.Body.String())
	}
	feedReady := httptest.NewRecorder()
	server.Handler().ServeHTTP(feedReady, httptest.NewRequest(http.MethodGet, "/feed-readyz", nil))
	if feedReady.Code != http.StatusServiceUnavailable {
		t.Fatalf("Feed readiness = %d body=%s", feedReady.Code, feedReady.Body.String())
	}
	feed := httptest.NewRecorder()
	server.Handler().ServeHTTP(feed, authenticatedFeedRequest(t, server, http.MethodGet, "/api/feed/projects", nil, 42))
	if feed.Code != http.StatusServiceUnavailable {
		t.Fatalf("Feed response = %d body=%s", feed.Code, feed.Body.String())
	}
}

func TestFeedEventsRejectsCrossUserImpressionToken(t *testing.T) {
	server, store, _ := feedAPITestServer(t)
	first := httptest.NewRecorder()
	server.Handler().ServeHTTP(first, authenticatedFeedRequest(t, server, http.MethodGet, "/api/feed/projects?limit=1", nil, 42))
	var page feedProjectsResponse
	if err := json.Unmarshal(first.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	event := map[string]any{"events": []map[string]any{{
		"id": "123e4567-e89b-12d3-a456-426614174000", "type": "impression",
		"repoKey": page.Items[0].Project.RepoKey, "occurredAt": server.clock().Format(time.RFC3339Nano),
		"impressionToken": page.Items[0].ImpressionToken,
	}}}
	body, _ := json.Marshal(event)
	wrongUser := httptest.NewRecorder()
	server.Handler().ServeHTTP(wrongUser, authenticatedFeedRequest(t, server, http.MethodPost, "/api/feed/events", body, 99))
	if wrongUser.Code != http.StatusBadRequest {
		t.Fatalf("cross-user status=%d body=%s", wrongUser.Code, wrongUser.Body.String())
	}
	if len(store.events) != 0 {
		t.Fatalf("cross-user event was accepted: %#v", store.events)
	}

	valid := httptest.NewRecorder()
	server.Handler().ServeHTTP(valid, authenticatedFeedRequest(t, server, http.MethodPost, "/api/feed/events", body, 42))
	if valid.Code != http.StatusAccepted {
		t.Fatalf("valid status=%d body=%s", valid.Code, valid.Body.String())
	}
	if len(store.events) != 1 || store.events[0].RequestID != page.RequestID {
		t.Fatalf("event audit mismatch: %#v", store.events)
	}
}

func TestFeedDisabledDoesNotExposeEndpoint(t *testing.T) {
	server := NewAPIServer(Config{}, &fakeScanStore{}, &fakeStatusStore{}, &fakePublisher{})
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/feed/tags", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestFeedFirstPageSurvivesUpstashFailureWithoutCursor(t *testing.T) {
	now := time.Date(2026, 8, 13, 2, 0, 0, 0, time.UTC)
	store := &fakeFeedDataStore{candidates: []FeedCandidate{feedCandidate("one/alpha", "one", 90, 90, "low", now)}}
	redis := &unavailableFeedRedis{fakeStatusStore: &fakeStatusStore{}}
	config := Config{FeedMode: FeedModeBaseline, FeedSigningSecret: strings.Repeat("f", 32), AuthSecret: strings.Repeat("a", 32)}
	server := NewAPIServer(config, &fakeScanStore{}, redis, &fakePublisher{})
	server.clock = func() time.Time { return now }
	if err := server.UseFeed(store, redis); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, authenticatedFeedRequest(t, server, http.MethodGet, "/api/feed/projects", nil, 42))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var page feedProjectsResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.NextCursor != nil || !containsString(page.Degraded, "cursor_store_unavailable") {
		t.Fatalf("unexpected degraded page: %#v", page)
	}
}

func TestFeedWritesFailClosedWhenUpstashIsUnavailable(t *testing.T) {
	now := time.Date(2026, 8, 13, 2, 0, 0, 0, time.UTC)
	store := &fakeFeedDataStore{}
	redis := &unavailableFeedRedis{fakeStatusStore: &fakeStatusStore{}}
	config := Config{FeedMode: FeedModeBaseline, FeedSigningSecret: strings.Repeat("f", 32), AuthSecret: strings.Repeat("a", 32)}
	server := NewAPIServer(config, &fakeScanStore{}, redis, &fakePublisher{})
	server.clock = func() time.Time { return now }
	if err := server.UseFeed(store, redis); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, authenticatedFeedRequest(t, server, http.MethodDelete, "/api/feed/profile", nil, 42))
	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "rate_limit_unavailable") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestGorseCanaryAddsOnlyHydratedCandidatesWithoutExposingSources(t *testing.T) {
	now := time.Date(2026, 8, 13, 2, 0, 0, 0, time.UTC)
	store := &fakeFeedDataStore{
		candidates:      []FeedCandidate{feedCandidate("base/project", "base", 90, 90, "low", now)},
		gorseCandidates: []FeedCandidate{feedCandidate("remote/project", "remote", 80, 80, "emerging", now)},
	}
	config := Config{FeedMode: FeedModeGorseCanary, FeedGorseLiveBPS: 10_000,
		FeedSigningSecret: strings.Repeat("f", 32), AuthSecret: strings.Repeat("a", 32)}
	server := NewAPIServer(config, &fakeScanStore{}, &fakeStatusStore{}, &fakePublisher{})
	server.clock = func() time.Time { return now }
	sessions := NewMemoryFeedSessionStore()
	sessions.now = server.clock
	if err := server.UseFeed(store, sessions); err != nil {
		t.Fatal(err)
	}
	if err := server.UseFeedGorse(fakeFeedGorseRecommender{itemIDs: []string{"remote:project"}}); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, authenticatedFeedRequest(t, server, http.MethodGet, "/api/feed/projects", nil, 42))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var page feedProjectsResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || len(store.requests) != 1 || store.requests[0].CandidateCounts["gorse"] != 1 {
		t.Fatalf("Gorse canary mismatch: page=%#v requests=%#v", page, store.requests)
	}
	if strings.Contains(recorder.Body.String(), "candidateSources") || strings.Contains(recorder.Body.String(), "itemId") {
		t.Fatalf("internal recommendation fields leaked: %s", recorder.Body.String())
	}
}

var _ FeedDataStore = (*fakeFeedDataStore)(nil)
