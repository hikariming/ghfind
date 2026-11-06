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

// Second half of #621: a quick scan hydrates evidence twice - once for
// topRepos, once for personalOriginal - and then replaces each topRepos entry
// with the personalOriginal object wholesale. When the second pass loses the
// README and languages the first pass already fetched, the replacement drops
// evidence the scan had already collected: personalOriginal's copy never gets
// them, so the merge overwrites the hydrated candidate with empty fields.
func TestCollectKeepsFirstPassEvidenceWhenSecondPassIsForbidden(t *testing.T) {
	readmeRequests := 0
	languageRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case request.URL.Path == "/users/alice":
			_, _ = w.Write([]byte(`{"login":"alice","id":1,"html_url":"https://github.com/alice","created_at":"2020-01-01T00:00:00Z","followers":100,"following":10,"public_repos":1,"bio":"builder"}`))
		case request.URL.Path == "/users/alice/repos":
			_, _ = w.Write([]byte(`[{"name":"project","full_name":"alice/project","fork":false,"size":250,"stargazers_count":40,"forks_count":4,"open_issues_count":3,"language":"Go","description":"A useful service for testing","pushed_at":"2026-07-30T00:00:00Z"}]`))
		case request.URL.Path == "/users/alice/events/public":
			_, _ = w.Write([]byte(`[{"created_at":"2026-08-01T00:00:00Z"}]`))
		case request.URL.Path == "/repos/alice/project/readme":
			readmeRequests++
			if readmeRequests == 2 {
				// The second pass loses what the first pass already fetched:
				// a plain 403, not a rate limit, so collection continues.
				w.Header().Set("X-Ratelimit-Remaining", "4999")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"message":"Resource not accessible by integration"}`))
				return
			}
			_, _ = w.Write([]byte(`{"path":"README.md","size":45,"encoding":"base64","content":"SW5zdGFsbCBhbmQgdXNhZ2UuIEFQSSBkZXNpZ24gdGVzdHMu"}`))
		case request.URL.Path == "/repos/alice/project/languages":
			languageRequests++
			if languageRequests == 2 {
				// Same loss for languages: fetchRepoLanguages returns no
				// entries, and the helper assigns the field unconditionally.
				w.Header().Set("X-Ratelimit-Remaining", "4999")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"message":"Resource not accessible by integration"}`))
				return
			}
			_, _ = w.Write([]byte(`{"Go":2000}`))
		case strings.HasSuffix(request.URL.Path, "/contents"):
			_, _ = w.Write([]byte(`[{"name":"src"},{"name":"README.md"}]`))
		case request.URL.Path == "/repos/popular/project":
			w.WriteHeader(http.StatusNotFound)
		case request.URL.Path == "/repos/popular/project/languages":
			_, _ = w.Write([]byte(`{"Go":2000}`))
		case request.URL.Path == "/graphql":
			var body struct {
				Query string `json:"query"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			_, _ = w.Write([]byte(`{"data":` + collectorEvidenceGraphQL(t, body.Query) + `}`))
		default:
			t.Errorf("unexpected request %s", request.URL)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	collector := NewGitHubCollector(NewGitHubClient("token").withBaseURL(server.URL).withHTTPClient(server.Client()))
	collector.clock = func() time.Time { return time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC) }
	scan, err := collector.Collect(context.Background(), "alice")
	if err != nil {
		t.Fatalf("Collect returned error: %v", err)
	}
	if readmeRequests != 2 {
		t.Fatalf("expected the same repository to be hydrated in both passes, got %d README requests", readmeRequests)
	}
	// languageRequests is deliberately not pinned: without the errors.Is change
	// the second pass aborts at the README 403 and never asks for languages,
	// with it the languages call is made and skipped. Either way personalOriginal
	// ends up with no languages, which is what the merge must not act on.
	if len(scan.TopRepos) != 1 {
		t.Fatalf("unexpected candidates: %#v", scan.TopRepos)
	}
	// The first pass fetched this README, so the second pass' 403 must not
	// erase it from the final result.
	if scan.TopRepos[0].Readme == nil {
		t.Fatal("second-pass 403 discarded the README that the first pass had already collected")
	}
	if len(scan.TopRepos[0].Languages) != 1 {
		t.Errorf("languages = %#v, want the fetched Go entry to survive the merge", scan.TopRepos[0].Languages)
	}
	if scan.TopRepos[0].ContentSkillShare == nil {
		t.Error("content skill share is missing on the merged repository")
	}
}

// collectorEvidenceGraphQL answers the GraphQL queries the quick Collect path
// issues for the single-repository fixture above, using the same query markers
// as github_collector_test.go so the two fixtures stay readable together.
func collectorEvidenceGraphQL(t *testing.T, query string) string {
	t.Helper()
	switch {
	case strings.Contains(query, "query OriginalInventory"):
		return `{"user":{"forks":{"totalCount":0},"repositories":{"nodes":[{"name":"project","nameWithOwner":"alice/project","isFork":false,"diskUsage":250,"stargazerCount":40,"forkCount":4,"issues":{"totalCount":3},"primaryLanguage":{"name":"Go"},"description":"A useful service for testing","pushedAt":"2026-07-30T00:00:00Z"}],"pageInfo":{"hasNextPage":false}}}}`
	case strings.Contains(query, "type: ISSUE, first: $count"):
		return `{"search":{"issueCount":1,"nodes":[{"id":"PR_9","mergedAt":"2025-05-01T00:00:00Z","repository":{"nameWithOwner":"popular/project","stargazerCount":20000,"isPrivate":false,"isFork":false,"owner":{"login":"popular"}}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}`
	case strings.Contains(query, "CodeSamplePr"):
		return `{"s0":{"nodes":[{"title":"fix scheduler","additions":30,"deletions":2,"changedFiles":1,"repository":{"nameWithOwner":"popular/project","stargazerCount":20000,"isPrivate":false},"files":{"nodes":[{"path":"internal/scheduler.go"}]}}]}}`
	case strings.Contains(query, "commitContributionsByRepository"):
		return `{"user":{"y0":{"commitContributionsByRepository":[]}}}`
	case strings.Contains(query, "organizations(first: 20)"):
		return `{"user":{"organizations":{"nodes":[]}}}`
	case strings.Contains(query, "labels(first: 20)"):
		return `{"user":{"pullRequests":{"nodes":[]}}}`
	case strings.Contains(query, "states: MERGED, after"):
		return `{"user":{"pullRequests":{"nodes":[{"id":"PR_9","repository":{"nameWithOwner":"popular/project","stargazerCount":20000,"isPrivate":false,"isFork":false,"owner":{"login":"popular"}}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}`
	case strings.Contains(query, "hasIssuesEnabled"):
		return `{"repository":{"stargazerCount":40,"hasIssuesEnabled":true,"isMirror":false,"watchers":{"totalCount":2},"issues":{"totalCount":3},"pullRequests":{"totalCount":4}}}`
	case strings.Contains(query, "issues(states: OPEN)"):
		return `{"r0":{"issues":{"totalCount":3}}}`
	case strings.Contains(query, "files(first: 100)"):
		return `{"user":{"pullRequests":{"nodes":[{"title":"fix worker","additions":20,"deletions":3,"changedFiles":2,"repository":{"nameWithOwner":"upstream/framework","stargazerCount":1000,"isPrivate":false},"files":{"nodes":[{"path":"internal/worker.go"}]}}]}}}`
	case strings.Contains(query, "pullRequests(first: $count, orderBy"):
		return `{"user":{"pullRequests":{"nodes":[{"title":"fix worker","repository":{"nameWithOwner":"upstream/framework"}}]}}}`
	case strings.Contains(query, "totalCommitContributions"):
		return `{"user":{"pronouns":null,"pinnedItems":{"nodes":[]},"mergedPRs":{"totalCount":1},"allPRs":{"totalCount":1},"closedPRs":{"totalCount":0,"nodes":[]},"issues":{"totalCount":2},"contributionYears":{"contributionYears":[2025]},"contributionsCollection":{"totalCommitContributions":1,"totalPullRequestContributions":1,"totalIssueContributions":1,"totalPullRequestReviewContributions":0,"contributionCalendar":{"totalContributions":50}}}}`
	default:
		t.Errorf("unhandled GraphQL query: %s", query)
		return `{}`
	}
}
