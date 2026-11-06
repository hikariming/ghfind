package backend

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

// #621 asks that a plain 403, a 403 carrying Retry-After, a rate-limited 403,
// a 429 and a cancellation are not collapsed into one outcome. These cases pin
// what the errors.Is change does at the boundary of the request layer's retry
// budget (two attempts for a single-token pool, see request() in
// github_client.go).
func TestHydrateTopRepoEvidenceClassifiesRequestFailures(t *testing.T) {
	for _, scenario := range []struct {
		name           string
		status         int
		remaining      string
		retryAfter     string
		cancel         bool
		wantSentinel   error
		wantFirstReads int
		wantContinue   bool
	}{
		{
			name: "plain 403 skips the repository and continues", status: http.StatusForbidden,
			remaining: "4998", wantSentinel: ErrGitHubUnavailable, wantFirstReads: 1, wantContinue: true,
		},
		{
			name: "403 with Retry-After is retried then skipped", status: http.StatusForbidden,
			remaining: "4998", retryAfter: "0.01", wantSentinel: ErrGitHubUnavailable, wantFirstReads: 2, wantContinue: true,
		},
		{
			name: "rate limited 403 aborts", status: http.StatusForbidden,
			remaining: "0", wantSentinel: ErrGitHubRateLimited, wantFirstReads: 2, wantContinue: false,
		},
		{
			name: "429 aborts", status: http.StatusTooManyRequests,
			remaining: "4998", wantSentinel: ErrGitHubRateLimited, wantFirstReads: 2, wantContinue: false,
		},
		{
			name: "cancellation aborts and is not swallowed", status: http.StatusForbidden,
			remaining: "4998", cancel: true, wantSentinel: context.Canceled, wantFirstReads: 0, wantContinue: false,
		},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			requested := map[string]int{}
			client := newEvidenceTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				requested[r.URL.Path]++
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("X-Ratelimit-Remaining", scenario.remaining)
				if scenario.retryAfter != "" {
					w.Header().Set("Retry-After", scenario.retryAfter)
				}
				switch r.URL.Path {
				case "/repos/alice/first/readme":
					w.WriteHeader(scenario.status)
					_, _ = w.Write([]byte(`{"message":"synthetic failure"}`))
				case "/repos/alice/second/readme":
					_, _ = w.Write([]byte(`{"path":"README.md","encoding":"base64","size":120,"content":"` + evidenceReadmeBase64 + `"}`))
				case "/repos/alice/second/languages":
					_, _ = w.Write([]byte(`{"TypeScript":800}`))
				default:
					w.WriteHeader(http.StatusNotFound)
					_, _ = w.Write([]byte(`{"message":"Not Found"}`))
				}
			})

			ctx := context.Background()
			if scenario.cancel {
				canceled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = canceled
			}
			repos := []TopRepo{
				{Name: "first", OwnerLogin: stringPointer("alice"), Stars: 40},
				{Name: "second", OwnerLogin: stringPointer("alice"), Stars: 20},
			}
			err := client.hydrateTopRepoEvidence(ctx, repos, "alice", 6)
			if got := requested["/repos/alice/first/readme"]; got != scenario.wantFirstReads {
				t.Errorf("first repository README requests = %d, want %d", got, scenario.wantFirstReads)
			}
			if scenario.wantContinue {
				if err != nil {
					t.Fatalf("collection should continue past this response, got %v", err)
				}
				if repos[1].Readme == nil {
					t.Error("later repository lost its evidence even though collection continued")
				}
				return
			}
			if !errors.Is(err, scenario.wantSentinel) {
				t.Fatalf("error = %v, want %v", err, scenario.wantSentinel)
			}
			if requested["/repos/alice/second/readme"] != 0 {
				t.Errorf("aborted scan requested later repositories: %v", requested)
			}
		})
	}
}
