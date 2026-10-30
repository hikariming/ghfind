package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func fictionGitHub(t *testing.T, originals int, openPRs ...int) (*GitHubCollector, *atomic.Int32) {
	t.Helper()
	active, peak := &atomic.Int32{}, &atomic.Int32{}
	openPRCount := 0
	if len(openPRs) > 0 {
		openPRCount = openPRs[0]
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		login := strings.TrimPrefix(r.URL.Path, "/users/")
		if strings.HasPrefix(r.URL.Path, "/users/") && !strings.Contains(login, "/") {
			forks := 0
			if login == "fiction-highfork" {
				forks = 500
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"login": login, "id": 900001, "public_repos": originals + forks, "created_at": "2020-01-01T00:00:00Z", "followers": 100, "following": 10, "bio": "Fictional builder"})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/events/public") {
			fmt.Fprint(w, `[{"created_at":"2026-08-01T00:00:00Z"}]`)
			return
		}
		if r.URL.Path != "/graphql" {
			w.WriteHeader(404)
			fmt.Fprint(w, `{}`)
			return
		}
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		query := body.Query
		var data any
		switch {
		case strings.Contains(query, "query OriginalInventory"):
			if !strings.Contains(query, "isFork: false") || !strings.Contains(query, "ownerAffiliations: [OWNER]") {
				t.Error("inventory must exclude forks server-side")
			}
			start, _ := strconv.Atoi(fmt.Sprint(body.Variables["after"]))
			end := start + githubPageSize
			if end > originals {
				end = originals
			}
			nodes := []any{}
			for i := start; i < end; i++ {
				size, stars := 0, 0
				if i < 2 {
					size = 250
					stars = 40
				}
				nodes = append(nodes, map[string]any{"name": fmt.Sprintf("fiction-original-%d", i), "nameWithOwner": fmt.Sprintf("%s/fiction-original-%d", body.Variables["login"], i), "diskUsage": size, "stargazerCount": stars, "forkCount": 4, "description": "Fictional service", "pushedAt": "2026-07-30T00:00:00Z", "primaryLanguage": map[string]any{"name": "Go"}, "issues": map[string]any{"totalCount": 3}, "openPullRequests": map[string]any{"totalCount": openPRCount}})
			}
			forks := 0
			if body.Variables["login"] == "fiction-highfork" {
				forks = 500
			}
			data = map[string]any{"user": map[string]any{"forks": map[string]any{"totalCount": forks}, "repositories": map[string]any{"nodes": nodes, "pageInfo": map[string]any{"hasNextPage": end < originals, "endCursor": strconv.Itoa(end)}}}}
		case strings.Contains(query, "totalCommitContributions"):
			data = json.RawMessage(`{"user":{"pinnedItems":{"nodes":[]},"mergedPRs":{"totalCount":0},"allPRs":{"totalCount":1},"closedPRs":{"totalCount":1,"nodes":[]},"issues":{"totalCount":2},"contributionYears":{"contributionYears":[2025]},"contributionsCollection":{"totalCommitContributions":20,"totalPullRequestContributions":0,"totalIssueContributions":2,"totalPullRequestReviewContributions":0,"contributionCalendar":{"totalContributions":22}}}}`)
		default:
			// Independent-source overlap is measured at the fake upstream, with no
			// real accounts/tokens or external services.
			if strings.Contains(query, "commitContributionsByRepository") || strings.Contains(query, "labels(first: 20)") || strings.Contains(query, "type: ISSUE, first: $count") || strings.Contains(query, "states: MERGED, after") {
				n := active.Add(1)
				for {
					old := peak.Load()
					if n <= old || peak.CompareAndSwap(old, n) {
						break
					}
				}
				defer active.Add(-1)
				time.Sleep(5 * time.Millisecond)
			}
			data = json.RawMessage(`{"user":{"y0":{"commitContributionsByRepository":[]},"pullRequests":{"nodes":[],"pageInfo":{"hasNextPage":false}},"organizations":{"nodes":[]}},"search":{"issueCount":0,"nodes":[],"pageInfo":{"hasNextPage":false}},"repository":null}`)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
	}))
	t.Cleanup(server.Close)
	collector := NewGitHubCollector(NewGitHubClient("fiction-token").withBaseURL(server.URL).withHTTPClient(server.Client()))
	collector.clock = func() time.Time { return time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC) }
	return collector, peak
}

func TestScanMVPFictionForkNeutrality(t *testing.T) {
	raw, err := os.ReadFile("testdata/scan-mvp-fiction.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Originals int
		HighForks int
		LowForks  int
		HighLogin string
		LowLogin  string
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	collector, peak := fictionGitHub(t, fixture.Originals)
	quick, err := collector.Collect(context.Background(), fixture.HighLogin)
	if err != nil {
		t.Fatal(err)
	}
	if quick.Collection.Coverage != "partial_public" || !strings.Contains(strings.Join(quick.Collection.TruncationReasons, ","), "public_repos_quick_limit") {
		t.Fatalf("coverage=%+v", quick.Collection)
	}
	high, err := collector.CollectFull(context.Background(), fixture.HighLogin)
	if err != nil {
		t.Fatal(err)
	}
	low, err := collector.CollectFull(context.Background(), fixture.LowLogin)
	if err != nil {
		t.Fatal(err)
	}
	if high.Collection.Coverage != "complete_public" || low.Collection.Coverage != "complete_public" {
		t.Fatalf("full coverage: %+v %+v", high.Collection, low.Collection)
	}
	if high.Metrics.ForkRepoCount != float64(fixture.HighForks) || high.Metrics.FetchedRepoCount != 502 || high.Metrics.NonemptyOriginalRepoCount != 2 || high.Metrics.TotalStars != low.Metrics.TotalStars || high.Scoring.FinalScore > low.Scoring.FinalScore {
		t.Fatalf("high=%+v low=%+v", high.Metrics, low.Metrics)
	}
	mostlyForks := false
	for _, note := range high.Scoring.RiskNotes {
		if note.Flag == "mostly_forks" {
			mostlyForks = true
		}
	}
	if !mostlyForks {
		t.Fatal("fork risk footprint was erased")
	}
	if peak.Load() != 2 {
		t.Fatalf("independent source concurrency=%d, want 2", peak.Load())
	}
	t.Logf("fiction-highfork=%.1f fiction-lowfork=%.1f originals=2 forks=500/0", high.Scoring.FinalScore, low.Scoring.FinalScore)
}

func TestScanMVPFullInventoryBeyondQuick(t *testing.T) {
	collector, _ := fictionGitHub(t, quickRepoPages*githubPageSize+1, 2)
	quick, _, incomplete, err := collector.github.ownedOriginalInventory(context.Background(), "fiction-lowfork", false)
	if err != nil || !incomplete || len(quick) != quickRepoPages*githubPageSize {
		t.Fatalf("quick=%d incomplete=%v err=%v", len(quick), incomplete, err)
	}
	full, _, incomplete, err := collector.github.ownedOriginalInventory(context.Background(), "fiction-lowfork", true)
	if err != nil || incomplete || len(full) != quickRepoPages*githubPageSize+1 {
		t.Fatalf("full=%d incomplete=%v err=%v", len(full), incomplete, err)
	}
	if full[0].OpenIssuesCount != 5 {
		t.Fatal("inventory must preserve REST open issue + PR count")
	}
}

func TestScanMVPWorkerDeepensBeforePersisting(t *testing.T) {
	collector, _ := fictionGitHub(t, 2)
	store := openScanPersistenceStore(t)
	worker := NewScanWorker(Config{MaxAttempts: 5}, collector, store, &fakeStatusStore{}, &fakeScanPublisher{}, nil)
	job := ScanJob{ID: "fiction-full-job", Username: "fiction-highfork", RequestedAt: 1}
	disposition, reason := worker.process(context.Background(), job)
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("worker: %v %s", disposition, reason)
	}
	scan, err := store.GetCollectedScan(context.Background(), job.ID)
	if err != nil || scan == nil || scan.Collection == nil || scan.Collection.Mode != "full" || scan.Collection.Coverage != "complete_public" {
		t.Fatalf("scan=%+v err=%v", scan, err)
	}
	var coverage, collection string
	if err := store.db.QueryRow(`SELECT coverage, collection_version FROM public_scan_runs WHERE id = ?`, job.ID).Scan(&coverage, &collection); err != nil {
		t.Fatal(err)
	}
	if coverage != "complete_public" || collection != "v8" {
		t.Fatalf("stored coverage=%s collection=%s", coverage, collection)
	}
}

func TestScanMVPPartialPersistenceIsNotLabeledComplete(t *testing.T) {
	store := openScanPersistenceStore(t)
	scan := ScanResult{Metrics: RawMetrics{Username: "fiction-partial"}, Collection: &CollectionCoverage{Mode: "full", Coverage: "partial_public", TruncationReasons: []string{"workflow_unavailable"}}}
	scan.Scoring = Score(scan.Metrics)
	_, err := store.PersistCollectedScan(context.Background(), ScanJob{ID: "fiction-partial-job", Username: "fiction-partial"}, scan)
	if err != nil {
		t.Fatal(err)
	}
	var state, coverage, sources string
	if err := store.db.QueryRow(`SELECT state, coverage, source_status FROM public_scan_runs WHERE id = ?`, "fiction-partial-job").Scan(&state, &coverage, &sources); err != nil {
		t.Fatal(err)
	}
	if state != "partial_public" || coverage != "partial_public" || strings.Contains(sources, `"workflow_landings":"complete"`) {
		t.Fatalf("state=%s coverage=%s sources=%s", state, coverage, sources)
	}
}

func TestScanMVPCommitWindowDiscardsTruncatedParent(t *testing.T) {
	node := func(repo string, commits int) any {
		return map[string]any{"repository": map[string]any{"nameWithOwner": "fiction-org/" + repo, "stargazerCount": 1000, "owner": map[string]string{"login": "fiction-org"}}, "contributions": map[string]any{"totalCount": commits, "nodes": []any{}}}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Variables map[string]string `json:"variables"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		root := strings.HasPrefix(body.Variables["from0"], "2025-01-01") && strings.HasPrefix(body.Variables["to0"], "2025-12-31")
		nodes := []any{}
		if root {
			for i := 0; i < githubPageSize; i++ {
				nodes = append(nodes, node(fmt.Sprintf("truncated-parent-%d", i), 99))
			}
		} else if strings.HasPrefix(body.Variables["from0"], "2025-01-01") {
			nodes = append(nodes, node("shared", 2))
		} else {
			nodes = append(nodes, node("shared", 3), node("tail", 7))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"user": map[string]any{"y0": map[string]any{"commitContributionsByRepository": nodes}}}})
	}))
	defer server.Close()
	client := NewGitHubClient("fiction-token").withBaseURL(server.URL).withHTTPClient(server.Client())
	quickScope := &collectionScope{}
	_, err := client.fetchCommitContribReposByYear(context.Background(), "fiction-lowfork", []int{2025}, quickScope)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(quickScope.Reasons, ","), "commit_repository_cap") {
		t.Fatal("missing quick saturation")
	}
	fullScope := &collectionScope{Full: true}
	repos, err := client.fetchCommitContribReposByYear(context.Background(), "fiction-lowfork", []int{2025}, fullScope)
	if err != nil || len(repos) != 2 || repos[0].Repo != "fiction-org/shared" || repos[0].Commits != 5 || repos[0].ActiveYears != 1 || repos[1].Repo != "fiction-org/tail" || repos[1].Commits != 7 || len(fullScope.Reasons) != 0 {
		t.Fatalf("repos=%+v scope=%+v err=%v", repos, fullScope, err)
	}
}

func TestScanMVPCommitResourceLimitSubdividesInFullMode(t *testing.T) {
	node := func(repo string, commits int, stars int) any {
		return map[string]any{"repository": map[string]any{"nameWithOwner": "fiction-org/" + repo, "stargazerCount": stars, "owner": map[string]string{"login": "fiction-org"}}, "contributions": map[string]any{"totalCount": commits, "nodes": []any{}}}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Variables map[string]string `json:"variables"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		fullYear := strings.HasPrefix(body.Variables["from0"], "2026-01-01") && strings.HasPrefix(body.Variables["to0"], "2026-12-31")
		if fullYear {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"user": nil}, "errors": []any{map[string]any{"type": "RESOURCE_LIMITS_EXCEEDED", "message": "Resource limits for this query exceeded."}}})
			return
		}
		fromTime, _ := time.Parse(time.RFC3339, body.Variables["from0"])
		early := fromTime.Before(time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC))
		var nodes []any
		if early {
			nodes = []any{node("shared", 3, 1000), node("mega", 4, 230000)}
		} else {
			nodes = []any{node("shared", 2, 1000), node("tail", 7, 1000)}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"user": map[string]any{"y0": map[string]any{"commitContributionsByRepository": nodes}}}})
	}))
	defer server.Close()
	client := NewGitHubClient("fiction-token").withBaseURL(server.URL).withHTTPClient(server.Client())
	quickScope := &collectionScope{}
	quick, err := client.fetchCommitContribReposByYear(context.Background(), "fiction-hyperactive", []int{2026}, quickScope)
	if err != nil {
		t.Fatal(err)
	}
	if len(quick) != 0 || !strings.Contains(strings.Join(quickScope.Reasons, ","), "commit_resource_limit") {
		t.Fatalf("quick should note and drop year: repos=%+v reasons=%v", quick, quickScope.Reasons)
	}
	fullScope := &collectionScope{Full: true}
	repos, err := client.fetchCommitContribReposByYear(context.Background(), "fiction-hyperactive", []int{2026}, fullScope)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(fullScope.Reasons, ","), "commit_resource_limit") {
		t.Fatalf("full should not note resource limit after successful subdivision: %v", fullScope.Reasons)
	}
	if len(repos) != 3 {
		t.Fatalf("expected 3 repos, got %+v", repos)
	}
	byRepo := map[string]float64{}
	for _, r := range repos {
		byRepo[r.Repo] = r.Commits
	}
	if byRepo["fiction-org/mega"] != 4 || byRepo["fiction-org/shared"] != 5 || byRepo["fiction-org/tail"] != 7 {
		t.Fatalf("unexpected commits %+v", byRepo)
	}
}
