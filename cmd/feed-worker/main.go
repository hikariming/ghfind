package main

import (
	"log/slog"
	"os"
	"time"

	"github.com/hikariming/ghfind/internal/feed/runtime"
)

var version = "development"

func main() {
	if err := run(); err != nil {
		slog.Error("Feed executor stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	config, err := runtime.LoadWorkerConfig()
	if err != nil {
		return err
	}
	store, _, err := runtime.OpenStore(config.Config)
	if err != nil {
		return err
	}
	defer store.Close()
	handler, err := runtime.WorkerHandler(config, version, store)
	if err != nil {
		return err
	}
	return runtime.ServeWithWriteTimeout(config.Port, handler, 75*time.Second)
}
