package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/rabbitmq/amqp091-go"
)

type workerDisposition int

const (
	workerCompleted workerDisposition = iota
	workerRetry
	workerDead

	workerProcessTimeout  = 30 * time.Second
	workerDeliveryTimeout = 10 * time.Second
)

// Worker is the process-side implementation of a durable score-history task.
// It has no dependency on a Next runtime and can be restarted independently.
type Worker struct {
	config    Config
	snapshots ScoreSnapshotStore
	statuses  JobStatusStore
	publisher ScoreSnapshotPublisher
	metrics   *BackendMetrics
	log       *slog.Logger
}

func NewWorker(
	config Config,
	snapshots ScoreSnapshotStore,
	statuses JobStatusStore,
	publisher ScoreSnapshotPublisher,
	logger *slog.Logger,
) *Worker {
	if logger == nil {
		logger = slog.Default()
	}
	return &Worker{config: config, snapshots: snapshots, statuses: statuses, publisher: publisher, metrics: NewBackendMetrics(), log: logger}
}

func (w *Worker) UseMetrics(metrics *BackendMetrics) *Worker {
	if metrics != nil {
		w.metrics = metrics
	}
	return w
}

// Run consumes until cancellation or a broker/channel failure. The command
// entrypoint reconnects after a bounded backoff, so transient broker failures
// do not turn into a silently dead worker.
func (w *Worker) Run(ctx context.Context) error {
	connection, err := amqp091.Dial(w.config.RabbitURL)
	if err != nil {
		return fmt.Errorf("dial RabbitMQ consumer: %w", err)
	}
	defer connection.Close()
	channel, err := connection.Channel()
	if err != nil {
		return fmt.Errorf("open RabbitMQ consume channel: %w", err)
	}
	defer channel.Close()
	if err := declareJobTopology(channel); err != nil {
		return err
	}
	if err := channel.Qos(4, 0, false); err != nil {
		return fmt.Errorf("configure worker prefetch: %w", err)
	}
	deliveries, err := channel.Consume(scoreSnapshotQueue, "ghfind-score-snapshot-worker", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume score snapshot jobs: %w", err)
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case delivery, open := <-deliveries:
			if !open {
				return fmt.Errorf("RabbitMQ delivery channel closed")
			}
			w.handleDelivery(ctx, delivery)
		}
	}
}

func (w *Worker) handleDelivery(ctx context.Context, delivery amqp091.Delivery) {
	var job ScoreSnapshotJob
	if err := json.Unmarshal(delivery.Body, &job); err != nil || job.ID == "" || job.Username == "" {
		w.log.Error("discarding malformed score snapshot job", "error", err)
		_ = delivery.Reject(false)
		return
	}
	processCtx, cancel := context.WithTimeout(ctx, workerProcessTimeout)
	disposition, reason := w.process(processCtx, job)
	cancel()
	switch disposition {
	case workerCompleted:
		if err := delivery.Ack(false); err != nil {
			w.log.Error("acknowledge completed job", "job_id", job.ID, "error", err)
		}
	case workerRetry:
		next := job
		next.Attempt++
		if next.Attempt >= w.config.MaxAttempts {
			w.deadLetterOrRequeue(ctx, delivery, next, reason)
			return
		}
		retryCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
		err := w.publisher.PublishRetry(retryCtx, next, retryDelay(next.Attempt))
		cancel()
		if err != nil {
			w.log.Error("publish retry job", "job_id", job.ID, "error", err)
			_ = delivery.Nack(false, true)
			return
		}
		statusCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
		err = w.statuses.Put(statusCtx, newJobStatus(next, JobRetrying, reason))
		cancel()
		if err != nil {
			w.log.Error("record retrying job state", "job_id", job.ID, "error", err)
			// The retry message already received a broker confirm. Ack the source
			// delivery so an Upstash outage cannot create an immediate duplicate;
			// the next delivery will repair its visible status.
		}
		_ = delivery.Ack(false)
	case workerDead:
		w.deadLetterOrRequeue(ctx, delivery, job, reason)
	}
}

func (w *Worker) deadLetterOrRequeue(ctx context.Context, delivery amqp091.Delivery, job ScoreSnapshotJob, reason string) {
	// Record the terminal state first. If that dependency is down, leave the
	// source delivery unacked so no dead-letter event is emitted without a
	// queryable terminal status. Once the status is durable, a broker failure can
	// safely requeue and overwrite the same failed state on the next attempt.
	statusCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
	err := w.statuses.Put(statusCtx, newJobStatus(job, JobFailed, reason))
	cancel()
	if err != nil {
		w.log.Error("record terminal job failure", "job_id", job.ID, "error", err)
		_ = delivery.Nack(false, true)
		return
	}
	publishCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
	err = w.publisher.PublishDead(publishCtx, job, reason)
	cancel()
	if err != nil {
		w.log.Error("publish terminal job failure", "job_id", job.ID, "error", err)
		_ = delivery.Nack(false, true)
		return
	}
	w.metrics.recordWorkerJobDeadLettered(ScoreSnapshotJobKind)
	_ = delivery.Ack(false)
}

func (w *Worker) process(ctx context.Context, job ScoreSnapshotJob) (workerDisposition, string) {
	startedAt := time.Now()
	w.metrics.recordWorkerJobStarted(ScoreSnapshotJobKind)
	attempt := job.Attempt + 1
	running := newJobStatus(job, JobRunning, "")
	running.Attempt = attempt
	if err := w.statuses.Put(ctx, running); err != nil {
		w.metrics.recordWorkerJobRetry(ScoreSnapshotJobKind, time.Since(startedAt))
		return workerRetry, "status store unavailable: " + err.Error()
	}
	created, err := w.snapshots.PersistScoreSnapshot(ctx, job)
	if errors.Is(err, ErrScoreNotFound) {
		w.metrics.recordWorkerJobFailed(ScoreSnapshotJobKind, "permanent", time.Since(startedAt))
		return workerDead, ErrScoreNotFound.Error()
	}
	if err != nil {
		w.metrics.recordWorkerJobRetry(ScoreSnapshotJobKind, time.Since(startedAt))
		return workerRetry, err.Error()
	}
	completed := newJobStatus(job, JobCompleted, "")
	completed.Attempt = attempt
	if !created {
		completed.Error = "duplicate_delivery"
	}
	if err := w.statuses.Put(ctx, completed); err != nil {
		w.metrics.recordWorkerJobRetry(ScoreSnapshotJobKind, time.Since(startedAt))
		return workerRetry, "status store unavailable: " + err.Error()
	}
	result := "created"
	if !created {
		result = "duplicate"
	}
	w.metrics.recordWorkerJobCompleted(ScoreSnapshotJobKind, result, time.Since(startedAt))
	return workerCompleted, ""
}

func newJobStatus(job ScoreSnapshotJob, state JobState, message string) JobStatus {
	now := time.Now().UTC()
	createdAt := time.UnixMilli(job.RequestedAt).UTC()
	return JobStatus{
		ID:        job.ID,
		Kind:      ScoreSnapshotJobKind,
		Username:  job.Username,
		State:     state,
		Attempt:   job.Attempt,
		CreatedAt: createdAt,
		UpdatedAt: now,
		Error:     message,
	}
}
