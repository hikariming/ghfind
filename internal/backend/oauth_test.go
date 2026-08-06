package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type fakeOAuthStore struct {
	fakeScoreStore
	session OAuthSession
	name    string
	calls   int
}

func (s *fakeOAuthStore) UpsertOAuthUser(_ context.Context, session OAuthSession, name string, _ time.Time) error {
	s.session, s.name, s.calls = session, name, s.calls+1
	return nil
}

func TestGitHubOAuthCallbackCreatesSignedGoSession(t *testing.T) {
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/login/oauth/access_token":
			if err := request.ParseForm(); err != nil || request.Form.Get("code") != "code-fixture" {
				t.Fatalf("token request form=%v err=%v", request.Form, err)
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "token-fixture"})
		case "/user":
			if request.Header.Get("Authorization") != "Bearer token-fixture" {
				t.Fatalf("authorization=%q", request.Header.Get("Authorization"))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 42, "login": "OctoCat", "name": "The Cat", "avatar_url": "https://avatars.example/octocat"})
		default:
			http.NotFound(w, request)
		}
	}))
	defer github.Close()

	store := &fakeOAuthStore{}
	server := NewAPIServer(Config{GitHubOAuthID: "client", GitHubOAuthSecret: "secret", AuthSecret: "auth-secret", PublicSiteURL: "https://ghfind.example"}, store, &fakeStatusStore{}, &fakePublisher{})
	server.githubOAuthOrigin = github.URL
	now := time.Unix(1_700_000_000, 0).UTC()
	server.clock = func() time.Time { return now }

	beginRequest := httptest.NewRequest(http.MethodGet, "/api/auth/github?callbackUrl=%2Fu%2Foctocat", nil)
	beginResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(beginResponse, beginRequest)
	if beginResponse.Code != http.StatusFound {
		t.Fatalf("begin status=%d body=%s", beginResponse.Code, beginResponse.Body.String())
	}
	authorize, err := url.Parse(beginResponse.Header().Get("Location"))
	githubOrigin, _ := url.Parse(github.URL)
	if err != nil || authorize.Host != githubOrigin.Host || authorize.Path != "/login/oauth/authorize" {
		t.Fatalf("authorize=%q err=%v", beginResponse.Header().Get("Location"), err)
	}
	state := authorize.Query().Get("state")
	cookies := beginResponse.Result().Cookies()
	if state == "" || len(cookies) != 1 || cookies[0].Name != oauthStateCookie {
		t.Fatalf("state=%q cookies=%#v", state, cookies)
	}

	callbackRequest := httptest.NewRequest(http.MethodGet, "/api/auth/callback/github?code=code-fixture&state="+url.QueryEscape(state), nil)
	callbackRequest.AddCookie(cookies[0])
	callbackResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(callbackResponse, callbackRequest)
	if callbackResponse.Code != http.StatusFound || callbackResponse.Header().Get("Location") != "https://ghfind.example/u/octocat" {
		t.Fatalf("callback status=%d location=%q body=%s", callbackResponse.Code, callbackResponse.Header().Get("Location"), callbackResponse.Body.String())
	}
	if store.calls != 1 || store.session.GitHubID != 42 || store.session.Login != "octocat" || store.name != "The Cat" {
		t.Fatalf("stored user=%#v name=%q calls=%d", store.session, store.name, store.calls)
	}
	var sessionCookie *http.Cookie
	for _, cookie := range callbackResponse.Result().Cookies() {
		if cookie.Name == oauthSessionCookie {
			sessionCookie = cookie
		}
	}
	if sessionCookie == nil {
		t.Fatalf("session cookie missing: %#v", callbackResponse.Result().Cookies())
	}
	sessionRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	sessionRequest.AddCookie(sessionCookie)
	if session := server.sessionFromRequest(sessionRequest, now.Add(time.Minute)); session == nil || session.Login != "octocat" || session.GitHubID != 42 {
		t.Fatalf("session=%#v", session)
	}
}

func TestGitHubOAuthRejectsTamperedState(t *testing.T) {
	server := NewAPIServer(Config{GitHubOAuthID: "client", GitHubOAuthSecret: "secret", AuthSecret: "auth-secret", PublicSiteURL: "https://ghfind.example"}, &fakeOAuthStore{}, &fakeStatusStore{}, &fakePublisher{})
	state, err := server.newOAuthState("/")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/auth/callback/github?code=x&state="+url.QueryEscape(state+"tampered"), nil)
	request.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: state})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "invalid_oauth_state") {
		t.Fatalf("response=%d body=%s", response.Code, response.Body.String())
	}
}
