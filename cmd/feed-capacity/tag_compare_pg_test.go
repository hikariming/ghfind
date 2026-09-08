//go:build feeddiagnostic

package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/hikariming/ghfind/internal/backend"
)

// A separately authorized eight-read-only-query comparison on the existing
// synthetic fixture: two SELECTs and two EXPLAINs per cohort. No seeds, writes,
// HTTP requests, planner settings or large-capacity reruns are performed.
func TestDiagnosticTagAnalysisCompare(t *testing.T) {
	dsn := os.Getenv("FEED_DIAGNOSIS_TEST_DATABASE_URL")
	if err := validateDSN(dsn); err != nil {
		t.Fatal(err)
	}
	baseline := os.Getenv("FEED_DIAGNOSIS_TEST_BASELINE")
	if !regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(baseline) {
		t.Fatal("exact source SHA required")
	}
	out := os.Getenv("FEED_DIAGNOSIS_TEST_OUT")
	if out == "" {
		t.Fatal("fresh evidence output required")
	}
	if err := os.MkdirAll(out, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(out, "tag-analysis-comparison.json")); !os.IsNotExist(err) {
		t.Fatal("refuse overwrite")
	}
	original := backend.FeedDiagnosticReadQueries()["candidates.tag"]
	const join = "JOIN feed.projects current ON current.repo_key=pt.repo_key AND current.analysis_id=pt.analysis_id\n            WHERE pt.tag_id=pref.tag_id"
	const probe = "WHERE pt.tag_id=pref.tag_id\n            AND EXISTS(SELECT 1 FROM feed.projects current WHERE current.repo_key=pt.repo_key AND current.analysis_id=pt.analysis_id OFFSET 0)"
	if strings.Count(original, join) != 1 {
		t.Fatal("baseline runtime query changed; review comparator before executing")
	}
	proposed := strings.Replace(original, join, probe, 1)
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result := map[string]any{"baseline": baseline, "startedAt": started.UTC(), "status": "incomplete", "scope": "eight read-only synthetic SQL comparisons; no HTTP or capacity acceptance", "deadlineSeconds": 30, "queryLimit": 8, "queries": []any{}}
	defer func() {
		result["finishedAt"] = time.Now().UTC()
		result["durationSeconds"] = time.Since(started).Seconds()
		if err := writeDiagnosticJSON(out, "tag-analysis-comparison.json", result); err != nil {
			t.Error(err)
		}
	}()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	type row struct {
		Key      string  `json:"key"`
		Affinity float64 `json:"affinity"`
	}
	attempted := 0
	for cohort := 0; cohort < 2; cohort++ {
		var expected []row
		for variant, query := range []string{original, proposed} {
			attempted++
			result["attempted"] = attempted
			at := time.Now()
			one, done := context.WithTimeout(ctx, 3*time.Second)
			rows, err := tx.QueryContext(one, query, highUser+int64(cohort))
			if err != nil {
				done()
				t.Fatal(err)
			}
			actual := []row{}
			for rows.Next() {
				var r row
				if err = rows.Scan(&r.Key, &r.Affinity); err != nil {
					break
				}
				actual = append(actual, r)
			}
			if err == nil {
				err = rows.Err()
			}
			rows.Close()
			done()
			if err != nil {
				t.Fatal(err)
			}
			if len(actual) != 80 {
				t.Fatalf("synthetic candidate fixture missing: %d", len(actual))
			}
			if variant == 0 {
				expected = actual
			} else if !reflect.DeepEqual(actual, expected) {
				t.Fatal("ordered keys or exact affinities changed")
			}
			encoded, _ := json.Marshal(actual)
			result["queries"] = append(result["queries"].([]any), map[string]any{"cohort": cohort, "variant": variant, "operation": "select", "rowCount": len(actual), "orderedResultSHA256": fmt.Sprintf("%x", sha256.Sum256(encoded)), "durationMs": float64(time.Since(at).Microseconds()) / 1000, "outcome": "ok"})
		}
		for variant, query := range []string{original, proposed} {
			attempted++
			result["attempted"] = attempted
			at := time.Now()
			one, done := context.WithTimeout(ctx, 3*time.Second)
			var raw json.RawMessage
			err := tx.QueryRowContext(one, "EXPLAIN (ANALYZE,BUFFERS,SETTINGS,FORMAT JSON) "+query, highUser+int64(cohort)).Scan(&raw)
			done()
			if err != nil {
				t.Fatal(err)
			}
			var decoded any
			if err = json.Unmarshal(raw, &decoded); err != nil {
				t.Fatal(err)
			}
			result["queries"] = append(result["queries"].([]any), map[string]any{"cohort": cohort, "variant": variant, "operation": "explain", "sql": query, "sqlSHA256": fmt.Sprintf("%x", sha256.Sum256([]byte(query))), "durationMs": float64(time.Since(at).Microseconds()) / 1000, "plan": redactDiagnosticPlan(decoded), "outcome": "ok"})
		}
	}
	if ctx.Err() != nil {
		t.Fatal(ctx.Err())
	}
	result["status"] = "passed"
}
