// feed-capacity is a bounded synthetic local PostgreSQL acceptance harness.
// It deliberately cannot connect to a non-loopback or non-test database.
package main

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/hikariming/ghfind/internal/backend"
	"github.com/hikariming/ghfind/internal/feed/auth"
	feedruntime "github.com/hikariming/ghfind/internal/feed/runtime"
	"github.com/hikariming/ghfind/internal/feedmigration"
	_ "github.com/jackc/pgx/v5/stdlib"
)

//go:embed seed.sql
var seedSQL string

const gatewaySecret = "capacity-fixture-gateway-only-0123456789abcdef"
const tokenSecret = "capacity-fixture-tokens-only-0123456789abcdef"
const highUser int64 = 900000001

type observation struct {
	ScheduledOffsetMS float64 `json:"scheduledOffsetMs,omitempty"`
	StartedOffsetMS   float64 `json:"startedOffsetMs,omitempty"`
	FinishedOffsetMS  float64 `json:"finishedOffsetMs,omitempty"`
	Inflight          int     `json:"inflight,omitempty"`
	Status            int     `json:"status"`
	DurationMS        float64 `json:"durationMs"`
	Items             int     `json:"items"`
	Error             string  `json:"error,omitempty"`
}
type report struct {
	LoadStartedAt                         time.Time                `json:"loadStartedAt,omitempty"`
	Resources                             []capacityResourceSample `json:"resourceSamples,omitempty"`
	Baseline                              string                   `json:"baseline"`
	Scope                                 string                   `json:"scope"`
	Phase                                 string                   `json:"phase"`
	StartedAt                             time.Time                `json:"startedAt"`
	DurationSeconds                       float64                  `json:"durationSeconds"`
	Scheduled, Completed, Successful      int
	ErrorRate, P50MS, P95MS, P99MS, MaxMS float64
	GoVersion                             string
	CPUSeconds                            float64
	MaxHeapBytes                          uint64
	MaxRSSBytes                           int64
	CPUSamples                            []json.RawMessage `json:"pgDockerStats"`
	Candidates                            json.RawMessage   `json:"candidateCounts"`
	Counts                                map[string]int64  `json:"counts"`
	Observations                          []observation     `json:"observations"`
	Deletion                              map[string]any    `json:"deletion,omitempty"`
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func validateDSN(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "postgres" || u.User == nil || !strings.HasSuffix(strings.TrimPrefix(u.Path, "/"), "_test") {
		return errors.New("explicit postgres URL with *_test database required")
	}
	ip := net.ParseIP(u.Hostname())
	if (ip == nil || !ip.IsLoopback()) && u.Hostname() != "localhost" {
		return errors.New("database must be loopback")
	}
	for key := range u.Query() {
		if key != "sslmode" && key != "connect_timeout" {
			return errors.New("database URL query override is forbidden")
		}
	}
	if u.Fragment != "" {
		return errors.New("invalid database URL")
	}
	return nil
}
func run() error {
	phase := flag.String("phase", "seed", "seed, load, profile, or delete")
	out := flag.String("out", "/tmp/ghfind-feed-capacity", "report directory")
	baseline := flag.String("baseline", "unknown", "exact source baseline SHA")
	container := flag.String("pg-container", "", "exclusive local container to sample")
	flag.Parse()
	dsn := os.Getenv("FEED_CAPACITY_DATABASE_URL")
	if err := validateDSN(dsn); err != nil {
		return err
	}
	if *phase != "seed" && *phase != "load" && *phase != "delete" && *phase != "profile" {
		return errors.New("invalid phase")
	}
	if err := os.MkdirAll(*out, 0700); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(4)
	if err := db.PingContext(ctx); err != nil {
		return err
	}
	if *phase == "seed" {
		return seed(ctx, db, dsn, *out, *baseline)
	}
	var version string
	if err := db.QueryRowContext(ctx, `SELECT fixture_version FROM public.feed_capacity_fixture WHERE id`).Scan(&version); err != nil || version != "synthetic-capacity-v1" {
		return errors.New("owned synthetic fixture marker required")
	}
	store, sessions, err := feedruntime.OpenStore(feedruntime.Config{StoreProfile: "postgres", DatabaseURL: dsn, Mode: backend.FeedModeBaseline, WriterEpoch: 1})
	if err != nil {
		return err
	}
	defer store.Close()
	handler, err := feedruntime.APIHandler(feedruntime.Config{StoreProfile: "postgres", Mode: backend.FeedModeBaseline, WriterEpoch: 1, GatewaySecret: gatewaySecret, SigningSecret: tokenSecret}, *baseline, store, sessions)
	if err != nil {
		return err
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	signer, _ := auth.New(gatewaySecret, "feed-api")
	rep := report{Baseline: *baseline, Scope: "local PostgreSQL synthetic capacity; signed gateway fixture is NOT real OAuth or Cloudflare evidence", Phase: *phase, StartedAt: time.Now().UTC(), GoVersion: runtime.Version()}
	if *phase == "load" {
		err = load(ctx, db, server.URL, signer, *container, &rep)
	} else if *phase == "profile" {
		err = profile(ctx, server.URL, signer, &rep, *out)
	} else {
		err = deletion(ctx, db, store.(*backend.PostgresFeedStore), server.URL, signer, &rep)
	}
	rep.DurationSeconds = time.Since(rep.StartedAt).Seconds()
	rep.Counts = counts(ctx, db)
	encoded, _ := json.MarshalIndent(rep, "", "  ")
	if writeErr := os.WriteFile(filepath.Join(*out, *phase+".json"), encoded, 0600); writeErr != nil {
		return writeErr
	}
	log.Printf("phase=%s completed=%d p95=%.1fms p99=%.1fms errors=%.4f output=%s", *phase, rep.Completed, rep.P95MS, rep.P99MS, rep.ErrorRate, *out)
	return err
}
func seed(ctx context.Context, db *sql.DB, dsn, out, baseline string) error {
	var exists bool
	if err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE')`).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return errors.New("seed requires a fresh exclusive database; never resets existing tables")
	}
	if _, err := db.ExecContext(ctx, `CREATE EXTENSION IF NOT EXISTS vector`); err != nil {
		return err
	}
	if err := feedmigration.Run(ctx, dsn); err != nil {
		return err
	}
	started := time.Now()
	log.Print("seeding 50000 projects / 5000 users / 1000000 synthetic events")
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, seedSQL); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `ANALYZE`); err != nil {
		return err
	}
	result := map[string]any{"baseline": baseline, "fixtureVersion": "synthetic-capacity-v1", "seedSeconds": time.Since(started).Seconds(), "counts": counts(ctx, db), "scope": "synthetic-only; no historical data imported or reclassified"}
	encoded, _ := json.MarshalIndent(result, "", "  ")
	if err := os.WriteFile(filepath.Join(out, "fixture.json"), encoded, 0600); err != nil {
		return err
	}
	return plans(ctx, db, out)
}
func counts(ctx context.Context, db *sql.DB) map[string]int64 {
	result := map[string]int64{}
	for _, table := range []string{"projects", "users", "events", "requests", "served_items", "project_submission_evidence", "project_tags"} {
		var n int64
		if db.QueryRowContext(ctx, "SELECT COUNT(*) FROM feed."+table).Scan(&n) == nil {
			result[table] = n
		}
	}
	var bytes int64
	if db.QueryRowContext(ctx, `SELECT pg_database_size(current_database())`).Scan(&bytes) == nil {
		result["databaseBytes"] = bytes
	}
	return result
}
func signedRequest(ctx context.Context, origin, method, path string, actor int64, signer *auth.Verifier) (*http.Request, error) {
	now := time.Now()
	token, err := signer.Sign(auth.Claims{Version: 1, Audience: "feed-api", GitHubID: actor, Login: fmt.Sprintf("capacity-user-%d", actor-highUser), IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(30 * time.Second).UnixMilli(), Method: method, Target: path, BodySHA256: auth.BodyHash(nil)})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, origin+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set(auth.Header, token)
	return req, nil
}
func call(ctx context.Context, client *http.Client, origin, method, path string, actor int64, signer *auth.Verifier) (observation, []byte) {
	began := time.Now()
	obs := observation{}
	req, err := signedRequest(ctx, origin, method, path, actor, signer)
	if err != nil {
		obs.Error = err.Error()
		return obs, nil
	}
	resp, err := client.Do(req)
	obs.DurationMS = float64(time.Since(began).Microseconds()) / 1000
	if err != nil {
		obs.Error = "transport_error"
		return obs, nil
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	obs.Status = resp.StatusCode
	if err != nil {
		obs.Error = "body_read"
	}
	var payload struct {
		Items []json.RawMessage `json:"items"`
		Error string            `json:"error"`
	}
	json.Unmarshal(body, &payload)
	obs.DurationMS = float64(time.Since(began).Microseconds()) / 1000
	obs.Items = len(payload.Items)
	if payload.Error != "" {
		obs.Error = payload.Error
	}
	return obs, body
}
func cpuSeconds() float64 {
	var usage syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
	return float64(usage.Utime.Sec+usage.Stime.Sec) + float64(usage.Utime.Usec+usage.Stime.Usec)/1e6
}
func load(ctx context.Context, db *sql.DB, origin string, signer *auth.Verifier, container string, rep *report) error {
	client := &http.Client{Timeout: 5 * time.Second}
	ready, _ := client.Get(origin + "/readyz")
	if ready == nil {
		return errors.New("readiness transport failed")
	}
	io.Copy(io.Discard, ready.Body)
	ready.Body.Close()
	if ready.StatusCode != 200 {
		return errors.New("readiness failed")
	}
	var samples sync.WaitGroup
	sampleCtx, stopSamples := context.WithCancel(ctx)
	defer stopSamples()
	if container != "" {
		samples.Add(1)
		go func() {
			defer samples.Done()
			tick := time.NewTicker(30 * time.Second)
			defer tick.Stop()
			for {
				select {
				case <-sampleCtx.Done():
					return
				case <-tick.C:
					sample, done := context.WithTimeout(sampleCtx, 3*time.Second)
					data, err := exec.CommandContext(sample, "docker", "stats", "--no-stream", "--format", "{{json .}}", container).Output()
					done()
					if err == nil && json.Valid(data) {
						var timed map[string]any
						if json.Unmarshal(data, &timed) == nil {
							timed["sampledAt"] = time.Now().UTC()
							data, _ = json.Marshal(timed)
						}
						rep.CPUSamples = append(rep.CPUSamples, json.RawMessage(strings.TrimSpace(string(data))))
					}
				}
			}
		}()
	}
	const total = 6000
	rep.Scheduled = total
	rep.Observations = make([]observation, total)
	sem := make(chan struct{}, 20)
	var wg sync.WaitGroup
	startCPU := cpuSeconds()
	started := time.Now()
	rep.LoadStartedAt = started.UTC()
	samples.Add(1)
	go func() { defer samples.Done(); sampleCapacityResources(sampleCtx, db, started, &rep.Resources) }()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for i := 0; i < total; i++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
		if i%100 == 0 {
			var mem runtime.MemStats
			runtime.ReadMemStats(&mem)
			if mem.HeapAlloc > rep.MaxHeapBytes {
				rep.MaxHeapBytes = mem.HeapAlloc
			}
		}
		if i%300 == 0 {
			log.Printf("load progress scheduled=%d/%d elapsed=%.0fs", i, total, time.Since(started).Seconds())
		}
		select {
		case sem <- struct{}{}:
			wg.Add(1)
			go func(index int) {
				defer wg.Done()
				defer func() { <-sem }()
				began := float64(time.Since(started).Microseconds()) / 1000
				inflight := len(sem)
				obs, _ := call(ctx, client, origin, "GET", "/api/feed/projects?limit=20", highUser+int64(index%5000), signer)
				obs.ScheduledOffsetMS = float64((index + 1) * 100)
				obs.StartedOffsetMS = began
				obs.FinishedOffsetMS = float64(time.Since(started).Microseconds()) / 1000
				obs.Inflight = inflight
				rep.Observations[index] = obs
			}(i)
		default:
			at := float64(time.Since(started).Microseconds()) / 1000
			rep.Observations[i] = observation{Error: "concurrency_limit", ScheduledOffsetMS: float64((i + 1) * 100), StartedOffsetMS: at, FinishedOffsetMS: at, Inflight: len(sem)}
		}
	}
	wg.Wait()
	stopSamples()
	samples.Wait()
	var usage syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
	rep.MaxRSSBytes = usage.Maxrss
	if runtime.GOOS == "linux" {
		rep.MaxRSSBytes *= 1024
	}
	rep.CPUSeconds = cpuSeconds() - startCPU
	values := []float64{}
	for _, obs := range rep.Observations {
		rep.Completed++
		if obs.Status == 200 && obs.Error == "" {
			rep.Successful++
		}
		values = append(values, obs.DurationMS)
	}
	sort.Float64s(values)
	rep.P50MS = values[len(values)/2]
	rep.P95MS = values[(len(values)*95)/100]
	rep.P99MS = values[(len(values)*99)/100]
	rep.MaxMS = values[len(values)-1]
	rep.ErrorRate = float64(rep.Completed-rep.Successful) / float64(rep.Completed)
	var candidateJSON string
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(jsonb_agg(x),'[]')::text FROM (SELECT candidate_counts,COUNT(*) requests FROM feed.requests WHERE id NOT LIKE 'synthetic-capacity-request-%' GROUP BY candidate_counts) x`).Scan(&candidateJSON); err == nil {
		rep.Candidates = json.RawMessage(candidateJSON)
	}
	return nil
}
