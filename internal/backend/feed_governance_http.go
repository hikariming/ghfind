package backend

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
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
	w.Header().Set("X-Feed-Contract", "1")
	respond := func(status int, v any) { writeJSON(w, status, v, noStoreHeaders()) }
	bodyComplete := r.Body == nil || r.Body == http.NoBody
	failure := func(status int, code string) {
		// net/http otherwise drains an unread request body before flushing a small
		// error response, allowing an unauthenticated slow body to delay rejection.
		if !bodyComplete {
			w.Header().Set("Connection", "close")
		}
		respond(status, map[string]string{"error": code})
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+h.secret)) != 1 {
		failure(401, "unauthorized")
		return
	}
	if r.Method != "POST" {
		failure(405, "method_not_allowed")
		return
	}
	if r.Header.Get("X-Feed-Contract") != "1" {
		failure(409, "contract_version_changed")
		return
	}
	if r.URL.RawQuery != "" || r.URL.EscapedPath() != r.URL.Path {
		failure(404, "operation_not_found")
		return
	}
	operation := strings.TrimPrefix(r.URL.Path, feedGovernancePath)
	if !strings.HasPrefix(r.URL.Path, feedGovernancePath) || (operation != "proposal" && operation != "review" && operation != "deprecate" && operation != "command") {
		failure(404, "operation_not_found")
		return
	}
	if strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])) != "application/json" {
		failure(415, "unsupported_media_type")
		return
	}
	if r.ContentLength > 32<<10 {
		failure(413, "request_too_large")
		return
	}
	// A context alone cannot interrupt a blocked net/http body read. Apply the
	// same absolute deadline to the connection and storage, without resetting it
	// whenever another body chunk arrives.
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	deadline, _ := ctx.Deadline()
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(deadline)
	body, err := io.ReadAll(io.LimitReader(r.Body, (32<<10)+1))
	bodyComplete = err == nil && len(body) <= 32<<10
	var timeout net.Error
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
		failure(408, "body_timeout")
		return
	}
	if len(body) > 32<<10 {
		failure(413, "request_too_large")
		return
	}
	// Match the Worker UTF8 decoder: discard at most one leading byte-order mark.
	body = bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf})
	if err != nil || !govValidJSONUnicode(body) {
		failure(400, "invalid_request")
		return
	}
	defer controller.SetReadDeadline(time.Time{})
	var raw map[string]json.RawMessage
	if err = json.Unmarshal(body, &raw); err != nil || raw == nil {
		failure(400, "invalid_request")
		return
	}
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
	// JSON.parse and the CF schema accept any numeric representation whose
	// resulting value is a safe integer. Normalize only the two integer fields.
	var raw map[string]json.RawMessage
	if json.Unmarshal(body, &raw) != nil || raw == nil {
		return errors.New("invalid object")
	}
	for _, key := range []string{"writerEpoch", "expectedTaxonomyVersion"} {
		if number, ok := raw[key]; ok {
			v, err := strconv.ParseFloat(string(number), 64)
			if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 1 || v > feedSafeInteger || math.Trunc(v) != v {
				return errors.New("invalid safe integer")
			}
			raw[key] = json.RawMessage(strconv.FormatInt(int64(v), 10))
		}
	}
	var err error
	body, err = json.Marshal(raw)
	if err != nil {
		return err
	}
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

// encoding/json replaces lone UTF16 surrogates with U+FFFD. Reject them before
// decoding so a command cannot acquire a different digest between Go and JS.
func govValidJSONUnicode(body []byte) bool {
	if !utf8.Valid(body) || !json.Valid(body) {
		return false
	}
	for i := 0; i < len(body); i++ {
		if body[i] != '\\' {
			continue
		}
		i++
		if body[i] != 'u' {
			continue
		}
		n, _ := strconv.ParseUint(string(body[i+1:i+5]), 16, 16)
		i += 4
		if n >= 0xdc00 && n <= 0xdfff {
			return false
		}
		if n >= 0xd800 && n <= 0xdbff {
			if i+6 >= len(body) || body[i+1] != '\\' || body[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(body[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}
