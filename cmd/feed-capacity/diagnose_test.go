package main

import (
	"context"
	"encoding/json"
	"github.com/hikariming/ghfind/internal/backend"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestDiagnosticPlanRejectsUnregisteredBeforeExecution(t *testing.T) {
	calls := 0
	spy := func(context.Context, string, []any) (json.RawMessage, error) {
		calls++
		return json.RawMessage(`[]`), nil
	}
	for _, query := range []string{"INSERT INTO feed.projects DEFAULT VALUES", "UPDATE feed.projects SET publishable=false", "SELECT 1", "WITH changed AS (DELETE FROM feed.events RETURNING *) SELECT * FROM changed", "SELECT 1; DELETE FROM feed.events", " EXPLAIN SELECT 1", "SELECT repo_key FROM feed.projects FOR SHARE"} {
		if _, err := executeDiagnosticPlan(context.Background(), query, nil, spy); err == nil {
			t.Fatalf("allowed unknown SQL %q", query)
		}
	}
	for _, query := range backend.FeedDiagnosticReadQueries() {
		if _, err := executeDiagnosticPlan(context.Background(), query+"; DELETE FROM feed.events", nil, spy); err == nil {
			t.Fatal("registered prefix permitted extra statement")
		}
	}
	if calls != 0 {
		t.Fatal("unregistered SQL reached execution")
	}
}
func TestDiagnosticTraceNeverEmitsSQLArgumentsOrUnknownSQL(t *testing.T) {
	tracer := newDiagnosticTracer()
	ctx := context.WithValue(context.Background(), diagnosticRequestKey{}, 1)
	ctx = tracer.TraceQueryStart(ctx, nil, pgx.TraceQueryStartData{SQL: "INSERT secret_private_literal", Args: []any{"secret_private_argument"}})
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{Err: &pgconn.PgError{Code: "23505", Message: "secret_error_detail"}})
	queries, stages, _ := tracer.snapshot()
	encoded, _ := json.Marshal([]any{queries, stages, tracer.exemplars()})
	if strings.Contains(string(encoded), "secret_") {
		t.Fatalf("payload leaked: %s", encoded)
	}
	if len(queries) != 1 || queries[0].Outcome != "postgres_23505" || queries[0].SHA256 == "" {
		t.Fatalf("missing timing: %#v", queries)
	}
}
func TestDiagnosticPlanRedaction(t *testing.T) {
	var input any
	if err := json.Unmarshal([]byte(`[{"Plan":{"Node Type":"Index Scan","Index Name":"projects_pkey","Relation Name":"projects","Actual Rows":20,"Filter":"github_id = 900000001","Index Cond":"private argument","Alias":"private alias","Unknown Future Field":"private value","Output":["private value"],"Plans":[{"Node Type":"Limit","Actual Rows":1}]},"Execution Time":3.4,"Settings":{"search_path":"private schema"}}]`), &input); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(redactDiagnosticPlan(input))
	if strings.Contains(string(encoded), "private") || strings.Contains(string(encoded), "900000001") {
		t.Fatalf("plan leak: %s", encoded)
	}
	if !strings.Contains(string(encoded), "projects_pkey") || !strings.Contains(string(encoded), "Execution Time") {
		t.Fatal("useful plan metrics lost")
	}
}
func TestDiagnosticFailureStillWritesEarlyReports(t *testing.T) {
	out := t.TempDir()
	if err := diagnose("not a driver config", out, "synthetic-baseline"); err == nil {
		t.Fatal("invalid config succeeded")
	}
	var rep diagnosisReport
	data, err := os.ReadFile(filepath.Join(out, "diagnose.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &rep); err != nil {
		t.Fatal(err)
	}
	if rep.Status != "incomplete" || rep.Attempted != 0 || rep.NotAttempted != 100 || rep.ErrorCode != "invalid_driver_config" {
		t.Fatalf("incorrect failure report: %#v", rep)
	}
	if _, err = os.Stat(filepath.Join(out, "actual-query-plans.json")); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(out, "load.json")); !os.IsNotExist(err) {
		t.Fatal("diagnosis wrote capacity artifact")
	}
}

func TestDiagnosticPlanUsesExactRegisteredRuntimeSQL(t *testing.T) {
	for _, query := range backend.FeedDiagnosticReadQueries() {
		calls := 0
		_, err := executeDiagnosticPlan(context.Background(), query, []any{int64(7)}, func(_ context.Context, sql string, args []any) (json.RawMessage, error) {
			calls++
			if sql != "EXPLAIN (ANALYZE,BUFFERS,SETTINGS,FORMAT JSON) "+query || len(args) != 1 || args[0] != int64(7) {
				t.Fatal("runtime query or arguments changed")
			}
			return json.RawMessage(`[]`), nil
		})
		if err != nil || calls != 1 {
			t.Fatalf("registered query not executed: %v", err)
		}
	}
}

func TestDiagnosticTraceCapturesStdlibFormatOptions(t *testing.T) {
	tracer := newDiagnosticTracer()
	keys := []string{"synthetic-owner/project"}
	query := backend.FeedDiagnosticReadQueries()["candidates.hydrate"]
	ctx := context.WithValue(context.Background(), diagnosticRequestKey{}, 1)
	ctx = tracer.TraceQueryStart(ctx, nil, pgx.TraceQueryStartData{SQL: query, Args: []any{pgx.QueryResultFormatsByOID{20: 1, 25: 0}, int64(highUser), keys}})
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})
	keys[0] = "changed-after-trace"
	examples := tracer.exemplars()
	if len(examples) != 1 || len(examples[0].args) != 2 {
		t.Fatalf("stdlib trace not captured: %#v", examples)
	}
	if examples[0].args[0] != highUser || examples[0].args[1].([]string)[0] != "synthetic-owner/project" {
		t.Fatal("format metadata shifted args or slice was not cloned")
	}
	if _, ok := diagnosticCloneArgs([]any{int64(1), pgx.QueryResultFormatsByOID{20: 1}}); ok {
		t.Fatal("accepted metadata inside bind arguments")
	}
	if _, ok := diagnosticCloneArgs([]any{map[string]string{"private": "payload"}}); ok {
		t.Fatal("accepted unsupported arbitrary payload")
	}
}
