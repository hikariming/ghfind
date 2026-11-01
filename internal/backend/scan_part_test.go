package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPlanScanFanoutKeepsLightAccountsInProcess(t *testing.T) {
	plan := planScanFanout(scanSeedSignals{
		PublicRepos: float64(quickRepoPages * githubPageSize),
		MergedPRs:   float64(mergedPRWindow),
		ClosedPRs:   float64(githubPageSize),
	})
	if plan.Split || len(plan.parts()) != 0 {
		t.Fatalf("light account split: %+v", plan)
	}
}

func TestPlanScanFanoutCapsHeavyAccountsAndSerializesSearch(t *testing.T) {
	plan := planScanFanout(scanSeedSignals{
		PublicRepos:   float64(quickRepoPages*githubPageSize) + 1,
		MergedPRs:     float64(externalMergedPRCap),
		ClosedPRs:     float64(githubPageSize) + 1,
		ExternalAtCap: true,
		RateRemaining: 2,
		RateKnown:     true,
	})
	if !plan.Split || len(plan.parts()) != 3 {
		t.Fatalf("plan=%+v", plan)
	}
	if len(plan.SearchParts) != 1 || plan.SearchParts[0] != scanPartExternal {
		t.Fatalf("search lane=%v", plan.SearchParts)
	}
	enqueued := len(plan.SearchParts) + len(plan.ParallelParts)
	if enqueued != 2 || len(plan.InlineParts) != 3 {
		t.Fatalf("budgeted plan=%+v", plan)
	}
}

func TestSplitScanMatchesInProcessCollect(t *testing.T) {
	collector := fictionFanoutGitHub(t, fanoutFixture{
		login: "fiction-heavy", publicRepos: quickRepoPages*githubPageSize + 1, merged: 4, closed: 1, years: []int{2025},
	})
	direct, err := collector.Collect(context.Background(), "fiction-heavy")
	if err != nil {
		t.Fatal(err)
	}
	split := collectThroughParts(t, collector, "fiction-heavy")
	if split.Scoring.FinalScore != direct.Scoring.FinalScore || split.Scoring.Tier != direct.Scoring.Tier {
		t.Fatalf("score split=%v direct=%v", split.Scoring.FinalScore, direct.Scoring.FinalScore)
	}
	if split.Collection.Coverage != direct.Collection.Coverage || split.Metrics.MergedPRCount != direct.Metrics.MergedPRCount || split.Metrics.PublicRepos != direct.Metrics.PublicRepos || split.Metrics.TotalStars != direct.Metrics.TotalStars {
		t.Fatalf("facts split=%+v direct=%+v coverage split=%+v direct=%+v", split.Metrics, direct.Metrics, split.Collection, direct.Collection)
	}
}

func TestPartialPartFailureWritesPerSourceStatus(t *testing.T) {
	collector := fictionFanoutGitHub(t, fanoutFixture{
		login: "fiction-partial", publicRepos: 1, merged: mergedPRWindow + 1, closed: 0, failPart: scanPartRepos,
	})
	scan, sources := collectThroughPartsWithSources(t, collector, "fiction-partial")
	if scan.Collection == nil || scan.Collection.Coverage != "partial_public" {
		t.Fatalf("coverage=%+v", scan.Collection)
	}
	if sources[scanSourceOriginalRepos] != scanSourceStateFailed {
		t.Fatalf("original_repos=%s", sources[scanSourceOriginalRepos])
	}
	merged := map[string]string{}
	if err := json.Unmarshal(mergedSourceStatus(scan, sources), &merged); err != nil {
		t.Fatal(err)
	}
	if merged[scanSourceNativePRs] != scanSourceStatePending || merged[scanSourceQuick] != scanSourceStateComplete || merged[scanSourceOriginalRepos] != scanSourceStateFailed {
		t.Fatalf("merged=%v part=%v", merged, sources)
	}
	if sources[scanSourceCommitRecovery] == "" || sources[scanSourceWorkflowLandings] == "" {
		t.Fatalf("missing sources=%v", sources)
	}
}

func TestRepeatedPartDeliveryIsIdempotent(t *testing.T) {
	store := openScanPersistenceStore(t)
	parent := ScanJob{ID: "fiction-parent", Username: "fiction-repeat", RequestedAt: 1}
	seed := scanSeedEnvelope{User: githubUser{Login: "fiction-repeat", ID: 1}, Full: false}
	parts := []string{scanPartRepos, scanPartDependents}
	if err := store.SaveScanParent(context.Background(), parent, false, parts, seed); err != nil {
		t.Fatal(err)
	}
	job := ScanPartJob{ParentID: parent.ID, Username: parent.Username, Part: scanPartRepos}
	first := scanPartPayload{Part: scanPartRepos, Repos: []githubRepo{{Name: "first"}}}
	stored, done, err := store.SaveScanPart(context.Background(), job, first)
	if err != nil || !stored || done {
		t.Fatalf("first stored=%v done=%v err=%v", stored, done, err)
	}
	again := scanPartPayload{Part: scanPartRepos, Repos: []githubRepo{{Name: "second"}}, Failed: true}
	stored, done, err = store.SaveScanPart(context.Background(), job, again)
	if err != nil || stored || done {
		t.Fatalf("repeat stored=%v done=%v err=%v", stored, done, err)
	}
	loaded, err := store.LoadScanParent(context.Background(), parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Payloads[scanPartRepos].Failed || len(loaded.Payloads[scanPartRepos].Repos) != 1 || loaded.Payloads[scanPartRepos].Repos[0].Name != "first" {
		t.Fatalf("overwritten payload=%+v", loaded.Payloads[scanPartRepos])
	}
	stored, done, err = store.SaveScanPart(context.Background(), ScanPartJob{ParentID: parent.ID, Username: parent.Username, Part: scanPartDependents}, scanPartPayload{Part: scanPartDependents})
	if err != nil || !stored || !done {
		t.Fatalf("last stored=%v done=%v err=%v", stored, done, err)
	}
}

func TestLightUserDoesNotEnqueueParts(t *testing.T) {
	collector := fictionFanoutGitHub(t, fanoutFixture{login: "fiction-light", publicRepos: 1, merged: 1, closed: 0})
	publisher := &recordingScanPublisher{}
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, collector, openScanPersistenceStore(t), &fakeStatusStore{}, publisher, nil)
	disposition, reason := worker.process(context.Background(), ScanJob{ID: "fiction-light-job", Username: "fiction-light", RequestedAt: 1})
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("worker: %v %s", disposition, reason)
	}
	if len(publisher.parts) != 0 || len(publisher.assembles) != 0 {
		t.Fatalf("light account published parts=%d assembles=%d", len(publisher.parts), len(publisher.assembles))
	}
}

func TestHeavyUserPublishesAtMostFourParts(t *testing.T) {
	collector := fictionFanoutGitHub(t, fanoutFixture{
		login: "fiction-heavy", publicRepos: quickRepoPages*githubPageSize + 1, merged: float64(externalMergedPRCap), closed: githubPageSize + 1, years: []int{2025},
	})
	publisher := &recordingScanPublisher{}
	store := openScanPersistenceStore(t)
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, collector, store, &fakeStatusStore{}, publisher, nil)
	disposition, reason := worker.process(context.Background(), ScanJob{ID: "fiction-heavy-job", Username: "fiction-heavy", RequestedAt: 1})
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("worker: %v %s", disposition, reason)
	}
	if len(publisher.parts) == 0 || len(publisher.parts) > maxScanFanoutParts {
		t.Fatalf("published %d parts", len(publisher.parts))
	}
	searchLane := -1
	for _, part := range publisher.parts {
		if part.Part == scanPartExternal {
			searchLane = part.Lane
		}
	}
	if searchLane != 0 {
		t.Fatalf("search lane=%d parts=%+v", searchLane, publisher.parts)
	}
	parent, err := store.LoadScanParent(context.Background(), "fiction-heavy-job")
	if err != nil || !containsPart(parent.Parts, scanPartDependents) || len(parent.Parts) != len(publisher.parts)+1 {
		t.Fatalf("published=%d parent=%+v err=%v", len(publisher.parts), parent.Parts, err)
	}
}

type fanoutFixture struct {
	login       string
	publicRepos int
	merged      float64
	closed      float64
	years       []int
	failPart    string
}

func fictionFanoutGitHub(t *testing.T, fixture fanoutFixture) *GitHubCollector {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-RateLimit-Remaining", "4000")
		if request.URL.Path == "/users/"+fixture.login {
			fmt.Fprintf(w, `{"login":%q,"id":424242,"node_id":"U_FICTION","html_url":"https://github.com/%s","created_at":"2020-01-01T00:00:00Z","followers":12,"following":2,"public_repos":%d,"bio":"fictional"}`, fixture.login, fixture.login, fixture.publicRepos)
			return
		}
		if strings.HasPrefix(request.URL.Path, "/users/") && strings.HasSuffix(request.URL.Path, "/events/public") {
			fmt.Fprint(w, `[{"created_at":"2026-08-01T00:00:00Z"}]`)
			return
		}
		if strings.HasPrefix(request.URL.Path, "/users/") && strings.HasSuffix(request.URL.Path, "/repos") {
			fmt.Fprintf(w, `[{"name":"fiction-lib","full_name":"%s/fiction-lib","fork":false,"size":120,"stargazers_count":8,"forks_count":1,"open_issues_count":0,"language":"Go","description":"Fictional library","pushed_at":"2026-07-01T00:00:00Z"}]`, fixture.login)
			return
		}
		if request.URL.Path != "/graphql" {
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{}`)
			return
		}
		var body struct {
			Query string `json:"query"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		part := ""
		switch {
		case strings.Contains(body.Query, "query OriginalInventory"):
			part = scanPartRepos
		case strings.Contains(body.Query, "type: ISSUE, first: $count"):
			part = scanPartExternal
		case strings.Contains(body.Query, "states: MERGED, after"):
			part = scanPartMerged
		case strings.Contains(body.Query, "commitContributionsByRepository"):
			part = scanPartCommits
		case strings.Contains(body.Query, "labels(first: 20)"):
			part = scanPartWorkflows
		}
		if part != "" && part == fixture.failPart {
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprint(w, `{"message":"fiction upstream"}`)
			return
		}
		years := "[]"
		if len(fixture.years) > 0 {
			raw, _ := json.Marshal(fixture.years)
			years = string(raw)
		}
		data := fmt.Sprintf(`{"user":{"pronouns":null,"pinnedItems":{"nodes":[]},"mergedPRs":{"totalCount":%g},"allPRs":{"totalCount":%g},"closedPRs":{"totalCount":%g,"nodes":[]},"issues":{"totalCount":0},"contributionYears":{"contributionYears":%s},"contributionsCollection":{"totalCommitContributions":3,"totalPullRequestContributions":1,"totalIssueContributions":0,"totalPullRequestReviewContributions":0,"contributionCalendar":{"totalContributions":4},"contributionYears":%s},"organizations":{"nodes":[]},"pullRequests":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}},"y0":{"commitContributionsByRepository":[]},"forks":{"totalCount":0},"repositories":{"nodes":[{"name":"fiction-lib","nameWithOwner":"%s/fiction-lib","isFork":false,"diskUsage":120,"stargazerCount":8,"forkCount":1,"issues":{"totalCount":0},"primaryLanguage":{"name":"Go"},"description":"Fictional library","pushedAt":"2026-07-01T00:00:00Z"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}},"search":{"issueCount":0,"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}`,
			fixture.merged, fixture.merged, fixture.closed, years, years, fixture.login)
		fmt.Fprintf(w, `{"data":%s}`, data)
	}))
	t.Cleanup(server.Close)
	collector := NewGitHubCollector(NewGitHubClient("fiction-token").withBaseURL(server.URL).withHTTPClient(server.Client()))
	collector.clock = func() time.Time { return time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC) }
	return collector
}

func collectThroughParts(t *testing.T, collector *GitHubCollector, username string) ScanResult {
	t.Helper()
	scan, _ := collectThroughPartsWithSources(t, collector, username)
	return scan
}

func collectThroughPartsWithSources(t *testing.T, collector *GitHubCollector, username string) (ScanResult, map[string]string) {
	t.Helper()
	signals, user, overview, stats, lastYear, latest, err := collector.SeedScan(context.Background(), username)
	if err != nil {
		t.Fatal(err)
	}
	signals.Full = false
	plan := planScanFanout(signals)
	if !plan.Split {
		t.Fatal("fixture did not split")
	}
	payloads := map[string]scanPartPayload{}
	for _, part := range append(append([]string{}, plan.parts()...), plan.InlineParts...) {
		if part == scanPartDependents {
			continue
		}
		payload, err := collector.CollectScanPart(context.Background(), username, part, false, user, overview)
		if err != nil {
			payload = scanPartPayload{Part: part, Failed: true, Error: err.Error()}
		}
		payloads[part] = payload
		// A repeated delivery keeps the first payload.
		_, _ = collector.CollectScanPart(context.Background(), username, part, false, user, overview)
	}
	scan, sources, err := collector.assembleCollectedScan(context.Background(), false, user, overview, stats, lastYear, latest, payloads)
	if err != nil {
		t.Fatal(err)
	}
	return scan, sources
}

type recordingScanPublisher struct {
	fakeScanPublisher
	mu        sync.Mutex
	parts     []ScanPartJob
	assembles []ScanAssembleJob
}

func (p *recordingScanPublisher) PublishScanPart(_ context.Context, job ScanPartJob) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.parts = append(p.parts, job)
	return nil
}

func (p *recordingScanPublisher) PublishScanAssemble(_ context.Context, job ScanAssembleJob) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.assembles = append(p.assembles, job)
	return nil
}
