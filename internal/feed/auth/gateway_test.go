package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGatewayCrossLanguageFixture(t *testing.T) {
	verifier, _ := New("fixture-gateway-secret-0123456789abcdef", "feed-api")
	body := `{"saved":true,"impressionToken":"fixture"}`
	claims := Claims{Version: 1, Audience: "feed-api", GitHubID: 42, Login: "octocat", AvatarURL: "https://avatars.githubusercontent.com/u/42", IssuedAt: 1788825600000, ExpiresAt: 1788825630000, Method: "PUT", Target: "/api/feed/projects/octo/repo/state?mode=test", BodySHA256: BodyHash([]byte(body))}
	token, err := verifier.Sign(claims)
	if err != nil {
		t.Fatal(err)
	}
	if suffix := strings.Split(token, ".")[1]; suffix != "jGCAotv6ohscgkhltuUn3vOUo1f1AQHLyuU1i_pmQ-I" {
		t.Fatalf("cross-language signature changed: %s", suffix)
	}
	request := httptest.NewRequest(claims.Method, claims.Target, strings.NewReader(body))
	request.Header.Set(Header, token)
	got, err := verifier.Verify(request, time.UnixMilli(claims.IssuedAt+1000))
	if err != nil || got.GitHubID != 42 {
		t.Fatalf("verify: %v %v", got, err)
	}
	for name, mutate := range map[string]func(*http.Request){"method": func(r *http.Request) { r.Method = "POST" }, "query": func(r *http.Request) { r.URL.RawQuery = "mode=other" }, "body": func(r *http.Request) { r.Body = http.NoBody }, "header": func(r *http.Request) { r.Header.Add(Header, token) }} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest(claims.Method, claims.Target, strings.NewReader(body))
			r.Header.Set(Header, token)
			mutate(r)
			if _, err := verifier.Verify(r, time.UnixMilli(claims.IssuedAt+1000)); err == nil {
				t.Fatal("tampered context accepted")
			}
		})
	}
	for _, delta := range []int64{-6000, 31000} {
		r := httptest.NewRequest(claims.Method, claims.Target, strings.NewReader(body))
		r.Header.Set(Header, token)
		if _, err := verifier.Verify(r, time.UnixMilli(claims.IssuedAt+delta)); err == nil {
			t.Fatalf("invalid time accepted %d", delta)
		}
	}
}
func TestGatewayRejectsOversizedBodyAndOtherAudience(t *testing.T) {
	verifier, _ := New(strings.Repeat("s", 32), "feed-api")
	now := time.Now()
	c := Claims{Version: 1, Audience: "feed-worker", GitHubID: 1, Login: "octocat", IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(time.Minute).UnixMilli(), Method: "POST", Target: "/api/feed/events", BodySHA256: BodyHash(nil)}
	token, _ := verifier.Sign(c)
	r := httptest.NewRequest("POST", c.Target, http.NoBody)
	r.Header.Set(Header, token)
	if _, err := verifier.Verify(r, now); err == nil {
		t.Fatal("wrong audience accepted")
	}
	c.Audience = "feed-api"
	body := strings.Repeat("x", MaxBody+1)
	c.BodySHA256 = BodyHash([]byte(body))
	token, _ = verifier.Sign(c)
	r = httptest.NewRequest("POST", c.Target, strings.NewReader(body))
	r.Header.Set(Header, token)
	if _, err := verifier.Verify(r, now); err == nil {
		t.Fatal("oversized signed body accepted")
	}
}
