package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/rabbitmq/amqp091-go"
)

const scanWorkerProcessTimeout = 2 * time.Minute

type ScanCollector interface {
	Collect(context.Context, string) (ScanResult, error)
}

// ScanWorker is independently restartable from the HTTP API. It is the real
// asynchronous scan path: collect from GitHub -> score in Go -> atomically
// persist existing Turso records -> queryable Upstash terminal status.
type ScanWorker struct {
	config     Config
	collector  ScanCollector
	results    ScanResultStore
	statuses   JobStatusStore
	scanCache  ScanCache
	outcomes   ScanOutcomeStore
	lookupGate LookupGate
	flightGate ScanFlightGate
	revisions  CampaignRevisionWriter
	publisher  ScanJobPublisher
	metrics    *BackendMetrics
	log        *slog.Logger
}

func NewScanWorker(config Config, collector ScanCollector, results ScanResultStore, statuses JobStatusStore, publisher ScanJobPublisher, logger *slog.Logger) *ScanWorker {
	if logger == nil {
		logger = slog.Default()
	}
	worker := &ScanWorker{config: config, collector: collector, results: results, statuses: statuses, publisher: publisher, metrics: NewBackendMetrics(), log: logger}
	if cache, ok := statuses.(ScanCache); ok {
		worker.scanCache = cache
	}
	if outcomes, ok := results.(ScanOutcomeStore); ok {
		worker.outcomes = outcomes
	}
	if gate, ok := statuses.(LookupGate); ok {
		worker.lookupGate = gate
	}
	if gate, ok := statuses.(ScanFlightGate); ok {
		worker.flightGate = gate
	}
	if revisions, ok := statuses.(CampaignRevisionWriter); ok {
		worker.revisions = revisions
	}
	return worker
}

func (w *ScanWorker) UseMetrics(metrics *BackendMetrics) *ScanWorker {
	if metrics != nil {
		w.metrics = metrics
	}
	return w
}

func (w *ScanWorker) Run(ctx context.Context) error {
	connection, err := amqp091.Dial(w.config.RabbitURL)
	if err != nil {
		return fmt.Errorf("dial RabbitMQ scan consumer: %w", err)
	}
	defer connection.Close()
	channel, err := connection.Channel()
	if err != nil {
		return fmt.Errorf("open scan worker channel: %w", err)
	}
	defer channel.Close()
	if err := declareJobTopology(channel); err != nil {
		return err
	}
	concurrency := w.config.ScanConcurrency
	if concurrency < 1 {
		concurrency = 1
	}
	// Prefetch exactly the number of jobs this process works on in parallel:
	// scans are latency-bound on sequential GitHub API calls, so a prefetch of
	// one would serialize the whole fleet behind a single slow collection.
	if err := channel.Qos(concurrency, 0, false); err != nil {
		return fmt.Errorf("configure scan worker prefetch: %w", err)
	}
	deliveries, err := channel.Consume(scanQueue, "ghfind-scan-worker", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume scan jobs: %w", err)
	}
	return w.consumeDeliveries(ctx, deliveries, concurrency)
}

// consumeDeliveries processes deliveries with bounded parallelism. Each job
// runs in its own goroutine; every store/publisher dependency is safe for
// concurrent use (per-publish AMQP channels, atomic token rotation, mutexed
// metrics). On shutdown the broker context cancels in-flight jobs, which then
// nack/requeue so a restarted worker picks them up.
func (w *ScanWorker) consumeDeliveries(ctx context.Context, deliveries <-chan amqp091.Delivery, concurrency int) error {
	semaphore := make(chan struct{}, concurrency)
	var inFlight sync.WaitGroup
	for {
		select {
		case <-ctx.Done():
			inFlight.Wait()
			return nil
		case delivery, open := <-deliveries:
			if !open {
				inFlight.Wait()
				return fmt.Errorf("RabbitMQ scan delivery channel closed")
			}
			semaphore <- struct{}{}
			inFlight.Add(1)
			go func() {
				defer inFlight.Done()
				defer func() { <-semaphore }()
				w.handleDelivery(ctx, delivery)
			}()
		}
	}
}

func (w *ScanWorker) handleDelivery(ctx context.Context, delivery amqp091.Delivery) {
	var job ScanJob
	if err := json.Unmarshal(delivery.Body, &job); err != nil || job.ID == "" || job.Username == "" {
		w.log.Error("discarding malformed scan job", "error", err)
		_ = delivery.Reject(false)
		return
	}
	processCtx, cancel := context.WithTimeout(ctx, scanWorkerProcessTimeout)
	disposition, reason := w.process(processCtx, job)
	cancel()
	switch disposition {
	case workerCompleted:
		_ = delivery.Ack(false)
		w.releaseFlight(ctx, job)
	case workerRetry:
		next := job
		next.Attempt++
		if next.Attempt >= w.config.MaxAttempts {
			w.deadLetterOrRequeue(ctx, delivery, next, reason)
			return
		}
		publishCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
		err := w.publisher.PublishScanRetry(publishCtx, next, retryDelay(next.Attempt))
		cancel()
		if err != nil {
			w.log.Error("publish scan retry", "job_id", job.ID, "error", err)
			_ = delivery.Nack(false, true)
			return
		}
		statusCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
		err = w.statuses.Put(statusCtx, newScanJobStatus(next, JobRetrying, reason))
		cancel()
		if err != nil {
			w.log.Error("record scan retry status", "job_id", job.ID, "error", err)
		}
		_ = delivery.Ack(false)
	case workerDead:
		w.deadLetterOrRequeue(ctx, delivery, job, reason)
		w.releaseFlight(ctx, job)
	}
}

func (w *ScanWorker) process(ctx context.Context, job ScanJob) (workerDisposition, string) {
	startedAt := time.Now()
	w.metrics.recordWorkerJobStarted(ScanJobKind)
	attempt := job.Attempt + 1
	running := newScanJobStatus(job, JobRunning, "")
	running.Attempt = attempt
	if err := w.statuses.Put(ctx, running); err != nil {
		w.metrics.recordWorkerJobRetry(ScanJobKind, time.Since(startedAt))
		return workerRetry, "status store unavailable: " + err.Error()
	}
	scan, err := w.collector.Collect(ctx, job.Username)
	if err != nil {
		if errors.Is(err, ErrGitHubAccountNotFound) || errors.Is(err, ErrGitHubAuthRequired) {
			w.metrics.recordWorkerJobFailed(ScanJobKind, "permanent", time.Since(startedAt))
			return workerDead, err.Error()
		}
		w.metrics.recordWorkerJobRetry(ScanJobKind, time.Since(startedAt))
		return workerRetry, err.Error()
	}
	created, err := w.results.PersistCollectedScan(ctx, job, scan)
	if errors.Is(err, ErrScanJobConflict) {
		w.metrics.recordWorkerJobFailed(ScanJobKind, "conflict", time.Since(startedAt))
		return workerDead, err.Error()
	}
	if err != nil {
		w.metrics.recordWorkerJobRetry(ScanJobKind, time.Since(startedAt))
		return workerRetry, err.Error()
	}
	if w.scanCache != nil {
		// Turso remains the authoritative result. A cache failure must never make
		// a successfully committed scan retry and write a newer-looking score.
		if err := w.scanCache.SetCachedScan(ctx, scan.Metrics.Username, scan); err != nil {
			w.log.Warn("cache collected scan", "job_id", job.ID, "error", err)
		}
	}
	if created {
		recordSuccessfulScanOutcome(ctx, w.outcomes, w.lookupGate, w.revisions, scan.Metrics.Username, job.LookupHash, job.Campaign, time.Now().UTC())
	}
	completed := newScanJobStatus(job, JobCompleted, "")
	completed.Attempt = attempt
	if !created {
		completed.Error = "duplicate_delivery"
	}
	if err := w.statuses.Put(ctx, completed); err != nil {
		w.metrics.recordWorkerJobRetry(ScanJobKind, time.Since(startedAt))
		return workerRetry, "status store unavailable: " + err.Error()
	}
	result := "created"
	if !created {
		result = "duplicate"
	}
	w.metrics.recordWorkerJobCompleted(ScanJobKind, result, time.Since(startedAt))
	return workerCompleted, ""
}

func (w *ScanWorker) releaseFlight(ctx context.Context, job ScanJob) {
	if !job.FlightLock || w.flightGate == nil {
		return
	}
	if err := w.flightGate.ReleaseScanFlight(ctx, job.Username); err != nil {
		w.log.Warn("release scan flight lock", "job_id", job.ID, "error", err)
	}
}

func (w *ScanWorker) deadLetterOrRequeue(ctx context.Context, delivery amqp091.Delivery, job ScanJob, reason string) {
	statusCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
	err := w.statuses.Put(statusCtx, newScanJobStatus(job, JobFailed, reason))
	cancel()
	if err != nil {
		w.log.Error("record terminal scan status", "job_id", job.ID, "error", err)
		_ = delivery.Nack(false, true)
		return
	}
	publishCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
	err = w.publisher.PublishScanDead(publishCtx, job, reason)
	cancel()
	if err != nil {
		w.log.Error("publish terminal scan failure", "job_id", job.ID, "error", err)
		_ = delivery.Nack(false, true)
		return
	}
	w.metrics.recordWorkerJobDeadLettered(ScanJobKind)
	_ = delivery.Ack(false)
}

func newScanJobStatus(job ScanJob, state JobState, message string) JobStatus {
	now := time.Now().UTC()
	return JobStatus{ID: job.ID, Kind: ScanJobKind, Username: job.Username, State: state, Attempt: job.Attempt, CreatedAt: time.UnixMilli(job.RequestedAt).UTC(), UpdatedAt: now, Error: message}
}
