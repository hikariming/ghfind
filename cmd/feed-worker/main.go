package main

import (
	"log/slog"
	"os"
	"time"

	"github.com/hikariming/ghfind/internal/feed/runtime"
)

var version = "development"
var imageBuildID = "development"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--build-info" {
		if err := runtime.WriteBuildInfo(os.Stdout, "feed-worker", version, imageBuildID); err != nil {
			os.Exit(1)
		}
		return
	}
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
	config.ImageBuildID = imageBuildID
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
