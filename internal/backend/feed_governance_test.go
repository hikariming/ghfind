package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
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
	if status, _ := govHTTP(t, h, "proposal", map[string]any{"proposalKind": "user", "proposalId": string(bytes.Repeat([]byte("x"), 32769))}); status != 400 {
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
