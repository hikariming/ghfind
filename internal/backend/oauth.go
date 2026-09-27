package backend

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// oauthSessionCookie carries the signed OAuth session verified by the Feed API.
const oauthSessionCookie = "ghfind_session"

type OAuthSession struct {
	GitHubID  int64  `json:"github_id"`
	Login     string `json:"login"`
	AvatarURL string `json:"avatar_url,omitempty"`
	ExpiresAt int64  `json:"expires_at"`
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
