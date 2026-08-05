package backend

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGitHubClientRotatesTokenAfterRetryableResponse(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		attempts++
		if attempts == 1 {
			if got := request.Header.Get("Authorization"); got != "Bearer first" {
				t.Errorf("first Authorization = %q", got)
			}
			w.Header().Set("X-Ratelimit-Remaining", "0")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if got := request.Header.Get("Authorization"); got != "Bearer second" {
			t.Errorf("second Authorization = %q", got)
		}
		_, _ = w.Write([]byte(`{"login":"alice","id":1}`))
	}))
	defer server.Close()
	client := NewGitHubClient("first,second").withBaseURL(server.URL).withHTTPClient(server.Client())
	user, err := client.GetUser(context.Background(), "alice")
	if err != nil || user.Login != "alice" || attempts != 2 {
		t.Fatalf("user=%#v err=%v attempts=%d", user, err, attempts)
	}
}

func TestGitHubClientClassifiesGraphQLResourceLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"errors":[{"type":"RESOURCE_LIMITS_EXCEEDED","message":"too expensive"}]}`))
	}))
	defer server.Close()
	client := NewGitHubClient("token").withBaseURL(server.URL).withHTTPClient(server.Client())
	var data struct{}
	err := client.graphql(context.Background(), "query { viewer { login } }", nil, &data)
	if !errors.Is(err, ErrGitHubResourceLimit) {
		t.Fatalf("error = %v, want resource limit", err)
	}
}

func TestGitHubClientRotatesThroughEveryPoolToken(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		seen = append(seen, request.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"login":"alice","id":1}`))
	}))
	defer server.Close()
	client := NewGitHubClient("t1, t2,,t3,t4 , t5").withBaseURL(server.URL).withHTTPClient(server.Client())
	for i := 0; i < 5; i++ {
		if _, err := client.GetUser(context.Background(), "alice"); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	want := []string{"Bearer t1", "Bearer t2", "Bearer t3", "Bearer t4", "Bearer t5"}
	if len(seen) != len(want) {
		t.Fatalf("requests = %d, want %d", len(seen), len(want))
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Fatalf("request %d Authorization = %q, want %q (all pool tokens must be used)", i, seen[i], want[i])
		}
	}
}

func TestGitHubClientSingleTokenStillRetriesTransientFailure(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		attempts++
		if got := request.Header.Get("Authorization"); got != "Bearer solo" {
			t.Errorf("Authorization = %q, want the single pool token on every attempt", got)
		}
		if attempts == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"login":"alice","id":1}`))
	}))
	defer server.Close()
	client := NewGitHubClient("solo").withBaseURL(server.URL).withHTTPClient(server.Client())
	user, err := client.GetUser(context.Background(), "alice")
	if err != nil || user.Login != "alice" {
		t.Fatalf("user=%#v err=%v", user, err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want a same-token retry for a transient 502", attempts)
	}
}
