package backend

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A plain 403 (no Retry-After, X-Ratelimit-Remaining != 0) wraps
// ErrGitHubUnavailable. hydrateTopRepoEvidence used direct comparison, which
// cannot match that sentinel and aborted the remaining candidate repositories.

func newEvidenceTestClient(t *testing.T, handler http.HandlerFunc) *GitHubClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return NewGitHubClient("token").withBaseURL(server.URL).withHTTPClient(server.Client())
}

// base64 of a README carrying install/usage/api/testing signals, so the hydrated
// repository has real parsed features rather than an empty document.
const evidenceReadmeBase64 = "IyBFeGFtcGxlCgpBIHNtYWxsIGxpYnJhcnkuCgojIyBJbnN0YWxsCgpgYGBiYXNoCm5wbSBpIGV4YW1wbGUKYGBgCgojIyBVc2FnZQoKU2VlIHRoZSBkZW1vLgoKIyMgQVBJCgphcGkgc3VyZmFjZQoKIyMgVGVzdGluZwoKcnVuIHRlc3RzCg=="

func TestHydrateTopRepoEvidenceContinuesAfterPlainForbidden(t *testing.T) {
	requested := map[string]int{}
	client := newEvidenceTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		requested[r.URL.Path]++
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Ratelimit-Remaining", "4998")
		switch {
		// The first repository's README is forbidden on every attempt.
		case r.URL.Path == "/repos/alice/first/readme":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"Forbidden","documentation_url":"https://docs.github.com"}`))
		case r.URL.Path == "/repos/alice/first/languages":
			_, _ = w.Write([]byte(`{"Go":1200}`))
		case r.URL.Path == "/repos/alice/first/contents":
			_, _ = w.Write([]byte(`[{"name":"main.go"}]`))
		case r.URL.Path == "/repos/alice/second/readme":
			_, _ = w.Write([]byte(`{"path":"README.md","encoding":"base64","size":120,"content":"` + evidenceReadmeBase64 + `"}`))
		case r.URL.Path == "/repos/alice/second/languages":
			_, _ = w.Write([]byte(`{"TypeScript":800}`))
		case r.URL.Path == "/repos/alice/second/contents":
			_, _ = w.Write([]byte(`[{"name":"src"}]`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
		}
	})

	repos := []TopRepo{
		{Name: "first", OwnerLogin: stringPointer("alice"), Stars: 40},
		{Name: "second", OwnerLogin: stringPointer("alice"), Stars: 20},
	}
	if err := client.hydrateTopRepoEvidence(context.Background(), repos, "alice", 6); err != nil {
		t.Fatalf("hydrateTopRepoEvidence returned error: %v", err)
	}

	// The forbidden README must not stop the loop: the second repository still gets
	// its README, languages and root listing.
	if requested["/repos/alice/second/readme"] == 0 {
		t.Errorf("second repository README was never requested; paths seen = %v", requested)
	}
	if repos[1].Readme == nil {
		t.Fatalf("second repository lost its README despite only the first being forbidden")
	}
	if len(repos[1].Languages) != 1 || repos[1].Languages[0].Name != "TypeScript" {
		t.Errorf("second repository languages = %#v", repos[1].Languages)
	}
	if len(repos[1].RootPaths) != 1 || repos[1].RootPaths[0] != "src" {
		t.Errorf("second repository root paths = %#v", repos[1].RootPaths)
	}
	// The degraded repository keeps its other evidence and simply has no README.
	if repos[0].Readme != nil {
		t.Errorf("first repository should have no README, got %#v", repos[0].Readme)
	}
	if len(repos[0].Languages) != 1 {
		t.Errorf("first repository languages = %#v, want the languages call to have succeeded", repos[0].Languages)
	}
}

func TestHydrateTopRepoEvidenceContinuesAfterForbiddenLanguages(t *testing.T) {
	client := newEvidenceTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Ratelimit-Remaining", "4998")
		switch r.URL.Path {
		case "/repos/alice/first/readme", "/repos/alice/second/readme":
			_, _ = w.Write([]byte(`{"path":"README.md","encoding":"base64","size":120,"content":"` + evidenceReadmeBase64 + `"}`))
		case "/repos/alice/first/languages":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"Forbidden"}`))
		case "/repos/alice/second/languages":
			_, _ = w.Write([]byte(`{"TypeScript":800}`))
		default:
			_, _ = w.Write([]byte(`[]`))
		}
	})

	repos := []TopRepo{{Name: "first", OwnerLogin: stringPointer("alice")}, {Name: "second", OwnerLogin: stringPointer("alice")}}
	if err := client.hydrateTopRepoEvidence(context.Background(), repos, "alice", 6); err != nil {
		t.Fatalf("a plain languages 403 must not abort later evidence: %v", err)
	}
	if repos[1].Readme == nil || len(repos[1].Languages) != 1 {
		t.Fatalf("second repository was not hydrated: %#v", repos[1])
	}
	if len(repos[0].Languages) != 0 || repos[0].Readme == nil {
		t.Fatalf("forbidden languages should retain the README and omit languages: %#v", repos[0])
	}
}

func TestHydrateTopRepoEvidenceStillAbortsOnRateLimit(t *testing.T) {
	requested := map[string]int{}
	client := newEvidenceTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		requested[r.URL.Path]++
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/repos/alice/first/readme" {
			// A real rate-limit signal: remaining == 0. This is ErrGitHubRateLimited,
			// not ErrGitHubUnavailable, and must still stop collection.
			w.Header().Set("X-Ratelimit-Remaining", "0")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"API rate limit exceeded"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	})

	repos := []TopRepo{
		{Name: "first", OwnerLogin: stringPointer("alice"), Stars: 40},
		{Name: "second", OwnerLogin: stringPointer("alice"), Stars: 20},
	}
	err := client.hydrateTopRepoEvidence(context.Background(), repos, "alice", 6)
	if !errors.Is(err, ErrGitHubRateLimited) {
		t.Fatalf("expected ErrGitHubRateLimited after retries, got %v", err)
	}
	if requested["/repos/alice/first/readme"] != 2 {
		t.Errorf("primary rate-limit response should be retried once, got %d requests", requested["/repos/alice/first/readme"])
	}
	if requested["/repos/alice/second/readme"] != 0 {
		t.Errorf("rate limited pool should abort, but later repos were requested: %v", requested)
	}
}

func TestHydrateTopRepoEvidenceTreatsMissingReadmeAsAbsent(t *testing.T) {
	// 404 is returned unwrapped as ErrGitHubAccountNotFound and means "no README".
	// It must stay non-fatal after the errors.Is change.
	client := newEvidenceTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/alice/first/readme":
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
		case "/repos/alice/first/languages":
			_, _ = w.Write([]byte(`{"Go":10}`))
		case "/repos/alice/first/contents":
			_, _ = w.Write([]byte(`[]`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
		}
	})
	repos := []TopRepo{{Name: "first", OwnerLogin: stringPointer("alice"), Stars: 1}}
	if err := client.hydrateTopRepoEvidence(context.Background(), repos, "alice", 6); err != nil {
		t.Fatalf("a missing README must not abort collection: %v", err)
	}
	if repos[0].Readme != nil {
		t.Errorf("expected no README, got %#v", repos[0].Readme)
	}
	if valueOrString(repos[0].ReadmeExcerpt, "") != "" {
		t.Errorf("expected empty README excerpt, got %q", valueOrString(repos[0].ReadmeExcerpt, ""))
	}
}
