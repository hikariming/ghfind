package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestFeedRateLimitReusesLegacyUpstashKeysAndBudgets(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	for _, tc := range []struct {
		kind   string
		budget int
	}{{"read", 60}, {"events", 120}, {"write", 20}} {
		t.Run(tc.kind, func(t *testing.T) {
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
				if err := json.Unmarshal(command[6], &budget); err != nil || budget != tc.budget {
					t.Fatalf("budget=%d err=%v", budget, err)
				}
				bucket := now.UnixMilli() / time.Minute.Milliseconds()
				if current != "rl:feed:"+tc.kind+":42:"+strconv.FormatInt(bucket, 10) || !strings.HasSuffix(previous, ":"+strconv.FormatInt(bucket-1, 10)) {
					t.Fatalf("current=%q previous=%q", current, previous)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"result":[` + strconv.Itoa(tc.budget-1) + `,` + strconv.Itoa(tc.budget) + `]}`))
			}))
			defer server.Close()
			store := &UpstashStatusStore{baseURL: server.URL, token: "token", client: server.Client()}
			result, err := store.LimitFeed(context.Background(), 42, tc.kind, now)
			if err != nil || !result.Success || result.Limit != tc.budget || result.Remaining != tc.budget-1 {
				t.Fatalf("result=%#v err=%v", result, err)
			}
		})
	}
}

func TestFeedRateLimitRejectsExhaustedBudgetAndFailsClosedOnUpstashError(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	exhausted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"result":[-1,20]}`))
	}))
	defer exhausted.Close()
	store := &UpstashStatusStore{baseURL: exhausted.URL, token: "token", client: exhausted.Client()}
	result, err := store.LimitFeed(context.Background(), 42, "write", now)
	if err != nil || result.Success || result.Unavailable || result.Remaining != 0 {
		t.Fatalf("exhausted result=%#v err=%v", result, err)
	}

	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer broken.Close()
	store = &UpstashStatusStore{baseURL: broken.URL, token: "token", client: broken.Client()}
	result, err = store.LimitFeed(context.Background(), 42, "write", now)
	if err == nil || !result.Unavailable || result.Success {
		t.Fatalf("unavailable result=%#v err=%v", result, err)
	}
}
