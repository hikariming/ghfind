package backend

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

type communityFixture struct {
	Name              string                  `json:"name"`
	Raw               OwnRepoCommunityRaw     `json:"raw"`
	Context           OwnRepoCommunityContext `json:"context"`
	ExpectedFacts     OwnRepoCommunityFacts   `json:"expected_facts"`
	ExpectedCommunity float64                 `json:"expected_community"`
}

// TestCommunityFixturesMatchNode pins Go to the facts and community score the
// TypeScript collector derives from the same raw samples.
func TestCommunityFixturesMatchNode(t *testing.T) {
	_, thisFile, _, _ := runtime.Caller(0)
	contents, err := os.ReadFile(filepath.Join(filepath.Dir(thisFile), "..", "..", "src", "lib", "__tests__", "community-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []communityFixture
	if err := json.Unmarshal(contents, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) < 3 {
		t.Fatalf("expected community fixtures, got %d", len(fixtures))
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			got := ComputeOwnRepoCommunityFacts(fixture.Raw, fixture.Context)
			if !reflect.DeepEqual(got, fixture.ExpectedFacts) {
				gotJSON, _ := json.Marshal(got)
				wantJSON, _ := json.Marshal(fixture.ExpectedFacts)
				t.Fatalf("facts = %s, want %s", gotJSON, wantJSON)
			}
			if community := OwnRepoCommunity(got); community != fixture.ExpectedCommunity {
				t.Fatalf("community = %v, want %v", community, fixture.ExpectedCommunity)
			}
		})
	}
}

func fullCommunityFacts() OwnRepoCommunityFacts {
	latency, days := 1.0, 1.0
	return OwnRepoCommunityFacts{WeightedContributors: 30, SustainedContributors: 10, OutsideDemand: 300, MergeLatencyDays: &latency, OwnerResponseShare: 1, OutsideAcceptance: 1, Forks: 1000, DaysSinceOutsideMerge: &days, LeadShare: 1}
}

func TestOwnRepoCommunityFormula(t *testing.T) {
	full := fullCommunityFacts()
	if got := OwnRepoCommunity(full); got != 1 {
		t.Fatalf("full community = %v", got)
	}
	gated := full
	gated.WeightedContributors = 0
	if got := OwnRepoCommunity(gated); got != 0 {
		t.Fatalf("audience without builders = %v", got)
	}
	stale := full
	stale.DaysSinceOutsideMerge = nil
	if got := OwnRepoCommunity(stale); got != 0.4 {
		t.Fatalf("stale community = %v", got)
	}
	half := full
	half.LeadShare = 0.5
	if got := OwnRepoCommunity(half); got != 0.5 {
		t.Fatalf("half lead share = %v", got)
	}
}

func communityRepo(repo, owner string, stars, prs float64, community *float64) ContribRepoAgg {
	return ContribRepoAgg{Repo: repo, OwnerLogin: owner, Stars: stars, Commits: 300, PRs: prs, ActiveYears: 3,
		Months: []string{"2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"}, PRSample: 10, CodePRSample: 10, Community: community}
}

func TestCommunityImpactGateAndCredit(t *testing.T) {
	high, half, attributedCommunity := 0.8, 0.5, 0.9
	if got := ComputeImpactFromContribMap([]ContribRepoAgg{communityRepo("me/tool", "me", 500, 100, nil)}, "me"); got.ImpactRepoCount != 0 {
		t.Fatalf("own 500★ repo without community qualified: %#v", got)
	}
	got := ComputeImpactFromContribMap([]ContribRepoAgg{communityRepo("me/tool", "me", 500, 100, &high)}, "me")
	if got.ImpactRepoCount != 1 || got.ImpactPrestigeScore != 0.8 || got.ImpactDepthRaw != 2 {
		t.Fatalf("community repo impact = %#v", got)
	}
	popular := ComputeImpactFromContribMap([]ContribRepoAgg{communityRepo("me/tool", "me", 90000, 100, nil)}, "me")
	engaged := ComputeImpactFromContribMap([]ContribRepoAgg{communityRepo("me/tool", "me", 90000, 100, &half)}, "me")
	if popular.ImpactPrestigeScore != 0 || engaged.ImpactPrestigeScore != 0.5 || math.Abs(engaged.ImpactDepthRaw-(popular.ImpactDepthRaw+1.25)) > 0.011 {
		t.Fatalf("stars became prestige or depth wrong: %#v vs %#v", engaged, popular)
	}
	attributed := communityRepo("big-org/engine", "big-org", 70000, 100, &attributedCommunity)
	attributed.AttributedOriginal = true
	if got := ComputeImpactFromContribMap([]ContribRepoAgg{attributed}, "me"); got.ImpactPrestigeScore != 0.9 {
		t.Fatalf("attributed original prestige = %v", got.ImpactPrestigeScore)
	}
}

func TestCommunityStarInflationAndOwnPRShare(t *testing.T) {
	measured := map[string]OwnRepoCommunityFacts{"me/tool": fullCommunityFacts()}
	repos := []ContribRepoAgg{communityRepo("me/tool", "me", 500, 150, nil)}
	if got := ApplyOwnRepoCommunities(repos, measured, false); valueOrZero(got[0].Community) != 1 {
		t.Fatalf("community = %#v", got[0].Community)
	}
	if got := ApplyOwnRepoCommunities(repos, measured, true); got[0].Community == nil || *got[0].Community != 0 || got[0].CommunityFacts == nil {
		t.Fatalf("star-inflation suspect kept community: %#v", got[0])
	}
	high, full := 0.8, 1.0
	attributed := communityRepo("big-org/engine", "big-org", 70000, 40, &full)
	attributed.AttributedOriginal = true
	share := OwnPRCommunityShare([]ContribRepoAgg{communityRepo("me/tool", "me", 500, 150, &high), communityRepo("me/side", "me", 300, 50, nil), attributed}, "me", 200)
	if share != 0.8 {
		t.Fatalf("own PR community share = %v", share)
	}
}

type recordingCollectCache struct {
	inner CollectCache
	ttls  map[string]time.Duration
}

func (c *recordingCollectCache) Get(ctx context.Context, key string) ([]byte, bool) {
	return c.inner.Get(ctx, key)
}

func (c *recordingCollectCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) {
	c.ttls[key] = ttl
	c.inner.Set(ctx, key, value, ttl)
}

func communityGitHubServer(t *testing.T, restRemaining string, calls *int) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls++
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/repos/me/tool/contributors" {
			w.Header().Set("X-RateLimit-Remaining", restRemaining)
			_, _ = w.Write([]byte(`[{"login":"me","type":"User","contributions":300},{"login":"bob","type":"User","contributions":40}]`))
			return
		}
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		var data string
		switch {
		case strings.Contains(body.Query, "c0: search"):
			data = `{"rateLimit":{"remaining":4000},"c0":{"issueCount":12},"c1":{"issueCount":0}}`
		case strings.Contains(body.Query, "forkCount"):
			data = `{"rateLimit":{"remaining":4000},"repository":{"forkCount":40},"closed":{"issueCount":3},"opened":{"issueCount":15}}`
		case strings.Contains(body.Query, "... on PullRequest"):
			data = `{"search":{"issueCount":12,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"createdAt":"2026-09-01T00:00:00Z","mergedAt":"2026-09-02T00:00:00Z","additions":40,"deletions":2,"title":"fix: retry","files":{"nodes":[{"path":"src/net.ts"}]},"author":{"__typename":"User","login":"bob"}}]}}`
		case strings.Contains(body.Query, "... on Issue"):
			data = `{"search":{"issueCount":4,"nodes":[{"createdAt":"2026-09-10T00:00:00Z","author":{"__typename":"User","login":"bob"},"comments":{"nodes":[{"author":{"login":"me"}}]}}]}}`
		case strings.Contains(body.Query, "u0: user(login:"):
			if !reflect.DeepEqual(body.Variables, map[string]any{"l0": "bob"}) {
				t.Errorf("profile variables = %#v", body.Variables)
			}
			data = `{"u0":{"login":"bob","createdAt":"2018-01-01T00:00:00Z","followers":{"totalCount":50},"pullRequests":{"totalCount":30},"organizations":{"nodes":[]}}}`
		default:
			t.Errorf("unexpected request %s %s", r.URL.Path, body.Query)
			data = `{}`
		}
		_, _ = w.Write([]byte(`{"data":` + data + `}`))
	}))
}

func TestCollectOwnRepoCommunitiesCachesAndRespectsBudget(t *testing.T) {
	calls := 0
	server := communityGitHubServer(t, "4000", &calls)
	defer server.Close()
	client := NewGitHubClient("token").withBaseURL(server.URL).withHTTPClient(server.Client())
	repos := []ContribRepoAgg{
		communityRepo("me/tool", "me", 500, 100, nil),
		communityRepo("me/quiet", "me", 900, 100, nil),
		communityRepo("org/lib", "org", 9000, 100, nil),
	}
	cache := &recordingCollectCache{inner: NewMemoryCollectCache(), ttls: map[string]time.Duration{}}
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	facts, err := client.collectOwnRepoCommunities(context.Background(), repos, "me", nil, now, cache)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := facts["me/tool"]
	if len(facts) != 1 || !ok || got.WeightedContributors != 1 || got.OutsideAcceptance != 0.8 || got.Forks != 40 || got.OwnerResponseShare != 1 {
		t.Fatalf("facts = %#v", facts)
	}
	if cache.ttls["community:counts:v2:me"] != 24*time.Hour || cache.ttls["community:facts:v2:me:me/tool"] != 7*24*time.Hour || cache.ttls["community:profile:v2:bob"] != 30*24*time.Hour {
		t.Fatalf("cache TTLs = %#v", cache.ttls)
	}
	before := calls
	again, err := client.collectOwnRepoCommunities(context.Background(), repos, "me", nil, now, cache)
	if err != nil || !reflect.DeepEqual(again, facts) || calls != before {
		t.Fatalf("cached run made %d calls, facts %#v, err %v", calls-before, again, err)
	}

	lowCalls := 0
	low := communityGitHubServer(t, "120", &lowCalls)
	defer low.Close()
	lowClient := NewGitHubClient("token").withBaseURL(low.URL).withHTTPClient(low.Client())
	if facts, err := lowClient.collectOwnRepoCommunities(context.Background(), repos, "me", nil, now, nil); err != nil || len(facts) != 0 {
		t.Fatalf("REST floor ignored: %#v, %v", facts, err)
	}
}
