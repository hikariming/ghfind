package backend

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestCollectOrganizationMaintainedReposRequiresLocalProofAndLeavesScoreUntouched(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path + "?" + request.URL.RawQuery {
		case "/repos/org/controller?":
			_, _ = writer.Write([]byte(`{"name":"controller","full_name":"org/controller","fork":false,"private":false,"size":120,"stargazers_count":30,"forks_count":2,"open_issues_count":1,"language":"Go","description":"A Go controller","owner":{"login":"org","type":"Organization"}}`))
		case "/repos/org/controller/releases?per_page=10", "/repos/org/controller/tags?per_page=5":
			_, _ = writer.Write([]byte(`[]`))
		case "/repos/org/controller/contents/MAINTAINERS?":
			_, _ = writer.Write([]byte(`{"content":"YWxpY2UK","encoding":"base64"}`))
		case "/repos/org/controller/languages?":
			_, _ = writer.Write([]byte(`{"Go":100}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`{"message":"Not Found"}`))
		}
	}))
	defer server.Close()

	client := NewGitHubClient("test-token").withBaseURL(server.URL).withHTTPClient(server.Client())
	metrics := RawMetrics{Username: "alice", Followers: 42, MergedPRCount: 10}
	before := Score(metrics)
	work := client.collectOrganizationMaintainedRepos(context.Background(), []ContribRepoAgg{
		{Repo: "org/controller", OwnerLogin: "org", Commits: 80, PRs: 12, ActiveYears: 3, Stars: 30},
		{Repo: "alice/private-score-input", OwnerLogin: "alice", Commits: 500, PRs: 50, ActiveYears: 5, Stars: 5000},
	}, "alice", stringPointer("https://github.com/alice"))

	if len(work) != 1 {
		t.Fatalf("work=%#v", work)
	}
	if repo := repoDisplayName(work[0].Repository); repo != "org/controller" {
		t.Fatalf("repo=%q", repo)
	}
	if len(work[0].Repository.Languages) != 1 || work[0].Repository.Languages[0].Name != "Go" {
		t.Fatalf("languages=%#v", work[0].Repository.Languages)
	}
	if !strings.Contains(strings.Join(work[0].Evidence, " "), "maintainer/codeowner") {
		t.Fatalf("evidence=%#v", work[0].Evidence)
	}

	// The evidence only lives in SignatureWork. Score consumes RawMetrics, so
	// attaching it cannot mutate the existing scoring chain.
	scan := ScanResult{Metrics: metrics, SignatureWork: SignatureWork{OrganizationMaintainedRepos: work}}
	if after := Score(scan.Metrics); !reflect.DeepEqual(after, before) {
		t.Fatalf("organization maintenance evidence changed score: before=%#v after=%#v", before, after)
	}
}
