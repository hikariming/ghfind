package backend

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestPortableServedWindowStableAfterImpressions(t *testing.T) {
	server, store, sessions := feedAPITestServer(t)
	server.portableFeed = true
	store.user = FeedUser{GitHubID: 42, ProfileVersion: 1, TaxonomyVersion: 1}
	now := server.clock()
	candidates := []FeedCandidate{}
	for i := 0; i < 65; i++ {
		owner := fmt.Sprintf("owner%d", i%15)
		candidates = append(candidates, feedCandidate(fmt.Sprintf("%s/repo%d", owner, i), owner, float64(100-i), 90, "low", now))
	}
	snapshot := FeedSession{ID: "stable", GitHubID: 42, ProfileVersion: 1, TaxonomyVersion: 1, AlgorithmVersion: FeedPortableAlgorithmVersion, PageSize: 3, CreatedAt: now, ExpiresAt: now.Add(FeedSessionTTL), Items: RankFeedCandidates(candidates, FeedRankOptions{Now: now, Limit: 65, Seed: "rolling", OwnerCap: 2, ExplorationRate: .1, ExplorationWindowSize: 20})}
	if err := sessions.PutFeedSession(context.Background(), snapshot, FeedSessionTTL); err != nil {
		t.Fatal(err)
	}
	decode := func(response *httptest.ResponseRecorder) feedProjectsResponse {
		t.Helper()
		if response.Code != 200 {
			t.Fatalf("status%d %s", response.Code, response.Body.String())
		}
		var page feedProjectsResponse
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return page
	}
	request := httptest.NewRequest("GET", "/api/feed/projects?limit=3", nil)
	first := httptest.NewRecorder()
	server.serveFeedPage(first, request, store.user, snapshot, 0, 3, now, nil, false)
	page := decode(first)
	if page.NextCursor == nil {
		t.Fatal("missing cursor")
	}
	claims, err := server.feedSigner.ParseCursor(*page.NextCursor, 42, now)
	if err != nil || !reflect.DeepEqual(claims.ServedTail, []int{0, 1, 2}) || claims.ServiceVersion != 1 || claims.ProbabilityUnavailable {
		t.Fatalf("actual served tail %+v %v", claims, err)
	}
	all := append([]FeedRankedItem(nil), page.Items...)
	call := func(cursor string) feedProjectsResponse {
		t.Helper()
		response := httptest.NewRecorder()
		server.serveFeedCursor(response, request, OAuthSession{GitHubID: 42}, cursor, 3, now)
		return decode(response)
	}
	repeated := call(*page.NextCursor)
	if _, err := store.AppendFeedEvents(context.Background(), 42, []AcceptedFeedEvent{{Input: FeedEventInput{Type: FeedEventImpression}}}); err != nil {
		t.Fatal(err)
	}
	repeatedAgain := call(*page.NextCursor)
	keys := func(p feedProjectsResponse) []string {
		out := []string{}
		for _, item := range p.Items {
			out = append(out, item.Project.RepoKey)
		}
		return out
	}
	if !reflect.DeepEqual(keys(repeated), keys(repeatedAgain)) || repeated.NextCursor == nil || *repeated.NextCursor != *repeatedAgain.NextCursor {
		t.Fatal("impression changed cursor continuation")
	}
	page = repeated
	for pages := 0; ; pages++ {
		if pages > 30 {
			t.Fatal("unbounded continuation")
		}
		all = append(all, page.Items...)
		if containsString(page.Degraded, "policy_probability_unavailable") {
			t.Fatal("served an unevaluable probability")
		}
		if page.NextCursor == nil {
			break
		}
		page = call(*page.NextCursor)
	}
	if len(all) != len(snapshot.Items) {
		t.Fatal("sampled choices were skipped")
	}
	for start := range all {
		counts := map[string]int{}
		explore := 0
		for _, item := range all[start:minInt(len(all), start+20)] {
			counts[item.Project.OwnerLogin]++
			if counts[item.Project.OwnerLogin] > 2 {
				t.Fatalf("owner window%d %+v", start, counts)
			}
			for _, ranked := range snapshot.Items {
				if ranked.Project.RepoKey == item.Project.RepoKey && ranked.Exploration {
					explore++
				}
			}
		}
		if explore > 2 {
			t.Fatalf("exploration window%d count%d", start, explore)
		}
	}
	for _, record := range store.requests {
		if record.AlgorithmVersion != FeedPortableAlgorithmVersion || containsString(record.Degraded, "policy_probability_unavailable") {
			t.Fatal("invalid request policy audit")
		}
	}
	loaded, err := sessions.GetFeedSession(context.Background(), snapshot.ID)
	if err != nil || !reflect.DeepEqual(loaded.Items, snapshot.Items) {
		t.Fatal("mutated immutable snapshot")
	}
	pieces := strings.Split(*repeated.NextCursor, ".")
	payload, _ := base64.RawURLEncoding.DecodeString(pieces[0])
	json.Unmarshal(payload, &claims)
	for _, mutate := range []func(*FeedCursorClaims){func(c *FeedCursorClaims) { c.SessionID = "other-session" }, func(c *FeedCursorClaims) { c.ServedTail = []int{0} }} {
		changed := claims
		mutate(&changed)
		encoded, _ := json.Marshal(changed)
		tampered := base64.RawURLEncoding.EncodeToString(encoded) + "." + pieces[1]
		if _, err := server.feedSigner.ParseCursor(tampered, 42, now); err == nil {
			t.Fatal("tampered history accepted")
		}
	}
}

func TestPortableWithdrawalExpiresSessionBeforeServingOrAudit(t *testing.T) {
	server, store, sessions := feedAPITestServer(t)
	server.portableFeed = true
	store.user = FeedUser{GitHubID: 42, ProfileVersion: 1, TaxonomyVersion: 1}
	snapshot := FeedSession{ID: "withdrawn", GitHubID: 42, ProfileVersion: 1, PageSize: 2, AlgorithmVersion: FeedPortableAlgorithmVersion, ExpiresAt: server.clock().Add(FeedSessionTTL)}
	for i := 0; i < 25; i++ {
		owner := fmt.Sprintf("distinct%d", i)
		snapshot.Items = append(snapshot.Items, FeedRankedItem{Project: FeedProject{OwnerLogin: owner, RepoKey: owner + "/repo"}, Rank: i, Propensity: .1})
	}
	if err := sessions.PutFeedSession(context.Background(), snapshot, FeedSessionTTL); err != nil {
		t.Fatal(err)
	}
	store.unavailable = map[string]bool{snapshot.Items[5].Project.RepoKey: true}
	response := httptest.NewRecorder()
	server.serveFeedPage(response, httptest.NewRequest("GET", "/api/feed/projects", nil), store.user, snapshot, 0, 2, server.clock(), nil, false)
	if response.Code != 410 || len(store.requests) != 0 {
		t.Fatalf("withdrawn status%d audited%d", response.Code, len(store.requests))
	}
	store.unavailable = nil
	if _, err := sessions.GetFeedSession(context.Background(), snapshot.ID); err == nil {
		t.Fatal("withdrawn snapshot can revive")
	}
}

func TestPortableRejectsOldQuotaViolatingSnapshot(t *testing.T) {
	server, store, sessions := feedAPITestServer(t)
	server.portableFeed = true
	store.user = FeedUser{GitHubID: 42, ProfileVersion: 1}
	snapshot := FeedSession{ID: "old-budget", GitHubID: 42, ProfileVersion: 1, ExpiresAt: server.clock().Add(FeedSessionTTL)}
	for i := 0; i < 3; i++ {
		owner := fmt.Sprintf("distinct%d", i)
		snapshot.Items = append(snapshot.Items, FeedRankedItem{Project: FeedProject{OwnerLogin: owner, RepoKey: owner + "/repo"}, Rank: i, Exploration: true, Propensity: .1})
	}
	sessions.PutFeedSession(context.Background(), snapshot, FeedSessionTTL)
	response := httptest.NewRecorder()
	server.serveFeedPage(response, httptest.NewRequest("GET", "/api/feed/projects", nil), store.user, snapshot, 0, 20, server.clock(), nil, false)
	if response.Code != 410 || len(store.requests) != 0 {
		t.Fatal("quota repaired by silently changing sampled distribution")
	}
}

func TestFeedCursorRejectsMalformedSignedServedTail(t *testing.T) {
	server, _, _ := feedAPITestServer(t)
	for _, tail := range [][]int{{-1}, {2, 1}, {1, 1}, {20}, make([]int, 20)} {
		token, err := server.feedSigner.SignCursor(FeedCursorClaims{SessionID: "s", GitHubID: 42, Offset: 20, ExpiresAt: server.clock().Add(FeedSessionTTL).UnixMilli(), ServiceVersion: 1, ServedTail: tail})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := server.feedSigner.ParseCursor(token, 42, server.clock()); err == nil {
			t.Fatalf("accepted signed malformed tail%v", tail)
		}
	}
}
