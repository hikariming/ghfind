package runtime

import (
	"context"
	"errors"
	"net/http"
	"os"

	"github.com/hikariming/ghfind/internal/backend"
)

type WorkerConfig struct {
	Config
	Enabled                                      bool
	ExecutorSecret, SourceEndpoint, SourceSecret string
}

func LoadWorkerConfig() (WorkerConfig, error) {
	c, err := loadConfig(false)
	if err != nil {
		return WorkerConfig{}, err
	}
	out := WorkerConfig{Config: c, Enabled: os.Getenv("FEED_EXECUTOR_ENABLED") == "true", ExecutorSecret: os.Getenv("FEED_EXECUTOR_SECRET"), SourceEndpoint: os.Getenv("FEED_SOURCE_ENDPOINT"), SourceSecret: os.Getenv("FEED_SOURCE_SECRET")}
	if out.Enabled && (len(out.ExecutorSecret) < 32 || len(out.SourceSecret) < 32 || out.SourceSecret == out.ExecutorSecret || out.ExecutorSecret == c.BridgeSecret || out.SourceSecret == c.BridgeSecret) {
		return out, errors.New("executor, source and bridge secrets must be independent and at least32bytes")
	}
	return out, nil
}
func WorkerHandler(c WorkerConfig, version string, store backend.FeedServingStore) (http.Handler, error) {
	if !c.Enabled {
		unavailable := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeStatus(w, 503, map[string]string{"error": "executor_disabled"})
		})
		return WithHealth(unavailable, c.Config, version, "feed-worker", func(context.Context) error { return errors.New("executor disabled") }), nil
	}
	jobs, ok := store.(backend.FeedJobStore)
	if !ok {
		return nil, errors.New("durable job backend unavailable")
	}
	catalog, ok := store.(backend.FeedCatalogProjectionStore)
	if !ok {
		return nil, errors.New("catalog projection backend unavailable")
	}
	source, err := backend.NewHTTPAssessmentSource(c.SourceEndpoint, c.SourceSecret)
	if err != nil {
		return nil, err
	}
	executor, err := backend.NewFeedExecutor(jobs, catalog, source, c.WriterEpoch, c.ExecutorSecret)
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle("/internal/feed/jobs/execute", executor)
	if c.StoreProfile == "cf_d1_r2" {
		cleanupStore, err := backend.NewHTTPFeedCleanupStore(c.BridgeEndpoint, c.ExecutorSecret)
		if err != nil {
			return nil, err
		}
		cleanup, err := backend.NewFeedCleanupExecutor(cleanupStore, c.WriterEpoch, c.ExecutorSecret)
		if err != nil {
			return nil, err
		}
		mux.Handle("/internal/feed/jobs/cleanup", cleanup)
	} else {
		mux.HandleFunc("/internal/feed/jobs/cleanup", func(w http.ResponseWriter, r *http.Request) {
			writeStatus(w, 503, map[string]string{"error": "archive_cleanup_unconfigured"})
		})
	}
	return WithHealth(mux, c.Config, version, "feed-worker", func(ctx context.Context) error {
		if err := store.Ping(ctx); err != nil {
			return err
		}
		return source.Ping(ctx)
	}), nil
}
