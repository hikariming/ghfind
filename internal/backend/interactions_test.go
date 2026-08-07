package backend

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func openInteractionTestStore(t *testing.T) *TursoStore {
	t.Helper()
	store, err := OpenTursoStore(Config{TursoURL: "file:" + filepath.Join(t.TempDir(), "interactions.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	for _, statement := range []string{
		`CREATE TABLE scores (username TEXT PRIMARY KEY, display_name TEXT, avatar_url TEXT, final_score REAL, tier TEXT, score_version TEXT, hidden INTEGER NOT NULL DEFAULT 0, prev_score REAL, prev_scanned_at INTEGER)`,
		`CREATE TABLE score_snapshots (id TEXT PRIMARY KEY, username TEXT NOT NULL, final_score REAL NOT NULL, generated_at INTEGER NOT NULL)`,
		`CREATE TABLE follows (follower_github_id INTEGER NOT NULL, target_username TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (follower_github_id, target_username))`,
		`CREATE TABLE profile_comments (id TEXT PRIMARY KEY, target_username TEXT NOT NULL, body TEXT NOT NULL, author_kind TEXT NOT NULL, author_github_id INTEGER, author_login TEXT, author_avatar_url TEXT, created_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE blog_comments (id TEXT PRIMARY KEY, post_slug TEXT NOT NULL, body TEXT NOT NULL, author_kind TEXT NOT NULL, author_github_id INTEGER, author_login TEXT, author_avatar_url TEXT, created_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE profile_reactions (target_username TEXT NOT NULL, voter_github_id INTEGER NOT NULL, voter_login TEXT NOT NULL, reaction TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (target_username, voter_github_id))`,
	} {
		if _, err := store.db.Exec(statement); err != nil {
			t.Fatalf("create interactions schema: %v", err)
		}
	}
	return store
}

func TestInteractionStorePreservesCommentReactionAndFollowContracts(t *testing.T) {
	store := openInteractionTestStore(t)
	ctx := context.Background()
	now := time.Unix(1_700_000_000, 0).UTC()
	masked := normalizeCommentText("  你好\n习近平  ")
	if masked != "你好 ***" {
		t.Fatalf("masked comment=%q", masked)
	}
	anonymous, err := store.CreateProfileComment(ctx, "octocat", masked, CommentAuthor{Type: "anonymous"}, nil, now)
	if err != nil || anonymous.Author.Type != "anonymous" {
		t.Fatalf("anonymous comment=%#v err=%v", anonymous, err)
	}
	avatar := "https://avatars.example/alice"
	githubID := int64(7)
	github, err := store.CreateProfileComment(ctx, "octocat", "ship it", CommentAuthor{Type: "github", Username: "alice", AvatarURL: &avatar}, &githubID, now)
	if err != nil || github.Author.Username != "alice" {
		t.Fatalf("github comment=%#v err=%v", github, err)
	}
	comments, err := store.ListProfileComments(ctx, "octocat")
	if err != nil || len(comments) != 2 || comments[0].ID != anonymous.ID || comments[1].ID != github.ID {
		t.Fatalf("ordered comments=%#v err=%v", comments, err)
	}

	if _, err := store.SetProfileReaction(ctx, "octocat", 7, "alice", ReactionLike, now); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetProfileReaction(ctx, "octocat", 8, "bob", ReactionPoop, now); err != nil {
		t.Fatal(err)
	}
	state, err := store.SetProfileReaction(ctx, "octocat", 7, "alice-renamed", ReactionFire, now)
	if err != nil || state.Counts != (ProfileReactionCounts{Poop: 1, Fire: 1}) || state.ViewerReaction == nil || *state.ViewerReaction != ReactionFire {
		t.Fatalf("replaced reaction=%#v err=%v", state, err)
	}
	state, err = store.RemoveProfileReaction(ctx, "octocat", 7)
	if err != nil || state.Counts != (ProfileReactionCounts{Poop: 1}) || state.ViewerReaction != nil {
		t.Fatalf("removed reaction=%#v err=%v", state, err)
	}

	for index := 0; index < maxFollows; index++ {
		result, err := store.SetFollow(ctx, 99, "watched-"+strings.Repeat("x", 1)+string(rune('a'+index%26))+string(rune('a'+index/26)), now)
		if err != nil || result != followWriteOK {
			t.Fatalf("follow %d result=%q err=%v", index, result, err)
		}
	}
	result, err := store.SetFollow(ctx, 99, "one-too-many", now)
	if err != nil || result != followWriteLimit {
		t.Fatalf("follow limit result=%q err=%v", result, err)
	}
}

func TestInteractionHTTPUsesSignedSessionAndExistingResponseContract(t *testing.T) {
	store := openInteractionTestStore(t)
	now := time.Unix(1_700_000_000, 0).UTC()
	server := NewAPIServer(Config{AuthSecret: "test-secret"}, store, &fakeStatusStore{}, &fakePublisher{})
	server.clock = func() time.Time { return now }
	session := OAuthSession{GitHubID: 42, Login: "Alice", AvatarURL: "https://avatars.example/alice", ExpiresAt: now.Add(time.Hour).UnixMilli()}
	encoded, err := server.encodeSignedPayload("session", session)
	if err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: oauthSessionCookie, Value: encoded}

	request := httptest.NewRequest(http.MethodGet, "/api/follows/alice", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"signedIn":false`) {
		t.Fatalf("anonymous follow probe status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPut, "/api/follows/octocat", nil)
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"following":true`) {
		t.Fatalf("signed follow status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/api/profile-comments/octocat", strings.NewReader(`{"text":"hello","anonymous":false}`))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"username":"alice"`) {
		t.Fatalf("signed comment status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPut, "/api/profile-reactions/octocat", strings.NewReader(`{"reaction":"fire"}`))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"viewerReaction":"fire"`) {
		t.Fatalf("reaction status=%d body=%s", response.Code, response.Body.String())
	}
}
