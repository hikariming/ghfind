package backend

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type noGovernanceStore struct{}

func (noGovernanceStore) InspectFeedGovernanceProposal(context.Context, FeedGovernanceTarget) (*FeedGovernanceProposal, error) {
	return nil, nil
}
func (noGovernanceStore) GetFeedGovernanceCommand(context.Context, string) (*FeedGovernanceResult, error) {
	return nil, nil
}
func (noGovernanceStore) ReviewFeedGovernanceProposal(context.Context, FeedGovernanceReview) (FeedGovernanceResult, error) {
	return FeedGovernanceResult{}, nil
}
func (noGovernanceStore) DeprecateFeedGovernanceTag(context.Context, FeedGovernanceDeprecate) (FeedGovernanceResult, error) {
	return FeedGovernanceResult{}, nil
}

const govTestSecret = "fixture-operator-secret-independent-0123456789"

func govHTTP(t *testing.T, h http.Handler, operation string, input any) (int, []byte) {
	t.Helper()
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", feedGovernancePath+operation, bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+govTestSecret)
	r.Header.Set("X-Feed-Contract", "1")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	b, _ := io.ReadAll(w.Result().Body)
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("governance cache control")
	}
	return w.Code, b
}
func TestFeedGovernanceHTTPBoundary(t *testing.T) {
	h, err := NewFeedGovernanceHandler(noGovernanceStore{}, govTestSecret)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", feedGovernancePath+"proposal", bytes.NewBufferString(`{"proposalKind":"user","proposalId":"x"}`))
	r.Header.Set("X-Feed-Contract", "1")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("operator auth", w.Code)
	}
	base := map[string]any{"commandId": "00000000-0000-4000-8000-000000000001", "writerEpoch": 1, "expectedTaxonomyVersion": 1, "operator": "reviewer", "reason": "Reviewed one proposal", "proposalKind": "user", "proposalId": "x", "expectedAnalysisId": "analysis", "action": "map", "canonicalTagId": "use_case:tool", "assignment": map[string]any{"weight": 0, "confidence": 1}}
	if status, b := govHTTP(t, h, "review", base); status != 200 {
		t.Fatalf("valid explicit zero rejected %d %s", status, b)
	}
	for _, assignment := range []any{nil, map[string]any{"confidence": 1}, map[string]any{"weight": nil, "confidence": 1}, map[string]any{"weight": 0, "confidence": 1, "hidden": true}} {
		copy := map[string]any{}
		for k, v := range base {
			copy[k] = v
		}
		copy["assignment"] = assignment
		if status, _ := govHTTP(t, h, "review", copy); status != 400 {
			t.Fatal("invalid assignment accepted", assignment, status)
		}
	}
	copy := map[string]any{}
	for k, v := range base {
		copy[k] = v
	}
	copy["action"] = "reject"
	copy["assignment"] = nil
	if status, _ := govHTTP(t, h, "review", copy); status != 400 {
		t.Fatal("reject accepted unknown action fields")
	}
	for _, op := range []string{"proposal?x=1", "proposal/", "unknown"} {
		if status, _ := govHTTP(t, h, op, map[string]any{"proposalKind": "user", "proposalId": "x"}); status < 400 {
			t.Fatal("unexpected path accepted", op)
		}
	}
	if status, _ := govHTTP(t, h, "deprecate", map[string]any{"commandId": "00000000-0000-4000-8000-000000000001", "writerEpoch": 1, "expectedTaxonomyVersion": 1, "operator": "reviewer", "reason": "Reviewed tag deprecation", "canonicalTagId": "use_case:tool", "action": "deprecate"}); status != 400 {
		t.Fatal("deprecate action accepted")
	}
	if status, _ := govHTTP(t, h, "proposal", map[string]any{"proposalKind": "user", "proposalId": string(bytes.Repeat([]byte("x"), 32769))}); status != 413 {
		t.Fatal("oversize accepted")
	}
}

func TestFeedGovernanceTextRejectsControlBytes(t *testing.T) {
	for _, s := range []string{"bad\nreason", "bad\tvalue", "bad\x00value", "bad\x7fvalue"} {
		if govText(s, 1, 100) {
			t.Fatalf("control accepted %q", s)
		}
	}
	if !govText("中文审核 <>& \u2028", 1, 100) {
		t.Fatal("valid unicode rejected")
	}
}

func TestFeedGovernanceHTTPTransportContract(t *testing.T) {
	h, _ := NewFeedGovernanceHandler(noGovernanceStore{}, govTestSecret)
	for _, tc := range []struct {
		name, key, value, suffix string
		status                   int
		code                     string
	}{
		{"authorization", "Authorization", "Bearer wrong", "", 401, "unauthorized"},
		{"contract", "X-Feed-Contract", "2", "", 409, "contract_version_changed"},
		{"content type", "Content-Type", "text/plain", "", 415, "unsupported_media_type"},
		{"query", "", "", "?unexpected=1", 404, "operation_not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", feedGovernancePath+"proposal"+tc.suffix, strings.NewReader(`{"proposalKind":"user","proposalId":"x"}`))
			r.Header.Set("Authorization", "Bearer "+govTestSecret)
			r.Header.Set("X-Feed-Contract", "1")
			r.Header.Set("Content-Type", "application/json")
			if tc.key != "" {
				r.Header.Set(tc.key, tc.value)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status || !bytes.Contains(w.Body.Bytes(), []byte(tc.code)) {
				t.Fatalf("got %d %s", w.Code, w.Body)
			}
		})
	}
}

func TestFeedGovernanceBodyDeadlineInterruptsSocketRead(t *testing.T) {
	h, _ := NewFeedGovernanceHandler(noGovernanceStore{}, govTestSecret)
	server := httptest.NewServer(h)
	defer server.Close()
	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(7 * time.Second))
	started := time.Now()
	// Announce a body but never send it. A store-only context timeout does not
	// interrupt this read; the HTTP connection deadline must enforce the bound.
	_, err = fmt.Fprintf(conn, "POST %sproposal HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer %s\r\nX-Feed-Contract: 1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n", feedGovernancePath, govTestSecret)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	elapsed := time.Since(started)
	if response.StatusCode != 408 || !bytes.Contains(body, []byte("body_timeout")) || elapsed > 6*time.Second {
		t.Fatalf("body deadline: status=%d elapsed=%s body=%s", response.StatusCode, elapsed, body)
	}
}

func TestFeedGovernanceJSONNumericAndUnicodeParity(t *testing.T) {
	for _, number := range []string{"1", "1.0", "1e0", "9007199254740991"} {
		var out FeedGovernanceCommand
		if err := govDecode([]byte(`{"writerEpoch":`+number+`,"expectedTaxonomyVersion":1e0}`), &out); err != nil {
			t.Fatalf("integer %s: %v", number, err)
		}
	}
	for _, number := range []string{`"1"`, "null", "0", "-1", "1.5", "1e999", "9007199254740992"} {
		var out FeedGovernanceCommand
		if err := govDecode([]byte(`{"writerEpoch":`+number+`}`), &out); err == nil {
			t.Fatalf("invalid integer %s", number)
		}
	}
	for _, tc := range []struct {
		body  string
		valid bool
	}{
		{`{"text":"\ud800"}`, false}, {`{"text":"\udfff"}`, false},
		{`{"text":"\ud800x\udfff"}`, false}, {`{"text":"\ud83d\ude00"}`, true},
		{`{"text":"\\ud800"}`, true}, {`{"text":"中文 <>&"}`, true},
		{"{\"text\":\"" + string([]byte{0xff}) + "\"}", false},
	} {
		if govValidJSONUnicode([]byte(tc.body)) != tc.valid {
			t.Fatalf("unicode validation %s", tc.body)
		}
	}
	if !govBlank("\ufeff\u2028") || govBlank("\u0085") {
		t.Fatal("ECMAScript whitespace mismatch")
	}
	for _, id := range []string{"00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"} {
		c := govBase(1, 1)
		c.CommandID = id
		if validateGovCommand(c) {
			t.Fatal("special UUID accepted", id)
		}
	}
}

func TestFeedGovernanceEvidenceStrictStringArray(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `[null]`, `[1]`, `["\ud800"]`, `["bad\n"]`, `["bad\u007f"]`, `["` + strings.Repeat("x", 257) + `"]`} {
		if _, err := govDecodeEvidence([]byte(raw)); err == nil {
			t.Fatal("malformed evidence accepted", raw)
		}
	}
	for _, raw := range []string{`[]`, `[""]`, `["中文","\ud83d\ude00"]`} {
		if _, err := govDecodeEvidence([]byte(raw)); err != nil {
			t.Fatal("valid evidence rejected", raw, err)
		}
	}
}

func TestFeedGovernanceEarlyRejectionDoesNotDrainUntrustedBody(t *testing.T) {
	h, _ := NewFeedGovernanceHandler(noGovernanceStore{}, govTestSecret)
	server := httptest.NewServer(h)
	defer server.Close()
	for _, tc := range []struct {
		name, secret, media string
		length, status      int
	}{
		{"unauthorized", "wrong", "application/json", 100, 401},
		{"unsupported media", govTestSecret, "text/plain", 100, 415},
		{"declared oversize", govTestSecret, "application/json", 32769, 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(time.Second))
			_, err = fmt.Fprintf(conn, "POST %sproposal HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer %s\r\nX-Feed-Contract: 1\r\nContent-Type: %s\r\nContent-Length: %d\r\n\r\n", feedGovernancePath, tc.secret, tc.media, tc.length)
			if err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatal("early rejection blocked draining body", err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.status {
				t.Fatalf("status %d want %d", response.StatusCode, tc.status)
			}
		})
	}
}
