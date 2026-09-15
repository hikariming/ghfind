package main

import (
	"github.com/hikariming/ghfind/internal/feed/runtime"
	"log/slog"
	"os"
)

var version = "development"
var imageBuildID = "development"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--build-info" {
		if err := runtime.WriteBuildInfo(os.Stdout, "feed-api", version, imageBuildID); err != nil {
			os.Exit(1)
		}
		return
	}
	if err := run(); err != nil {
		slog.Error("Feed API stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	config, err := runtime.LoadConfig()
	if err != nil {
		return err
	}
	config.ImageBuildID = imageBuildID
	store, sessions, err := runtime.OpenStore(config)
	if err != nil {
		return err
	}
	defer store.Close()
	handler, err := runtime.APIHandler(config, version, store, sessions)
	if err != nil {
		return err
	}
	return runtime.Serve(config.Port, handler)
}
