package backend

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fixedFeedSource struct {
	response FeedSourceResponse
	err      error
	reads    int
}

func (s *fixedFeedSource) ReadFeedAssessment(context.Context, FeedSourceEvent) (FeedSourceResponse, error) {
	s.reads++
	return s.response, s.err
}
func executorSourceFixture(t *testing.T, analysisID string, version int64) (FeedSourceEvent, *fixedFeedSource) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	raw := validProjectAnalysisMap()
	raw["analysis_id"] = analysisID
	raw["analyzed_at"] = now.Format(time.RFC3339)
	encoded := mustMarshalJSON(t, raw)
	digest := sha256.Sum256([]byte(encoded))
	hash := fmt.Sprintf("%x", digest)
	event := FeedSourceEvent{ContractVersion: 1, EventID: "assessment.completed:" + analysisID + ":" + hash, AggregateKey: "owner/useful-tool", SourceVersion: version, Kind: "assessment.completed", AnalysisID: analysisID, ReceiptID: "app:" + analysisID, SourceHash: hash, OccurredAt: now.UnixMilli()}
	source := &fixedFeedSource{response: FeedSourceResponse{EventID: event.EventID, SourceVersion: version, Status: "current", AnalysisJSON: encoded, Assessment: &FeedSourceAssessment{RepoKey: event.AggregateKey, LatestAnalysisID: analysisID, ProductScore: 87, Confidence: 74, ResolvedCommitSHA: strings.Repeat("a", 40), AnalyzedAt: now.UnixMilli()}, Receipt: &FeedSubmissionReceipt{ReceiptID: event.ReceiptID, SourceKind: "app_submission", SubmittedAt: now}}}
	return event, source
}

type recordingFeedJobStore struct {
	status      string
	failCode    string
	completeErr error
	completions int
	claims      int
}

func (s *recordingFeedJobStore) ClaimFeedJob(context.Context, FeedJobClaimRequest) (FeedJobClaimResponse, error) {
	s.claims++
	if s.status == "" {
		s.status = "leased"
	}
	return FeedJobClaimResponse{Status: s.status}, nil
}
func (s *recordingFeedJobStore) CompleteFeedJob(context.Context, FeedJobFinishRequest) error {
	if s.completeErr != nil {
		return s.completeErr
	}
	s.completions++
	s.status = "completed"
	return nil
}
func (s *recordingFeedJobStore) FailFeedJob(_ context.Context, r FeedJobFinishRequest) error {
	s.failCode = r.ErrorCode
	return nil
}

type recordingFeedProjection struct {
	calls int
	input FeedApplyProjectionRequest
}

func (s *recordingFeedProjection) ApplyFeedProjection(_ context.Context, in FeedApplyProjectionRequest) (FeedApplyProjectionResponse, error) {
	s.calls++
	s.input = in
	return FeedApplyProjectionResponse{}, nil
}
func TestFeedExecutorVerifiesSourceAndCommitsBeforeAck(t *testing.T) {
	event, source := executorSourceFixture(t, "analysis-executor-1", 1)
	jobs := &recordingFeedJobStore{}
	catalog := &recordingFeedProjection{}
	executor, err := NewFeedExecutor(jobs, catalog, source, 1, strings.Repeat("e", 32))
	if err != nil {
		t.Fatal(err)
	}
	status, err := executor.Execute(context.Background(), event)
	if err != nil || status != "completed" || jobs.completions != 1 || catalog.calls != 1 {
		t.Fatalf("execute=%s %v jobs=%+v", status, err, jobs)
	}
	if len(catalog.input.Projection.ProductTags) != 3 || !catalog.input.Projection.ProductTags[0].NamespaceExplicit || catalog.input.Receipt.ReceiptID != event.ReceiptID {
		t.Fatalf("lost governance evidence %+v", catalog.input)
	}
	status, err = executor.Execute(context.Background(), event)
	if err != nil || status != "duplicate" || catalog.calls != 1 || source.reads != 1 {
		t.Fatal("completed retry reran business effects")
	}
	jobs.status = "leased"
	jobs.completeErr = errors.New("completion persistence unavailable")
	if _, err := executor.Execute(context.Background(), event); err == nil {
		t.Fatal("acknowledged uncommitted completion")
	}
}
func TestFeedExecutorRejectsHashIdentityAndUnverifiedReceipts(t *testing.T) {
	for _, name := range []string{"hash", "receipt", "identity", "status", "source_failure"} {
		t.Run(name, func(t *testing.T) {
			event, source := executorSourceFixture(t, "analysis-executor-bad", 1)
			switch name {
			case "hash":
				source.response.AnalysisJSON += " "
			case "receipt":
				source.response.Receipt.ReceiptID = "other"
			case "identity":
				source.response.Assessment.RepoKey = "other/repo"
			case "status":
				source.response.Status = "completed"
			case "source_failure":
				source.err = errors.New("down")
			}
			jobs := &recordingFeedJobStore{}
			catalog := &recordingFeedProjection{}
			executor, _ := NewFeedExecutor(jobs, catalog, source, 1, strings.Repeat("e", 32))
			if _, err := executor.Execute(context.Background(), event); err == nil || jobs.failCode == "" || catalog.calls != 0 || jobs.completions != 0 {
				t.Fatalf("invalid source accepted jobs=%+v calls=%d err=%v", jobs, catalog.calls, err)
			}
		})
	}
}
func TestFeedExecutorHTTPRequiresAuthAndNeverAcksUnknownFields(t *testing.T) {
	event, source := executorSourceFixture(t, "analysis-http", 1)
	jobs := &recordingFeedJobStore{}
	executor, _ := NewFeedExecutor(jobs, &recordingFeedProjection{}, source, 1, strings.Repeat("e", 32))
	encoded, _ := json.Marshal(event)
	for _, authenticated := range []bool{false, true} {
		body := string(encoded)
		if authenticated {
			body = strings.TrimSuffix(body, "}") + `,"publishable":true}`
		}
		r := httptest.NewRequest(http.MethodPost, "/internal/feed/jobs/execute", strings.NewReader(body))
		if authenticated {
			r.Header.Set("Authorization", "Bearer "+strings.Repeat("e", 32))
		}
		w := httptest.NewRecorder()
		executor.ServeHTTP(w, r)
		if (authenticated && w.Code != 400) || (!authenticated && w.Code != 401) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if jobs.claims != 0 {
		t.Fatal("invalid HTTP claimed work")
	}
}
