package backend

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWorkerHealthHandlerHealthz(t *testing.T) {
	server := httptest.NewServer(NewWorkerHealthHandler())
	defer server.Close()

	response, err := http.Get(server.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("healthz status = %d, want 200", response.StatusCode)
	}
	var body map[string]bool
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode healthz body: %v", err)
	}
	if !body["ok"] {
		t.Fatalf("healthz body = %v, want ok:true", body)
	}
}

func TestWorkerHealthHandlerReadyzAllHealthy(t *testing.T) {
	server := httptest.NewServer(NewWorkerHealthHandler(
		func(context.Context) error { return nil },
		func(context.Context) error { return nil },
	))
	defer server.Close()

	response, err := http.Get(server.URL + "/readyz")
	if err != nil {
		t.Fatalf("GET /readyz: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("readyz status = %d, want 200", response.StatusCode)
	}
	if cacheControl := response.Header.Get("Cache-Control"); cacheControl != "no-store" {
		t.Fatalf("readyz Cache-Control = %q, want no-store", cacheControl)
	}
}

func TestWorkerHealthHandlerReadyzFailsClosed(t *testing.T) {
	server := httptest.NewServer(NewWorkerHealthHandler(
		func(context.Context) error { return nil },
		func(context.Context) error { return errors.New("broker unreachable") },
	))
	defer server.Close()

	response, err := http.Get(server.URL + "/readyz")
	if err != nil {
		t.Fatalf("GET /readyz: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("readyz status = %d, want 503", response.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode readyz body: %v", err)
	}
	if body["error"] != "dependency_unavailable" {
		t.Fatalf("readyz error = %q, want dependency_unavailable", body["error"])
	}
}

func TestWorkerHealthHandlerReadyzTimesOut(t *testing.T) {
	server := httptest.NewServer(NewWorkerHealthHandler(
		func(ctx context.Context) error {
			<-ctx.Done()
			return ctx.Err()
		},
	))
	defer server.Close()

	start := time.Now()
	response, err := http.Get(server.URL + "/readyz")
	if err != nil {
		t.Fatalf("GET /readyz: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("readyz status = %d, want 503", response.StatusCode)
	}
	if elapsed := time.Since(start); elapsed > 6*time.Second {
		t.Fatalf("readyz took %v, want bounded by the 4s probe timeout", elapsed)
	}
}

func TestWorkerHealthHandlerRejectsOtherPaths(t *testing.T) {
	server := httptest.NewServer(NewWorkerHealthHandler())
	defer server.Close()

	for _, request := range []struct {
		method string
		path   string
		want   int
	}{
		{method: "POST", path: "/healthz", want: http.StatusMethodNotAllowed},
		{method: "GET", path: "/", want: http.StatusNotFound},
		{method: "GET", path: "/metrics", want: http.StatusNotFound},
	} {
		req, err := http.NewRequest(request.method, server.URL+request.path, nil)
		if err != nil {
			t.Fatalf("%s %s: %v", request.method, request.path, err)
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", request.method, request.path, err)
		}
		response.Body.Close()
		if response.StatusCode != request.want {
			t.Fatalf("%s %s status = %d, want %d", request.method, request.path, response.StatusCode, request.want)
		}
	}
}

func TestWorkerFeedReadinessIsIsolatedFromCoreReadiness(t *testing.T) {
	server := httptest.NewServer(NewWorkerHealthHandlerWithFeed(
		func(context.Context) error { return errors.New("Feed PostgreSQL unavailable") },
		func(context.Context) error { return nil },
	))
	defer server.Close()

	core, err := http.Get(server.URL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	core.Body.Close()
	if core.StatusCode != http.StatusOK {
		t.Fatalf("core readiness = %d, want 200", core.StatusCode)
	}
	feed, err := http.Get(server.URL + "/feed-readyz")
	if err != nil {
		t.Fatal(err)
	}
	feed.Body.Close()
	if feed.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("Feed readiness = %d, want 503", feed.StatusCode)
	}
}
