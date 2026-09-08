package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPortableSnapshotPreservesPrivateFeatures(t *testing.T) {
	feature := .63
	now := time.Now().UTC().Truncate(time.Millisecond)
	session := FeedSession{ID: "s", GitHubID: 42, ProfileVersion: 9, CreatedAt: now, ExpiresAt: now.Add(FeedSessionTTL), Items: []FeedRankedItem{{Project: FeedProject{RepoKey: "o/r", ItemID: "o:r", Publishable: true, SubmissionEvidence: true}, Rank: 8, Score: .7, Propensity: .012, Exploration: true, CandidateSources: []string{"tag", "latest"}, Features: FeedFeatureSnapshot{TagAffinity: &feature, MMRScore: .4}}}}
	encoded, err := json.Marshal(feedSessionDTO(session))
	if err != nil {
		t.Fatal(err)
	}
	var dto FeedSessionDTO
	if err := json.Unmarshal(encoded, &dto); err != nil {
		t.Fatal(err)
	}
	got := dto.session()
	item := got.Items[0]
	if item.Rank != 8 || item.Score != .7 || item.Propensity != .012 || !item.Project.Publishable || !item.Project.SubmissionEvidence || item.Project.ItemID != "o:r" || item.Features.TagAffinity == nil || *item.Features.TagAffinity != feature {
		t.Fatalf("private snapshot data lost: %+v", item)
	}
	public, _ := json.Marshal(item)
	for _, private := range []string{"candidateSources", "score", "rank", "propensity", "features", "submissionEvidence", "itemId", "publishable"} {
		if bytes.Contains(public, []byte(`"`+private+`"`)) {
			t.Fatalf("private field %s leaked: %s", private, public)
		}
	}
}
func TestPortableCFStoreUsesVersionedOperationsAndActorScope(t *testing.T) {
	var operations []string
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("b", 32) || r.Header.Get("X-Feed-Contract") != "1" {
			t.Error("missing bridge auth/version")
		}
		operations = append(operations, r.URL.Path)
		switch r.URL.Path {
		case "/internal/feed/v1/health":
			json.NewEncoder(w).Encode(FeedBridgeHealthResponse{Ready: true, ContractVersion: "1", WriterEpoch: 1, WritesEnabled: true})
		case "/internal/feed/v1/sessions.get":
			var in FeedBridgeSessionRequest
			json.NewDecoder(r.Body).Decode(&in)
			if in.GitHubID != 42 || in.ID != "s" || in.WriterEpoch != 1 {
				t.Error("unscoped session")
			}
			json.NewEncoder(w).Encode(FeedBridgeSessionResponse{Session: FeedSessionDTO{ID: "s", GitHubID: 42}})
		default:
			t.Errorf("unexpected op %s", r.URL.Path)
		}
	}))
	defer bridge.Close()
	store, err := NewCFFeedStore(bridge.URL, strings.Repeat("b", 32), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetFeedSession(context.Background(), "s"); err == nil {
		t.Fatal("unscoped lookup accepted")
	}
	if _, err := store.GetFeedSessionForUser(context.Background(), 42, "s"); err != nil {
		t.Fatal(err)
	}
	if len(operations) != 2 {
		t.Fatal(operations)
	}
}
func TestPortableAnonymousAndDeletionWithServingOff(t *testing.T) {
	_, store, sessions := feedAPITestServer(t)
	authenticate := func(r *http.Request, now time.Time) *OAuthSession {
		if r.Header.Get("test-auth") == "42" {
			return &OAuthSession{GitHubID: 42, Login: "octocat"}
		}
		return nil
	}
	handler, err := NewStandaloneFeedHandler(FeedModeOff, strings.Repeat("s", 32), store, sessions, authenticate)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/feed/projects", "/api/feed/preferences", "/api/feed/profile"} {
		method := "GET"
		if path == "/api/feed/profile" {
			method = "DELETE"
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(method, path, nil))
		if w.Code != 401 {
			t.Fatalf("anonymous %s status=%d", path, w.Code)
		}
	}
	req := httptest.NewRequest("DELETE", "/api/feed/profile", nil)
	req.Header.Set("test-auth", "42")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 202 {
		t.Fatalf("disabled serving prevents deletion: %d %s", w.Code, w.Body)
	}
}
func TestPortableStateRequiresImpressionAndRejectsUnknownFields(t *testing.T) {
	_, store, sessions := feedAPITestServer(t)
	handler, err := NewStandaloneFeedHandler(FeedModeBaseline, strings.Repeat("s", 32), store, sessions, func(*http.Request, time.Time) *OAuthSession { return &OAuthSession{GitHubID: 42, Login: "octocat"} })
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{"saved":true}`, `{"saved":true,"githubId":42}`, `{"saved":true} {}`, `{"saved":true}` + strings.Repeat(" ", feedMaxBodyBytes)} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("PUT", "/api/feed/projects/o/r/state", strings.NewReader(body)))
		if w.Code != 400 {
			t.Fatalf("invalid body status %d", w.Code)
		}
	}
}

func TestPortableEventsSupportsBothLegacyShapesStrictly(t *testing.T) {
	for _, body := range []string{`[{"id":"x","type":"impression","repoKey":"o/r","occurredAt":"2026-09-08T00:00:00Z","impressionToken":"t"}]`, `{"events":[{"id":"x","type":"impression","repoKey":"o/r","occurredAt":"2026-09-08T00:00:00Z","impressionToken":"t"}]}`} {
		var payload feedEventsPayload
		if err := decodeFeedJSON(httptest.NewRequest("POST", "/", strings.NewReader(body)), &payload); err != nil || len(payload.Events) != 1 {
			t.Fatalf("legacy event shape rejected %v", err)
		}
	}
	for _, body := range []string{`{"events":[],"unknown":true}`, `[{"id":"x","unknown":true}]`, `[] {}`, `[]` + strings.Repeat(" ", feedMaxBodyBytes)} {
		var payload feedEventsPayload
		if err := decodeFeedJSON(httptest.NewRequest("POST", "/", strings.NewReader(body)), &payload); err == nil {
			t.Fatalf("invalid event shape accepted %s", body[:minInt(len(body), 50)])
		}
	}
}
func TestPortableAuthenticationOnceAndPatchCompatibility(t *testing.T) {
	_, store, sessions := feedAPITestServer(t)
	calls := 0
	handler, err := NewStandaloneFeedHandler(FeedModeBaseline, strings.Repeat("s", 32), store, sessions, func(*http.Request, time.Time) *OAuthSession {
		calls++
		return &OAuthSession{GitHubID: 42, Login: "octocat"}
	})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("PATCH", "/api/feed/projects/o/r/state", strings.NewReader(`{"saved":true}`)))
	if w.Code != 400 || calls != 1 {
		t.Fatalf("PATCH status%d authentication calls%d", w.Code, calls)
	}
}
