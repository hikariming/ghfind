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

	server := backend.NewAPIServer(config, store, statuses, publisher, store.Ping, statuses.Ping, publisher.Ping)
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
