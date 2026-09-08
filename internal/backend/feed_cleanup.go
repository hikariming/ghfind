package backend

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"time"
)

type FeedCleanupClaim struct {
	WriterEpoch  int64  `json:"writerEpoch"`
	LeaseOwner   string `json:"leaseOwner"`
	LeaseSeconds int    `json:"leaseSeconds"`
}
type FeedCleanupLease struct {
	Status       string     `json:"status"`
	DeletionID   string     `json:"deletionId,omitempty"`
	ProfileFloor int64      `json:"profileFloor,omitempty"`
	Phase        string     `json:"phase,omitempty"`
	Attempts     int        `json:"attempts,omitempty"`
	Failures     int        `json:"failures,omitempty"`
	LeaseUntil   *time.Time `json:"leaseUntil,omitempty"`
}
type FeedCleanupCommand struct {
	WriterEpoch int64  `json:"writerEpoch"`
	DeletionID  string `json:"deletionId"`
	LeaseOwner  string `json:"leaseOwner"`
	ErrorCode   string `json:"errorCode,omitempty"`
}
type FeedCleanupProgress struct {
	Status    string `json:"status"`
	Phase     string `json:"phase"`
	Processed int    `json:"processed"`
}

// Cleanup steps must persist their own checkpoint under the unexpired lease.
// They must distinguish user generations and process at most100 rows/objects.
// Release is a successful yield and must not consume the failure budget.
type FeedCleanupStore interface {
	ClaimFeedCleanup(context.Context, FeedCleanupClaim) (FeedCleanupLease, error)
	StepFeedCleanup(context.Context, FeedCleanupCommand) (FeedCleanupProgress, error)
	FailFeedCleanup(context.Context, FeedCleanupCommand) error
	ReleaseFeedCleanup(context.Context, FeedCleanupCommand) error
}
type HTTPFeedCleanupStore struct{ transport *CFFeedStore }

func NewHTTPFeedCleanupStore(endpoint, secret string) (*HTTPFeedCleanupStore, error) {
	transport, err := NewCFFeedStore(endpoint, secret, &http.Client{Timeout: 20 * time.Second})
	if err != nil {
		return nil, err
	}
	return &HTTPFeedCleanupStore{transport}, nil
}
func (s *HTTPFeedCleanupStore) ClaimFeedCleanup(ctx context.Context, in FeedCleanupClaim) (FeedCleanupLease, error) {
	var out FeedCleanupLease
	err := s.transport.callPath(ctx, "/internal/feed/cleanup/v1/claim", in, &out)
	return out, err
}
func (s *HTTPFeedCleanupStore) StepFeedCleanup(ctx context.Context, in FeedCleanupCommand) (FeedCleanupProgress, error) {
	var out FeedCleanupProgress
	err := s.transport.callPath(ctx, "/internal/feed/cleanup/v1/step", in, &out)
	return out, err
}
func (s *HTTPFeedCleanupStore) FailFeedCleanup(ctx context.Context, in FeedCleanupCommand) error {
	return s.transport.callPath(ctx, "/internal/feed/cleanup/v1/fail", in, nil)
}
func (s *HTTPFeedCleanupStore) ReleaseFeedCleanup(ctx context.Context, in FeedCleanupCommand) error {
	return s.transport.callPath(ctx, "/internal/feed/cleanup/v1/release", in, nil)
}

type FeedCleanupResult struct {
	Status     string `json:"status"`
	DeletionID string `json:"deletionId,omitempty"`
	Steps      int    `json:"steps"`
	Processed  int    `json:"processed"`
}
type FeedCleanupExecutor struct {
	store  FeedCleanupStore
	epoch  int64
	secret string
}

func NewFeedCleanupExecutor(store FeedCleanupStore, epoch int64, secret string) (*FeedCleanupExecutor, error) {
	if store == nil || epoch < 1 || len(secret) < 32 {
		return nil, errors.New("cleanup store, writer epoch and executor secret required")
	}
	return &FeedCleanupExecutor{store, epoch, secret}, nil
}
func (e *FeedCleanupExecutor) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" || r.URL.Path != "/internal/feed/jobs/cleanup" {
		writeJSON(w, 404, map[string]string{"error": "not_found"}, noStoreHeaders())
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+e.secret)) != 1 {
		writeJSON(w, 401, map[string]string{"error": "authentication_required"}, noStoreHeaders())
		return
	}
	var body struct{}
	if err := decodeFeedJSON(r, &body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid_body"}, noStoreHeaders())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	result, err := e.Execute(ctx)
	if err != nil {
		writeJSON(w, 503, map[string]string{"error": "cleanup_unavailable"}, feedUnavailableHeaders())
		return
	}
	writeJSON(w, 200, result, noStoreHeaders())
}
func (e *FeedCleanupExecutor) Execute(ctx context.Context) (FeedCleanupResult, error) {
	out := FeedCleanupResult{Status: "idle"}
	owner, err := NewFeedID("cleanup")
	if err != nil {
		return out, err
	}
	// Keep a separate work deadline so a normal time-budget yield still has
	// time to durably release its lease before the outer 60-second request ends.
	work, stopWork := context.WithTimeout(ctx, 50*time.Second)
	defer stopWork()
	lease, err := e.store.ClaimFeedCleanup(work, FeedCleanupClaim{e.epoch, owner, 90})
	if err != nil {
		return out, err
	}
	if lease.Status == "idle" {
		return out, nil
	}
	if lease.Status != "leased" || lease.DeletionID == "" {
		return out, errors.New("invalid cleanup claim")
	}
	command := FeedCleanupCommand{WriterEpoch: e.epoch, DeletionID: lease.DeletionID, LeaseOwner: owner}
	out.DeletionID = lease.DeletionID
	fail := func(cause error) (FeedCleanupResult, error) {
		failure, cancel := context.WithTimeout(context.WithoutCancel(ctx), 4*time.Second)
		defer cancel()
		command.ErrorCode = "cleanup_step_failed"
		if err := e.store.FailFeedCleanup(failure, command); err != nil {
			return out, err
		}
		return out, cause
	}
	yield := func() (FeedCleanupResult, error) {
		release, cancel := context.WithTimeout(context.WithoutCancel(ctx), 4*time.Second)
		defer cancel()
		if err := e.store.ReleaseFeedCleanup(release, command); err != nil {
			return out, err
		}
		out.Status = "queued"
		return out, nil
	}
	for out.Steps < 8 && work.Err() == nil {
		progress, err := e.store.StepFeedCleanup(work, command)
		if err != nil {
			if work.Err() != nil {
				return yield()
			}
			return fail(err)
		}
		if progress.Processed < 0 || progress.Processed > 100 || (progress.Status != "running" && progress.Status != "completed") {
			return fail(errors.New("invalid cleanup progress"))
		}
		out.Steps++
		out.Processed += progress.Processed
		if progress.Status == "completed" {
			if progress.Phase != "completed" {
				return fail(errors.New("incomplete cleanup phases"))
			}
			out.Status = "completed"
			return out, nil
		}
	}
	return yield()
}
