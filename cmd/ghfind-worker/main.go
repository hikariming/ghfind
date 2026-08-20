package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/hikariming/ghfind/internal/backend"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	config := backend.LoadConfigFromEnv()
	if err := config.ValidateWorker(); err != nil {
		logger.Error("invalid worker configuration", "error", err)
		os.Exit(1)
	}
	store, err := backend.OpenTursoStore(config)
	if err != nil {
		logger.Error("open Turso store", "error", err)
		os.Exit(1)
	}
	defer store.Close()
	statuses, err := backend.NewUpstashStatusStore(config)
	if err != nil {
		logger.Error("open job status store", "error", err)
		os.Exit(1)
	}
	publisher, err := backend.OpenRabbitPublisher(config.RabbitURL)
	if err != nil {
		logger.Error("connect RabbitMQ publisher", "error", err)
		os.Exit(1)
	}
	defer publisher.Close()
	metrics := backend.NewBackendMetrics()
	scoreWorker := backend.NewWorker(config, store, statuses, publisher, logger).UseMetrics(metrics)
	scanWorker := backend.NewScanWorker(
		config,
		backend.NewGitHubCollector(backend.NewGitHubClient(config.GitHubToken)),
		store,
		statuses,
		publisher,
		logger,
	).UseMetrics(metrics)
	projectAnalysisWorker := backend.NewProjectAnalysisWorker(
		config,
		store,
		backend.NewMosooClient(config),
		statuses,
		publisher,
		logger,
	).UseMetrics(metrics)
	var feedStore *backend.PostgresFeedStore
	var feedReconciler *backend.FeedProjectReconciler
	var feedOutboxRelay *backend.FeedOutboxRelay
	var feedEmbeddingWorker *backend.FeedEmbeddingWorker
	var feedGorseWorker *backend.FeedGorseProjectionWorker
	var feedMaintenanceWorker *backend.FeedMaintenanceWorker
	var feedCatalogWorker *backend.FeedCatalogProjectionWorker
	if config.FeedMode.Enabled() {
		feedStore, err = backend.OpenPostgresFeedStore(config)
		if err != nil {
			logger.Warn("Feed PostgreSQL configuration unavailable; core workers will continue", "error", err)
			feedStore = nil
		} else {
			defer feedStore.Close()
			probeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			probeErr := feedStore.Ping(probeCtx)
			cancel()
			if probeErr != nil {
				logger.Warn("Feed PostgreSQL unavailable at startup; Feed workers will retry independently", "error", probeErr)
			}
			if config.EmbeddingBaseURL != "" {
				embeddingProvider, providerErr := backend.NewFeedEmbeddingProvider(config)
				if providerErr != nil {
					logger.Warn("Feed embedding provider disabled; tag-only Feed will continue", "error", providerErr)
				} else {
					feedEmbeddingWorker = backend.NewFeedEmbeddingWorker(feedStore, embeddingProvider, config.EmbeddingModel, logger)
				}
			}
			feedReconciler = backend.NewFeedProjectReconciler(store, feedStore, logger)
			feedCatalogWorker = backend.NewFeedCatalogProjectionWorker(config, feedReconciler, publisher, logger)
			feedMaintenanceWorker = backend.NewFeedMaintenanceWorker(feedStore, logger).
				UseMetrics(metrics).
				UseShadowOutcomeWindow(config.FeedShadowOutcomeWindow)
			feedOutboxRelay, err = backend.NewFeedOutboxRelay(feedStore, publisher, logger)
			if err != nil {
				logger.Warn("Feed outbox relay disabled; core workers will continue", "error", err)
			}
			var gorseClient backend.FeedGorseClient
			if config.FeedMode == backend.FeedModeGorseShadow || config.FeedMode == backend.FeedModeGorseCanary {
				configuredGorseClient, gorseErr := backend.NewGorseClient(config)
				if gorseErr != nil {
					logger.Warn("Gorse projection unavailable; baseline Feed will continue", "error", gorseErr)
				} else {
					gorseClient = configuredGorseClient
				}
			}
			// Always drain the Feed projection queue. In baseline mode the worker
			// acknowledges projections without an external side effect; enabling
			// Gorse requires an explicit, repeatable full rebuild first.
			feedGorseWorker = backend.NewFeedGorseProjectionWorker(config, feedStore, gorseClient, logger).UseMetrics(metrics)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// The worker serves its own liveness/readiness probes next to /metrics so
	// Docker HEALTHCHECK and Railway can restart a silently dead consumer.
	// /readyz fails closed until Turso, Upstash, and RabbitMQ all ping cleanly.
	handler := http.NewServeMux()
	handler.Handle("/metrics", metrics.Handler())
	checks := []func(context.Context) error{
		func(ctx context.Context) error { return store.Ping(ctx) },
		func(ctx context.Context) error { return statuses.Ping(ctx) },
		func(ctx context.Context) error { return publisher.Ping(ctx) },
	}
	var feedCheck func(context.Context) error
	if config.FeedMode.Enabled() {
		if feedStore != nil {
			feedCheck = feedStore.Ping
		} else {
			feedCheck = func(context.Context) error { return errors.New("Feed PostgreSQL is not configured") }
		}
	}
	handler.Handle("/", backend.NewWorkerHealthHandlerWithFeed(feedCheck, checks...))
	metricsServer := &http.Server{
		Addr:              config.WorkerMetricsListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	go func() {
		logger.Info("worker metrics listening", "address", config.WorkerMetricsListenAddr)
		if err := metricsServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("worker metrics stopped unexpectedly", "error", err)
			stop()
		}
	}()
	var consumers sync.WaitGroup
	runConsumer := func(name string, consume func(context.Context) error) {
		defer consumers.Done()
		for {
			err := consume(ctx)
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				logger.Error("worker consumer stopped; reconnecting", "consumer", name, "error", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(3 * time.Second):
			}
		}
	}
	consumerCount := 3
	if feedReconciler != nil {
		consumerCount++
	}
	if feedCatalogWorker != nil {
		consumerCount++
	}
	if feedOutboxRelay != nil {
		consumerCount++
	}
	if feedMaintenanceWorker != nil {
		consumerCount++
	}
	if feedEmbeddingWorker != nil {
		consumerCount++
	}
	if feedGorseWorker != nil {
		consumerCount++
	}
	consumers.Add(consumerCount)
	go runConsumer("score-snapshot", scoreWorker.Run)
	go runConsumer("scan", scanWorker.Run)
	go runConsumer("project-analysis", projectAnalysisWorker.Run)
	if feedReconciler != nil {
		go runConsumer("feed-project-reconcile", feedReconciler.Run)
	}
	if feedCatalogWorker != nil {
		go runConsumer("feed-catalog-events", feedCatalogWorker.Run)
	}
	if feedOutboxRelay != nil {
		go runConsumer("feed-outbox-relay", feedOutboxRelay.Run)
	}
	if feedMaintenanceWorker != nil {
		go runConsumer("feed-maintenance", feedMaintenanceWorker.Run)
	}
	if feedEmbeddingWorker != nil {
		go runConsumer("feed-embeddings", feedEmbeddingWorker.Run)
	}
	if feedGorseWorker != nil {
		go runConsumer("feed-gorse-projection", feedGorseWorker.Run)
	}
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := metricsServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful worker metrics shutdown failed", "error", err)
	}
	consumers.Wait()
}
