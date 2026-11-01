package backend

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

func TestConcurrentParentAndAssembleKeepSeparateCursors(t *testing.T) {
	clock := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
	leftCatalog := fictionCatalog{
		login:       "fiction-left",
		publicRepos: 1,
		repos:       []fictionRepo{{name: "fiction-left-lib", pushed: "2026-07-01T00:00:00Z", stars: 4}},
	}
	rightCatalog := fictionCatalog{
		login:       "fiction-right",
		publicRepos: 1,
		repos:       []fictionRepo{{name: "fiction-right-lib", pushed: "2026-07-02T00:00:00Z", stars: 6}},
	}
	collector := fictionDualLoginGitHub(t, clock, leftCatalog, rightCatalog)
	store := openMemoryScanStore(t)
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanIncrementalEnabled: true, ScanConcurrency: 2}, collector, store, &mutexStatusStore{}, &fakeScanPublisher{}, nil)

	// The two collects overlap, then each persist runs with its own pending
	// book. SQLite file locks reject overlapping writes, so the persists are
	// ordered after both collects have staged a local cursor.
	type staged struct {
		job     ScanJob
		scan    ScanResult
		pending *pendingScanCursors
	}
	stagedCh := make(chan staged, 2)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for _, job := range []ScanJob{
		{ID: "fiction-left-job", Username: leftCatalog.login, RequestedAt: 1},
		{ID: "fiction-right-job", Username: rightCatalog.login, RequestedAt: 1},
	} {
		wg.Add(1)
		go func(job ScanJob) {
			defer wg.Done()
			<-start
			scan, pending, err := worker.collectIncremental(context.Background(), job)
			if err != nil {
				t.Errorf("%s collect: %v", job.Username, err)
				return
			}
			stagedCh <- staged{job: job, scan: scan, pending: pending}
		}(job)
	}
	close(start)
	wg.Wait()
	close(stagedCh)
	var persistWg sync.WaitGroup
	errCh := make(chan error, 2)
	for item := range stagedCh {
		persistWg.Add(1)
		go func(item staged) {
			defer persistWg.Done()
			disposition, reason := worker.persistFinishedScan(context.Background(), item.job, item.scan, item.pending)
			if disposition != workerCompleted || reason != "" {
				errCh <- errors.New(item.job.Username + " " + reason)
			}
		}(item)
	}
	persistWg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
	assertUserCursorRepo(t, store, leftCatalog.login, "fiction-left-lib", "2026-07-01T00:00:00Z")
	assertUserCursorRepo(t, store, rightCatalog.login, "fiction-right-lib", "2026-07-02T00:00:00Z")
}

func fictionDualLoginGitHub(t *testing.T, clock time.Time, catalogs ...fictionCatalog) *GitHubCollector {
	t.Helper()
	byLogin := map[string]fictionCatalog{}
	for _, catalog := range catalogs {
		byLogin[catalog.login] = catalog
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		login := ""
		for candidate := range byLogin {
			if strings.Contains(request.URL.Path, "/"+candidate) || strings.Contains(request.URL.RawQuery, candidate) {
				login = candidate
			}
		}
		if login == "" && request.URL.Path == "/graphql" {
			raw, _ := io.ReadAll(request.Body)
			request.Body = io.NopCloser(bytes.NewReader(raw))
			var body struct {
				Variables map[string]any `json:"variables"`
			}
			_ = json.Unmarshal(raw, &body)
			if value, ok := body.Variables["login"].(string); ok {
				login = value
			}
		}
		catalog, ok := byLogin[login]
		if !ok {
			catalog = catalogs[0]
		}
		(&fictionUpstream{catalog: catalog}).serve(w, request)
	}))
	t.Cleanup(server.Close)
	collector := NewGitHubCollector(NewGitHubClient("fiction-token").withBaseURL(server.URL).withHTTPClient(server.Client()))
	collector.clock = func() time.Time { return clock }
	return collector
}

func openMemoryScanStore(t *testing.T) *TursoStore {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:scan-race-"+t.Name()+"?mode=memory&cache=shared&_busy_timeout=5000")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	store := &TursoStore{db: db}
	for _, statement := range []string{
		`CREATE TABLE scores (username TEXT PRIMARY KEY, display_name TEXT, avatar_url TEXT, profile_url TEXT, final_score REAL, tier TEXT, tags TEXT, roast_line TEXT, score_version TEXT, score_write_token TEXT, score_source_collection_version TEXT, score_source_snapshot_hash TEXT, bot_score REAL, sub_scores TEXT, risk_assessment TEXT, risk_notes TEXT, scanned_at INTEGER, prev_score REAL, prev_scanned_at INTEGER, roast TEXT, roast_version TEXT, roast_en TEXT, roast_en_version TEXT, followers INTEGER, total_stars INTEGER, hidden INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE account_stats (username TEXT PRIMARY KEY, lookup_count INTEGER, first_lookup_at INTEGER, last_lookup_at INTEGER)`,
		`CREATE TABLE public_scan_runs (id TEXT PRIMARY KEY, username TEXT, score_version TEXT, collection_version TEXT, state TEXT, coverage TEXT, source_status TEXT, quick_scan TEXT, snapshot TEXT, snapshot_hash TEXT, started_at INTEGER, completed_at INTEGER, updated_at INTEGER)`,
		`CREATE TABLE score_snapshots (id TEXT PRIMARY KEY, username TEXT, display_name TEXT, avatar_url TEXT, profile_url TEXT, final_score REAL, tier TEXT, tags TEXT, roast_line TEXT, score_version TEXT, roast_version TEXT, roast_lang TEXT, bot_score REAL, sub_scores TEXT, generated_at INTEGER)`,
		`CREATE TABLE profile_snapshots (id TEXT PRIMARY KEY, username TEXT, scanned_at INTEGER, top_repos TEXT, impact_repos TEXT, verified_prs TEXT, metrics TEXT, pinned_repos TEXT, organizations TEXT, signature_work TEXT, scan_version TEXT)`,
		`CREATE TABLE developer_facets (username TEXT, facet_type TEXT, facet_value TEXT, weight REAL, PRIMARY KEY (username, facet_type, facet_value))`,
		`CREATE TABLE repos (repo_key TEXT PRIMARY KEY, name_with_owner TEXT, owner_login TEXT, name TEXT, description TEXT, stars INTEGER, forks INTEGER, language TEXT, topics TEXT, updated_at INTEGER)`,
		`CREATE TABLE repo_developers (repo_key TEXT, username TEXT, relation TEXT, commits INTEGER, prs INTEGER, weight REAL, updated_at INTEGER, PRIMARY KEY (repo_key, username, relation))`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	return store
}

func assertUserCursorRepo(t *testing.T, store *TursoStore, username, repo, pushed string) {
	t.Helper()
	book, err := store.LoadScanCursors(context.Background(), username)
	if err != nil {
		t.Fatal(err)
	}
	mark, ok := book.source(scanCursorRepos)
	if !ok || len(mark.Repos) != 1 || mark.Repos[0].Name != repo || mark.Watermark != pushed {
		t.Fatalf("%s cursor=%+v", username, mark)
	}
}

func TestDependentsPublishOnceWhenPartsFinishTogether(t *testing.T) {
	store := openScanPersistenceStore(t)
	publisher := &recordingScanPublisher{}
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, &fakeScanCollector{}, store, &fakeStatusStore{}, publisher, nil)
	parentJob := ScanJob{ID: "fiction-ready", Username: "fiction-ready", RequestedAt: 1}
	if err := store.SaveScanParent(context.Background(), parentJob, false, []string{scanPartRepos, scanPartDependents}, scanSeedEnvelope{}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.SaveScanPart(context.Background(), ScanPartJob{ParentID: parentJob.ID, Username: parentJob.Username, Part: scanPartRepos}, scanPartPayload{Part: scanPartRepos}); err != nil {
		t.Fatal(err)
	}
	parent, err := store.LoadScanParent(context.Background(), parentJob.ID)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			disposition, reason := worker.publishReady(context.Background(), parent, ScanPartJob{ParentID: parentJob.ID, Username: parentJob.Username, Part: scanPartRepos, RequestedAt: 1})
			if disposition != workerCompleted || reason != "" {
				t.Errorf("publish ready: %v %s", disposition, reason)
			}
		}()
	}
	wg.Wait()
	dependents := 0
	for _, part := range publisher.parts {
		if part.Part == scanPartDependents {
			dependents++
		}
	}
	if dependents != 1 {
		t.Fatalf("dependents published %d times", dependents)
	}
}

func TestCursorSchemaDDLRetriesAfterFailure(t *testing.T) {
	db, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), "cursor-ddl.db"))
	if err != nil {
		t.Fatal(err)
	}
	store := &TursoStore{db: db}
	db.Close()
	if err := store.EnsureScanCursorSchema(context.Background()); err == nil {
		t.Fatal("closed database accepted the first schema call")
	}
	if store.cursorSchemaOK {
		t.Fatal("failed DDL was remembered as success")
	}
	reopened, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), "cursor-ddl-retry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	store.db = reopened
	if err := store.EnsureScanCursorSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureScanCursorSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !store.cursorSchemaOK {
		t.Fatal("successful DDL was not remembered")
	}
}
