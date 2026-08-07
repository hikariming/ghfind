package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGitHubCollectorBuildsGoNativeScanResult(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if request.URL.Path == "/users/alice" {
			_, _ = w.Write([]byte(`{"login":"alice","id":1,"html_url":"https://github.com/alice","created_at":"2020-01-01T00:00:00Z","followers":100,"following":10,"public_repos":1,"bio":"builder"}`))
			return
		}
		if request.URL.Path == "/users/alice/repos" {
			_, _ = w.Write([]byte(`[{"name":"project","full_name":"alice/project","fork":false,"size":250,"stargazers_count":40,"forks_count":4,"open_issues_count":3,"language":"Go","description":"A useful service for testing","pushed_at":"2026-07-30T00:00:00Z"}]`))
			return
		}
		if request.URL.Path == "/users/alice/events/public" {
			_, _ = w.Write([]byte(`[{"created_at":"2026-08-01T00:00:00Z"}]`))
			return
		}
		if request.URL.Path == "/repos/alice/project/readme" {
			_, _ = w.Write([]byte(`{"path":"README.md","size":45,"encoding":"base64","content":"SW5zdGFsbCBhbmQgdXNhZ2UuIEFQSSBkZXNpZ24gdGVzdHMu"}`))
			return
		}
		if request.URL.Path == "/repos/alice/project/languages" {
			_, _ = w.Write([]byte(`{"Go":2000}`))
			return
		}
		if request.URL.Path != "/graphql" {
			t.Errorf("unexpected request %s", request.URL)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body struct {
			Query string `json:"query"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		var data string
		switch {
		case strings.Contains(body.Query, "commitContributionsByRepository"):
			data = `{"user":{"y0":{"commitContributionsByRepository":[]}}}`
		case strings.Contains(body.Query, "organizations(first: 20)"):
			data = `{"user":{"organizations":{"nodes":[]}}}`
		case strings.Contains(body.Query, "labels(first: 20)"):
			data = `{"user":{"pullRequests":{"nodes":[]}}}`
		case strings.Contains(body.Query, "states: MERGED, after"):
			data = `{"user":{"pullRequests":{"nodes":[{"repository":{"nameWithOwner":"popular/project","stargazerCount":20000,"isPrivate":false,"isFork":false,"owner":{"login":"popular"}}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}`
		case strings.Contains(body.Query, "hasIssuesEnabled"):
			data = `{"repository":{"stargazerCount":40,"hasIssuesEnabled":true,"isMirror":false,"watchers":{"totalCount":2},"issues":{"totalCount":3},"pullRequests":{"totalCount":4}}}`
		case strings.Contains(body.Query, "issues(states: OPEN)"):
			data = `{"r0":{"issues":{"totalCount":3}}}`
		case strings.Contains(body.Query, "files(first: 50)"):
			data = `{"user":{"pullRequests":{"nodes":[{"title":"fix worker","additions":20,"deletions":3,"changedFiles":2,"repository":{"nameWithOwner":"upstream/framework","stargazerCount":1000,"isPrivate":false},"files":{"nodes":[{"path":"internal/worker.go"}]}}]}}}`
		case strings.Contains(body.Query, "pullRequests(first: $count, orderBy"):
			data = `{"user":{"pullRequests":{"nodes":[{"title":"fix worker","repository":{"nameWithOwner":"upstream/framework"}}]}}}`
		case strings.Contains(body.Query, "totalCommitContributions"):
			data = `{"user":{"pinnedItems":{"nodes":[]},"mergedPRs":{"totalCount":480},"allPRs":{"totalCount":480},"closedPRs":{"totalCount":0,"nodes":[]},"issues":{"totalCount":2},"contributionYears":{"contributionYears":[2025]},"contributionsCollection":{"totalCommitContributions":1,"totalPullRequestContributions":1,"totalIssueContributions":1,"totalPullRequestReviewContributions":0,"contributionCalendar":{"totalContributions":50}}}}`
		default:
			t.Errorf("unhandled GraphQL query: %s", body.Query)
			data = `{}`
		}
		_, _ = w.Write([]byte(`{"data":` + data + `}`))
	}))
	defer server.Close()
	collector := NewGitHubCollector(NewGitHubClient("token").withBaseURL(server.URL).withHTTPClient(server.Client()))
	collector.clock = func() time.Time { return time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC) }
	scan, err := collector.Collect(context.Background(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	if scan.Metrics.Username != "alice" || scan.Metrics.MergedPRCount != 480 || scan.Metrics.RecentMergedPRSample != 1 || scan.Metrics.DaysSinceLastActivity == nil || *scan.Metrics.DaysSinceLastActivity != 2 {
		t.Fatalf("unexpected metrics: %#v", scan.Metrics)
	}
	if !scan.Metrics.MergedPRContributionAggregationIncomplete || scan.Metrics.ImpactPRCount != 1 {
		t.Fatalf("bounded merged-PR evidence was not preserved: %#v", scan.Metrics)
	}
	if len(scan.TopRepos) != 1 || scan.TopRepos[0].Readme == nil || scan.Scoring.FinalScore <= 0 || scan.Scoring.FinalScore != Score(scan.Metrics).FinalScore {
		t.Fatalf("scan is not a Go-native deterministic result: %#v", scan)
	}
}
