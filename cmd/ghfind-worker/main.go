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

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// The worker serves its own liveness/readiness probes next to /metrics so
	// Docker HEALTHCHECK and Railway can restart a silently dead consumer.
	// /readyz fails closed until Turso, Upstash, and RabbitMQ all ping cleanly.
	handler := http.NewServeMux()
	handler.Handle("/metrics", metrics.Handler())
	handler.Handle("/", backend.NewWorkerHealthHandler(
		func(ctx context.Context) error { return store.Ping(ctx) },
		func(ctx context.Context) error { return statuses.Ping(ctx) },
		func(ctx context.Context) error { return publisher.Ping(ctx) },
	))
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
	consumers.Add(3)
	go runConsumer("score-snapshot", scoreWorker.Run)
	go runConsumer("scan", scanWorker.Run)
	go runConsumer("project-analysis", projectAnalysisWorker.Run)
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := metricsServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful worker metrics shutdown failed", "error", err)
	}
	consumers.Wait()
}
