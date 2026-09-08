package backend

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

type feedGovernanceHandler struct {
	store  FeedGovernanceStore
	secret string
}

func NewFeedGovernanceHandler(store FeedGovernanceStore, secret string) (http.Handler, error) {
	if store == nil || len(secret) < 32 {
		return nil, errors.New("governance store and independent operator secret required")
	}
	return &feedGovernanceHandler{store, secret}, nil
}
func (h *feedGovernanceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	respond := func(status int, v any) { writeJSON(w, status, v, noStoreHeaders()) }
	failure := func(status int, code string) { respond(status, map[string]string{"error": code}) }
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+h.secret)) != 1 {
		failure(401, "authentication_required")
		return
	}
	if r.Method != "POST" {
		failure(405, "method_not_allowed")
		return
	}
	if r.URL.RawQuery != "" || r.URL.EscapedPath() != r.URL.Path || r.Header.Get("X-Feed-Contract") != "1" {
		failure(400, "invalid_request")
		return
	}
	operation := strings.TrimPrefix(r.URL.Path, feedGovernancePath)
	if !strings.HasPrefix(r.URL.Path, feedGovernancePath) || (operation != "proposal" && operation != "review" && operation != "deprecate" && operation != "command") {
		failure(404, "operation_not_found")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, (32<<10)+1))
	if err != nil || len(body) > 32<<10 {
		failure(400, "invalid_request")
		return
	}
	var raw map[string]json.RawMessage
	if err = json.Unmarshal(body, &raw); err != nil || raw == nil {
		failure(400, "invalid_request")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var result any
	switch operation {
	case "proposal":
		var input FeedGovernanceTarget
		if !govShape(raw, "proposalKind", "proposalId") || govDecode(body, &input) != nil || !validateGovTarget(input) {
			failure(400, "invalid_request")
			return
		}
		var p *FeedGovernanceProposal
		p, err = h.store.InspectFeedGovernanceProposal(ctx, input)
		result = struct {
			Proposal *FeedGovernanceProposal `json:"proposal"`
		}{p}
	case "command":
		var input struct {
			CommandID string `json:"commandId"`
		}
		if !govShape(raw, "commandId") || govDecode(body, &input) != nil || !feedEventIDPattern.MatchString(input.CommandID) {
			failure(400, "invalid_request")
			return
		}
		var c *FeedGovernanceResult
		c, err = h.store.GetFeedGovernanceCommand(ctx, input.CommandID)
		result = struct {
			Command *FeedGovernanceResult `json:"command"`
		}{c}
	case "deprecate":
		var input FeedGovernanceDeprecate
		if !govShape(raw, "commandId", "writerEpoch", "expectedTaxonomyVersion", "operator", "reason", "canonicalTagId") || govDecode(body, &input) != nil || validateGovDeprecate(input) != nil {
			failure(400, "invalid_request")
			return
		}
		result, err = h.store.DeprecateFeedGovernanceTag(ctx, input)
	case "review":
		var input FeedGovernanceReview
		if govDecode(body, &input) != nil {
			failure(400, "invalid_request")
			return
		}
		keys := []string{"commandId", "writerEpoch", "expectedTaxonomyVersion", "operator", "reason", "proposalKind", "proposalId", "expectedAnalysisId", "action"}
		switch input.Action {
		case "create":
			keys = append(keys, "labels", "assignment")
		case "map":
			keys = append(keys, "canonicalTagId", "assignment")
		}
		if !govShape(raw, keys...) || validateGovReview(input) != nil {
			failure(400, "invalid_request")
			return
		}
		for _, nested := range []struct {
			key  string
			keys []string
		}{{"labels", []string{"labelZh", "labelEn", "description"}}, {"assignment", []string{"weight", "confidence"}}} {
			if b, ok := raw[nested.key]; ok {
				var object map[string]json.RawMessage
				if json.Unmarshal(b, &object) != nil || !govShape(object, nested.keys...) {
					failure(400, "invalid_request")
					return
				}
			}
		}
		result, err = h.store.ReviewFeedGovernanceProposal(ctx, input)
	}
	if err != nil {
		var e *feedGovernanceError
		switch {
		case errors.As(err, &e):
			failure(e.status, e.code)
		case errors.Is(err, ErrFeedWriterEpoch):
			failure(409, "writer_epoch_changed")
		case errors.Is(err, ErrFeedTaxonomyChanged):
			failure(409, "taxonomy_version_changed")
		default:
			failure(503, "governance_unavailable")
		}
		return
	}
	respond(200, result)
}
func govShape(raw map[string]json.RawMessage, keys ...string) bool {
	if len(raw) != len(keys) {
		return false
	}
	for _, k := range keys {
		v, ok := raw[k]
		if !ok || bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			return false
		}
	}
	return true
}
func govDecode(body []byte, value any) error {
	d := json.NewDecoder(bytes.NewReader(body))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
