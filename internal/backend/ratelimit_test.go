package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestUpstashSlidingRateLimitUsesAtomicScriptAndHashedPrincipal(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer token" {
			t.Fatalf("Authorization=%q", request.Header.Get("Authorization"))
		}
		var command []json.RawMessage
		if err := json.NewDecoder(request.Body).Decode(&command); err != nil {
			t.Fatal(err)
		}
		var operation, key string
		if err := json.Unmarshal(command[0], &operation); err != nil || operation != "EVAL" {
			t.Fatalf("operation=%q err=%v", operation, err)
		}
		if err := json.Unmarshal(command[3], &key); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(key, "ghfind:backend:rate-limit:v1:scan:") || strings.Contains(key, "198.51.100.10") {
			t.Fatalf("key=%q", key)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":[1,9,1700000060000]}`))
	}))
	defer server.Close()
	store := &UpstashStatusStore{baseURL: server.URL, token: "token", client: server.Client()}
	result, err := store.LimitPublicRead(context.Background(), "198.51.100.10", now)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success || result.Limit != 10 || result.Remaining != 9 || !result.ResetAt.Equal(now.Add(time.Minute)) {
		t.Fatalf("result=%#v", result)
	}
}

func TestVerdictRateLimitReusesLegacyUpstashKeysAndBudgets(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	var mu sync.Mutex
	keys := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var command []json.RawMessage
		if err := json.NewDecoder(request.Body).Decode(&command); err != nil {
			t.Fatal(err)
		}
		var operation, current, previous string
		var keyCount, budget int
		if err := json.Unmarshal(command[0], &operation); err != nil || operation != "EVAL" {
			t.Fatalf("operation=%q err=%v", operation, err)
		}
		if err := json.Unmarshal(command[2], &keyCount); err != nil || keyCount != 3 {
			t.Fatalf("keyCount=%d err=%v", keyCount, err)
		}
		if err := json.Unmarshal(command[3], &current); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(command[4], &previous); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(command[6], &budget); err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(previous, ":"+strconv.FormatInt(now.UnixMilli()/time.Minute.Milliseconds()-1, 10)) && budget == 6 {
			t.Fatalf("minute previous key=%q", previous)
		}
		if !strings.Contains(current, "198.51.100.10") || (budget != 6 && budget != 40) {
			t.Fatalf("current=%q budget=%d", current, budget)
		}
		mu.Lock()
		keys = append(keys, current)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":[5,6]}`))
	}))
	defer server.Close()
	store := &UpstashStatusStore{baseURL: server.URL, token: "token", client: server.Client()}
	result, err := store.LimitVerdict(context.Background(), "198.51.100.10", now)
	if err != nil || !result.Success || result.Unavailable {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(keys) != 2 || !containsPrefix(keys, "rl:verdict:m:198.51.100.10:") || !containsPrefix(keys, "rl:verdict:d:198.51.100.10:") {
		t.Fatalf("keys=%#v", keys)
	}
}

func TestMCPRateLimitReusesLegacyUpstashKeyAndBudget(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var command []json.RawMessage
		if err := json.NewDecoder(request.Body).Decode(&command); err != nil {
			t.Fatal(err)
		}
		var operation, current string
		var keyCount, budget int
		if err := json.Unmarshal(command[0], &operation); err != nil || operation != "EVAL" {
			t.Fatalf("operation=%q err=%v", operation, err)
		}
		if err := json.Unmarshal(command[2], &keyCount); err != nil || keyCount != 3 {
			t.Fatalf("keyCount=%d err=%v", keyCount, err)
		}
		if err := json.Unmarshal(command[3], &current); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(command[6], &budget); err != nil || budget != 15 {
			t.Fatalf("budget=%d err=%v", budget, err)
		}
		if !strings.HasPrefix(current, "rl:mcp:198.51.100.10:") {
			t.Fatalf("key=%q", current)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":[14,15]}`))
	}))
	defer server.Close()
	store := &UpstashStatusStore{baseURL: server.URL, token: "token", client: server.Client()}
	result, err := store.LimitMCP(context.Background(), "198.51.100.10", now)
	if err != nil || !result.Success || result.Limit != 15 || result.Remaining != 14 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
}

func containsPrefix(values []string, prefix string) bool {
	for _, value := range values {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
}

func TestRateLimitHeadersRetainsPublicAPIFields(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	headers := rateLimitHeaders(RateLimitResult{
		Success: false, Limit: 10, Remaining: 0, ResetAt: now.Add(35 * time.Second),
	}, now)
	if headers["RateLimit-Limit"] != "10" || headers["RateLimit-Remaining"] != "0" || headers["RateLimit-Reset"] != "35" || headers["Retry-After"] != "35" {
		t.Fatalf("headers=%#v", headers)
	}
	if got := rateLimitHeaders(RateLimitResult{Unavailable: true}, now); got["Retry-After"] != "15" {
		t.Fatalf("unavailable headers=%#v", got)
	}
}
