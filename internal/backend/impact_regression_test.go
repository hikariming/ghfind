package backend

import (
	"context"
	"encoding/json"
	"fmt"
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

type impactRegressionFixture struct {
	ExpectedFinalRange [2]float64       `json:"expected_final_range"`
	RecordedAt         string           `json:"recorded_at"`
	Metrics            RawMetrics       `json:"metrics"`
	ContribRepos       []ContribRepoAgg `json:"contrib_repos"`
	RecentPRs          []RecentPR       `json:"recent_prs"`
	StarRepos          []TopRepo        `json:"star_repos"`
	Expected           struct {
		ImpactPrestigeScore float64   `json:"impact_prestige_score"`
		ImpactDepthRaw      float64   `json:"impact_depth_raw"`
		ImpactRepoCount     float64   `json:"impact_repo_count"`
		SubScores           SubScores `json:"sub_scores"`
		FinalScore          float64   `json:"final_score"`
	} `json:"expected"`
}

// TestImpactRegressionFixturesMatchNode runs the shared real-account
// snapshots (recorded by scripts/record-score-fixtures.mts) through the Go
// pipeline at the recorded clock: the collected metrics, impact, weighted
// stars and score must all match the Node results.
func TestImpactRegressionFixturesMatchNode(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate Go test file")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "src", "lib", "__tests__", "impact-regression-fixtures.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read impact regression fixtures: %v", err)
	}
	fixtures := map[string]impactRegressionFixture{}
	if err := json.Unmarshal(contents, &fixtures); err != nil {
		t.Fatalf("decode impact regression fixtures: %v", err)
	}
	if len(fixtures) < 5 {
		t.Fatalf("expected the five recorded accounts, got %d", len(fixtures))
	}
	for name, fixture := range fixtures {
		t.Run(name, func(t *testing.T) {
			recorded := fixture.Metrics
			m := recorded
			login := strings.ToLower(m.Username)
			now, err := time.Parse(time.RFC3339, fixture.RecordedAt)
			if err != nil {
				t.Fatalf("recorded_at: %v", err)
			}
			impact := ComputeImpactFromContribMap(fixture.ContribRepos, login)
			quality := ComputeImpactQualitySignals(fixture.RecentPRs, impact.ImpactPRCount, login, valueOrZero(m.WorkflowLandedImpactPRCount))
			weightedTotal, weightedMax := WeightedOriginalStars(fixture.StarRepos, now)
			m.MaxImpactRepoStars = impact.MaxImpactRepoStars
			m.ImpactPrestigeScore = &impact.ImpactPrestigeScore
			m.ImpactDepthRaw = impact.ImpactDepthRaw
			m.ImpactRepoCount = &impact.ImpactRepoCount
			m.ImpactRepos = impact.ImpactRepos
			m.ImpactCommitCount = &impact.ImpactCommitCount
			m.ImpactPRCount = impact.ImpactPRCount
			m.VerifiedImpactPRCount = &quality.VerifiedImpactPRCount
			m.CoreImpactPRCount = &quality.CoreImpactPRCount
			m.DocLikeImpactPRCount = &quality.DocLikeImpactPRCount
			m.UnverifiedImpactPRCount = &quality.UnverifiedImpactPRCount
			m.WeightedTotalStars = &weightedTotal
			m.WeightedMaxStars = &weightedMax
			contentShare, contentConfidence := ContentSkillSignals(fixture.StarRepos)
			m.ContentSkillStarShare = &contentShare
			m.ContentSkillConfidence = &contentConfidence

			// The Go pure pipeline reproduces what the Node collector recorded.
			for field, pair := range map[string][2]float64{
				"max_impact_repo_stars":      {m.MaxImpactRepoStars, recorded.MaxImpactRepoStars},
				"impact_prestige_score":      {*m.ImpactPrestigeScore, valueOrZero(recorded.ImpactPrestigeScore)},
				"impact_depth_raw":           {m.ImpactDepthRaw, recorded.ImpactDepthRaw},
				"impact_repo_count":          {*m.ImpactRepoCount, valueOrZero(recorded.ImpactRepoCount)},
				"impact_commit_count":        {*m.ImpactCommitCount, valueOrZero(recorded.ImpactCommitCount)},
				"impact_pr_count":            {m.ImpactPRCount, recorded.ImpactPRCount},
				"verified_impact_pr_count":   {*m.VerifiedImpactPRCount, valueOrZero(recorded.VerifiedImpactPRCount)},
				"core_impact_pr_count":       {*m.CoreImpactPRCount, valueOrZero(recorded.CoreImpactPRCount)},
				"doc_like_impact_pr_count":   {*m.DocLikeImpactPRCount, valueOrZero(recorded.DocLikeImpactPRCount)},
				"unverified_impact_pr_count": {*m.UnverifiedImpactPRCount, valueOrZero(recorded.UnverifiedImpactPRCount)},
				"weighted_total_stars":       {weightedTotal, valueOrZero(recorded.WeightedTotalStars)},
				"weighted_max_stars":         {weightedMax, valueOrZero(recorded.WeightedMaxStars)},
			} {
				if pair[0] != pair[1] {
					t.Errorf("%s = %v, Node recorded %v", field, pair[0], pair[1])
				}
			}
			// Community scores and the own-PR community share follow from the
			// recorded facts (star-inflation suspects get 0).
			for _, repo := range fixture.ContribRepos {
				if repo.CommunityFacts == nil {
					continue
				}
				want := OwnRepoCommunity(*repo.CommunityFacts)
				if recorded.StarInflationSuspect {
					want = 0
				}
				if repo.Community == nil || *repo.Community != want {
					t.Errorf("%s community = %v, want %v", repo.Repo, repo.Community, want)
				}
			}
			if recorded.ExternalMergedPRCount != nil {
				ownPRs := recorded.MergedPRCount - min(*recorded.ExternalMergedPRCount, recorded.MergedPRCount)
				if got, want := OwnPRCommunityShare(fixture.ContribRepos, login, ownPRs), valueOrZero(recorded.OwnPRCommunity); got != want {
					t.Errorf("own_pr_community = %v, Node recorded %v", got, want)
				}
			}
			got := Score(m)

			want := fixture.Expected
			if impact.ImpactPrestigeScore != want.ImpactPrestigeScore || impact.ImpactDepthRaw != want.ImpactDepthRaw || impact.ImpactRepoCount != want.ImpactRepoCount {
				t.Fatalf("impact = %#v, want prestige %v depth %v repos %v", impact, want.ImpactPrestigeScore, want.ImpactDepthRaw, want.ImpactRepoCount)
			}
			if !reflect.DeepEqual(got.SubScores, want.SubScores) || got.FinalScore != want.FinalScore {
				t.Fatalf("score = %v %#v, want %v %#v", got.FinalScore, got.SubScores, want.FinalScore, want.SubScores)
			}
			if got.FinalScore < fixture.ExpectedFinalRange[0] || got.FinalScore > fixture.ExpectedFinalRange[1] {
				t.Fatalf("final score %v outside %v", got.FinalScore, fixture.ExpectedFinalRange)
			}
		})
	}
}

func TestDocLikeRepoNames(t *testing.T) {
	for _, repo := range []string{"fixture-owner-035/socket.io", "socket.io", "foo/bar.org", "org/composite", "org/parasite", "org/homepage-builder-sdk"} {
		if isDocLikeRepo(repo) {
			t.Errorf("%s must not be doc-like", repo)
		}
	}
	for _, repo := range []string{"someone/someone.github.io", "fixture-account-016/deerflow-website", "org/project-site", "org/project-homepage", "org/website", "org/site", "org/mywebsite"} {
		if !isDocLikeRepo(repo) {
			t.Errorf("%s must be doc-like", repo)
		}
	}
	for _, topic := range []string{"awesome", "course", "tutorial", "notes", "docs", "Awesome-List"} {
		if !isDocOrResourceRepo(ContribRepoAgg{Repo: "org/engine", Topics: []string{topic}}) {
			t.Errorf("topic %s must mark a resource repo", topic)
		}
	}
	if isDocOrResourceRepo(ContribRepoAgg{Repo: "org/engine", Topics: []string{"llm", "inference"}}) {
		t.Error("code topics must not mark a resource repo")
	}
}

func TestImpactExcludesMergesDocsAndOwnPrestige(t *testing.T) {
	agg := func(repo, owner string, stars, commits, merges, prs float64, topics ...string) ContribRepoAgg {
		return ContribRepoAgg{Repo: repo, OwnerLogin: owner, Stars: stars, Commits: commits, MergeCommits: merges, PRs: prs, Topics: topics}
	}
	authored := ComputeImpactFromContribMap([]ContribRepoAgg{agg("org/platform", "org", 24000, 6, 0, 0)}, "me")
	merged := ComputeImpactFromContribMap([]ContribRepoAgg{agg("org/platform", "org", 24000, 30, 24, 0)}, "me")
	if merged.ImpactPrestigeScore != authored.ImpactPrestigeScore || merged.ImpactDepthRaw != authored.ImpactDepthRaw {
		t.Fatalf("merge commits counted as work: %#v vs %#v", merged, authored)
	}
	if only := ComputeImpactFromContribMap([]ContribRepoAgg{agg("org/platform", "org", 24000, 12, 12, 0)}, "me"); only.ImpactPrestigeScore != 0 || only.ImpactDepthRaw != 0 {
		t.Fatalf("merge-only repo earned impact: %#v", only)
	}

	small := ComputeImpactFromContribMap([]ContribRepoAgg{
		agg("org/engine-website", "org", 4999, 40, 0, 10),
		agg("org/list", "org", 3000, 40, 0, 0, "awesome"),
	}, "me")
	if small.ImpactRepoCount != 0 {
		t.Fatalf("small doc/resource repos counted: %#v", small)
	}
	full := ComputeImpactFromContribMap([]ContribRepoAgg{agg("org/engine", "org", 8000, 40, 0, 10)}, "me")
	half := ComputeImpactFromContribMap([]ContribRepoAgg{agg("org/engine", "org", 8000, 40, 0, 10, "course")}, "me")
	if half.ImpactRepoCount != 1 || half.ImpactPrestigeScore >= full.ImpactPrestigeScore || half.ImpactDepthRaw >= full.ImpactDepthRaw {
		t.Fatalf("popular resource repo not halved: %#v vs %#v", half, full)
	}

	// 0.3 own weight x 0.79 code-share prior, no prestige.
	ownRepo := agg("me/tool", "me", 30000, 200, 0, 0)
	ownRepo.Forks = 1000
	own := ComputeImpactFromContribMap([]ContribRepoAgg{ownRepo}, "me")
	if own.ImpactRepoCount != 1 || own.ImpactPrestigeScore != 0 || own.ImpactDepthRaw != 0.58 {
		t.Fatalf("own repo impact = %#v, want depth 0.58 and no prestige", own)
	}
}

func TestApplyImpactRepoSignalsEstimatesMergeShare(t *testing.T) {
	got := ApplyImpactRepoSignals(
		[]ContribRepoAgg{{Repo: "Org/Engine", Commits: 50}, {Repo: "org/other", Commits: 9}},
		map[string]ImpactRepoSignal{"org/engine": {Topics: []string{"notes"}, SampledCommits: 100, MergeCommits: 30}},
	)
	if got[0].MergeCommits != 15 || !reflect.DeepEqual(got[0].Topics, []string{"notes"}) || got[1].MergeCommits != 0 || got[1].Topics != nil {
		t.Fatalf("signals = %#v", got)
	}
}

func TestImpactWeightsCodeShareTenureAndOwnEngagement(t *testing.T) {
	repo := ContribRepoAgg{Repo: "org/engine", OwnerLogin: "org", Stars: 20000, PRs: 10}
	code, docs := repo, repo
	code.PRSample, code.CodePRSample = 10, 10
	docs.PRSample = 10
	codeImpact := ComputeImpactFromContribMap([]ContribRepoAgg{code}, "me")
	docsImpact := ComputeImpactFromContribMap([]ContribRepoAgg{docs}, "me")
	if math.Abs(docsImpact.ImpactPrestigeScore-codeImpact.ImpactPrestigeScore*0.3) > 1e-3 {
		t.Fatalf("doc-only repo prestige %v, want 0.3 x %v", docsImpact.ImpactPrestigeScore, codeImpact.ImpactPrestigeScore)
	}
	if got := impactRepoCodeWeight(repo); math.Abs(got-0.79) > 1e-12 {
		t.Fatalf("prior code weight = %v", got)
	}
	// A sample speaks only for the work it covers: 1 PR out of 70 authored
	// commits stays near the prior; 1 PR + its squash commit is fully covered.
	thin := ContribRepoAgg{PRs: 1, Commits: 70, PRSample: 1, CodePRSample: 1}
	if got := impactRepoCodeWeight(thin); math.Abs(got-(0.3+0.7*(0.1+0.9*0.7))) > 1e-12 {
		t.Fatalf("thin-coverage code weight = %v", got)
	}
	if got := impactRepoCodeWeight(ContribRepoAgg{PRs: 1, Commits: 1, PRSample: 1}); math.Abs(got-0.3) > 1e-12 {
		t.Fatalf("fully covered doc PR weight = %v", got)
	}
	for months, want := range map[int]float64{0: 1, 1: 0.75, 3: 0.85, 6: 1, 9: 1} {
		tenure := repo
		for i := 0; i < months; i++ {
			tenure.Months = append(tenure.Months, fmt.Sprintf("2026-%02d", i+1))
		}
		if got := impactRepoTenureWeight(tenure); math.Abs(got-want) > 1e-12 {
			t.Errorf("tenure(%d) = %v, want %v", months, got, want)
		}
	}
	engaged, viral := 0.2, 0.005
	own := ContribRepoAgg{Repo: "me/skill", OwnerLogin: "me", Stars: 30000, Commits: 100, Engagement: &engaged}
	ownViral := own
	ownViral.Engagement = &viral
	if a, b := ComputeImpactFromContribMap([]ContribRepoAgg{own}, "me"), ComputeImpactFromContribMap([]ContribRepoAgg{ownViral}, "me"); math.Abs(b.ImpactDepthRaw-a.ImpactDepthRaw*0.5) > 0.01 || b.ImpactPrestigeScore != 0 {
		t.Fatalf("viral own repo depth %v vs %v", b.ImpactDepthRaw, a.ImpactDepthRaw)
	}
	attributed := ContribRepoAgg{Repo: "my-org/tool", OwnerLogin: "my-org", Stars: 600, Commits: 100, AttributedOriginal: true}
	if got := ComputeImpactFromContribMap([]ContribRepoAgg{attributed}, "me"); got.ImpactRepoCount != 0 {
		t.Fatalf("attributed original below 1000 stars counted: %#v", got)
	}
}

func TestStylesheetsAreCodeInUILibraries(t *testing.T) {
	ant, engine := "ant-design/x", "org/inference-engine"
	if IsDocLikeImpactPR(RecentPR{Repo: &ant, Files: []string{"components/bubble/index.less"}}) {
		t.Error("UI library stylesheet classified as presentation")
	}
	if !IsDocLikeImpactPR(RecentPR{Repo: &engine, Files: []string{"web/index.css"}}) {
		t.Error("app stylesheet must stay presentation")
	}
}

func TestOriginalStarWeightsAndProfileReadme(t *testing.T) {
	now := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
	repo := func(name, pushed string, topics ...string) TopRepo {
		return TopRepo{Name: name, Stars: 1000, PushedAt: stringPointer(pushed), Topics: topics}
	}
	for _, tc := range []struct {
		repo TopRepo
		want float64
	}{
		{repo("engine", "2026-09-01T00:00:00Z"), 1},
		{repo("engine", "2020-01-01T00:00:00Z"), 0.5},
		{repo("chat-dataset-baseline", "2026-09-01T00:00:00Z"), 0.5689375},
		{repo("engine", "2026-09-01T00:00:00Z", "dataset"), 0.5689375},
		{TopRepo{Name: "slides", Stars: 1, PushedAt: stringPointer("2026-09-01T00:00:00Z"), Languages: []RepoLanguage{{Name: "HTML", Size: 900}, {Name: "Python", Size: 100}}}, 0.271},
	} {
		if got := OriginalRepoStarWeight(tc.repo, now); math.Abs(got-tc.want) > 1e-12 {
			t.Errorf("%s weight = %v, want %v", tc.repo.Name, got, tc.want)
		}
	}
	if !isProfileReadmeRepo(TopRepo{Name: "Me"}, "me") || isProfileReadmeRepo(TopRepo{Name: "me", OwnerLogin: stringPointer("my-org"), AttributedOriginal: true}, "me") {
		t.Error("profile README detection")
	}
}

func TestAggregateMergedPRNodesDedupesWindowAndExternalSearch(t *testing.T) {
	node := func(id, repo string, stars float64, merged string) mergedPRNode {
		owner := strings.SplitN(repo, "/", 2)[0]
		return mergedPRNode{ID: &id, MergedAt: &merged, Repository: &graphContributionRepo{NameWithOwner: repo, StargazerCount: stars, Owner: &struct {
			Login *string `json:"login"`
		}{Login: &owner}}}
	}
	got := AggregateMergedPRNodes([]mergedPRNode{
		node("a", "org/engine", 5000, "2025-01-10T00:00:00Z"),
		node("b", "org/engine", 5000, "2025-03-10T00:00:00Z"),
		node("a", "org/engine", 5000, "2025-01-10T00:00:00Z"),
	})
	if len(got) != 1 || got[0].PRs != 2 || got[0].ActiveYears != 1 || !reflect.DeepEqual(got[0].Months, []string{"2025-01", "2025-03"}) {
		t.Fatalf("aggregate = %#v", got)
	}
	if share := highStarPRShare([]mergedPRNode{node("a", "org/engine", 5000, "2025-01-10T00:00:00Z"), node("c", "bob/tiny", 3, "2025-01-10T00:00:00Z")}); share != 0.5 {
		t.Fatalf("high-star share = %v", share)
	}
}

func TestFetchImpactRepoSignalsQueriesEligibleReposAndCountsMerges(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		if request.URL.Path != "/graphql" || !strings.Contains(body.Query, "author: { id: $author }") ||
			!reflect.DeepEqual(body.Variables, map[string]any{"author": "U_me", "o0": "org", "n0": "engine"}) {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"data":{"r0":{"repositoryTopics":{"nodes":[{"topic":{"name":"awesome"}}]},
			"defaultBranchRef":{"target":{"history":{"nodes":[{"parents":{"totalCount":2}},{"parents":{"totalCount":1}},{"parents":{"totalCount":1}},{"parents":{"totalCount":1}}]}}}}}}`))
	}))
	defer server.Close()

	client := NewGitHubClient("test-token").withBaseURL(server.URL).withHTTPClient(server.Client())
	repos := []ContribRepoAgg{
		{Repo: "org/engine", OwnerLogin: "org", Stars: 9000, Commits: 40},
		{Repo: "org/tiny", OwnerLogin: "org", Stars: 50, Commits: 40},
		{Repo: "me/own", OwnerLogin: "me", Stars: 500, Commits: 40},
	}
	signals, err := client.fetchImpactRepoSignals(context.Background(), repos, "me", "U_me")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]ImpactRepoSignal{"org/engine": {Topics: []string{"awesome"}, SampledCommits: 4, MergeCommits: 1}}
	if !reflect.DeepEqual(signals, want) {
		t.Fatalf("signals = %#v, want %#v", signals, want)
	}
}

func TestFetchExternalMergedPRsSearchesOutsideOwnRepos(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		if body.Variables["q"] != "is:pr is:merged is:public author:alice -user:alice sort:created-desc" {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"data":{"search":{"issueCount":2,"nodes":[
			{"id":"PR_1","mergedAt":"2026-01-02T00:00:00Z","repository":{"nameWithOwner":"org/engine","stargazerCount":900,"owner":{"login":"org"}}},
			{"id":"PR_2","mergedAt":"2026-02-02T00:00:00Z","repository":{"nameWithOwner":"bob/tiny","stargazerCount":3,"owner":{"login":"bob"}}},
			{}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}`))
	}))
	defer server.Close()
	client := NewGitHubClient("test-token").withBaseURL(server.URL).withHTTPClient(server.Client())
	got, err := client.fetchExternalMergedPRs(context.Background(), "alice", externalMergedPRCap)
	if err != nil || got == nil || got.Total != 2 || len(got.Nodes) != 2 || highStarPRShare(got.Nodes) != 0.5 {
		t.Fatalf("external = %#v, err %v", got, err)
	}
}

func TestCollectImpactCodeSamplesFetchesOnlyUnderCoveredRepos(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls++
		var body struct {
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		if !reflect.DeepEqual(body.Variables, map[string]any{"q0": "repo:org/docsy is:pr is:merged author:alice sort:created-desc"}) {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"data":{"s0":{"nodes":[{"title":"docs: update guide","additions":10,"deletions":0,"changedFiles":1,
			"repository":{"nameWithOwner":"org/docsy","stargazerCount":5000,"isPrivate":false},"files":{"nodes":[{"path":"docs/guide.md"}]}}]}}}`))
	}))
	defer server.Close()
	client := NewGitHubClient("test-token").withBaseURL(server.URL).withHTTPClient(server.Client())
	title, repo, files := "fix scheduler", "org/engine", []string{"src/scheduler.ts"}
	samples, err := client.collectImpactCodeSamples(context.Background(), []ContribRepoAgg{
		{Repo: "org/engine", OwnerLogin: "org", Stars: 9000, PRs: 1},
		{Repo: "org/docsy", OwnerLogin: "org", Stars: 5000, PRs: 3},
		{Repo: "org/tiny", OwnerLogin: "org", Stars: 50, PRs: 9},
	}, "alice", []RecentPR{{Title: &title, Repo: &repo, RepoStars: 9000, Churn: 40, Files: files}})
	if err != nil || calls != 1 {
		t.Fatalf("err %v calls %d", err, calls)
	}
	want := map[string]ImpactCodeSample{"org/engine": {PRSample: 1, CodePRSample: 1}, "org/docsy": {PRSample: 1, CodePRSample: 0}}
	if !reflect.DeepEqual(samples, want) {
		t.Fatalf("samples = %#v, want %#v", samples, want)
	}
}
