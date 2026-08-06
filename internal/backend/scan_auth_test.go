package backend

import (
	"net/http/httptest"
	"testing"
)

func TestClientIPIgnoresGenericForwardedForByDefault(t *testing.T) {
	request := httptest.NewRequest("POST", "/api/scan", nil)
	request.RemoteAddr = "203.0.113.10:4567"
	request.Header.Set("X-Forwarded-For", "198.51.100.42")

	if got := clientIPFromRequest(request, false); got != "203.0.113.10" {
		t.Fatalf("clientIPFromRequest = %q, want RemoteAddr", got)
	}
}

func TestClientIPUsesVercelHeaderOnlyWhenTrusted(t *testing.T) {
	request := httptest.NewRequest("POST", "/api/scan", nil)
	request.RemoteAddr = "203.0.113.10:4567"
	request.Header.Set("X-Forwarded-For", "198.51.100.42")
	request.Header.Set("X-Vercel-Forwarded-For", "192.0.2.77, 192.0.2.88")

	if got := clientIPFromRequest(request, true); got != "192.0.2.77" {
		t.Fatalf("trusted clientIPFromRequest = %q, want Vercel header", got)
	}
	if got := clientIPFromRequest(request, false); got != "203.0.113.10" {
		t.Fatalf("untrusted clientIPFromRequest = %q, want RemoteAddr", got)
	}
}

func TestClientIPFallsBackToUnknown(t *testing.T) {
	request := httptest.NewRequest("POST", "/api/scan", nil)
	request.RemoteAddr = ""

	if got := clientIPFromRequest(request, false); got != "unknown" {
		t.Fatalf("clientIPFromRequest = %q, want unknown", got)
	}
}
