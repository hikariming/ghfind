package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	feedauth "github.com/hikariming/ghfind/internal/feed/auth"
	"github.com/hikariming/ghfind/internal/feedmigration"
)

type crossProfileStore interface {
	FeedServingStore
	FeedSessionStore
	FeedJobStore
	FeedCatalogProjectionStore
}

// Both profiles execute the identical public API contract. These are synthetic
// signed gateway fixtures, not evidence of real GitHub OAuth or real assessment.
// The wrapper starts a fresh local workerd database; PostgreSQL must be disposable.
func TestPortableAPIBothProfiles(t *testing.T) {
	endpoint, secret, dsn := os.Getenv("FEED_TEST_BRIDGE_ENDPOINT"), os.Getenv("FEED_TEST_BRIDGE_SECRET"), os.Getenv("FEED_TEST_DATABASE_URL")
	if endpoint == "" || secret == "" || dsn == "" {
		if os.Getenv("FEED_REQUIRE_CROSSPROFILE_TESTS") == "1" {
			t.Fatal("cross-profile contracts require workerd bridge, independent secret and PostgreSQL DSN")
		}
		t.Skip("run scripts/test-feed-crossprofile.mjs with a disposable PostgreSQL database")
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		t.Fatal("cross-profile fixtures only accept an isolated loopback workerd")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	resetFeedIntegrationSchema(t, ctx, dsn)
	if err := feedmigration.Run(ctx, dsn); err != nil {
		t.Fatal(err)
	}
	pg, err := OpenPostgresFeedStore(Config{FeedDatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if err := pg.EnablePortableRuntime(1); err != nil {
		t.Fatal(err)
	}
	cf, err := NewCFFeedStore(endpoint, secret, &http.Client{Timeout: 4 * time.Second, Transport: crossProfileTransport{}})
	if err != nil {
		t.Fatal(err)
	}
	for _, profile := range []struct {
		name  string
		store crossProfileStore
	}{{"postgres", pg}, {"cf_d1_r2", cf}} {
		t.Run(profile.name, func(t *testing.T) { runPortableAPIContract(t, ctx, profile.store) })
	}
}

// Optional local diagnostics contain only this test's synthetic DTOs, never
// credentials. Production runtime uses the ordinary HTTP transport.
type crossProfileTransport struct{}

func (crossProfileTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	var body []byte
	if os.Getenv("FEED_TEST_CAPTURE_DIR") != "" {
		body, _ = io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
	}
	response, err := http.DefaultTransport.RoundTrip(r)
	if err == nil && response.StatusCode >= 400 && len(body) > 0 {
		_ = os.WriteFile(filepath.Join(os.Getenv("FEED_TEST_CAPTURE_DIR"), filepath.Base(r.URL.Path)+".json"), body, 0600)
	}
	return response, err
}

func runPortableAPIContract(t *testing.T, ctx context.Context, store crossProfileStore) {
	t.Helper()
	if err := store.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	// Twenty-one projects from one owner pressure the cap; unique owners provide
	// enough alternatives for stable pagination and metadata persistence.
	for i := 0; i < 50; i++ {
		owner := fmt.Sprintf("contractowner%d", i)
		if i < 21 {
			owner = "contractbusy"
		}
		id, repo := fmt.Sprintf("contract-analysis-%d", i), fmt.Sprintf("%s/repo%d", owner, i)
		assessment := validFeedAssessment()
		assessment.RepoKey, assessment.LatestAnalysisID, assessment.AnalyzedAt = repo, id, now.UnixMilli()
		assessment.Analysis.AnalysisID = id
		assessment.Analysis.Repository.RepoKey = repo
		assessment.Analysis.Repository.CanonicalURL = "https://github.com/" + repo
		assessment.Analysis.AnalyzedAt = now.Format(time.RFC3339Nano)
		projection, err := BuildFeedProjectProjection(assessment, nil)
		if err != nil {
			t.Fatal(err)
		}
		event := FeedSourceEvent{ContractVersion: 1, EventID: "assessment.completed:" + id + ":" + projection.SourceHash,
			AggregateKey: repo, SourceVersion: int64(i + 1), Kind: "assessment.completed", AnalysisID: id,
			ReceiptID: "app:" + id, SourceHash: projection.SourceHash, OccurredAt: now.UnixMilli()}
		claim, err := store.ClaimFeedJob(ctx, FeedJobClaimRequest{WriterEpoch: 1, Event: event, LeaseOwner: "api-contract", LeaseSeconds: 90})
		if err != nil || claim.Status != "leased" {
			t.Fatalf("seed claim: %+v %v", claim, err)
		}
		_, err = store.ApplyFeedProjection(ctx, FeedApplyProjectionRequest{WriterEpoch: 1, EventID: event.EventID,
			LeaseOwner: "api-contract", SourceVersion: event.SourceVersion, Projection: FeedProjectionDTO{FeedProjectProjection: projection, ProductTags: []FeedProjectionProductTag{}},
			Receipt: FeedSubmissionReceipt{ReceiptID: event.ReceiptID, SourceKind: "app_submission", SubmittedAt: now}})
		if err != nil {
			t.Fatalf("seed projection: %v", err)
		}
		if err := store.CompleteFeedJob(ctx, FeedJobFinishRequest{WriterEpoch: 1, EventID: event.EventID, LeaseOwner: "api-contract"}); err != nil {
			t.Fatal(err)
		}
	}
	verifier, err := feedauth.New(strings.Repeat("g", 32), "feed-api")
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewStandaloneFeedHandler(FeedModeBaseline, strings.Repeat("s", 32), store, store, func(r *http.Request, now time.Time) *OAuthSession {
		claims, err := verifier.Verify(r, now)
		if err != nil {
			return nil
		}
		return &OAuthSession{GitHubID: claims.GitHubID, Login: claims.Login, AvatarURL: claims.AvatarURL}
	})
	if err != nil {
		t.Fatal(err)
	}
	call := func(actor int64, method, path string, input any, expected int) []byte {
		t.Helper()
		var body []byte
		if input != nil {
			body, err = json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if actor > 0 {
			now := time.Now()
			token, err := verifier.Sign(feedauth.Claims{Version: 1, Audience: "feed-api", GitHubID: actor, Login: "contract-user",
				IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(30 * time.Second).UnixMilli(), Method: method, Target: r.URL.RequestURI(), BodySHA256: feedauth.BodyHash(body)})
			if err != nil {
				t.Fatal(err)
			}
			r.Header.Set(feedauth.Header, token)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != expected {
			t.Fatalf("%s %s status=%d want=%d body=%s", method, path, w.Code, expected, w.Body)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("missing no-store: %s", path)
		}
		return w.Body.Bytes()
	}
	call(0, "GET", "/api/feed/projects", nil, 401)
	tags, _, err := store.ListFeedTags(ctx)
	if err != nil || len(tags) != 13 {
		t.Fatalf("unapproved taxonomy: %d %v", len(tags), err)
	}
	page := func(path string) feedProjectsResponse {
		var out feedProjectsResponse
		body := call(4242, "GET", path, nil, 200)
		for _, field := range []string{"analysisId", "sourceHash", "score", "features", "propensity", "embedding", "candidateSources"} {
			if bytes.Contains(body, []byte(`"`+field+`"`)) {
				t.Fatalf("public private-field leak: %s", field)
			}
		}
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	first := page("/api/feed/projects?limit=20")
	if len(first.Items) != 20 || first.NextCursor == nil {
		t.Fatalf("first page incomplete: %d", len(first.Items))
	}
	item := first.Items[0]
	event := FeedEventInput{ID: "11111111-1111-4111-8111-111111111111", Type: FeedEventImpression,
		RepoKey: item.Project.RepoKey, ImpressionToken: item.ImpressionToken, OccurredAt: now}
	call(4242, "POST", "/api/feed/events", map[string]any{"events": []FeedEventInput{event}}, 202)
	second := page("/api/feed/projects?limit=20&cursor=" + url.QueryEscape(*first.NextCursor))
	seen := map[string]bool{}
	items := append(first.Items, second.Items...)
	for i, item := range items {
		if seen[item.Project.RepoKey] {
			t.Fatal("duplicate pagination result")
		}
		seen[item.Project.RepoKey] = true
		owners := map[string]int{}
		start := i - 19
		if start < 0 {
			start = 0
		}
		for _, recent := range items[start : i+1] {
			owners[recent.Project.OwnerLogin]++
		}
		for owner, count := range owners {
			if count > 2 {
				t.Fatalf("rolling owner cap %s:%d", owner, count)
			}
		}
	}
	statePath := "/api/feed/projects/" + item.Project.RepoKey + "/state"
	call(4243, "PUT", statePath, map[string]any{"saved": true, "impressionToken": item.ImpressionToken}, 400)
	call(4242, "PUT", statePath, map[string]any{"saved": true, "impressionToken": item.ImpressionToken}, 200)
	// Saving changes the profile, but subsequent same-generation token use remains valid.
	event.ID, event.Type = "22222222-2222-4222-8222-222222222222", FeedEventGitHubOutbound
	body := map[string]any{"events": []FeedEventInput{event}}
	call(4242, "POST", "/api/feed/events", body, 202)
	var duplicate FeedEventAppendResult
	if err := json.Unmarshal(call(4242, "POST", "/api/feed/events", body, 202), &duplicate); err != nil {
		t.Fatal(err)
	}
	if duplicate.Accepted != 0 || duplicate.Duplicate != 1 {
		t.Fatalf("duplicate event had effects: %+v", duplicate)
	}
	call(4242, "PUT", statePath, map[string]any{"saved": false, "impressionToken": item.ImpressionToken}, 200)
	var deleted FeedBridgeDeleteResponse
	if err := json.Unmarshal(call(4242, "DELETE", "/api/feed/profile", nil, 202), &deleted); err != nil {
		t.Fatal(err)
	}
	var deletionStatus FeedBridgeDeleteResponse
	if err := json.Unmarshal(call(4242, "GET", "/api/feed/profile/deletions/"+deleted.DeletionID, nil, 200), &deletionStatus); err != nil {
		t.Fatal(err)
	}
	if deleted.Status != "queued" || deletionStatus.Status != "queued" || deletionStatus.DeletionID != deleted.DeletionID {
		t.Fatalf("deletion acceptance/status contract diverged: %+v / %+v", deleted, deletionStatus)
	}
	call(4243, "GET", "/api/feed/profile/deletions/"+deleted.DeletionID, nil, 404)
	call(4242, "PUT", statePath, map[string]any{"saved": true, "impressionToken": item.ImpressionToken}, 400)
	runPortableSessionIdentityContract(t, ctx, store)
}
