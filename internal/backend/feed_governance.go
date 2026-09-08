package backend

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const feedGovernancePath = "/internal/feed/governance/v1/"
const feedSafeInteger = 9007199254740991

type FeedGovernanceTarget struct {
	ProposalKind string `json:"proposalKind"`
	ProposalID   string `json:"proposalId"`
}
type FeedGovernanceCommand struct {
	CommandID               string `json:"commandId"`
	WriterEpoch             int64  `json:"writerEpoch"`
	ExpectedTaxonomyVersion int64  `json:"expectedTaxonomyVersion"`
	Operator                string `json:"operator"`
	Reason                  string `json:"reason"`
}
type FeedGovernanceLabels struct {
	LabelZH     string `json:"labelZh"`
	LabelEN     string `json:"labelEn"`
	Description string `json:"description"`
}
type FeedGovernanceAssignment struct {
	Weight     float64 `json:"weight"`
	Confidence float64 `json:"confidence"`
}
type FeedGovernanceReview struct {
	FeedGovernanceCommand
	FeedGovernanceTarget
	ExpectedAnalysisID string                    `json:"expectedAnalysisId"`
	Action             string                    `json:"action"`
	Labels             *FeedGovernanceLabels     `json:"labels,omitempty"`
	Assignment         *FeedGovernanceAssignment `json:"assignment,omitempty"`
	CanonicalTagID     string                    `json:"canonicalTagId,omitempty"`
}
type FeedGovernanceDeprecate struct {
	FeedGovernanceCommand
	CanonicalTagID string `json:"canonicalTagId"`
}
type FeedGovernanceResult struct {
	CommandID       string  `json:"commandId"`
	Action          string  `json:"action"`
	ProposalKind    string  `json:"proposalKind,omitempty"`
	ProposalID      string  `json:"proposalId,omitempty"`
	CanonicalTagID  *string `json:"canonicalTagId"`
	Status          string  `json:"status"`
	TaxonomyVersion int64   `json:"taxonomyVersion"`
	AppliedAt       int64   `json:"appliedAt"`
}
type FeedGovernanceProposal struct {
	FeedGovernanceTarget
	RepoKey           string   `json:"repoKey"`
	AnalysisID        string   `json:"analysisId"`
	Namespace         string   `json:"namespace"`
	Slug              string   `json:"slug"`
	LabelZH           string   `json:"labelZh"`
	LabelEN           string   `json:"labelEn"`
	Evidence          []string `json:"evidence"`
	Status            string   `json:"status"`
	ReviewedBy        *string  `json:"reviewedBy"`
	ReviewReason      *string  `json:"reviewReason"`
	CurrentAnalysisID *string  `json:"currentAnalysisId"`
	CurrentEvidence   bool     `json:"currentEvidence"`
	TaxonomyVersion   int64    `json:"taxonomyVersion"`
}
type FeedGovernanceStore interface {
	InspectFeedGovernanceProposal(context.Context, FeedGovernanceTarget) (*FeedGovernanceProposal, error)
	GetFeedGovernanceCommand(context.Context, string) (*FeedGovernanceResult, error)
	ReviewFeedGovernanceProposal(context.Context, FeedGovernanceReview) (FeedGovernanceResult, error)
	DeprecateFeedGovernanceTag(context.Context, FeedGovernanceDeprecate) (FeedGovernanceResult, error)
}
type feedGovernanceError struct {
	status int
	code   string
}

func (e *feedGovernanceError) Error() string { return e.code }
func govError(status int, code string) error { return &feedGovernanceError{status, code} }
func govConflict(code string) error          { return govError(409, code) }
func govText(s string, min, max int) bool {
	if !utf8.ValidString(s) || len(s) < min || len(s) > max || (min > 0 && govBlank(s)) {
		return false
	}
	for _, r := range s {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func validateGovTarget(t FeedGovernanceTarget) bool {
	return (t.ProposalKind == "assessment" || t.ProposalKind == "user") && govText(t.ProposalID, 1, 160)
}
func validateGovCommand(c FeedGovernanceCommand) bool {
	return feedEventIDPattern.MatchString(c.CommandID) && c.WriterEpoch > 0 && c.WriterEpoch <= feedSafeInteger && c.ExpectedTaxonomyVersion > 0 && c.ExpectedTaxonomyVersion <= feedSafeInteger && govText(c.Operator, 1, 100) && govText(c.Reason, 8, 500)
}
func validateGovReview(v FeedGovernanceReview) error {
	if !validateGovCommand(v.FeedGovernanceCommand) || !validateGovTarget(v.FeedGovernanceTarget) || !govText(v.ExpectedAnalysisID, 1, 160) {
		return govError(400, "invalid_request")
	}
	assigned := v.Assignment != nil && !math.IsNaN(v.Assignment.Weight) && !math.IsInf(v.Assignment.Weight, 0) && v.Assignment.Weight >= 0 && v.Assignment.Weight <= 1 && !math.IsNaN(v.Assignment.Confidence) && !math.IsInf(v.Assignment.Confidence, 0) && v.Assignment.Confidence >= 0 && v.Assignment.Confidence <= 1
	switch v.Action {
	case "create":
		if !assigned || v.CanonicalTagID != "" || v.Labels == nil || !govText(v.Labels.LabelZH, 0, 160) || !govText(v.Labels.LabelEN, 0, 160) || !govText(v.Labels.Description, 0, 1000) || govBlank(v.Labels.LabelZH+v.Labels.LabelEN) {
			return govError(400, "invalid_request")
		}
	case "map":
		if !assigned || v.Labels != nil || !govText(v.CanonicalTagID, 1, 160) {
			return govError(400, "invalid_request")
		}
	case "reject":
		if v.Labels != nil || v.Assignment != nil || v.CanonicalTagID != "" {
			return govError(400, "invalid_request")
		}
	default:
		return govError(400, "invalid_request")
	}
	return nil
}
func validateGovDeprecate(v FeedGovernanceDeprecate) error {
	if !validateGovCommand(v.FeedGovernanceCommand) || !govText(v.CanonicalTagID, 1, 160) {
		return govError(400, "invalid_request")
	}
	return nil
}

// Logical command identity follows the RFC8785 subset shared with the Worker:
// keys are ASCII, strings retain UTF8 including <>& and U+2028/U+2029, and
// JSON numbers use ECMAScript thresholds; negative zero canonicalizes to zero.
func feedGovernanceDigest(input any, implicitAction string) (string, error) {
	encoded, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	var object map[string]any
	d := json.NewDecoder(strings.NewReader(string(encoded)))
	d.UseNumber()
	if err = d.Decode(&object); err != nil {
		return "", err
	}
	if implicitAction != "" {
		object["action"] = implicitAction
	}
	canonical, err := govCanonical(object)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(canonical))), nil
}
func govJSONString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 32 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
func govCanonical(v any) (string, error) {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			s, e := govCanonical(x[k])
			if e != nil {
				return "", e
			}
			parts = append(parts, govJSONString(k)+":"+s)
		}
		return "{" + strings.Join(parts, ",") + "}", nil
	case []any:
		parts := make([]string, 0, len(x))
		for _, v := range x {
			s, e := govCanonical(v)
			if e != nil {
				return "", e
			}
			parts = append(parts, s)
		}
		return "[" + strings.Join(parts, ",") + "]", nil
	case string:
		return govJSONString(x), nil
	case json.Number:
		f, e := strconv.ParseFloat(string(x), 64)
		if e != nil {
			return "", e
		}
		if f == 0 {
			return "0", nil
		}
		b, e := json.Marshal(f)
		return string(b), e
	case nil:
		return "null", nil
	case bool:
		if x {
			return "true", nil
		}
		return "false", nil
	default:
		return "", errors.New("unsupported governance canonical value")
	}
}

// ECMAScript String.trim whitespace, shared with the Worker validators. U+0085
// is not JS whitespace; U+FEFF is. C0/DEL rejection remains independent.
func govBlank(s string) bool {
	for _, r := range s {
		switch {
		case r >= 0x2000 && r <= 0x200a:
		case r == 0x9 || r == 0xa || r == 0xb || r == 0xc || r == 0xd || r == 0x20 || r == 0xa0 || r == 0x1680 || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff:
		default:
			return false
		}
	}
	return true
}
