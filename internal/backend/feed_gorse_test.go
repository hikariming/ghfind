package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestGorseClientUsesAuthenticatedUpsertAndOverwriteFeedback(t *testing.T) {
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-API-Key") != "server-key" {
			t.Errorf("missing Gorse API key")
		}
		requests = append(requests, request.Method+" "+request.URL.Path)
		if request.Method == http.MethodPatch {
			http.Error(w, "missing", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if request.URL.Path == "/api/recommend/gh:42" {
			_ = json.NewEncoder(w).Encode([]string{"owner:repo"})
			return
		}
		_, _ = w.Write([]byte(`{"RowAffected":1}`))
	}))
	defer server.Close()
	client, err := NewGorseClient(Config{GorseBaseURL: server.URL, GorseServerAPIKey: "server-key"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := client.UpsertUser(ctx, GorseUser{UserID: "gh:42", Labels: map[string]any{"tags": []string{"a"}}}); err != nil {
		t.Fatal(err)
	}
	if err := client.UpsertItem(ctx, GorseItem{ItemID: "owner:repo", Labels: map[string]any{}, Timestamp: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if err := client.PutFeedback(ctx, []GorseFeedback{{FeedbackType: "save", UserID: "gh:42", ItemID: "owner:repo", Value: 1, Timestamp: time.Now()}}); err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteFeedback(ctx, "save", "gh:42", "owner:repo"); err != nil {
		t.Fatal(err)
	}
	items, err := client.Recommend(ctx, "gh:42", 100)
	if err != nil || len(items) != 1 {
		t.Fatalf("recommend=%v err=%v", items, err)
	}
	joined := strings.Join(requests, "|")
	for _, expected := range []string{"PATCH /api/user/gh:42", "POST /api/user", "PATCH /api/item/owner:repo", "POST /api/item", "PUT /api/feedback", "DELETE /api/feedback/save/gh:42/owner:repo"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing %q in %s", expected, joined)
		}
	}
}

func TestGorseIDsRejectRepositorySlash(t *testing.T) {
	if err := validateGorseID("owner/repo"); err == nil {
		t.Fatal("slash should be rejected")
	}
}

func TestGorseClientIntegration(t *testing.T) {
	baseURL := os.Getenv("FEED_TEST_GORSE_URL")
	if baseURL == "" {
		t.Skip("FEED_TEST_GORSE_URL is not set")
	}
	client, err := NewGorseClient(Config{GorseBaseURL: baseURL, GorseServerAPIKey: os.Getenv("FEED_TEST_GORSE_API_KEY")})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	userID := "gh:9988776655"
	itemID := "contract:project"
	_ = client.DeleteUser(ctx, userID)
	if err := client.UpsertUser(ctx, GorseUser{UserID: userID, Labels: map[string]any{"tags": []string{"domain:devtools"}}, Comment: "contract"}); err != nil {
		t.Fatal(err)
	}
	if err := client.UpsertItem(ctx, GorseItem{ItemID: itemID, Categories: []string{"micro_tool"}, Timestamp: time.Now().UTC(), Labels: map[string]any{"tags": []string{"domain:devtools"}, "embedding": []float64{1, 0}}}); err != nil {
		t.Fatal(err)
	}
	feedback := []GorseFeedback{
		{FeedbackType: "impression", UserID: userID, ItemID: itemID, Value: 1, Timestamp: time.Now().UTC()},
		{FeedbackType: "save", UserID: userID, ItemID: itemID, Value: 1, Timestamp: time.Now().UTC()},
		{FeedbackType: "not_interested", UserID: userID, ItemID: itemID, Value: -1, Timestamp: time.Now().UTC()},
	}
	if err := client.PutFeedback(ctx, feedback); err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteFeedback(ctx, "save", userID, itemID); err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteFeedback(ctx, "not_interested", userID, itemID); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Recommend(ctx, userID, 10); err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteUser(ctx, userID); err != nil {
		t.Fatal(err)
	}
}
