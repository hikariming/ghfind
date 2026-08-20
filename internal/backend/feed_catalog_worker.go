package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/rabbitmq/amqp091-go"
)

type FeedCatalogProjectionWorker struct {
	config     Config
	reconciler *FeedProjectReconciler
	publisher  FeedCatalogSyncPublisher
	log        *slog.Logger
}

func NewFeedCatalogProjectionWorker(
	config Config,
	reconciler *FeedProjectReconciler,
	publisher FeedCatalogSyncPublisher,
	logger *slog.Logger,
) *FeedCatalogProjectionWorker {
	if logger == nil {
		logger = slog.Default()
	}
	return &FeedCatalogProjectionWorker{config: config, reconciler: reconciler, publisher: publisher, log: logger}
}

func (w *FeedCatalogProjectionWorker) Run(ctx context.Context) error {
	if w.reconciler == nil || w.publisher == nil {
		return fmt.Errorf("Feed catalog projection dependencies are required")
	}
	connection, err := amqp091.Dial(w.config.RabbitURL)
	if err != nil {
		return fmt.Errorf("dial RabbitMQ for Feed catalog projection: %w", err)
	}
	defer connection.Close()
	channel, err := connection.Channel()
	if err != nil {
		return err
	}
	defer channel.Close()
	if err := declareJobTopology(channel); err != nil {
		return err
	}
	if err := channel.Qos(4, 0, false); err != nil {
		return err
	}
	deliveries, err := channel.Consume(feedCatalogSyncQueue, "ghfind-feed-catalog-worker", false, false, false, false, nil)
	if err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case delivery, open := <-deliveries:
			if !open {
				return fmt.Errorf("Feed catalog projection delivery channel closed")
			}
			w.handleDelivery(ctx, delivery)
		}
	}
}

func (w *FeedCatalogProjectionWorker) handleDelivery(ctx context.Context, delivery amqp091.Delivery) {
	var job FeedCatalogSyncJob
	if err := json.Unmarshal(delivery.Body, &job); err != nil || strings.TrimSpace(job.RepoKey) == "" || strings.TrimSpace(job.AnalysisID) == "" {
		w.log.Error("discarding malformed Feed catalog sync job", "error", err)
		_ = delivery.Reject(false)
		return
	}
	projected, err := w.reconciler.SyncProject(ctx, job.RepoKey)
	if err == nil {
		w.log.Info("Feed catalog event applied", "repo_key", job.RepoKey, "analysis_id", job.AnalysisID, "changed", projected)
		_ = delivery.Ack(false)
		return
	}
	next := job
	next.Attempt++
	publishCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
	defer cancel()
	if next.Attempt >= w.config.MaxAttempts {
		if deadErr := w.publisher.PublishFeedCatalogSyncDead(publishCtx, next, err.Error()); deadErr != nil {
			w.log.Error("dead-letter Feed catalog sync failed; requeueing original", "repo_key", job.RepoKey, "error", deadErr)
			_ = delivery.Nack(false, true)
			return
		}
		w.log.Error("Feed catalog sync exhausted retries", "repo_key", job.RepoKey, "error", err)
		_ = delivery.Ack(false)
		return
	}
	if retryErr := w.publisher.PublishFeedCatalogSyncRetry(publishCtx, next, retryDelay(next.Attempt)); retryErr != nil {
		w.log.Error("publish Feed catalog retry failed; requeueing original", "repo_key", job.RepoKey, "error", retryErr)
		_ = delivery.Nack(false, true)
		return
	}
	w.log.Warn("Feed catalog sync scheduled for retry", "repo_key", job.RepoKey, "attempt", next.Attempt, "error", err)
	_ = delivery.Ack(false)
}
