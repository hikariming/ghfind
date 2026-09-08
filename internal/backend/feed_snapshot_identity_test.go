package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestPortableMissingSnapshotIdentityExpires(t *testing.T) {
	for _, missing := range []string{"analysis", "hash", "both"} {
		t.Run(missing, func(t *testing.T) {
			server, store, sessions := feedAPITestServer(t)
			server.portableFeed = true
			store.user = FeedUser{GitHubID: 42, ProfileVersion: 1, TaxonomyVersion: 1}
			p := feedCandidate("owner/repo", "owner", 80, 90, "low", server.clock()).Project
			p.AnalysisID, p.SourceHash = "analysis", "hash"
			if missing != "hash" {
				p.AnalysisID = ""
			}
			if missing != "analysis" {
				p.SourceHash = ""
			}
			now := server.clock()
			session := FeedSession{ID: "missing-identity", GitHubID: 42, ProfileVersion: 1, TaxonomyVersion: 1, CreatedAt: now, ExpiresAt: now.Add(FeedSessionTTL), Items: []FeedRankedItem{{Project: p}}}
			if err := sessions.PutFeedSession(context.Background(), session, FeedSessionTTL); err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			server.serveFeedPage(response, httptest.NewRequest("GET", "/api/feed/projects", nil), store.user, session, 0, 1, now, nil, false)
			if response.Code != 410 || len(store.requests) != 0 {
				t.Fatalf("missing identity served: %d %+v", response.Code, store.requests)
			}
			got, err := sessions.GetFeedSession(context.Background(), session.ID)
			if (err != nil && !errors.Is(err, ErrFeedSessionNotFound)) || got != nil {
				t.Fatalf("stale session retained: %+v %v", got, err)
			}
		})
	}
}

func TestPortableLegacyExhaustedSnapshotExpires(t *testing.T) {
	server, store, sessions := feedAPITestServer(t)
	server.portableFeed = true
	store.user = FeedUser{GitHubID: 42, ProfileVersion: 1, TaxonomyVersion: 1}
	now := server.clock()
	session := FeedSession{ID: "legacy-exhausted", GitHubID: 42, ProfileVersion: 1, TaxonomyVersion: 1, CreatedAt: now, ExpiresAt: now.Add(FeedSessionTTL), Items: []FeedRankedItem{{Project: FeedProject{RepoKey: "owner/repo"}}}}
	if err := sessions.PutFeedSession(context.Background(), session, FeedSessionTTL); err != nil {
		t.Fatal(err)
	}
	token, err := server.feedSigner.SignCursor(FeedCursorClaims{SessionID: session.ID, GitHubID: 42, Offset: 1, ExpiresAt: session.ExpiresAt.UnixMilli(), ServiceVersion: 1, ServedTail: []int{0}})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.serveFeedCursor(response, httptest.NewRequest("GET", "/api/feed/projects", nil), OAuthSession{GitHubID: 42}, token, 1, now)
	if response.Code != 410 {
		t.Fatalf("legacy exhausted snapshot: %d %s", response.Code, response.Body)
	}
}

type keyOnlyFeedStore struct{ FeedServingStore }

func TestPortableRejectsKeyOnlyCatalog(t *testing.T) {
	_, store, sessions := feedAPITestServer(t)
	if _, err := NewStandaloneFeedHandler(FeedModeBaseline, strings.Repeat("s", 32), keyOnlyFeedStore{store}, sessions, func(*http.Request, time.Time) *OAuthSession { return nil }); err == nil {
		t.Fatal("key-only catalog accepted")
	}
}
func TestFeedSnapshotIdentityBounds(t *testing.T) {
	valid := FeedProjectIdentity{"owner/repo", "analysis", "hash"}
	for _, values := range [][]FeedProjectIdentity{{valid, valid}, make([]FeedProjectIdentity, 241), {{"owner/repo", "", "hash"}}, {{"owner/repo", "analysis", ""}}} {
		if _, err := validateFeedProjectIdentities(values); !errors.Is(err, ErrFeedCatalogChanged) {
			t.Fatalf("invalid identity accepted: %v", err)
		}
	}
}

// Called by the mandatory shared PostgreSQL + local workerd/D1 API fixture.
// Assessment/project updates go through the real durable projection command.
func runPortableSessionIdentityContract(t *testing.T, ctx context.Context, store crossProfileStore) {
	t.Helper()
	catalog := store.(FeedSnapshotCatalogStore)
	signer, _ := NewFeedSigner(strings.Repeat("s", 32))
	handler, err := NewStandaloneFeedHandler(FeedModeBaseline, strings.Repeat("s", 32), store, store, func(*http.Request, time.Time) *OAuthSession {
		return &OAuthSession{GitHubID: 8080, Login: "identity-fixture"}
	})
	if err != nil {
		t.Fatal(err)
	}
	page := func(path string, want int) feedProjectsResponse {
		t.Helper()
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != want {
			t.Fatalf("identity page: got%d want%d %s", w.Code, want, w.Body)
		}
		var p feedProjectsResponse
		if want == 200 {
			if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
				t.Fatal(err)
			}
		}
		for _, private := range []string{"analysisId", "sourceHash", "score", "propensity", "features"} {
			if strings.Contains(w.Body.String(), `"`+private+`"`) {
				t.Fatalf("private identity leak %s", private)
			}
		}
		return p
	}
	first := page("/api/feed/projects?limit=1", 200)
	if first.NextCursor == nil {
		t.Fatal("missing identity cursor")
	}
	claims, err := signer.ParseCursor(*first.NextCursor, 8080, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.(ActorFeedSessionStore).GetFeedSessionForUser(ctx, 8080, claims.SessionID)
	if err != nil || session == nil {
		t.Fatalf("snapshot load: %v", err)
	}
	legacy := *session
	legacy.ID = "identity-legacy-session"
	legacy.Items = append([]FeedRankedItem(nil), session.Items...)
	for i := range legacy.Items {
		legacy.Items[i].Project.AnalysisID, legacy.Items[i].Project.SourceHash = "", ""
	}
	if err := store.PutFeedSession(ctx, legacy, FeedSessionTTL); err != nil {
		t.Fatal(err)
	}
	legacyClaims := claims
	legacyClaims.SessionID = legacy.ID
	legacyCursor, err := signer.SignCursor(legacyClaims)
	if err != nil {
		t.Fatal(err)
	}
	page("/api/feed/projects?limit=1&cursor="+url.QueryEscape(legacyCursor), 410)
	var old FeedRankedItem
	for _, item := range session.Items[1:] {
		if item.Project.OwnerLogin != "contractbusy" {
			old = item
			break
		}
	}
	if old.Project.AnalysisID == "" || old.Project.SourceHash == "" {
		t.Fatal("real recall omitted identity")
	}
	user, err := store.GetFeedUser(ctx, 8080)
	if err != nil {
		t.Fatal(err)
	}
	expected := feedProjectIdentities([]FeedRankedItem{old})
	available, err := catalog.AvailableFeedProjects(ctx, 8080, expected)
	if err != nil || !available[old.Project.RepoKey] {
		t.Fatalf("initial identity unavailable: %v", err)
	}
	bounded := append([]FeedProjectIdentity(nil), expected...)
	for i := 1; i < 240; i++ {
		bounded = append(bounded, FeedProjectIdentity{fmt.Sprintf("missing-%d/repo", i), "missing", "missing"})
	}
	available, err = catalog.AvailableFeedProjects(ctx, 8080, bounded)
	if err != nil || len(available) != 1 || !available[old.Project.RepoKey] {
		t.Fatalf("bounded 240-key identity query failed: %v", err)
	}
	apply := func(version int64, analysisID, summary string) {
		t.Helper()
		now := time.Now().UTC().Truncate(time.Millisecond)
		assessment := validFeedAssessment()
		assessment.RepoKey, assessment.LatestAnalysisID, assessment.AnalyzedAt = old.Project.RepoKey, analysisID, now.UnixMilli()
		assessment.Analysis.AnalysisID = analysisID
		assessment.Analysis.Repository.RepoKey = old.Project.RepoKey
		assessment.Analysis.Repository.CanonicalURL = "https://github.com/" + old.Project.RepoKey
		assessment.Analysis.AnalyzedAt = now.Format(time.RFC3339Nano)
		projection, err := BuildFeedProjectProjection(assessment, nil)
		if err != nil {
			t.Fatal(err)
		}
		projection.Summary, projection.ProjectType, projection.Descriptor = summary, "sdk-library", summary
		projection.SourceHash, err = feedProjectionHash(projection)
		if err != nil {
			t.Fatal(err)
		}
		event := FeedSourceEvent{ContractVersion: 1, EventID: "assessment.completed:" + analysisID + ":" + projection.SourceHash, AggregateKey: projection.RepoKey, SourceVersion: version, Kind: "assessment.completed", AnalysisID: analysisID, ReceiptID: fmt.Sprintf("identity-receipt-%d", version), SourceHash: projection.SourceHash, OccurredAt: now.UnixMilli()}
		claim, err := store.ClaimFeedJob(ctx, FeedJobClaimRequest{WriterEpoch: 1, Event: event, LeaseOwner: "identity-fixture", LeaseSeconds: 90})
		if err != nil || claim.Status != "leased" {
			t.Fatalf("identity claim %+v %v", claim, err)
		}
		result, err := store.ApplyFeedProjection(ctx, FeedApplyProjectionRequest{WriterEpoch: 1, EventID: event.EventID, LeaseOwner: "identity-fixture", SourceVersion: version, Projection: FeedProjectionDTO{FeedProjectProjection: projection, ProductTags: []FeedProjectionProductTag{}}, Receipt: FeedSubmissionReceipt{ReceiptID: event.ReceiptID, SourceKind: "app_submission", SubmittedAt: now}})
		if err != nil {
			t.Fatalf("identity projection %+v %v", result, err)
		}
		if err := store.CompleteFeedJob(ctx, FeedJobFinishRequest{WriterEpoch: 1, EventID: event.EventID, LeaseOwner: "identity-fixture"}); err != nil {
			t.Fatal(err)
		}
	}
	// The projection changes after the successful availability read but before
	// request persistence. Publication remains true throughout.
	record := FeedRequestRecord{ID: "identity-race-request", AlgorithmVersion: FeedPortableAlgorithmVersion, User: *user, Seed: "identity-seed", CandidateCounts: map[string]int{"latest": 1}, Degraded: []string{}, Items: []FeedRankedItem{old}}
	existing := record
	existing.ID = "identity-previously-served"
	if err := store.SaveFeedRequest(ctx, existing); err != nil {
		t.Fatal(err)
	}
	apply(1001, "identity-analysis-new", "Current assessed content")
	if err := store.SaveFeedRequest(ctx, existing); !errors.Is(err, ErrFeedCatalogChanged) {
		t.Fatalf("stale exact retry served old content: %v", err)
	}
	if err := store.SaveFeedRequest(ctx, record); !errors.Is(err, ErrFeedCatalogChanged) {
		t.Fatalf("stale save accepted: %v", err)
	}
	if pg, ok := store.(*PostgresFeedStore); ok {
		var n int
		if err := pg.db.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM feed.requests WHERE id=$1)+(SELECT COUNT(*) FROM feed.served_items WHERE request_id=$1)`, record.ID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("race wrote records: %d %v", n, err)
		}
	}
	available, err = catalog.AvailableFeedProjects(ctx, 8080, expected)
	if err != nil || available[old.Project.RepoKey] {
		t.Fatalf("stale identity available: %v", err)
	}
	page("/api/feed/projects?limit=1&cursor="+url.QueryEscape(*first.NextCursor), 410)
	current := page("/api/feed/projects?limit=50", 200)
	found := false
	for _, item := range current.Items {
		if item.Project.RepoKey == old.Project.RepoKey {
			found = true
			if item.Project.Summary != "Current assessed content" || !hasIdentityTag(item.Project.Tags, "artifact:sdk-library") {
				t.Fatalf("new session stale content/tags: %+v", item.Project)
			}
		}
	}
	if !found {
		t.Fatal("new session lost eligible updated project")
	}
	candidates, _, err := store.LoadFeedCandidates(ctx, *user, 240)
	if err != nil {
		t.Fatal(err)
	}
	var fresh FeedProject
	for _, candidate := range candidates {
		if candidate.Project.RepoKey == old.Project.RepoKey {
			fresh = candidate.Project
		}
	}
	if fresh.AnalysisID != "identity-analysis-new" {
		t.Fatal("new private identity not hydrated")
	}
	// Same analysis ID can carry a newer source hash; comparing only analysis ID
	// also fails this re-projection case.
	apply(1002, fresh.AnalysisID, "Reprojected current content")
	available, err = catalog.AvailableFeedProjects(ctx, 8080, []FeedProjectIdentity{{fresh.RepoKey, fresh.AnalysisID, fresh.SourceHash}})
	if err != nil || available[fresh.RepoKey] {
		t.Fatalf("hash-only update accepted: %v", err)
	}
	record.ID = "identity-hash-race-request"
	record.Items[0].Project = fresh
	if err := store.SaveFeedRequest(ctx, record); !errors.Is(err, ErrFeedCatalogChanged) {
		t.Fatalf("hash-only stale save accepted: %v", err)
	}
}
func hasIdentityTag(tags []FeedTag, id string) bool {
	for _, tag := range tags {
		if tag.ID == id {
			return true
		}
	}
	return false
}
