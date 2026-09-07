// Command ghfind-feed-bootstrap is an operator-triggered, one-shot PostgreSQL
// extension installer. It is intentionally separate from normal migrations and
// is never part of the automatic main-branch deployment gate.
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
	if err := feedmigration.BootstrapRequiredExtensions(
		ctx,
		os.Getenv("FEED_DATABASE_URL"),
		os.Getenv("FEED_EXTENSION_BOOTSTRAP_ACK"),
	); err != nil {
		logger.Error("Feed extension bootstrap failed", "error", err)
		os.Exit(1)
	}
	logger.Info("Feed PostgreSQL extensions installed")
}
