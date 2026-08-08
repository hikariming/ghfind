package backend

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	oauthStateCookie   = "ghfind_oauth_state"
	oauthSessionCookie = "ghfind_session"
	oauthStateTTL      = 10 * time.Minute
	oauthSessionTTL    = 30 * 24 * time.Hour
)

type githubOAuthState struct {
	Nonce      string `json:"nonce"`
	ExpiresAt  int64  `json:"expires_at"`
	CallbackTo string `json:"callback_to"`
}

type OAuthSession struct {
	GitHubID  int64  `json:"github_id"`
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url,omitempty"`
	ExpiresAt int64  `json:"expires_at"`
}

type OAuthUserStore interface {
	UpsertOAuthUser(context.Context, OAuthSession, string, time.Time) error
}

type OAuthScoreStore interface {
	HasCanonicalPublicScore(context.Context, string) (bool, error)
}

func (s *TursoStore) UpsertOAuthUser(ctx context.Context, session OAuthSession, name string, now time.Time) error {
	if session.GitHubID <= 0 || session.Login == "" {
		return fmt.Errorf("invalid OAuth user")
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO users
      (github_id, login, name, avatar_url, created_at, last_login)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(github_id) DO UPDATE SET
        login = excluded.login,
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        last_login = excluded.last_login`, session.GitHubID, session.Login, nullableText(name), nullableText(session.AvatarURL), now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return fmt.Errorf("upsert OAuth user: %w", err)
	}
	return nil
}

func (s *TursoStore) HasCanonicalPublicScore(ctx context.Context, username string) (bool, error) {
	var exists int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM scores
      WHERE username = ? AND hidden = 0 AND score_version = ?
        AND score_source_collection_version = ?
        AND length(score_source_snapshot_hash) = 64
        AND score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'
      LIMIT 1`, strings.ToLower(username), goCanonicalScoreVersion, goCanonicalCollectionVersion).Scan(&exists)
	if err == nil {
		return true, nil
	}
	if err == sql.ErrNoRows {
		return false, nil
	}
	return false, fmt.Errorf("read OAuth score brief: %w", err)
}

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (s *APIServer) oauthConfigured() bool {
	return s.config.GitHubOAuthID != "" && s.config.GitHubOAuthSecret != "" && s.config.AuthSecret != "" && s.publicOrigin() != ""
}

func (s *APIServer) publicOrigin() string {
	parsed, err := url.Parse(s.config.PublicSiteURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return ""
	}
	return strings.TrimRight(parsed.String(), "/")
}

func (s *APIServer) beginGitHubOAuth(w http.ResponseWriter, request *http.Request) {
	if !s.oauthConfigured() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "auth_not_configured"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	state, err := s.newOAuthState(s.safeOAuthCallback(request.URL.Query().Get("callbackUrl")))
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "auth_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	s.setOAuthCookie(w, request, oauthStateCookie, state, int(oauthStateTTL.Seconds()))
	authorize, _ := url.Parse(strings.TrimRight(s.githubOAuthOrigin, "/") + "/login/oauth/authorize")
	query := authorize.Query()
	query.Set("client_id", s.config.GitHubOAuthID)
	query.Set("redirect_uri", s.publicOrigin()+"/api/auth/callback/github")
	query.Set("scope", "read:user")
	query.Set("state", state)
	authorize.RawQuery = query.Encode()
	http.Redirect(w, request, authorize.String(), http.StatusFound)
}

func (s *APIServer) completeGitHubOAuth(w http.ResponseWriter, request *http.Request) {
	if !s.oauthConfigured() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "auth_not_configured"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	state, err := s.readOAuthState(request)
	if err != nil || subtle.ConstantTimeCompare([]byte(request.URL.Query().Get("state")), []byte(s.stateCookieValue(request))) != 1 {
		s.clearOAuthCookie(w, request, oauthStateCookie)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_oauth_state"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	if providerError := request.URL.Query().Get("error"); providerError != "" {
		s.clearOAuthCookie(w, request, oauthStateCookie)
		http.Redirect(w, request, s.publicOrigin()+"/?auth_error="+url.QueryEscape("github"), http.StatusFound)
		return
	}
	code := strings.TrimSpace(request.URL.Query().Get("code"))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing_oauth_code"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	profile, err := s.fetchGitHubOAuthProfile(request.Context(), code)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "github_oauth_failed"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	store, ok := s.scores.(OAuthUserStore)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "auth_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	now := s.clock().UTC()
	session := OAuthSession{GitHubID: profile.ID, Login: strings.ToLower(profile.Login), AvatarURL: profile.AvatarURL, ExpiresAt: now.Add(oauthSessionTTL).UnixMilli()}
	if err := store.UpsertOAuthUser(request.Context(), session, profile.Name, now); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "auth_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	encoded, err := s.encodeSignedPayload("session", session)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "auth_unavailable"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	s.setOAuthCookie(w, request, oauthSessionCookie, encoded, int(oauthSessionTTL.Seconds()))
	s.clearOAuthCookie(w, request, oauthStateCookie)
	http.Redirect(w, request, s.publicOrigin()+state.CallbackTo, http.StatusFound)
}

func (s *APIServer) signOut(w http.ResponseWriter, request *http.Request) {
	s.clearOAuthCookie(w, request, oauthSessionCookie)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true}, map[string]string{"Cache-Control": "no-store"})
}

// me is deliberately always a 200 probe. Browser chrome can call it without
// error handling while all identity verification stays in Go.
func (s *APIServer) me(w http.ResponseWriter, request *http.Request) {
	session := s.sessionFromRequest(request, s.clock().UTC())
	if session == nil {
		writeJSON(w, http.StatusOK, map[string]any{"user": nil, "scored": false}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	scored := false
	if store, ok := s.scores.(OAuthScoreStore); ok {
		if value, err := store.HasCanonicalPublicScore(request.Context(), session.Login); err == nil {
			scored = value
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":   map[string]any{"login": session.Login, "image": nullableText(session.AvatarURL)},
		"scored": scored,
	}, map[string]string{"Cache-Control": "no-store"})
}

func (s *APIServer) sessionFromRequest(request *http.Request, now time.Time) *OAuthSession {
	cookie, err := request.Cookie(oauthSessionCookie)
	if err != nil || cookie.Value == "" {
		return nil
	}
	var session OAuthSession
	if err := s.decodeSignedPayload("session", cookie.Value, &session); err != nil || session.GitHubID <= 0 || normalizeGitHubUsername(session.Login) == "" || session.ExpiresAt <= now.UnixMilli() {
		return nil
	}
	session.Login = normalizeGitHubUsername(session.Login)
	return &session
}

func (s *APIServer) newOAuthState(callback string) (string, error) {
	bytes := make([]byte, 24)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return s.encodeSignedPayload("state", githubOAuthState{Nonce: base64.RawURLEncoding.EncodeToString(bytes), ExpiresAt: s.clock().UTC().Add(oauthStateTTL).UnixMilli(), CallbackTo: callback})
}

func (s *APIServer) readOAuthState(request *http.Request) (githubOAuthState, error) {
	cookie, err := request.Cookie(oauthStateCookie)
	if err != nil {
		return githubOAuthState{}, err
	}
	var state githubOAuthState
	if err := s.decodeSignedPayload("state", cookie.Value, &state); err != nil {
		return githubOAuthState{}, err
	}
	if state.Nonce == "" || state.ExpiresAt <= s.clock().UTC().UnixMilli() || state.CallbackTo == "" {
		return githubOAuthState{}, fmt.Errorf("expired OAuth state")
	}
	return state, nil
}

func (s *APIServer) stateCookieValue(request *http.Request) string {
	cookie, err := request.Cookie(oauthStateCookie)
	if err != nil {
		return ""
	}
	return cookie.Value
}

func (s *APIServer) encodeSignedPayload(kind string, value any) (string, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	return encoded + "." + s.oauthSignature(kind, encoded), nil
}

func (s *APIServer) decodeSignedPayload(kind, encoded string, target any) error {
	parts := strings.Split(encoded, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return fmt.Errorf("invalid signed payload")
	}
	if subtle.ConstantTimeCompare([]byte(parts[1]), []byte(s.oauthSignature(kind, parts[0]))) != 1 {
		return fmt.Errorf("invalid signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return err
	}
	return json.Unmarshal(payload, target)
}

func (s *APIServer) oauthSignature(kind, payload string) string {
	mac := hmac.New(sha256.New, []byte(s.config.AuthSecret))
	_, _ = mac.Write([]byte("ghfind:oauth:" + kind + ":" + payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *APIServer) safeOAuthCallback(raw string) string {
	if raw == "" {
		return "/"
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "/"
	}
	if parsed.IsAbs() {
		origin, err := url.Parse(s.publicOrigin())
		if err != nil || !strings.EqualFold(parsed.Scheme, origin.Scheme) || !strings.EqualFold(parsed.Host, origin.Host) {
			return "/"
		}
		if parsed.RawQuery != "" {
			return parsed.EscapedPath() + "?" + parsed.RawQuery
		}
		return parsed.EscapedPath()
	}
	if !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") {
		return "/"
	}
	return raw
}

func (s *APIServer) setOAuthCookie(w http.ResponseWriter, request *http.Request, name, value string, maxAge int) {
	secure := request.TLS != nil || strings.EqualFold(strings.TrimSpace(strings.Split(request.Header.Get("X-Forwarded-Proto"), ",")[0]), "https")
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", MaxAge: maxAge, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: secure})
}

func (s *APIServer) clearOAuthCookie(w http.ResponseWriter, request *http.Request, name string) {
	s.setOAuthCookie(w, request, name, "", -1)
}

type githubOAuthProfile struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

func (s *APIServer) fetchGitHubOAuthProfile(ctx context.Context, code string) (githubOAuthProfile, error) {
	client := s.oauthHTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	values := url.Values{
		"client_id":     {s.config.GitHubOAuthID},
		"client_secret": {s.config.GitHubOAuthSecret},
		"code":          {code},
		"redirect_uri":  {s.publicOrigin() + "/api/auth/callback/github"},
	}
	tokenRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.githubOAuthOrigin, "/")+"/login/oauth/access_token", strings.NewReader(values.Encode()))
	if err != nil {
		return githubOAuthProfile{}, err
	}
	tokenRequest.Header.Set("Accept", "application/json")
	tokenRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenRequest.Header.Set("User-Agent", "ghfind")
	tokenResponse, err := client.Do(tokenRequest)
	if err != nil {
		return githubOAuthProfile{}, err
	}
	defer tokenResponse.Body.Close()
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if tokenResponse.StatusCode < 200 || tokenResponse.StatusCode >= 300 || json.NewDecoder(io.LimitReader(tokenResponse.Body, 64<<10)).Decode(&token) != nil || token.AccessToken == "" {
		return githubOAuthProfile{}, fmt.Errorf("GitHub OAuth token exchange failed")
	}
	apiOrigin := strings.TrimRight(s.githubAPIOrigin, "/")
	if apiOrigin == "" {
		apiOrigin = defaultGitHubAPIURL
	}
	profileRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, apiOrigin+"/user", nil)
	if err != nil {
		return githubOAuthProfile{}, err
	}
	profileRequest.Header.Set("Accept", "application/vnd.github+json")
	profileRequest.Header.Set("Authorization", "Bearer "+token.AccessToken)
	profileRequest.Header.Set("User-Agent", "ghfind")
	profileResponse, err := client.Do(profileRequest)
	if err != nil {
		return githubOAuthProfile{}, err
	}
	defer profileResponse.Body.Close()
	var profile githubOAuthProfile
	if profileResponse.StatusCode < 200 || profileResponse.StatusCode >= 300 || json.NewDecoder(io.LimitReader(profileResponse.Body, 64<<10)).Decode(&profile) != nil || profile.ID <= 0 || normalizeGitHubUsername(profile.Login) == "" {
		return githubOAuthProfile{}, fmt.Errorf("GitHub OAuth profile request failed")
	}
	profile.Login = normalizeGitHubUsername(profile.Login)
	return profile, nil
}
