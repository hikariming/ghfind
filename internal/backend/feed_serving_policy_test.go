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

func TestPortableServedWindowSurvivesHardFilterCompression(t *testing.T) {
	server, store, sessions := feedAPITestServer(t)
	server.portableFeed = true
	store.user = FeedUser{GitHubID: 42, ProfileVersion: 1, TaxonomyVersion: 1}
	store.unavailable = map[string]bool{}
	now := server.clock()
	snapshot := FeedSession{ID: "compressed", GitHubID: 42, ProfileVersion: 1, TaxonomyVersion: 1, AlgorithmVersion: FeedPortableAlgorithmVersion, PageSize: 3, CreatedAt: now, ExpiresAt: now.Add(FeedSessionTTL)}
	for i := 0; i < 65; i++ {
		owner := fmt.Sprintf("owner%d", i)
		explore := i%20 < 2
		if i%20 < 2 {
			owner = "repeated"
		}
		key := fmt.Sprintf("%s/repo%d", owner, i)
		snapshot.Items = append(snapshot.Items, FeedRankedItem{Project: FeedProject{RepoKey: key, OwnerLogin: owner, Publishable: true, SubmissionEvidence: true}, Rank: i, Exploration: explore, Propensity: .1})
		if i >= 2 && i <= 18 {
			store.unavailable[key] = true
		}
	}
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
	firstClaims, err := server.feedSigner.ParseCursor(*page.NextCursor, 42, now)
	if err != nil || !reflect.DeepEqual(firstClaims.ServedTail, []int{0, 1, 19}) || firstClaims.ServiceVersion != 1 || !firstClaims.ProbabilityUnavailable {
		t.Fatalf("actual served tail %+v %v", firstClaims, err)
	}
	all := append([]FeedRankedItem(nil), page.Items...)
	call := func(cursor string) feedProjectsResponse {
		t.Helper()
		response := httptest.NewRecorder()
		server.serveFeedCursor(response, request, OAuthSession{GitHubID: 42}, cursor, 3, now)
		return decode(response)
	}
	repeated := call(*page.NextCursor)
	repeatedAgain := call(*page.NextCursor)
	keys := func(p feedProjectsResponse) []string {
		out := []string{}
		for _, item := range p.Items {
			out = append(out, item.Project.RepoKey)
		}
		return out
	}
	if !reflect.DeepEqual(keys(repeated), keys(repeatedAgain)) || repeated.NextCursor == nil || *repeated.NextCursor != *repeatedAgain.NextCursor {
		t.Fatal("same cursor changed continuation")
	}
	if repeated.Items[0].Project.OwnerLogin == "repeated" {
		t.Fatal("third owner survived compressed boundary")
	}
	page = repeated
	for pages := 0; ; pages++ {
		if pages > 30 {
			t.Fatal("unbounded continuation")
		}
		all = append(all, page.Items...)
		if !containsString(page.Degraded, "policy_probability_unavailable") {
			t.Fatal("lost probability uncertainty across cursor")
		}
		if page.NextCursor == nil {
			break
		}
		page = call(*page.NextCursor)
	}
	for start := range all {
		counts := map[string]int{}
		explore := 0
		for _, item := range all[start:minInt(len(all), start+20)] {
			counts[item.Project.OwnerLogin]++
			if counts[item.Project.OwnerLogin] > 2 {
				t.Fatalf("owner window%d %+v", start, counts)
			}
			// The public item hides exploration; resolve its immutable snapshot record.
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
		if record.AlgorithmVersion != FeedPortableAlgorithmVersion || !containsString(record.Degraded, "policy_probability_unavailable") {
			t.Fatal("request audit lost serving policy/uncertainty")
		}
	}
	loaded, err := sessions.GetFeedSession(context.Background(), snapshot.ID)
	if err != nil || !reflect.DeepEqual(loaded.Items, snapshot.Items) || len(loaded.Degraded) != 0 {
		t.Fatal("page mutated immutable snapshot")
	}
	// Changing either session identity or tail while retaining the signature fails.
	pieces := strings.Split(*repeated.NextCursor, ".")
	payload, _ := base64.RawURLEncoding.DecodeString(pieces[0])
	var claims FeedCursorClaims
	json.Unmarshal(payload, &claims)
	for _, mutate := range []func(*FeedCursorClaims){func(c *FeedCursorClaims) { c.SessionID = "other-session" }, func(c *FeedCursorClaims) { c.ServedTail = []int{19} }} {
		changed := claims
		mutate(&changed)
		encoded, _ := json.Marshal(changed)
		tampered := base64.RawURLEncoding.EncodeToString(encoded) + "." + pieces[1]
		if _, err := server.feedSigner.ParseCursor(tampered, 42, now); err == nil {
			t.Fatal("tampered history accepted")
		}
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

func TestPortableExplorationCapUsesServedWindowWithDistinctOwners(t *testing.T) {
	server, store, _ := feedAPITestServer(t)
	server.portableFeed = true
	store.user = FeedUser{GitHubID: 42, ProfileVersion: 1, TaxonomyVersion: 1}
	store.unavailable = map[string]bool{}
	snapshot := FeedSession{ID: "exploration-compression", GitHubID: 42, ProfileVersion: 1, AlgorithmVersion: FeedPortableAlgorithmVersion, ExpiresAt: server.clock().Add(FeedSessionTTL)}
	for i := 0; i < 25; i++ {
		owner := fmt.Sprintf("distinct%d", i)
		key := owner + "/repo"
		snapshot.Items = append(snapshot.Items, FeedRankedItem{Project: FeedProject{OwnerLogin: owner, RepoKey: key}, Rank: i, Exploration: i%20 < 2, Propensity: .1})
		if i >= 2 && i <= 18 {
			store.unavailable[key] = true
		}
	}
	response := httptest.NewRecorder()
	server.serveFeedPage(response, httptest.NewRequest("GET", "/api/feed/projects", nil), store.user, snapshot, 0, 20, server.clock(), nil, false)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	if len(store.requests) != 1 {
		t.Fatal("missing request")
	}
	explore := 0
	for _, item := range store.requests[0].Items {
		if item.Exploration {
			explore++
		}
		if item.Rank == 20 || item.Rank == 21 {
			t.Fatal("third exploration crossed compacted window")
		}
	}
	if explore != 2 {
		t.Fatalf("exploration count%d", explore)
	}
}
