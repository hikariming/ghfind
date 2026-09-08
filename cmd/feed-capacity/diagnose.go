package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/hikariming/ghfind/internal/backend"
	"github.com/hikariming/ghfind/internal/feed/auth"
	feedruntime "github.com/hikariming/ghfind/internal/feed/runtime"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

const diagnosisLimit = 120 * time.Second
const diagnosisRequestWindow = 80 * time.Second // leave up to 40s for bounded actual-query EXPLAINs
const diagnosisRequests = 100

type diagnosisReport struct {
	Baseline        string                   `json:"baseline"`
	Phase           string                   `json:"phase"`
	Scope           string                   `json:"scope"`
	StartedAt       time.Time                `json:"startedAt"`
	FinishedAt      time.Time                `json:"finishedAt"`
	DurationSeconds float64                  `json:"durationSeconds"`
	Status          string                   `json:"status"`
	ErrorCode       string                   `json:"errorCode,omitempty"`
	Limits          map[string]int           `json:"limits"`
	GoVersion       string                   `json:"goVersion"`
	Attempted       int                      `json:"attempted"`
	Completed       int                      `json:"completed"`
	Cancelled       int                      `json:"cancelled"`
	NotAttempted    int                      `json:"notAttempted"`
	Successful      int                      `json:"successful"`
	Outcomes        map[string]int           `json:"outcomes"`
	Observations    []observation            `json:"observations"`
	SQL             []diagnosticQueryTiming  `json:"sql"`
	Stages          []diagnosticStageTiming  `json:"stages"`
	DroppedTraces   int                      `json:"droppedTraces"`
	Resources       []capacityResourceSample `json:"resourceSamples"`
	Limitations     []string                 `json:"limitations"`
}

func writeDiagnosticJSON(out, file string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	temp := filepath.Join(out, file+".tmp")
	if err = os.WriteFile(temp, data, 0600); err != nil {
		return err
	}
	return os.Rename(temp, filepath.Join(out, file))
}

// The report is created before parsing a driver config or contacting PostgreSQL.
// All dependency work, HTTP requests and EXPLAINs share the same 120s deadline.
func diagnose(dsn, out, baseline string) (resultErr error) {
	started := time.Now()
	rep := diagnosisReport{Baseline: baseline, Phase: "diagnose", Scope: "isolated synthetic PostgreSQL diagnosis; NOT capacity, Cloudflare, or real OAuth acceptance", StartedAt: started.UTC(), Status: "incomplete", GoVersion: runtime.Version(), NotAttempted: diagnosisRequests, Outcomes: map[string]int{}, Limits: map[string]int{"totalSeconds": 120, "requestWindowSeconds": 80, "requests": 100, "concurrency": 1, "maximumPermittedConcurrency": 20, "requestSeconds": 5, "explainSeconds": 2}, Limitations: []string{"Sequential diagnostic traffic does not reproduce the 10 RPS capacity workload or prove an SLO.", "EXPLAIN uses the exact captured runtime template and in-memory arguments, on a separate read-only connection. Its custom plan may differ from a warmed runtime prepared generic plan.", "Only registered non-locking read queries are explained. Writes and unregistered queries retain fingerprint, duration and outcome only.", "Plan expression fields and parameter values are omitted. No gateway token, request payload or identity is emitted."}}
	plans := diagnosticPlansReport{Baseline: baseline, StartedAt: started.UTC(), Status: "incomplete", Plans: []diagnosticPlan{}}
	if err := writeDiagnosticJSON(out, "diagnose.json", rep); err != nil {
		return err
	}
	if err := writeDiagnosticJSON(out, "actual-query-plans.json", plans); err != nil {
		return err
	}
	ctx, cancel := context.WithDeadline(context.Background(), started.Add(diagnosisLimit))
	defer cancel()
	tracer := newDiagnosticTracer()
	defer func() {
		rep.FinishedAt = time.Now().UTC()
		rep.DurationSeconds = time.Since(started).Seconds()
		rep.SQL, rep.Stages, rep.DroppedTraces = tracer.snapshot()
		if resultErr != nil && rep.ErrorCode == "" {
			rep.ErrorCode = "diagnosis_incomplete"
		}
		if err := writeDiagnosticJSON(out, "diagnose.json", rep); err != nil {
			resultErr = errors.Join(resultErr, err)
		}
		if err := writeDiagnosticJSON(out, "actual-query-plans.json", plans); err != nil {
			resultErr = errors.Join(resultErr, err)
		}
	}()
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		rep.ErrorCode = "invalid_driver_config"
		return errors.New(rep.ErrorCode)
	}
	config.Tracer = tracer
	tracedDSN := stdlib.RegisterConnConfig(config)
	defer stdlib.UnregisterConnConfig(tracedDSN)
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		rep.ErrorCode = "database_open_failed"
		return errors.New(rep.ErrorCode)
	}
	defer db.Close()
	db.SetMaxOpenConns(4)
	if err = db.PingContext(ctx); err != nil {
		rep.ErrorCode = "database_unavailable"
		return errors.New(rep.ErrorCode)
	}
	var version string
	if err = db.QueryRowContext(ctx, `SELECT fixture_version FROM public.feed_capacity_fixture WHERE id`).Scan(&version); err != nil || version != "synthetic-capacity-v1" {
		rep.ErrorCode = "fixture_marker_missing"
		return errors.New(rep.ErrorCode)
	}
	store, _, err := feedruntime.OpenStore(feedruntime.Config{StoreProfile: "postgres", DatabaseURL: tracedDSN, Mode: backend.FeedModeBaseline, WriterEpoch: 1})
	if err != nil {
		rep.ErrorCode = "store_initialization_failed"
		return errors.New(rep.ErrorCode)
	}
	defer store.Close()
	if err = store.Ping(ctx); err != nil {
		rep.ErrorCode = "store_readiness_failed"
		return errors.New(rep.ErrorCode)
	}
	wrapped := &diagnosticStore{PostgresFeedStore: store.(*backend.PostgresFeedStore), trace: tracer}
	handler, err := feedruntime.APIHandler(feedruntime.Config{StoreProfile: "postgres", Mode: backend.FeedModeBaseline, WriterEpoch: 1, GatewaySecret: gatewaySecret, SigningSecret: tokenSecret}, baseline, wrapped, wrapped)
	if err != nil {
		rep.ErrorCode = "handler_initialization_failed"
		return errors.New(rep.ErrorCode)
	}
	var index atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only one request is in flight. The label originates here, never from a client header.
		ctx := context.WithValue(r.Context(), diagnosticRequestKey{}, int(index.Load()))
		handler.ServeHTTP(w, r.WithContext(ctx))
	}))
	defer server.Close()
	signer, _ := auth.New(gatewaySecret, "feed-api")
	observeCtx, stopObservation := context.WithCancel(ctx)
	observed := make(chan struct{})
	go func() { defer close(observed); sampleCapacityResources(observeCtx, db, started, &rep.Resources) }()
	defer func() { stopObservation(); <-observed }()
	requestCtx, stopRequests := context.WithDeadline(ctx, started.Add(diagnosisRequestWindow))
	defer stopRequests()
	client := &http.Client{Timeout: 5 * time.Second}
	for i := 0; i < diagnosisRequests; i++ {
		if requestCtx.Err() != nil {
			break
		}
		index.Store(int64(i + 1))
		rep.Attempted++
		rep.NotAttempted--
		oneCtx, done := context.WithTimeout(requestCtx, 5*time.Second)
		obs, _ := call(oneCtx, client, server.URL, "GET", "/api/feed/projects?limit=20", highUser+int64(i%2), signer)
		outcome := "transport_error"
		if obs.Status > 0 {
			rep.Completed++
			outcome = fmt.Sprintf("http_%d", obs.Status)
			if obs.Status == 200 && obs.Error == "" && obs.Items == 20 {
				rep.Successful++
			} else if obs.Status == 200 {
				outcome = "invalid_success_response"
			}
		}
		if obs.Status == 0 && oneCtx.Err() != nil {
			rep.Cancelled++
			outcome = "cancelled"
		}
		done()
		rep.Outcomes[outcome]++
		rep.Observations = append(rep.Observations, obs)
	}
	// In-flight handler cancellation must settle before taking exemplar snapshots.
	server.CloseClientConnections()
	tracer.waitIdle(ctx)
	plans = explainDiagnosticQueries(ctx, db, baseline, tracer.exemplars())
	if rep.Attempted == diagnosisRequests && rep.Successful == diagnosisRequests && plans.Status == "complete" && ctx.Err() == nil {
		rep.Status = "complete"
		return nil
	}
	return errors.New("bounded diagnosis incomplete; inspect diagnostic artifacts")
}
