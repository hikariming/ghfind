package backend

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hikariming/ghfind/internal/feedmigration"
	"github.com/jackc/pgx/v5"
)

const feedLoadTestAck = "I_UNDERSTAND_THIS_TRUNCATES_FEED_SCHEMA"

// TestPostgresFeedStoreLoad is an explicit, destructive release qualification
// for a disposable database. It is excluded from ordinary CI: the normal real
// PostgreSQL integration suite covers correctness, while this test loads the
// requested 10k/50k catalog and measures the exact application pool/query path
// at 50 concurrent callers.
func TestPostgresFeedStoreLoad(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("FEED_LOAD_TEST_DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("FEED_LOAD_TEST_DATABASE_URL is not set")
	}
	if os.Getenv("FEED_LOAD_TEST_ACK") != feedLoadTestAck {
		t.Fatalf("FEED_LOAD_TEST_ACK must equal %s", feedLoadTestAck)
	}
	parsed, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToLower(parsed.Database), "loadtest") {
		t.Fatalf("refusing destructive load test: database name %q must contain loadtest", parsed.Database)
	}
	projectCount := loadTestInt(t, "FEED_LOAD_TEST_PROJECTS", 10_000, 1_000, 50_000)
	requestCount := loadTestInt(t, "FEED_LOAD_TEST_REQUESTS", 200, 50, 2_000)
	const concurrency = 50

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	if err := feedmigration.Run(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	store, err := OpenPostgresFeedStore(Config{FeedDatabaseURL: databaseURL})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := seedFeedLoadCatalog(ctx, store, projectCount); err != nil {
		t.Fatal(err)
	}
	// The dedicated migration role owns adaptive HNSW DDL. Running its
	// idempotent maintenance operation here exercises the same 50k transition
	// that production uses, without allowing the API/worker pool to create
	// indexes during a request.
	if err := feedmigration.MaintainVectorIndexes(ctx, databaseURL); err != nil {
		t.Fatalf("maintain vector indexes: %v", err)
	}
	user, err := store.GetFeedUser(ctx, 9_000_000_001)
	if err != nil || user == nil {
		t.Fatalf("load-test user: user=%#v err=%v", user, err)
	}

	for warm := 0; warm < 5; warm++ {
		if _, _, err := store.LoadFeedCandidates(ctx, *user, 240); err != nil {
			t.Fatalf("warm candidate request: %v", err)
		}
	}
	candidateDurations, candidateErrors, firstCandidateError := runFeedLoad(concurrency, requestCount, func(call int) error {
		requestCtx, requestCancel := context.WithTimeout(ctx, 2*time.Second)
		defer requestCancel()
		candidates, _, err := store.LoadFeedCandidates(requestCtx, *user, 240)
		if err == nil && len(candidates) < 80 {
			return fmt.Errorf("candidate pool too small: %d", len(candidates))
		}
		return err
	})
	if candidateErrors != 0 {
		t.Fatalf("candidate load errors=%d/%d first=%v", candidateErrors, requestCount, firstCandidateError)
	}
	candidateP95, candidateP99 := percentile(candidateDurations, 0.95), percentile(candidateDurations, 0.99)
	t.Logf("projects=%d candidate requests=%d concurrency=%d p95=%s p99=%s", projectCount, requestCount, concurrency, candidateP95, candidateP99)
	if candidateP95 > 400*time.Millisecond || candidateP99 > 900*time.Millisecond {
		t.Fatalf("candidate latency exceeded release SLO: p95=%s p99=%s", candidateP95, candidateP99)
	}

	eventDurations, eventErrors, firstEventError := runFeedLoad(concurrency, requestCount, func(call int) error {
		events := make([]AcceptedFeedEvent, 0, 50)
		for index := 0; index < 50; index++ {
			sequence := call*50 + index + 1
			repoNumber := sequence%projectCount + 1
			events = append(events, AcceptedFeedEvent{Input: FeedEventInput{
				ID:         fmt.Sprintf("%08x-0000-4000-8000-%012x", call+1, sequence),
				Type:       FeedEventImpression,
				RepoKey:    fmt.Sprintf("loadowner%d/repo%d", repoNumber%1000, repoNumber),
				OccurredAt: time.Now().UTC(),
			}, Metadata: map[string]any{"rank": index}})
		}
		requestCtx, requestCancel := context.WithTimeout(ctx, 2*time.Second)
		defer requestCancel()
		result, err := store.AppendFeedEvents(requestCtx, user.GitHubID, events)
		if err == nil && result.Accepted != len(events) {
			return fmt.Errorf("accepted %d of %d events", result.Accepted, len(events))
		}
		return err
	})
	if eventErrors != 0 {
		t.Fatalf("event batch load errors=%d/%d first=%v", eventErrors, requestCount, firstEventError)
	}
	eventP95, eventP99 := percentile(eventDurations, 0.95), percentile(eventDurations, 0.99)
	t.Logf("50-event batches=%d concurrency=%d p95=%s p99=%s", requestCount, concurrency, eventP95, eventP99)
	if eventP95 > 200*time.Millisecond {
		t.Fatalf("event batch latency exceeded release SLO: p95=%s p99=%s", eventP95, eventP99)
	}
}

func seedFeedLoadCatalog(ctx context.Context, store *PostgresFeedStore, projectCount int) error {
	if _, err := store.db.ExecContext(ctx, `TRUNCATE feed.projects,feed.users CASCADE`); err != nil {
		return fmt.Errorf("truncate disposable Feed load-test data: %w", err)
	}
	if _, err := store.db.ExecContext(ctx, `INSERT INTO feed.projects (
      repo_key,item_id,owner_login,name,canonical_url,summary,pain_statement,target_users,
      language,topics,project_type,lifecycle,product_score,confidence,verification_level,
      exposure_band,analysis_id,resolved_commit_sha,analyzed_at,descriptor,descriptor_hash,
      source_hash,publishable)
    SELECT 'loadowner'||(g % 1000)||'/repo'||g,
      'loadowner'||(g % 1000)||':repo'||g,
      'loadowner'||(g % 1000),'repo'||g,
      'https://github.com/loadowner'||(g % 1000)||'/repo'||g,
      'Synthetic project '||g,'Synthetic load qualification','["developers"]'::jsonb,
      CASE WHEN g % 3 = 0 THEN 'Go' WHEN g % 3 = 1 THEN 'TypeScript' ELSE 'Rust' END,
      '["developer-tools"]'::jsonb,'micro_tool','active_evolution',(g % 101)::double precision,
      (70 + g % 31)::double precision,'source_inspected',
      CASE WHEN g % 4 = 0 THEN 'low' WHEN g % 4 = 1 THEN 'emerging' WHEN g % 4 = 2 THEN 'unknown' ELSE 'mainstream' END,
      'load-analysis-'||g,lpad(to_hex(g),40,'0'),now() - ((g % 365)||' days')::interval,
      'Synthetic descriptor '||g,md5('descriptor-'||g),md5('source-'||g),true
    FROM generate_series(1,$1) AS g`, projectCount); err != nil {
		return fmt.Errorf("seed Feed load-test projects: %w", err)
	}
	if _, err := store.db.ExecContext(ctx, `INSERT INTO feed.project_tags
      (repo_key,tag_id,source,weight,confidence,evidence_ids,analysis_id,taxonomy_version)
    SELECT repo_key,'artifact:micro-tool','system',1,1,'[]'::jsonb,analysis_id,1
    FROM feed.projects`); err != nil {
		return fmt.Errorf("seed Feed load-test tags: %w", err)
	}
	vector := "[" + strings.TrimRight(strings.Repeat("0.25,", 16), ",") + "]"
	if _, err := store.db.ExecContext(ctx, `INSERT INTO feed.project_embeddings
      (repo_key,model,dimensions,descriptor_hash,embedding,active)
    SELECT repo_key,'load-model',16,descriptor_hash,$1::vector,true FROM feed.projects`, vector); err != nil {
		return fmt.Errorf("seed Feed load-test embeddings: %w", err)
	}
	if _, err := store.db.ExecContext(ctx, `INSERT INTO feed.users
      (github_id,login,taxonomy_version,profile_version,embedding_profile_version,embedding_model)
    VALUES (9000000001,'feed-loadtest',1,1,1,'load-model')`); err != nil {
		return fmt.Errorf("seed Feed load-test user: %w", err)
	}
	if _, err := store.db.ExecContext(ctx, `INSERT INTO feed.user_tag_preferences
      (github_id,tag_id,value,source,strength,taxonomy_version)
    VALUES (9000000001,'artifact:micro-tool',1,'explicit',1,1)`); err != nil {
		return fmt.Errorf("seed Feed load-test preference: %w", err)
	}
	if _, err := store.db.ExecContext(ctx, `INSERT INTO feed.user_profile_embeddings
      (github_id,model,dimensions,profile_version,embedding,active)
    VALUES (9000000001,'load-model',16,1,$1::vector,true)`, vector); err != nil {
		return fmt.Errorf("seed Feed load-test user embedding: %w", err)
	}
	if _, err := store.db.ExecContext(ctx, `INSERT INTO feed.events
      (id,github_id,repo_key,event_type,occurred_at,metadata)
    SELECT 'load-seed-'||g,9000000001,'loadowner'||(g % 1000)||'/repo'||g,
      'impression',now()-interval '31 days','{}'::jsonb
    FROM generate_series(1,$1) AS g`, projectCount); err != nil {
		return fmt.Errorf("seed Feed load-test impressions: %w", err)
	}
	for _, table := range []string{"projects", "project_tags", "project_embeddings", "events"} {
		if _, err := store.db.ExecContext(ctx, `ANALYZE feed.`+table); err != nil {
			return fmt.Errorf("analyze Feed load-test table %s: %w", table, err)
		}
	}
	return nil
}

func runFeedLoad(concurrency, calls int, operation func(int) error) ([]time.Duration, int64, error) {
	durations := make([]time.Duration, calls)
	jobs := make(chan int)
	start := make(chan struct{})
	var failures atomic.Int64
	var firstError error
	var firstErrorOnce sync.Once
	var workers sync.WaitGroup
	for worker := 0; worker < concurrency; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			for call := range jobs {
				started := time.Now()
				if err := operation(call); err != nil {
					failures.Add(1)
					firstErrorOnce.Do(func() { firstError = err })
				}
				durations[call] = time.Since(started)
			}
		}()
	}
	close(start)
	for call := 0; call < calls; call++ {
		jobs <- call
	}
	close(jobs)
	workers.Wait()
	return durations, failures.Load(), firstError
}

func percentile(values []time.Duration, quantile float64) time.Duration {
	ordered := append([]time.Duration(nil), values...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })
	index := int(float64(len(ordered)-1) * quantile)
	return ordered[index]
}

func loadTestInt(t *testing.T, name string, fallback, minimum, maximum int) int {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		t.Fatalf("%s must be an integer in [%d,%d]", name, minimum, maximum)
	}
	return value
}
