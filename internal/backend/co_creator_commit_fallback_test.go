package backend

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestCoCreatorCommitAuthorFallback(t *testing.T) {
	for _, mode := range []string{"empty-index", "nonempty", "error", "no-match"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path != "/repos/org/tool/commits" {
					t.Errorf("unexpected path %s", r.URL.Path)
				}
				if calls == 1 {
					if r.URL.Query().Get("author") != "renamed" || r.URL.Query().Get("per_page") != "3" {
						t.Error("unbounded primary query")
					}
					if mode == "error" {
						w.WriteHeader(404)
						fmt.Fprint(w, `{}`)
						return
					}
					if mode == "nonempty" {
						fmt.Fprint(w, `[{"sha":"known"}]`)
						return
					}
					fmt.Fprint(w, `[]`)
					return
				}
				if r.URL.Query().Has("author") || r.URL.Query().Get("per_page") != "30" {
					t.Error("unbounded fallback query")
				}
				if mode == "no-match" {
					fmt.Fprint(w, `[]`)
					return
				}
				fmt.Fprint(w, `[
     {"sha":"other","author":{"login":"someone"},"committer":{"login":"renamed"}},
     {"sha":"unlinked","author":null,"commit":{"author":{"name":"renamed","email":"renamed@example.com"}}},
     {"sha":"mine1","author":{"login":"Renamed"}},
     {"sha":"mine2","author":{"login":"renamed"}},
     {"sha":"mine3","author":{"login":"renamed"}},
     {"sha":"mine4","author":{"login":"renamed"}}]`)
			}))
			defer server.Close()
			client := NewGitHubClient("fixture-token").withBaseURL(server.URL).withHTTPClient(server.Client())
			got := []string{}
			for _, c := range client.fetchCoCreatorCommits(context.Background(), "org", "tool", "renamed") {
				got = append(got, c.SHA)
			}
			want, wantCalls := []string{}, 1
			switch mode {
			case "empty-index":
				want, wantCalls = []string{"mine1", "mine2", "mine3"}, 2
			case "nonempty":
				want = []string{"known"}
			case "no-match":
				wantCalls = 2
			}
			if !reflect.DeepEqual(got, want) || calls != wantCalls {
				t.Fatalf("got %v / %d calls; want %v / %d", got, calls, want, wantCalls)
			}
		})
	}
}

func TestCoCreatorFactsRecoveredCommitsKeepSubstanceGates(t *testing.T) {
	for _, mode := range []string{"code", "docs", "merge", "truncated"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/graphql":
					fmt.Fprint(w, `{"data":{}}`)
				case "/repos/org/tool/contributors":
					fmt.Fprint(w, `[]`)
				case "/repos/org/tool/commits":
					if r.URL.Query().Has("author") {
						fmt.Fprint(w, `[]`)
						return
					}
					parents := `[{}]`
					if mode == "merge" {
						parents = `[{},{}]`
					}
					fmt.Fprintf(w, `[{"sha":"mine","author":{"login":"me"},"parents":%s}]`, parents)
				case "/repos/org/tool/commits/mine":
					path, total := "src/main.ts", 20
					if mode == "docs" {
						path = "README.md"
					}
					if mode == "truncated" {
						total = 200
					}
					fmt.Fprintf(w, `{"stats":{"total":%d},"files":[{"filename":%q,"additions":20,"deletions":0}]}`, total, path)
				default:
					t.Errorf("unexpected request: %s", r.URL)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			client := NewGitHubClient("fixture-token").withBaseURL(server.URL).withHTTPClient(server.Client())
			facts := client.collectCoCreatorFacts(context.Background(), ContribRepoAgg{Repo: "org/tool", Commits: 58, ActiveYears: 1}, "me")
			if mode == "code" {
				if facts.SubstantiveSamples != 1 || facts.CoreChurn != 20 {
					t.Fatalf("recovered code missing: %+v", facts)
				}
			} else if facts.SubstantiveSamples != 0 || facts.CoreChurn != 0 {
				t.Fatalf("invalid evidence counted: %+v", facts)
			}
		})
	}
}
