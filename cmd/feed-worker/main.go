package main

import (
	"context"
	"errors"
	"github.com/hikariming/ghfind/internal/feed/runtime"
	"log/slog"
	"net/http"
	"os"
)

var version = "development"

// The worker binary is deliberately unable to advertise readiness until a
// durable task backend and verified-assessment handler are installed. It does
// not start RabbitMQ or silently acknowledge unsupported messages.
func main() {
	config, err := runtime.LoadConfig()
	if err != nil {
		slog.Error("Feed executor configuration rejected", "error", err)
		os.Exit(1)
	}
	unavailable := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"executor_handlers_unconfigured"}`, http.StatusServiceUnavailable)
	})
	handler := runtime.WithHealth(unavailable, config, version, "feed-worker", func(context.Context) error { return errors.New("durable executor handlers are not configured") })
	if err := runtime.Serve(config.Port, handler); err != nil {
		slog.Error("Feed executor stopped", "error", err)
		os.Exit(1)
	}
}
