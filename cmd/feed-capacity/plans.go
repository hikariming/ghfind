package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/hikariming/ghfind/internal/backend"
)

type diagnosticPlan struct {
	Template   string  `json:"template"`
	Cohort     int     `json:"syntheticCohort"`
	SHA256     string  `json:"sha256"`
	SQL        string  `json:"sql"`
	Outcome    string  `json:"outcome"`
	DurationMS float64 `json:"durationMs"`
	Plan       any     `json:"plan,omitempty"`
}
type diagnosticPlansReport struct {
	Unobserved      []string         `json:"unobserved"`
	Baseline        string           `json:"baseline"`
	StartedAt       time.Time        `json:"startedAt"`
	DurationSeconds float64          `json:"durationSeconds"`
	Status          string           `json:"status"`
	Attempted       int              `json:"attempted"`
	Completed       int              `json:"completed"`
	Cancelled       int              `json:"cancelled"`
	NotAttempted    int              `json:"notAttempted"`
	Plans           []diagnosticPlan `json:"plans"`
	Outcomes        map[string]int   `json:"outcomes"`
}

type diagnosticPlanExecutor func(context.Context, string, []any) (json.RawMessage, error)

// This exact-template check is the only path into the SQL executor. It excludes
// mutations, locks, arbitrary SELECTs, prefix tricks and appended statements.
func executeDiagnosticPlan(ctx context.Context, query string, args []any, execute diagnosticPlanExecutor) (json.RawMessage, error) {
	if _, ok := backend.FeedDiagnosticReadQuery(query); !ok {
		return nil, errors.New("unregistered_diagnostic_query")
	}
	return execute(ctx, "EXPLAIN (ANALYZE,BUFFERS,SETTINGS,FORMAT JSON) "+query, args)
}
func explainDiagnosticQueries(ctx context.Context, db *sql.DB, baseline string, examples []diagnosticExemplar) diagnosticPlansReport {
	started := time.Now()
	rep := diagnosticPlansReport{Baseline: baseline, StartedAt: started.UTC(), Status: "incomplete", NotAttempted: len(examples), Plans: []diagnosticPlan{}, Outcomes: map[string]int{}}
	observed := map[string]bool{}
	for _, example := range examples {
		observed[fmt.Sprintf("%s/%d", example.name, example.cohort)] = true
	}
	for name := range backend.FeedDiagnosticReadQueries() {
		for cohort := 0; cohort < 2; cohort++ {
			key := fmt.Sprintf("%s/%d", name, cohort)
			if !observed[key] {
				rep.Unobserved = append(rep.Unobserved, key)
			}
		}
	}
	sort.Strings(rep.Unobserved)
	// Examples arise only from actual requests and retain no more than two sets
	// (the skewed user and an ordinary synthetic user) per registered template.
	for _, example := range examples {
		if ctx.Err() != nil {
			break
		}
		rep.Attempted++
		rep.NotAttempted--
		at := time.Now()
		oneCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		raw, err := executeDiagnosticPlan(oneCtx, example.sql, example.args, func(c context.Context, q string, args []any) (json.RawMessage, error) {
			tx, err := db.BeginTx(c, &sql.TxOptions{ReadOnly: true})
			if err != nil {
				return nil, err
			}
			defer tx.Rollback()
			var raw json.RawMessage
			if err = tx.QueryRowContext(c, q, args...).Scan(&raw); err != nil {
				return nil, err
			}
			return raw, tx.Commit()
		})
		outcome := diagnosticOutcome(err)
		if oneCtx.Err() != nil {
			outcome = "cancelled"
			rep.Cancelled++
		}
		cancel()
		plan := diagnosticPlan{Template: example.name, Cohort: example.cohort, SHA256: fmt.Sprintf("%x", sha256.Sum256([]byte(example.sql))), SQL: example.sql, Outcome: outcome, DurationMS: float64(time.Since(at).Microseconds()) / 1000}
		if err == nil {
			var decoded any
			if err = json.Unmarshal(raw, &decoded); err == nil {
				plan.Plan = redactDiagnosticPlan(decoded)
				rep.Completed++
			} else {
				plan.Outcome = "invalid_plan_json"
			}
		}
		rep.Outcomes[plan.Outcome]++
		rep.Plans = append(rep.Plans, plan)
	}
	rep.DurationSeconds = time.Since(started).Seconds()
	if len(examples) > 0 && rep.Completed == len(examples) && len(rep.Unobserved) == 0 {
		rep.Status = "complete"
	}
	return rep
}

// Whitelist metadata instead of blacklisting a few known expression names:
// EXPLAIN may inline bound identities into filters, outputs, sort keys, aliases,
// settings or newer planner fields. Unknown strings are intentionally omitted.
func redactDiagnosticPlan(value any) any {
	switch v := value.(type) {
	case []any:
		out := make([]any, 0, len(v))
		for _, item := range v {
			if _, ok := item.(string); !ok {
				out = append(out, redactDiagnosticPlan(item))
			}
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for key, item := range v {
			switch x := item.(type) {
			case float64, bool:
				out[key] = x
			case map[string]any, []any:
				out[key] = redactDiagnosticPlan(x)
			case string:
				if safeDiagnosticPlanMetadata(key, x) {
					out[key] = x
				}
			}
		}
		return out
	default:
		return nil
	}
}
func safeDiagnosticPlanMetadata(key, value string) bool {
	switch key {
	case "Node Type", "Join Type", "Strategy", "Partial Mode", "Operation", "Scan Direction", "Parent Relationship", "Sort Method", "Sort Space Type", "Cache Mode":
		// These metadata enums are generated by PostgreSQL; never expression text.
		return len(value) <= 100
	case "Relation Name", "Index Name", "Schema":
		// Identifiers belong only to the fixed synthetic feed schema. No aliases,
		// arbitrary namespaces or object names from request parameters are retained.
		if key == "Schema" {
			return value == "feed"
		}
		if key == "Relation Name" {
			switch value {
			case "projects", "project_tags", "tag_definitions", "taxonomy_versions", "users", "user_tag_preferences", "user_project_state", "project_submission_evidence", "project_embeddings", "events":
				return true
			}
			return false
		}
		for _, c := range value {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
				return false
			}
		}
		return len(value) <= 100
	}
	return false
}
