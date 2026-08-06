package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRoastCachePreservesNodeKeysTTLAndLockLifetime(t *testing.T) {
	commands := make(chan []json.RawMessage, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var command []json.RawMessage
		if err := json.NewDecoder(request.Body).Decode(&command); err != nil {
			t.Fatal(err)
		}
		commands <- command
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":"OK"}`))
	}))
	defer server.Close()
	store := &UpstashStatusStore{baseURL: server.URL, token: "token", client: server.Client()}
	if err := store.SetCachedRoast(context.Background(), "OctoCat", roastLanguageEN, CachedRoast{Report: "# report", Delta: 0}); err != nil {
		t.Fatal(err)
	}
	if acquired, err := store.TryAcquireRoastLock(context.Background(), "OctoCat", roastLanguageEN); err != nil || !acquired {
		t.Fatalf("acquired=%v err=%v", acquired, err)
	}
	if err := store.ClearCachedRoast(context.Background(), "OctoCat", roastLanguageEN); err != nil {
		t.Fatal(err)
	}

	setCache, setLock, clearCache := <-commands, <-commands, <-commands
	assertCommandString(t, setCache, 0, "SET")
	assertCommandString(t, setCache, 1, "roast:v10:v9:v4:en:octocat")
	assertCommandNumber(t, setCache, 4, 86400)
	assertCommandString(t, setLock, 0, "SET")
	assertCommandString(t, setLock, 1, "lock:roast:v10:v9:v4:en:octocat")
	assertCommandNumber(t, setLock, 5, 270)
	assertCommandString(t, clearCache, 0, "DEL")
	assertCommandString(t, clearCache, 1, "roast:v10:v9:v4:en:octocat")
}

func assertCommandString(t *testing.T, command []json.RawMessage, index int, want string) {
	t.Helper()
	var got string
	if len(command) <= index || json.Unmarshal(command[index], &got) != nil || got != want {
		t.Fatalf("command[%d]=%s want=%q", index, command[index], want)
	}
}

func assertCommandNumber(t *testing.T, command []json.RawMessage, index int, want int) {
	t.Helper()
	var got int
	if len(command) <= index || json.Unmarshal(command[index], &got) != nil || got != want {
		t.Fatalf("command[%d]=%s want=%d", index, command[index], want)
	}
}
