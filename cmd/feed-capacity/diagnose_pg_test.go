//go:build feeddiagnostic

package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hikariming/ghfind/internal/backend"
	"github.com/hikariming/ghfind/internal/feed/auth"
	feedruntime "github.com/hikariming/ghfind/internal/feed/runtime"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// Explicit opt-in integration regression, separate from the 100-request CLI.
// It never creates fixtures, modifies limits, or produces a capacity report.
func TestDiagnosticPostgresTwoRequests(t *testing.T) {
	dsn := os.Getenv("FEED_DIAGNOSIS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("explicit owned synthetic diagnostic fixture required")
	}
	if err := validateDSN(dsn); err != nil {
		t.Fatal(err)
	}
	baseline := os.Getenv("FEED_DIAGNOSIS_TEST_BASELINE")
	if !regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(baseline) {
		t.Fatal("exact test baseline SHA required")
	}
	out := os.Getenv("FEED_DIAGNOSIS_TEST_OUT")
	if out == "" {
		out = t.TempDir()
	}
	if err := os.MkdirAll(out, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(out, "two-request-regression.json")); !os.IsNotExist(err) {
		t.Fatal("refuse overwriting prior regression evidence")
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	trace := newDiagnosticTracer()
	result := map[string]any{"baseline": baseline, "scope": "two-request PostgreSQL tracer regression only; NOT complete diagnose, capacity, OAuth, or Cloudflare evidence", "startedAt": started.UTC(), "status": "incomplete", "attempted": 0, "completed": 0, "maximumRequests": 2, "totalDeadlineSeconds": 20, "requestDeadlineSeconds": 5, "explainDeadlineSeconds": 2}
	defer func() {
		result["finishedAt"] = time.Now().UTC()
		result["durationSeconds"] = time.Since(started).Seconds()
		queries, stages, dropped := trace.snapshot()
		result["sql"], result["stages"], result["droppedTraces"] = queries, stages, dropped
		if err := writeDiagnosticJSON(out, "two-request-regression.json", result); err != nil {
			t.Error(err)
		}
	}()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var marker string
	if err = db.QueryRowContext(ctx, `SELECT fixture_version FROM public.feed_capacity_fixture WHERE id`).Scan(&marker); err != nil || marker != "synthetic-capacity-v1" {
		t.Fatal("existing owned synthetic marker required")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.Tracer = trace
	traced := stdlib.RegisterConnConfig(config)
	defer stdlib.UnregisterConnConfig(traced)
	store, _, err := feedruntime.OpenStore(feedruntime.Config{StoreProfile: "postgres", DatabaseURL: traced, Mode: backend.FeedModeBaseline, WriterEpoch: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	wrapped := &diagnosticStore{PostgresFeedStore: store.(*backend.PostgresFeedStore), trace: trace}
	handler, err := feedruntime.APIHandler(feedruntime.Config{StoreProfile: "postgres", Mode: backend.FeedModeBaseline, WriterEpoch: 1, GatewaySecret: gatewaySecret, SigningSecret: tokenSecret}, baseline, wrapped, wrapped)
	if err != nil {
		t.Fatal(err)
	}
	var requestIndex atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), diagnosticRequestKey{}, int(requestIndex.Load()))))
	}))
	defer server.Close()
	signer, _ := auth.New(gatewaySecret, "feed-api")
	observations := []observation{}
	for i := 0; i < 2; i++ {
		if ctx.Err() != nil {
			t.Fatal(ctx.Err())
		}
		requestIndex.Store(int64(i + 1))
		result["attempted"] = i + 1
		one, done := context.WithTimeout(ctx, 5*time.Second)
		obs, _ := call(one, &http.Client{Timeout: 5 * time.Second}, server.URL, "GET", "/api/feed/projects?limit=20", highUser+int64(i), signer)
		done()
		observations = append(observations, obs)
		result["observations"] = observations
		if obs.Status != 200 || obs.Error != "" || obs.Items != 20 {
			t.Fatalf("request %d: %#v", i, obs)
		}
		result["completed"] = i + 1
	}
	server.CloseClientConnections()
	trace.waitIdle(ctx)
	plans := explainDiagnosticQueries(ctx, db, baseline, trace.exemplars())
	result["plans"] = plans
	if plans.Status != "complete" || plans.Completed != 16 || ctx.Err() != nil {
		encoded, _ := json.Marshal(map[string]any{"status": plans.Status, "completed": plans.Completed, "unobserved": plans.Unobserved})
		t.Fatalf("plans incomplete: %s", encoded)
	}
	result["status"] = "passed"
}
