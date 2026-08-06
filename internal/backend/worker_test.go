package backend

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeSnapshotStore struct {
	created bool
	err     error
	calls   int
}

func (s *fakeSnapshotStore) PersistScoreSnapshot(_ context.Context, _ ScoreSnapshotJob) (bool, error) {
	s.calls++
	return s.created, s.err
}

func TestWorkerProcessCompletesAndMarksDuplicateDelivery(t *testing.T) {
	statuses := &fakeStatusStore{}
	snapshots := &fakeSnapshotStore{created: false}
	worker := NewWorker(Config{MaxAttempts: 5}, snapshots, statuses, &fakePublisher{}, nil)
	job := ScoreSnapshotJob{ID: "job_0123456789abcdef", Username: "octocat", RequestedAt: time.Now().UnixMilli()}
	disposition, reason := worker.process(context.Background(), job)
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("disposition=%v reason=%q", disposition, reason)
	}
	status, err := statuses.Get(context.Background(), job.ID)
	if err != nil || status == nil {
		t.Fatalf("status = %#v, err = %v", status, err)
	}
	if status.State != JobCompleted || status.Attempt != 1 || status.Error != "duplicate_delivery" {
		t.Fatalf("status = %#v", status)
	}
	for _, want := range []string{
		`ghfind_worker_jobs_started_total{kind="score_snapshot.v1"} 1`,
		`ghfind_worker_jobs_completed_total{kind="score_snapshot.v1",result="duplicate"} 1`,
		`ghfind_worker_job_duration_seconds_count{kind="score_snapshot.v1"} 1`,
	} {
		if !strings.Contains(worker.metrics.Prometheus(), want) {
			t.Fatalf("missing metric %q in:\n%s", want, worker.metrics.Prometheus())
		}
	}
}

func TestWorkerProcessDeadLettersUnknownScore(t *testing.T) {
	statuses := &fakeStatusStore{}
	worker := NewWorker(Config{MaxAttempts: 5}, &fakeSnapshotStore{err: ErrScoreNotFound}, statuses, &fakePublisher{}, nil)
	job := ScoreSnapshotJob{ID: "job_0123456789abcdef", Username: "missing", RequestedAt: time.Now().UnixMilli()}
	disposition, reason := worker.process(context.Background(), job)
	if disposition != workerDead || reason != ErrScoreNotFound.Error() {
		t.Fatalf("disposition=%v reason=%q", disposition, reason)
	}
}

func TestWorkerProcessRetriesTransientStoreFailure(t *testing.T) {
	statuses := &fakeStatusStore{}
	worker := NewWorker(Config{MaxAttempts: 5}, &fakeSnapshotStore{err: errors.New("temporary Turso failure")}, statuses, &fakePublisher{}, nil)
	job := ScoreSnapshotJob{ID: "job_0123456789abcdef", Username: "octocat", RequestedAt: time.Now().UnixMilli()}
	disposition, reason := worker.process(context.Background(), job)
	if disposition != workerRetry || reason != "temporary Turso failure" {
		t.Fatalf("disposition=%v reason=%q", disposition, reason)
	}
}

func TestRetryDelayIsBoundedExponential(t *testing.T) {
	if got := retryDelay(1); got != 2*time.Second {
		t.Fatalf("retryDelay(1) = %s", got)
	}
	if got := retryDelay(4); got != 16*time.Second {
		t.Fatalf("retryDelay(4) = %s", got)
	}
	if got := retryDelay(20); got != 2*time.Minute {
		t.Fatalf("retryDelay(20) = %s", got)
	}
}
