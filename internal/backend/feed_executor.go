package backend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var sourceHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var ErrFeedJobConflict = errors.New("feed job identity conflict")
var ErrFeedJobLease = errors.New("feed job lease lost")

func validateFeedSourceEvent(event FeedSourceEvent) error {
	if event.ContractVersion != 1 || event.Kind != "assessment.completed" || event.SourceVersion < 1 || event.SourceVersion > 9007199254740991 || event.OccurredAt < 1 || event.OccurredAt > 9007199254740991 || event.AnalysisID == "" || len(event.AnalysisID) > 200 || event.ReceiptID == "" || len(event.ReceiptID) > 256 || !sourceHashPattern.MatchString(event.SourceHash) || event.EventID != "assessment.completed:"+event.AnalysisID+":"+event.SourceHash {
		return errors.New("invalid source event")
	}
	repo, err := NormalizeGitHubRepository(event.AggregateKey)
	if err != nil || repo.RepoKey != event.AggregateKey {
		return errors.New("invalid source repository")
	}
	return nil
}

// HTTPAssessmentSource uses a separate source credential and retrieves bounded
// immutable source facts. It never downloads an arbitrary URL from a message.
type HTTPAssessmentSource struct {
	endpoint, secret string
	client           *http.Client
}

func NewHTTPAssessmentSource(endpoint, secret string) (*HTTPAssessmentSource, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(secret) < 32 {
		return nil, errors.New("valid source endpoint and secret required")
	}
	if u.Scheme != "https" && (u.Scheme != "http" || (u.Hostname() != "feed-source.internal" && u.Hostname() != "feed-bindings.internal" && u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost")) {
		return nil, errors.New("source requires HTTPS or private handler")
	}
	return &HTTPAssessmentSource{strings.TrimRight(endpoint, "/"), secret, &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (s *HTTPAssessmentSource) call(ctx context.Context, op string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	r, err := http.NewRequestWithContext(ctx, "POST", s.endpoint+"/internal/feed/source/v1/"+op, bytes.NewReader(body))
	if err != nil {
		return err
	}
	r.Header.Set("Authorization", "Bearer "+s.secret)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Feed-Contract", "1")
	response, err := s.client.Do(r)
	if err != nil {
		return errors.New("feed source unavailable")
	}
	defer response.Body.Close()
	encoded, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil || len(encoded) > 2<<20 {
		return errors.New("invalid source response")
	}
	if response.StatusCode != 200 {
		return fmt.Errorf("feed source returned %d", response.StatusCode)
	}
	return json.Unmarshal(encoded, output)
}
func (s *HTTPAssessmentSource) ReadFeedAssessment(ctx context.Context, event FeedSourceEvent) (FeedSourceResponse, error) {
	var out FeedSourceResponse
	err := s.call(ctx, "assessment", event, &out)
	return out, err
}
func (s *HTTPAssessmentSource) Ping(ctx context.Context) error {
	var out struct {
		Ready           bool   `json:"ready"`
		ContractVersion string `json:"contractVersion"`
	}
	if err := s.call(ctx, "health", struct{}{}, &out); err != nil {
		return err
	}
	if !out.Ready || out.ContractVersion != "1" {
		return errors.New("source not ready")
	}
	return nil
}
func (s *CFFeedStore) ClaimFeedJob(ctx context.Context, in FeedJobClaimRequest) (FeedJobClaimResponse, error) {
	var out FeedJobClaimResponse
	err := s.call(ctx, "jobs.claim", in, &out)
	return out, err
}
func (s *CFFeedStore) CompleteFeedJob(ctx context.Context, in FeedJobFinishRequest) error {
	return s.call(ctx, "jobs.complete", in, nil)
}
func (s *CFFeedStore) FailFeedJob(ctx context.Context, in FeedJobFinishRequest) error {
	return s.call(ctx, "jobs.fail", in, nil)
}
func (s *CFFeedStore) ApplyFeedProjection(ctx context.Context, in FeedApplyProjectionRequest) (FeedApplyProjectionResponse, error) {
	var out FeedApplyProjectionResponse
	err := s.call(ctx, "projection.apply", in, &out)
	return out, err
}

// FeedExecutor only acknowledges a job after its durable completion transaction
// succeeds. A process crash between projection and complete is a safe replay.
type FeedExecutor struct {
	jobs    FeedJobStore
	catalog FeedCatalogProjectionStore
	source  AssessmentSource
	epoch   int64
	secret  string
}

func NewFeedExecutor(jobs FeedJobStore, catalog FeedCatalogProjectionStore, source AssessmentSource, epoch int64, secret string) (*FeedExecutor, error) {
	if jobs == nil || catalog == nil || source == nil || epoch < 1 || len(secret) < 32 {
		return nil, errors.New("durable jobs, catalog, source, epoch and executor secret required")
	}
	return &FeedExecutor{jobs, catalog, source, epoch, secret}, nil
}
func (e *FeedExecutor) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != "POST" || r.URL.Path != "/internal/feed/jobs/execute" {
		writeJSON(w, 404, map[string]string{"error": "not_found"}, noStoreHeaders())
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+e.secret)) != 1 {
		writeJSON(w, 401, map[string]string{"error": "authentication_required"}, noStoreHeaders())
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, (16<<10)+1))
	if err != nil || len(body) > 16<<10 {
		writeJSON(w, 400, map[string]string{"error": "invalid_event"}, noStoreHeaders())
		return
	}
	var event FeedSourceEvent
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&event) != nil || validateFeedSourceEvent(event) != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid_event"}, noStoreHeaders())
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		writeJSON(w, 400, map[string]string{"error": "invalid_event"}, noStoreHeaders())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	status, err := e.Execute(ctx, event)
	if err != nil {
		writeJSON(w, 503, map[string]string{"error": "execution_unavailable", "eventId": event.EventID}, feedUnavailableHeaders())
		return
	}
	writeJSON(w, 200, map[string]string{"eventId": event.EventID, "status": status}, noStoreHeaders())
}
func (e *FeedExecutor) Execute(ctx context.Context, event FeedSourceEvent) (string, error) {
	if err := validateFeedSourceEvent(event); err != nil {
		return "", err
	}
	owner, err := NewFeedID("feed_executor")
	if err != nil {
		return "", err
	}
	claim, err := e.jobs.ClaimFeedJob(ctx, FeedJobClaimRequest{e.epoch, event, owner, 90})
	if err != nil {
		return "", err
	}
	if claim.Status == "completed" {
		return "duplicate", nil
	}
	if claim.Status != "leased" {
		return "", fmt.Errorf("job is %s", claim.Status)
	}
	finish := FeedJobFinishRequest{WriterEpoch: e.epoch, EventID: event.EventID, LeaseOwner: owner}
	fail := func(code string, cause error) (string, error) {
		finish.ErrorCode = code
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 4*time.Second)
		defer cancel()
		if err := e.jobs.FailFeedJob(cleanup, finish); err != nil {
			return "", fmt.Errorf("persist failure: %w", err)
		}
		return "", cause
	}
	source, err := e.source.ReadFeedAssessment(ctx, event)
	if err != nil {
		return fail("source_unavailable", err)
	}
	if source.EventID != event.EventID || source.SourceVersion != event.SourceVersion {
		return fail("source_identity_mismatch", errors.New("source event mismatch"))
	}
	if source.Status == "superseded" {
		if err := e.jobs.CompleteFeedJob(ctx, finish); err != nil {
			return "", err
		}
		return "duplicate", nil
	}
	if source.Status != "current" || source.Assessment == nil || source.Receipt == nil {
		return fail("source_invalid", errors.New("incomplete verified source"))
	}
	if source.Receipt.ReceiptID != event.ReceiptID || source.Receipt.SubmittedAt.IsZero() || (source.Receipt.SourceKind != "app_submission" && source.Receipt.SourceKind != "agent_submission" && source.Receipt.SourceKind != "verified_backfill") {
		return fail("receipt_invalid", errors.New("invalid submission receipt"))
	}
	digest := sha256.Sum256([]byte(source.AnalysisJSON))
	if fmt.Sprintf("%x", digest) != event.SourceHash {
		return fail("source_hash_mismatch", errors.New("analysis digest mismatch"))
	}
	artifact, err := parseProjectAnalysisArtifact(source.AnalysisJSON)
	if err != nil {
		return fail("artifact_invalid", err)
	}
	a := source.Assessment
	if a.RepoKey != event.AggregateKey || a.LatestAnalysisID != event.AnalysisID {
		return fail("assessment_identity_mismatch", errors.New("assessment identity mismatch"))
	}
	projection, err := BuildFeedProjectProjection(ProjectAssessment{RepoKey: a.RepoKey, LatestAnalysisID: a.LatestAnalysisID, ProductScore: a.ProductScore, Confidence: a.Confidence, TreasureEligible: a.TreasureEligible, ClassicEligible: a.ClassicEligible, ResolvedCommitSHA: a.ResolvedCommitSHA, AnalyzedAt: a.AnalyzedAt, Analysis: artifact}, source.Overview)
	if err != nil {
		return fail("projection_invalid", err)
	}
	dto := FeedProjectionDTO{FeedProjectProjection: projection, ProductTags: []FeedProjectionProductTag{}}
	for _, tag := range projection.ProductTags {
		dto.ProductTags = append(dto.ProductTags, FeedProjectionProductTag{tag.Namespace, tag.NamespaceExplicit, tag.Slug, tag.Labels, tag.EvidenceIDs})
	}
	applied, err := e.catalog.ApplyFeedProjection(ctx, FeedApplyProjectionRequest{e.epoch, event.EventID, owner, event.SourceVersion, dto, *source.Receipt})
	if err != nil {
		return fail("projection_unavailable", err)
	}
	if err := e.jobs.CompleteFeedJob(ctx, finish); err != nil {
		return "", err
	}
	if applied.Duplicate {
		return "duplicate", nil
	}
	return "completed", nil
}
