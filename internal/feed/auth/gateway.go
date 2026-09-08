// Package auth verifies the private gateway context. It has no dependency on
// OAuth, Next, Cloudflare, or the ranking/signing secret.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const Header = "X-Feed-Gateway"
const MaxBody = 128 << 10

var ErrUnauthorized = errors.New("invalid feed gateway context")
var loginPattern = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$`)

type Claims struct {
	Version    int    `json:"version"`
	Audience   string `json:"audience"`
	GitHubID   int64  `json:"githubId"`
	Login      string `json:"login"`
	AvatarURL  string `json:"avatarUrl"`
	IssuedAt   int64  `json:"issuedAt"`
	ExpiresAt  int64  `json:"expiresAt"`
	Method     string `json:"method"`
	Target     string `json:"target"`
	BodySHA256 string `json:"bodySha256"`
}
type Verifier struct {
	secret   []byte
	audience string
}

func New(secret, audience string) (*Verifier, error) {
	if len(secret) < 32 || audience == "" {
		return nil, fmt.Errorf("gateway secret (>=32 bytes) and audience are required")
	}
	return &Verifier{[]byte(secret), audience}, nil
}
func (v *Verifier) Sign(c Claims) (string, error) {
	encoded, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString(encoded)
	mac := hmac.New(sha256.New, v.secret)
	mac.Write([]byte("feed-gateway-v1\n" + payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
func BodyHash(body []byte) string {
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}
func (v *Verifier) Verify(r *http.Request, now time.Time) (*Claims, error) {
	values := r.Header.Values(Header)
	if len(values) != 1 || len(values[0]) > 4096 {
		return nil, ErrUnauthorized
	}
	parts := strings.Split(values[0], ".")
	if len(parts) != 2 {
		return nil, ErrUnauthorized
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrUnauthorized
	}
	mac := hmac.New(sha256.New, v.secret)
	mac.Write([]byte("feed-gateway-v1\n" + parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return nil, ErrUnauthorized
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, ErrUnauthorized
	}
	var claims Claims
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&claims) != nil {
		return nil, ErrUnauthorized
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, ErrUnauthorized
	}
	if claims.Version != 1 || claims.Audience != v.audience || claims.GitHubID <= 0 || claims.GitHubID > 9007199254740991 || !loginPattern.MatchString(claims.Login) ||
		claims.ExpiresAt <= now.UnixMilli() || claims.IssuedAt > now.Add(5*time.Second).UnixMilli() || claims.IssuedAt <= 0 || claims.ExpiresAt-claims.IssuedAt > 60000 || claims.ExpiresAt <= claims.IssuedAt ||
		claims.Method != r.Method || claims.Target != r.URL.RequestURI() {
		return nil, ErrUnauthorized
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil || len(body) > MaxBody {
		return nil, ErrUnauthorized
	}
	r.Body = io.NopCloser(strings.NewReader(string(body)))
	if !hmac.Equal([]byte(claims.BodySHA256), []byte(BodyHash(body))) {
		return nil, ErrUnauthorized
	}
	return &claims, nil
}
