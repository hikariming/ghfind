package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFirstCommitAttributionMatchesExistingNodeIdentity(t *testing.T) {
	repo := ContribRepoAgg{Repo: "org/tool", OwnerLogin: "org", Commits: 100, ActiveYears: 1}
	if got := ComputeOrgRepoAttribution(repo, nil, nil, true, false, "me", "other"); got != nil {
		t.Fatal("release alone must not establish identity")
	}
	got := ComputeOrgRepoAttribution(repo, nil, nil, true, false, "me", "me")
	if got == nil || got.Evidence[0] != "first commit author is me" {
		t.Fatalf("attribution %+v", got)
	}
	repo.IsFork = true
	if ComputeOrgRepoAttribution(repo, nil, nil, true, false, "me", "me") != nil {
		t.Fatal("fork attributed")
	}
	for _, tc := range []struct{ author, committer, email, want string }{
		{"author", "committer", "", "author"}, {"", "committer", "", "committer"},
		{"", "", "42+me@users.noreply.github.com", "me"}, {"", "", "me@example.com", ""},
	} {
		if got := resolveFirstCommitLogin(tc.author, tc.committer, tc.email, ""); got != tc.want {
			t.Fatalf("resolved %q, want %q", got, tc.want)
		}
	}
}

func TestFetchFirstCommitUsesPinnedHistoryAndRESTAuthor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/repos/org/tool/commits/first" {
			_, _ = w.Write([]byte(`{"author":{"login":"me"}}`))
			return
		}
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.Contains(body.Query, "totalCount") {
			_, _ = w.Write([]byte(`{"data":{"repository":{"isFork":false,"defaultBranchRef":{"target":{"oid":"tip","history":{"totalCount":100}}}}}}`))
			return
		}
		if body.Variables["after"] != "tip 98" {
			t.Errorf("cursor %+v", body.Variables)
		}
		_, _ = w.Write([]byte(`{"data":{"repository":{"defaultBranchRef":{"target":{"history":{"nodes":[{"oid":"first","author":{"email":"unlinked@example.com"},"committer":{"user":{"login":"other"}}}]}}}}}}`))
	}))
	defer server.Close()
	client := NewGitHubClient("token").withBaseURL(server.URL).withHTTPClient(server.Client())
	if got := client.fetchDefaultBranchFirstCommit(context.Background(), "org", "tool"); got != "me" {
		t.Fatalf("first login %q", got)
	}
}
