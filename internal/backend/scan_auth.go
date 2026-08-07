package backend

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const anonymousSessionCookie = "ghfind_anonymous_session"
const anonymousSessionTTL = 12 * time.Hour

var anonymousSessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{24,}$`)
var anonymousSessionSignaturePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{40,}$`)

type anonymousSession struct {
	ID     string
	Value  string
	Issued bool
}

func clientIPFromRequest(request *http.Request, trustVercelHeaders bool) string {
	if trustVercelHeaders {
		if ip := firstHeaderValue(request.Header.Get("X-Vercel-Forwarded-For")); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(request.RemoteAddr))
	if err == nil && host != "" {
		return host
	}
	if remote := strings.TrimSpace(request.RemoteAddr); remote != "" {
		return remote
	}
	return "unknown"
}

func firstHeaderValue(value string) string {
	for _, part := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func (s *APIServer) clientIP(request *http.Request) string {
	return clientIPFromRequest(request, s.config.TrustVercelHeaders)
}

func (s *APIServer) clientPrincipal(request *http.Request) string {
	return s.clientIP(request)
}

func (s *APIServer) lookupIPHash(ip string) string {
	salt := s.config.AuthSecret
	if salt == "" {
		salt = s.config.TurnstileSecret
	}
	if salt == "" {
		salt = "github-roast-heat-v1"
	}
	digest := sha256.Sum256([]byte(salt + "\x00" + ip))
	return fmt.Sprintf("%x", digest[:])
}

func (s *APIServer) machineAuthenticated(request *http.Request) (valid, absent bool) {
	authorization := strings.TrimSpace(request.Header.Get("Authorization"))
	if authorization == "" {
		return false, true
	}
	parts := strings.Fields(authorization)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || s.config.CLIAPIKey == "" {
		return false, false
	}
	if subtle.ConstantTimeCompare([]byte(parts[1]), []byte(s.config.CLIAPIKey)) != 1 {
		return false, false
	}
	return true, false
}

func (s *APIServer) anonymousSessionPrincipal(request *http.Request, now time.Time) string {
	secret := s.anonymousSessionSecret()
	cookie, err := request.Cookie(anonymousSessionCookie)
	if secret == "" || err != nil || cookie.Value == "" {
		return ""
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 4 || parts[0] != "v1" || !anonymousSessionIDPattern.MatchString(parts[1]) || !regexp.MustCompile(`^\d{13}$`).MatchString(parts[2]) || !anonymousSessionSignaturePattern.MatchString(parts[3]) {
		return ""
	}
	expiresAt, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || expiresAt <= now.UnixMilli() {
		return ""
	}
	payload := strings.Join(parts[:3], ".")
	if subtle.ConstantTimeCompare([]byte(parts[3]), []byte(s.anonymousSessionSignature(payload, secret))) != 1 {
		return ""
	}
	return "anon:" + parts[1]
}

func (s *APIServer) establishAnonymousSession(request *http.Request, now time.Time) *anonymousSession {
	if principal := s.anonymousSessionPrincipal(request, now); principal != "" {
		return &anonymousSession{ID: strings.TrimPrefix(principal, "anon:")}
	}
	secret := s.anonymousSessionSecret()
	if secret == "" {
		return nil
	}
	bytes := make([]byte, 18)
	if _, err := rand.Read(bytes); err != nil {
		return nil
	}
	id := base64.RawURLEncoding.EncodeToString(bytes)
	expiresAt := now.Add(anonymousSessionTTL).UnixMilli()
	payload := "v1." + id + "." + strconv.FormatInt(expiresAt, 10)
	return &anonymousSession{ID: id, Value: payload + "." + s.anonymousSessionSignature(payload, secret), Issued: true}
}

func (s *APIServer) anonymousSessionSecret() string {
	if s.config.TurnstileSecret == "" {
		return ""
	}
	if s.config.AuthSecret != "" {
		return s.config.AuthSecret
	}
	return s.config.TurnstileSecret
}

func (s *APIServer) anonymousSessionSignature(payload, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("ghfind:anonymous-session:" + payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *APIServer) attachAnonymousSession(w http.ResponseWriter, request *http.Request, session *anonymousSession) {
	if session == nil || !session.Issued || session.Value == "" {
		return
	}
	secure := request.TLS != nil || strings.EqualFold(strings.TrimSpace(strings.Split(request.Header.Get("X-Forwarded-Proto"), ",")[0]), "https")
	http.SetCookie(w, &http.Cookie{Name: anonymousSessionCookie, Value: session.Value, Path: "/", MaxAge: int(anonymousSessionTTL.Seconds()), HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: secure})
}

func (s *APIServer) verifyTurnstile(ctx context.Context, token, ip string) bool {
	if s.config.TurnstileSecret == "" {
		return true
	}
	if token == "" {
		return false
	}
	form := url.Values{"secret": {s.config.TurnstileSecret}, "response": {token}, "remoteip": {ip}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://challenges.cloudflare.com/turnstile/v0/siteverify", strings.NewReader(form.Encode()))
	if err != nil {
		return false
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	var body struct {
		Success bool `json:"success"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&body); err != nil {
		return false
	}
	return body.Success
}
