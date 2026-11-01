package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestContributionOverviewPreservesPronounsAcrossFallback(t *testing.T) {
	for _, fallback := range []bool{false, true} {
		for _, pronouns := range []*string{nil, stringPointer(""), stringPointer("  they/them  "), stringPointer("she/her")} {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				var body struct {
					Query string `json:"query"`
				}
				if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				if fallback && strings.Contains(body.Query, "totalCommitContributions") {
					_, _ = w.Write([]byte(`{"errors":[{"type":"RESOURCE_LIMITS_EXCEEDED","message":"Resource limits exceeded"}]}`))
					return
				}
				user := map[string]any{"contributionsCollection": map[string]any{"contributionCalendar": map[string]any{"totalContributions": 20}}}
				if strings.Contains(body.Query, "pinnedItems") {
					if !strings.Contains(body.Query, "pronouns") {
						t.Error("overview query omits pronouns")
					}
					user["pronouns"] = pronouns
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"user": user}})
			}))
			client := NewGitHubClient("token").withBaseURL(server.URL).withHTTPClient(server.Client())
			overview, _, contributions, err := client.fetchContributionOverview(context.Background(), "alice")
			server.Close()
			if err != nil {
				t.Fatal(err)
			}
			want := strings.TrimSpace(valueOrString(pronouns, ""))
			if valueOrString(overview.Pronouns, "") != want || contributions != 20 {
				t.Fatalf("fallback=%v pronouns=%v overview=%#v contributions=%v", fallback, pronouns, overview, contributions)
			}
		}
	}
}
