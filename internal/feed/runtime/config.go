// Package runtime wires portable Feed capabilities. Platform dependencies remain
// behind ordinary HTTP or database interfaces and no legacy process is started.
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/hikariming/ghfind/internal/backend"
	"github.com/hikariming/ghfind/internal/feed/auth"
)

type Config struct {
	Port           string
	Mode           backend.FeedMode
	StoreProfile   string
	DatabaseURL    string
	BridgeEndpoint string
	BridgeSecret   string
	GatewaySecret  string
	SigningSecret  string
	WriterEpoch    int64
}

func LoadConfig() (Config, error) { return loadConfig(true) }
func loadConfig(api bool) (Config, error) {
	c := Config{Port: os.Getenv("PORT"), Mode: backend.ParseFeedMode(os.Getenv("FEED_MODE")), StoreProfile: os.Getenv("FEED_STORE_PROFILE"), DatabaseURL: os.Getenv("FEED_DATABASE_URL"), BridgeEndpoint: os.Getenv("FEED_BRIDGE_ENDPOINT"), BridgeSecret: os.Getenv("FEED_BRIDGE_SECRET"), GatewaySecret: os.Getenv("FEED_GATEWAY_SECRET"), SigningSecret: os.Getenv("FEED_SIGNING_SECRET"), WriterEpoch: 1}
	if c.Port == "" {
		c.Port = "8080"
	}
	port, err := strconv.Atoi(c.Port)
	if err != nil || port < 1 || port > 65535 {
		return c, errors.New("PORT must be valid")
	}
	if epoch := os.Getenv("FEED_WRITER_EPOCH"); epoch != "" {
		c.WriterEpoch, err = strconv.ParseInt(epoch, 10, 64)
		if err != nil || c.WriterEpoch < 1 {
			return c, errors.New("FEED_WRITER_EPOCH must be positive")
		}
	}
	if c.Mode != backend.FeedModeOff && c.Mode != backend.FeedModeBaseline {
		return c, errors.New("independent Feed only supports off or baseline")
	}
	if c.StoreProfile != "cf_d1_r2" && c.StoreProfile != "postgres" {
		return c, errors.New("FEED_STORE_PROFILE must be cf_d1_r2 or postgres")
	}
	if api && (len(c.GatewaySecret) < 32 || len(c.SigningSecret) < 32 || c.GatewaySecret == c.SigningSecret) {
		return c, errors.New("distinct gateway and Feed signing secrets (>=32 bytes) required")
	}
	if c.StoreProfile == "cf_d1_r2" && (len(c.BridgeSecret) < 32 || (c.SigningSecret != "" && c.BridgeSecret == c.SigningSecret) || (c.GatewaySecret != "" && c.BridgeSecret == c.GatewaySecret)) {
		return c, errors.New("bridge secret must be independent")
	}
	return c, nil
}
func OpenStore(c Config) (backend.FeedServingStore, backend.FeedSessionStore, error) {
	switch c.StoreProfile {
	case "cf_d1_r2":
		store, err := backend.NewCFFeedStore(c.BridgeEndpoint, c.BridgeSecret, nil)
		if err != nil {
			return nil, nil, err
		}
		if err := store.SetWriterEpoch(c.WriterEpoch); err != nil {
			return nil, nil, err
		}
		return store, store, nil
	case "postgres":
		store, err := backend.OpenPostgresFeedStore(backend.Config{FeedDatabaseURL: c.DatabaseURL, FeedMode: c.Mode})
		if err != nil {
			return nil, nil, err
		}
		if err := store.EnablePortableRuntime(c.WriterEpoch); err != nil {
			store.Close()
			return nil, nil, err
		}
		return store, store, nil
	default:
		return nil, nil, errors.New("unknown Feed store profile")
	}
}
func APIHandler(c Config, version string, store backend.FeedServingStore, sessions backend.FeedSessionStore) (http.Handler, error) {
	verifier, err := auth.New(c.GatewaySecret, "feed-api")
	if err != nil {
		return nil, err
	}
	handler, err := backend.NewStandaloneFeedHandler(c.Mode, c.SigningSecret, store, sessions, func(r *http.Request, now time.Time) *backend.OAuthSession {
		claims, err := verifier.Verify(r, now)
		if err != nil {
			return nil
		}
		return &backend.OAuthSession{GitHubID: claims.GitHubID, Login: claims.Login, AvatarURL: claims.AvatarURL, ExpiresAt: claims.ExpiresAt}
	})
	if err != nil {
		return nil, err
	}
	return WithHealth(handler, c, version, "feed-api", store.Ping), nil
}
func WithHealth(handler http.Handler, c Config, version, service string, ready func(context.Context) error) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", handler)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeStatus(w, 200, map[string]any{"healthy": true, "service": service, "version": version, "contractVersion": backend.FeedBridgeVersion, "storageWriterVersion": backend.FeedStorageWriterVersion})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
		defer cancel()
		err := ready(ctx)
		status := 200
		if err != nil {
			status = 503
		}
		writeStatus(w, status, map[string]any{"ready": err == nil, "service": service, "version": version, "contractVersion": backend.FeedBridgeVersion, "storageWriterVersion": backend.FeedStorageWriterVersion, "storeProfile": c.StoreProfile, "writerEpoch": c.WriterEpoch})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(w, r)
	})
}
func writeStatus(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Serve drains in-flight work on SIGTERM without holding ephemeral task state.
func Serve(port string, handler http.Handler) error {
	return ServeWithWriteTimeout(port, handler, 30*time.Second)
}
func ServeWithWriteTimeout(port string, handler http.Handler, writeTimeout time.Duration) error {
	listener, err := net.Listen("tcp", ":"+strings.TrimSpace(port))
	if err != nil {
		return err
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: writeTimeout, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		slog.Info("draining Feed server")
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			return fmt.Errorf("drain feed: %w", err)
		}
		return nil
	}
}
