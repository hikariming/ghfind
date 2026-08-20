package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hikariming/ghfind/internal/backend"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	config := backend.LoadConfigFromEnv()
	if err := config.ValidateAPI(); err != nil {
		logger.Error("invalid API configuration", "error", err)
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
		logger.Error("connect RabbitMQ", "error", err)
		os.Exit(1)
	}
	defer publisher.Close()

	checks := []func(context.Context) error{store.Ping, statuses.Ping, publisher.Ping}
	var feedStore *backend.PostgresFeedStore
	if config.FeedMode.Enabled() {
		feedStore, err = backend.OpenPostgresFeedStore(config)
		if err != nil {
			logger.Warn("Feed PostgreSQL configuration unavailable; core API will continue", "error", err)
			feedStore = nil
		} else {
			defer feedStore.Close()
			probeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			probeErr := feedStore.Ping(probeCtx)
			cancel()
			if probeErr != nil {
				logger.Warn("Feed PostgreSQL unavailable at startup; Feed will return 503 until recovery", "error", probeErr)
			}
		}
	}
	server := backend.NewAPIServer(config, store, statuses, publisher, checks...)
	if err := server.UseFeed(feedStore, statuses); err != nil {
		logger.Error("configure Feed API", "error", err)
		os.Exit(1)
	}
	if config.FeedGorseLiveBPS > 0 {
		gorseClient, gorseErr := backend.NewGorseClient(config)
		if gorseErr != nil {
			logger.Warn("live Gorse candidate source unavailable; baseline Feed will continue", "error", gorseErr)
		} else if err := server.UseFeedGorse(gorseClient.WithTimeout(200 * time.Millisecond)); err != nil {
			logger.Warn("live Gorse candidate source disabled; baseline Feed will continue", "error", err)
		}
	}
	httpServer := &http.Server{
		Addr:              config.APIListenAddr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		// A foreground scan can wait up to 55 seconds for the durable worker.
		// Keep the edge-facing server deadline beyond that public contract.
		WriteTimeout: 70 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	go func() {
		logger.Info("Go API listening", "address", config.APIListenAddr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("Go API stopped unexpectedly", "error", err)
			os.Exit(1)
		}
	}()
	shutdown(httpServer, logger)
}

func shutdown(server *http.Server, logger *slog.Logger) {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		logger.Error("graceful API shutdown failed", "error", err)
	}
}
