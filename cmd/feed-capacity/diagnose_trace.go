package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/hikariming/ghfind/internal/backend"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type diagnosticRequestKey struct{}
type diagnosticStageKey struct{}
type diagnosticTraceKey struct{}
type diagnosticQueryTiming struct {
	Request    int     `json:"request"`
	Stage      string  `json:"stage"`
	Template   string  `json:"template,omitempty"`
	SHA256     string  `json:"sha256"`
	DurationMS float64 `json:"durationMs"`
	OffsetMS   float64 `json:"offsetMs"`
	Outcome    string  `json:"outcome"`
}
type diagnosticStageTiming struct {
	Request    int            `json:"request"`
	Stage      string         `json:"stage"`
	DurationMS float64        `json:"durationMs"`
	OffsetMS   float64        `json:"offsetMs"`
	Outcome    string         `json:"outcome"`
	Candidates map[string]int `json:"candidates,omitempty"`
}
type diagnosticTraceStart struct {
	at      time.Time
	sql     string
	request int
	stage   string
}
type diagnosticExemplar struct {
	name, sql string
	args      []any
	cohort    int
}
type diagnosticTracer struct {
	mu              sync.Mutex
	started         time.Time
	queries         []diagnosticQueryTiming
	stages          []diagnosticStageTiming
	examples        map[string]diagnosticExemplar
	dropped, active int
}

func newDiagnosticTracer() *diagnosticTracer {
	return &diagnosticTracer{started: time.Now(), examples: map[string]diagnosticExemplar{}}
}
func diagnosticOutcome(err error) string {
	if err == nil {
		return "ok"
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "deadline"
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return "postgres_" + pg.Code
	}
	return "error"
}
func (t *diagnosticTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	request, _ := ctx.Value(diagnosticRequestKey{}).(int)
	stage, _ := ctx.Value(diagnosticStageKey{}).(string)
	start := diagnosticTraceStart{time.Now(), data.SQL, request, stage}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.active++
	if name, ok := backend.FeedDiagnosticReadQuery(data.SQL); ok && request > 0 {
		cohort := (request - 1) % 2
		key := fmt.Sprintf("%s/%d", name, cohort)
		if _, exists := t.examples[key]; !exists {
			if args, ok := diagnosticCloneArgs(data.Args); ok {
				t.examples[key] = diagnosticExemplar{name, data.SQL, args, cohort}
			}
		}
	}
	return context.WithValue(ctx, diagnosticTraceKey{}, start)
}
func diagnosticCloneArgs(args []any) ([]any, bool) {
	// pgx traces the call before it consumes these leading result-format options.
	// database/sql's stdlib adapter always adds QueryResultFormatsByOID. They are
	// driver metadata, not SQL bind arguments, and must never shift placeholders.
options:
	for len(args) > 0 {
		switch args[0].(type) {
		case pgx.QueryResultFormatsByOID, pgx.QueryResultFormats:
			args = args[1:]
		default:
			break options
		}
	}

	out := make([]any, len(args))
	for i, arg := range args {
		switch v := arg.(type) {
		case int, int32, int64, string:
			out[i] = v
		case []string:
			out[i] = append([]string(nil), v...)
		default:
			return nil, false
		}
	}
	return out, true
}
func (t *diagnosticTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	start, ok := ctx.Value(diagnosticTraceKey{}).(diagnosticTraceStart)
	if !ok {
		return
	}
	name, _ := backend.FeedDiagnosticReadQuery(start.sql)
	entry := diagnosticQueryTiming{start.request, start.stage, name, fmt.Sprintf("%x", sha256.Sum256([]byte(start.sql))), float64(time.Since(start.at).Microseconds()) / 1000, float64(start.at.Sub(t.started).Microseconds()) / 1000, diagnosticOutcome(data.Err)}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.active--
	if len(t.queries) < 20000 {
		t.queries = append(t.queries, entry)
	} else {
		t.dropped++
	}
}
func (t *diagnosticTracer) stage(ctx context.Context, name string) (context.Context, func(error, map[string]int)) {
	at := time.Now()
	request, _ := ctx.Value(diagnosticRequestKey{}).(int)
	return context.WithValue(ctx, diagnosticStageKey{}, name), func(err error, candidates map[string]int) {
		entry := diagnosticStageTiming{request, name, float64(time.Since(at).Microseconds()) / 1000, float64(at.Sub(t.started).Microseconds()) / 1000, diagnosticOutcome(err), candidates}
		t.mu.Lock()
		defer t.mu.Unlock()
		t.stages = append(t.stages, entry)
	}
}
func (t *diagnosticTracer) waitIdle(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		t.mu.Lock()
		active := t.active
		t.mu.Unlock()
		if active == 0 {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (t *diagnosticTracer) exemplars() []diagnosticExemplar {
	t.mu.Lock()
	defer t.mu.Unlock()
	keys := make([]string, 0, len(t.examples))
	for key := range t.examples {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]diagnosticExemplar, 0, len(keys))
	for _, key := range keys {
		out = append(out, t.examples[key])
	}
	return out
}
func (t *diagnosticTracer) snapshot() ([]diagnosticQueryTiming, []diagnosticStageTiming, int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]diagnosticQueryTiming(nil), t.queries...), append([]diagnosticStageTiming(nil), t.stages...), t.dropped
}

type diagnosticStore struct {
	*backend.PostgresFeedStore
	trace *diagnosticTracer
}

func (s *diagnosticStore) LoadFeedCandidates(ctx context.Context, user backend.FeedUser, limit int) (items []backend.FeedCandidate, counts map[string]int, err error) {
	ctx, end := s.trace.stage(ctx, "candidates")
	defer func() { end(err, counts) }()
	return s.PostgresFeedStore.LoadFeedCandidates(ctx, user, limit)
}
func (s *diagnosticStore) GetFeedUser(ctx context.Context, id int64) (user *backend.FeedUser, err error) {
	ctx, end := s.trace.stage(ctx, "user.get")
	defer func() { end(err, nil) }()
	return s.PostgresFeedStore.GetFeedUser(ctx, id)
}
func (s *diagnosticStore) EnsureFeedUser(ctx context.Context, session backend.OAuthSession) (user *backend.FeedUser, err error) {
	ctx, end := s.trace.stage(ctx, "user.ensure")
	defer func() { end(err, nil) }()
	return s.PostgresFeedStore.EnsureFeedUser(ctx, session)
}
func (s *diagnosticStore) PutFeedSession(ctx context.Context, session backend.FeedSession, ttl time.Duration) (err error) {
	ctx, end := s.trace.stage(ctx, "session.put")
	defer func() { end(err, nil) }()
	return s.PostgresFeedStore.PutFeedSession(ctx, session, ttl)
}
func (s *diagnosticStore) GetFeedSessionForUser(ctx context.Context, id int64, key string) (session *backend.FeedSession, err error) {
	ctx, end := s.trace.stage(ctx, "session.get")
	defer func() { end(err, nil) }()
	return s.PostgresFeedStore.GetFeedSessionForUser(ctx, id, key)
}
func (s *diagnosticStore) AvailableFeedProjects(ctx context.Context, id int64, identities []backend.FeedProjectIdentity) (available map[string]bool, err error) {
	ctx, end := s.trace.stage(ctx, "snapshot.available")
	defer func() { end(err, nil) }()
	return s.PostgresFeedStore.AvailableFeedProjects(ctx, id, identities)
}
func (s *diagnosticStore) SaveFeedRequest(ctx context.Context, record backend.FeedRequestRecord) (err error) {
	ctx, end := s.trace.stage(ctx, "request.record")
	defer func() { end(err, nil) }()
	return s.PostgresFeedStore.SaveFeedRequest(ctx, record)
}
