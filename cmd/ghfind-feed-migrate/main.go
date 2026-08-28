package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hikariming/ghfind/internal/feedmigration"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := feedmigration.Run(ctx, os.Getenv("FEED_DATABASE_URL")); err != nil {
		logger.Error("Feed migration failed", "error", err)
		os.Exit(1)
	}
	logger.Info("Feed migrations complete")
}
