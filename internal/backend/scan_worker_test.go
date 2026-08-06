package backend

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rabbitmq/amqp091-go"
)

type fakeScanCollector struct {
	scan  ScanResult
	err   error
	calls int
}

func (c *fakeScanCollector) Collect(context.Context, string) (ScanResult, error) {
	c.calls++
	return c.scan, c.err
}

type fakeScanResultStore struct {
	created bool
	err     error
	calls   int
}

func (s *fakeScanResultStore) PersistCollectedScan(context.Context, ScanJob, ScanResult) (bool, error) {
	s.calls++
	return s.created, s.err
}
func (s *fakeScanResultStore) GetCollectedScan(context.Context, string) (*ScanResult, error) {
	return nil, nil
}

type fakeScanPublisher struct {
	retry []ScanJob
	dead  []ScanJob
}

type fakeDeliveryAcknowledger struct {
	acked int32
}

func (a *fakeDeliveryAcknowledger) Ack(uint64, bool) error {
	atomic.AddInt32(&a.acked, 1)
	return nil
}
func (a *fakeDeliveryAcknowledger) Nack(uint64, bool, bool) error { return nil }
func (a *fakeDeliveryAcknowledger) Reject(uint64, bool) error     { return nil }

type blockingScanCollector struct {
	started   chan string
	release   chan struct{}
	completed atomic.Int32
}

// mutexStatusStore is the concurrency-safe counterpart of fakeStatusStore for
// tests that drive the worker's parallel delivery path.
type mutexStatusStore struct {
	mu     sync.Mutex
	values map[string]JobStatus
}

func (s *mutexStatusStore) Put(_ context.Context, status JobStatus) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.values == nil {
		s.values = map[string]JobStatus{}
	}
	s.values[status.ID] = status
	return nil
}
func (s *mutexStatusStore) Get(_ context.Context, id string) (*JobStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[id]
	if !ok {
		return nil, nil
	}
	return &value, nil
}
func (s *mutexStatusStore) Ping(context.Context) error { return nil }

// mutexScanResultStore is the concurrency-safe counterpart of
// fakeScanResultStore for the parallel delivery tests.
type mutexScanResultStore struct {
	mu      sync.Mutex
	created bool
}

func (s *mutexScanResultStore) PersistCollectedScan(context.Context, ScanJob, ScanResult) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.created, nil
}
func (s *mutexScanResultStore) GetCollectedScan(context.Context, string) (*ScanResult, error) {
	return nil, nil
}

func (c *blockingScanCollector) Collect(_ context.Context, username string) (ScanResult, error) {
	c.started <- username
	<-c.release
	c.completed.Add(1)
	return ScanResult{Metrics: RawMetrics{Username: username}}, nil
}

func TestScanWorkerProcessesDeliveriesConcurrently(t *testing.T) {
	collector := &blockingScanCollector{started: make(chan string, 2), release: make(chan struct{})}
	acker := &fakeDeliveryAcknowledger{}
	worker := NewScanWorker(
		Config{MaxAttempts: 5, ScanConcurrency: 2},
		collector,
		&mutexScanResultStore{created: true},
		&mutexStatusStore{},
		&fakeScanPublisher{},
		nil,
	)
	deliveries := make(chan amqp091.Delivery, 2)
	for _, username := range []string{"alice", "bob"} {
		body, err := json.Marshal(ScanJob{ID: "job_" + username, Username: username, RequestedAt: time.Now().UnixMilli()})
		if err != nil {
			t.Fatal(err)
		}
		deliveries <- amqp091.Delivery{Body: body, Acknowledger: acker}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- worker.consumeDeliveries(ctx, deliveries, 2) }()

	started := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case username := <-collector.started:
			started[username] = true
		case <-time.After(5 * time.Second):
			t.Fatalf("only %d deliveries started concurrently: %v", len(started), started)
		}
	}
	close(collector.release)
	deadline := time.After(5 * time.Second)
	for atomic.LoadInt32(&acker.acked) < 2 {
		select {
		case <-deadline:
			t.Fatalf("acked=%d, want 2", acker.acked)
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("consumeDeliveries: %v", err)
	}
	if collector.completed.Load() != 2 {
		t.Fatalf("completed=%d, want 2", collector.completed.Load())
	}
}

type fakeScanCacheStatus struct {
	fakeStatusStore
	stored *ScanResult
}

func (s *fakeScanCacheStatus) GetCachedScan(context.Context, string) (*ScanResult, error) {
	return s.stored, nil
}
func (s *fakeScanCacheStatus) SetCachedScan(_ context.Context, _ string, scan ScanResult) error {
	s.stored = &scan
	return nil
}

func (p *fakeScanPublisher) PublishScan(context.Context, ScanJob) error { return nil }
func (p *fakeScanPublisher) PublishScanRetry(_ context.Context, job ScanJob, _ time.Duration) error {
	p.retry = append(p.retry, job)
	return nil
}
func (p *fakeScanPublisher) PublishScanDead(_ context.Context, job ScanJob, _ string) error {
	p.dead = append(p.dead, job)
	return nil
}

func TestScanWorkerPersistsGoCollectedResultAndMarksDuplicate(t *testing.T) {
	statuses := &fakeStatusStore{}
	worker := NewScanWorker(Config{MaxAttempts: 5}, &fakeScanCollector{scan: ScanResult{Metrics: RawMetrics{Username: "alice"}}}, &fakeScanResultStore{created: false}, statuses, &fakeScanPublisher{}, nil)
	job := ScanJob{ID: "job_scan", Username: "alice", RequestedAt: time.Now().UnixMilli()}
	disposition, reason := worker.process(context.Background(), job)
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("disposition=%v reason=%q", disposition, reason)
	}
	status, err := statuses.Get(context.Background(), job.ID)
	if err != nil || status == nil || status.Kind != ScanJobKind || status.State != JobCompleted || status.Error != "duplicate_delivery" {
		t.Fatalf("status=%#v err=%v", status, err)
	}
	for _, want := range []string{
		`ghfind_worker_jobs_started_total{kind="scan.quick.v1"} 1`,
		`ghfind_worker_jobs_completed_total{kind="scan.quick.v1",result="duplicate"} 1`,
		`ghfind_worker_job_duration_seconds_count{kind="scan.quick.v1"} 1`,
	} {
		if !strings.Contains(worker.metrics.Prometheus(), want) {
			t.Fatalf("missing metric %q in:\n%s", want, worker.metrics.Prometheus())
		}
	}
}

func TestScanWorkerClassifiesPermanentAndTransientCollectionFailures(t *testing.T) {
	job := ScanJob{ID: "job_scan", Username: "alice", RequestedAt: time.Now().UnixMilli()}
	permanent := NewScanWorker(Config{MaxAttempts: 5}, &fakeScanCollector{err: ErrGitHubAccountNotFound}, &fakeScanResultStore{}, &fakeStatusStore{}, &fakeScanPublisher{}, nil)
	if disposition, _ := permanent.process(context.Background(), job); disposition != workerDead {
		t.Fatalf("account not found disposition=%v", disposition)
	}
	transient := NewScanWorker(Config{MaxAttempts: 5}, &fakeScanCollector{err: errors.New("temporary GitHub outage")}, &fakeScanResultStore{}, &fakeStatusStore{}, &fakeScanPublisher{}, nil)
	if disposition, _ := transient.process(context.Background(), job); disposition != workerRetry {
		t.Fatalf("outage disposition=%v", disposition)
	}
}

func TestScanWorkerCachesOnlyAfterPersistenceSucceeds(t *testing.T) {
	statuses := &fakeScanCacheStatus{}
	scan := ScanResult{Metrics: RawMetrics{Username: "alice"}}
	worker := NewScanWorker(Config{MaxAttempts: 5}, &fakeScanCollector{scan: scan}, &fakeScanResultStore{created: true}, statuses, &fakeScanPublisher{}, nil)
	if disposition, reason := worker.process(context.Background(), ScanJob{ID: "job_scan", Username: "alice", RequestedAt: time.Now().UnixMilli()}); disposition != workerCompleted || reason != "" {
		t.Fatalf("disposition=%v reason=%q", disposition, reason)
	}
	if statuses.stored == nil || statuses.stored.Metrics.Username != "alice" {
		t.Fatalf("cached scan = %#v", statuses.stored)
	}
}
