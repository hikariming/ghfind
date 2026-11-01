package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestIncrementalMergeEqualsFullScanOfSameFacts(t *testing.T) {
	pushed := func(name, at string, stars float64) githubRepo {
		stamp := at
		return githubRepo{Name: name, FullName: "fiction-incremental/" + name, Size: 40, StargazersCount: stars, ForksCount: 1, PushedAt: &stamp, Language: stringPointer("Go")}
	}
	id := func(value string) *string { return &value }
	pr := func(key, at, repo string) mergedPRNode {
		stamp := at
		return mergedPRNode{ID: id(key), MergedAt: &stamp, Repository: &graphContributionRepo{NameWithOwner: repo, StargazerCount: 12, Owner: &struct {
			Login *string `json:"login"`
		}{Login: id("fiction-other")}}}
	}

	baselineRepos := []githubRepo{pushed("lib", "2026-07-01T00:00:00Z", 8), pushed("cli", "2026-06-01T00:00:00Z", 3)}
	updated := pushed("lib", "2026-08-02T00:00:00Z", 11)
	added := pushed("tool", "2026-08-03T00:00:00Z", 2)
	deleted := pushed("cli", "2026-06-01T00:00:00Z", 3)
	fullRepos := []githubRepo{added, updated}

	mergedRepos := reposFromCursorItems(mergeScanCursorItems(reposToCursorItems(baselineRepos), scanCursorAdvance{
		Source: scanCursorRepos,
		Items:  reposToCursorItems([]githubRepo{added, updated}),
	}))
	reconciled := reposFromCursorItems(mergeScanCursorItems(reposToCursorItems(mergedRepos), scanCursorAdvance{
		Source:  scanCursorRepos,
		Full:    true,
		Items:   reposToCursorItems(fullRepos),
		Dropped: []string{repoCursorKey(deleted)},
	}))
	if len(reconciled) != len(fullRepos) {
		t.Fatalf("reconciled repos=%d want %d", len(reconciled), len(fullRepos))
	}
	if reconciled[0].Name != "tool" || reconciled[1].Name != "lib" || reconciled[1].StargazersCount != 11 {
		t.Fatalf("reconciled order/stars=%+v", reconciled)
	}
	for _, repo := range reconciled {
		if repo.Name == "cli" {
			t.Fatal("deleted repo survived reconcile")
		}
	}

	kept := pr("pr-kept", "2026-05-01T00:00:00Z", "fiction-other/kept")
	fresh := pr("pr-new", "2026-08-04T00:00:00Z", "fiction-other/new")
	edited := pr("pr-kept", "2026-08-05T00:00:00Z", "fiction-other/kept")
	mergedNodes := nodesFromCursorItems(mergeScanCursorItems(nodesToCursorItems([]mergedPRNode{kept}), scanCursorAdvance{
		Source: scanCursorMerged,
		Items:  nodesToCursorItems([]mergedPRNode{fresh, edited}),
	}))
	if len(mergedNodes) != 2 || mergedNodes[0].ID == nil || *mergedNodes[0].ID != "pr-kept" || mergedNodes[0].MergedAt == nil || *mergedNodes[0].MergedAt != "2026-08-05T00:00:00Z" {
		t.Fatalf("merged nodes=%+v", mergedNodes)
	}

	fullPayload := scanPartPayload{Part: scanPartRepos, Repos: fullRepos, ForkCount: 1}
	incrementalPayload := scanPartPayload{Part: scanPartRepos, Repos: []githubRepo{added, updated}, ForkCount: 1, Incremental: true}
	base := scanSnapshotBaseline{Repos: baselineRepos}
	_, folded := applyIncrementalPayload(base, incrementalPayload, false)
	direct, _ := applyIncrementalPayload(scanSnapshotBaseline{}, fullPayload, true)
	if len(folded.Repos) != 3 || folded.Repos[0].Name != "tool" {
		t.Fatalf("incremental fold=%+v", namesOf(folded.Repos))
	}
	// Before reconcile, the deleted row is still present. That is the
	// contract: incremental does not invent deletes.
	if !containsRepo(folded.Repos, "cli") {
		t.Fatal("incremental merge dropped an unseen repo")
	}
	if len(direct.Repos) != 2 || containsRepo(direct.Repos, "cli") {
		t.Fatalf("full replace=%+v", namesOf(direct.Repos))
	}
}

func TestReconcileTriggersFromExistingConstants(t *testing.T) {
	now := time.Date(2026, 8, 10, 0, 0, 0, 0, time.UTC)
	valid := scanCursorWatermark{
		Source:       scanCursorRepos,
		Watermark:    "2026-08-01T00:00:00Z",
		Collection:   goCanonicalCollectionVersion,
		ReconciledAt: now.Add(-time.Hour).UTC().Format(time.RFC3339),
		UpdatedAt:    now.Add(-time.Hour).UTC().Format(time.RFC3339),
	}
	if got := decideScanReconcile(valid, now); got != scanReconcileNone {
		t.Fatalf("fresh cursor reason=%s", got)
	}
	if got := decideScanReconcile(scanCursorWatermark{}, now); got != scanReconcileMissing {
		t.Fatalf("missing=%s", got)
	}
	corrupt := valid
	corrupt.Watermark = "not-a-timestamp"
	if got := decideScanReconcile(corrupt, now); got != scanReconcileCorrupt {
		t.Fatalf("corrupt=%s", got)
	}
	staleVersion := valid
	staleVersion.Collection = "v6"
	if got := decideScanReconcile(staleVersion, now); got != scanReconcileVersion {
		t.Fatalf("version=%s", got)
	}
	counted := valid
	counted.IncrementalRuns = scanIncrementalReconcileEveryN()
	if got := decideScanReconcile(counted, now); got != scanReconcileRunCount {
		t.Fatalf("runs=%s every=%d", got, scanIncrementalReconcileEveryN())
	}
	aged := valid
	aged.ReconciledAt = now.Add(-scanIncrementalReconcileAge()).UTC().Format(time.RFC3339)
	if got := decideScanReconcile(aged, now); got != scanReconcileAge {
		t.Fatalf("age=%s", got)
	}
	if scanIncrementalReconcileEveryN() != int(defaultStatusTTL/roastFreshness) {
		t.Fatalf("run threshold = %d", scanIncrementalReconcileEveryN())
	}
	if scanIncrementalReconcileAge() != defaultStatusTTL {
		t.Fatalf("age threshold = %s", scanIncrementalReconcileAge())
	}
}

func TestCursorStoreRoundTripAndLazyTable(t *testing.T) {
	store := openScanPersistenceStore(t)
	book := scanCursorBook{Username: "Fiction-Cursor", Sources: map[string]scanCursorWatermark{
		scanCursorRepos: {
			Source: scanCursorRepos, Watermark: "2026-08-01T00:00:00Z", Collection: goCanonicalCollectionVersion,
			ReconciledAt: "2026-08-01T00:00:00Z",
			Repos:        []githubRepo{{Name: "fiction-lib", FullName: "fiction-cursor/fiction-lib", PushedAt: stringPointer("2026-08-01T00:00:00Z")}},
		},
	}}
	if err := store.SaveScanCursors(context.Background(), book); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.LoadScanCursors(context.Background(), "fiction-cursor")
	if err != nil {
		t.Fatal(err)
	}
	mark, ok := loaded.source(scanCursorRepos)
	if !ok || mark.Watermark != "2026-08-01T00:00:00Z" || len(mark.Repos) != 1 || mark.Repos[0].Name != "fiction-lib" {
		t.Fatalf("loaded=%+v ok=%v", mark, ok)
	}
	if _, err := store.db.Exec(`UPDATE scan_source_cursors SET book = ?, updated_at = updated_at WHERE username = ?`, `{`, "fiction-cursor"); err != nil {
		t.Fatal(err)
	}
	corrupt, err := store.LoadScanCursors(context.Background(), "fiction-cursor")
	if err != nil {
		t.Fatal(err)
	}
	if decideScanReconcile(corrupt.raw(scanCursorRepos), time.Now().UTC()) != scanReconcileMissing {
		t.Fatalf("corrupt book reason=%s raw=%+v", decideScanReconcile(corrupt.raw(scanCursorRepos), time.Now().UTC()), corrupt.raw(scanCursorRepos))
	}
}

func TestCursorSchemaMismatchAndLegacySourceReconcile(t *testing.T) {
	store := openScanPersistenceStore(t)
	stale := `{"schema":0,"username":"fiction-schema","sources":{"repos":{"source":"repos","watermark":"2026-08-01T00:00:00Z","collection":"v7"},"retired_source":{"source":"retired_source","watermark":"2026-08-01T00:00:00Z","collection":"v7"}}}`
	if _, err := store.db.Exec(`INSERT INTO scan_source_cursors (username, book, updated_at) VALUES (?, ?, 1)`, "fiction-schema", stale); err != nil {
		if err := store.EnsureScanCursorSchema(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.Exec(`INSERT INTO scan_source_cursors (username, book, updated_at) VALUES (?, ?, 1)`, "fiction-schema", stale); err != nil {
			t.Fatal(err)
		}
	}
	loaded, err := store.LoadScanCursors(context.Background(), "fiction-schema")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := loaded.source(scanCursorRepos); ok {
		t.Fatal("old schema kept a watermark")
	}
	if decideScanReconcile(loaded.raw(scanCursorRepos), time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)) != scanReconcileMissing {
		t.Fatal("schema mismatch did not reconcile")
	}
	if loaded.Revision == 0 {
		t.Fatal("schema mismatch dropped the row revision")
	}
}

func TestSameSecondPushedAtIsKeptAndDeduped(t *testing.T) {
	stamp := "2026-08-01T00:00:01Z"
	first := githubRepo{Name: "fiction-a", FullName: "fiction-same/fiction-a", StargazersCount: 1, PushedAt: &stamp}
	second := githubRepo{Name: "fiction-b", FullName: "fiction-same/fiction-b", StargazersCount: 2, PushedAt: &stamp}
	updated := githubRepo{Name: "fiction-a", FullName: "fiction-same/fiction-a", StargazersCount: 9, PushedAt: &stamp}
	if cursorBeforeWatermark(stamp, stamp) {
		t.Fatal("equal timestamp counted as older")
	}
	merged := reposFromCursorItems(mergeScanCursorItems(reposToCursorItems([]githubRepo{first}), scanCursorAdvance{
		Source: scanCursorRepos,
		Items:  reposToCursorItems([]githubRepo{second, updated}),
	}))
	if len(merged) != 2 {
		t.Fatalf("same-second repos=%d", len(merged))
	}
	foundUpdated := false
	for _, repo := range merged {
		if repo.Name == "fiction-a" && repo.StargazersCount == 9 {
			foundUpdated = true
		}
	}
	if !foundUpdated || !containsRepo(merged, "fiction-b") {
		t.Fatalf("deduped=%+v", merged)
	}
}

func TestCreatedOrderDoesNotStopOnMergedAt(t *testing.T) {
	// Page one is an older merge that was created later. Page two is a PR
	// created earlier and merged after the watermark. Stopping on mergedAt
	// would never request page two.
	var pages int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-RateLimit-Remaining", "4000")
		var body struct {
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		pages++
		if body.Variables["after"] == nil {
			fmt.Fprint(w, `{"data":{"user":{"pullRequests":{"nodes":[{"id":"pr-older","mergedAt":"2026-07-01T00:00:00Z","repository":{"nameWithOwner":"fiction-other/old","stargazerCount":1,"isPrivate":false,"isFork":false,"owner":{"login":"fiction-other"}}}],"pageInfo":{"hasNextPage":true,"endCursor":"page-2"}}}}}`)
			return
		}
		fmt.Fprint(w, `{"data":{"user":{"pullRequests":{"nodes":[{"id":"pr-late-merge","mergedAt":"2026-08-09T00:00:00Z","repository":{"nameWithOwner":"fiction-other/late","stargazerCount":1,"isPrivate":false,"isFork":false,"owner":{"login":"fiction-other"}}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}`)
	}))
	t.Cleanup(server.Close)
	client := NewGitHubClient("fiction-token").withBaseURL(server.URL).withHTTPClient(server.Client())
	nodes, err := client.fetchMergedPRNodesSince(context.Background(), "fiction-order", 10, "2026-08-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if pages < 2 {
		t.Fatalf("stopped after %d page(s)", pages)
	}
	found := false
	for _, node := range nodes {
		if node.ID != nil && *node.ID == "pr-late-merge" {
			found = true
		}
	}
	if !found {
		t.Fatalf("late merge missing: %+v", nodes)
	}
}

func TestCursorSaveConflictsWhenRevisionIsStale(t *testing.T) {
	store := openScanPersistenceStore(t)
	book := scanCursorBook{Username: "fiction-cas", Sources: map[string]scanCursorWatermark{
		scanCursorRepos: {Source: scanCursorRepos, Watermark: "2026-08-01T00:00:00Z", Collection: goCanonicalCollectionVersion},
	}}
	if err := store.SaveScanCursors(context.Background(), book); err != nil {
		t.Fatal(err)
	}
	first, err := store.LoadScanCursors(context.Background(), "fiction-cas")
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.LoadScanCursors(context.Background(), "fiction-cas")
	if err != nil {
		t.Fatal(err)
	}
	first.Sources[scanCursorRepos] = scanCursorWatermark{Source: scanCursorRepos, Watermark: "2026-08-02T00:00:00Z", Collection: goCanonicalCollectionVersion, Repos: []githubRepo{{Name: "fiction-winner", FullName: "fiction-cas/fiction-winner", PushedAt: stringPointer("2026-08-02T00:00:00Z")}}}
	if err := store.SaveScanCursors(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	second.Sources[scanCursorRepos] = scanCursorWatermark{Source: scanCursorRepos, Watermark: "2026-08-03T00:00:00Z", Collection: goCanonicalCollectionVersion}
	if err := store.SaveScanCursors(context.Background(), second); !errors.Is(err, ErrScanCursorConflict) {
		t.Fatalf("stale save err=%v", err)
	}
	loaded, err := store.LoadScanCursors(context.Background(), "fiction-cas")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Sources[scanCursorRepos].Watermark != "2026-08-02T00:00:00Z" || len(loaded.Sources[scanCursorRepos].Repos) != 1 {
		t.Fatalf("winner lost: %+v", loaded.Sources[scanCursorRepos])
	}
}

type failingCursorResultStore struct {
	*TursoStore
	failPersist bool
}

func (s *failingCursorResultStore) PersistCollectedScan(ctx context.Context, job ScanJob, scan ScanResult) (bool, error) {
	if s.failPersist {
		return false, errors.New("fiction persist failed")
	}
	return s.TursoStore.PersistCollectedScan(ctx, job, scan)
}

func TestPersistFailureDoesNotAdvanceCursor(t *testing.T) {
	clock := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
	catalog := fictionCatalog{
		login:       "fiction-persist",
		publicRepos: 1,
		repos:       []fictionRepo{{name: "fiction-lib", pushed: "2026-07-01T00:00:00Z", stars: 8}},
	}
	collector, _ := fictionIncrementalGitHub(t, catalog)
	collector.clock = func() time.Time { return clock }
	base := openScanPersistenceStore(t)
	store := &failingCursorResultStore{TursoStore: base, failPersist: true}
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanIncrementalEnabled: true}, collector, store, &fakeStatusStore{}, &fakeScanPublisher{}, nil)
	disposition, reason := worker.process(context.Background(), ScanJob{ID: "fiction-persist-1", Username: catalog.login, RequestedAt: 1})
	if disposition != workerRetry || !strings.Contains(reason, "fiction persist failed") {
		t.Fatalf("disposition=%v reason=%s", disposition, reason)
	}
	loaded, err := base.LoadScanCursors(context.Background(), catalog.login)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := loaded.source(scanCursorRepos); ok {
		t.Fatal("failed persist advanced the cursor")
	}
	store.failPersist = false
	disposition, reason = worker.process(context.Background(), ScanJob{ID: "fiction-persist-1", Username: catalog.login, RequestedAt: 1})
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("retry: %v %s", disposition, reason)
	}
	loaded, err = base.LoadScanCursors(context.Background(), catalog.login)
	if err != nil {
		t.Fatal(err)
	}
	mark, ok := loaded.source(scanCursorRepos)
	if !ok || mark.Watermark != "2026-07-01T00:00:00Z" || len(mark.Repos) != 1 {
		t.Fatalf("cursor after success=%+v ok=%v", mark, ok)
	}
}

func TestFlagOffSkipsIncrementalWatermark(t *testing.T) {
	collector, _ := fictionIncrementalGitHub(t, fictionCatalog{
		login: "fiction-flag",
		repos: []fictionRepo{{name: "fiction-lib", pushed: "2026-07-01T00:00:00Z", stars: 8}},
	})
	publisher := &recordingScanPublisher{}
	store := openScanPersistenceStore(t)
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, collector, store, &fakeStatusStore{}, publisher, nil)
	disposition, reason := worker.process(context.Background(), ScanJob{ID: "fiction-flag-off", Username: "fiction-flag", RequestedAt: 1})
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("worker: %v %s", disposition, reason)
	}
	for _, part := range publisher.parts {
		if part.Since != "" {
			t.Fatalf("flag off published since=%q part=%s", part.Since, part.Part)
		}
	}
	loaded, err := store.LoadScanCursors(context.Background(), "fiction-flag")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := loaded.source(scanCursorRepos); ok {
		t.Fatal("flag off wrote a repo cursor")
	}
}

func TestIncrementalScanMatchesFullCollect(t *testing.T) {
	clock := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
	initial := fictionCatalog{
		login:       "fiction-incremental",
		publicRepos: 3,
		repos: []fictionRepo{
			{name: "fiction-lib", pushed: "2026-07-01T00:00:00Z", stars: 8},
			{name: "fiction-old", pushed: "2026-05-01T00:00:00Z", stars: 2},
		},
		merged: []fictionPR{{id: "pr-old", merged: "2026-05-02T00:00:00Z", repo: "fiction-other/kept"}},
	}
	collector, upstream := fictionIncrementalGitHub(t, initial)
	collector.clock = func() time.Time { return clock }
	store := openScanPersistenceStore(t)
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanIncrementalEnabled: true}, collector, store, &fakeStatusStore{}, &fakeScanPublisher{}, nil)

	first, reason := worker.process(context.Background(), ScanJob{ID: "fiction-incremental-1", Username: initial.login, RequestedAt: 1})
	if first != workerCompleted || reason != "" {
		t.Fatalf("initial: %v %s", first, reason)
	}
	fullInitial, err := collector.Collect(context.Background(), initial.login)
	if err != nil {
		t.Fatal(err)
	}
	persisted := loadPersistedScan(t, store, "fiction-incremental-1")
	assertSameScanContract(t, "initial", persisted, fullInitial)

	next := fictionCatalog{
		login:       initial.login,
		publicRepos: 3,
		repos: []fictionRepo{
			{name: "fiction-lib", pushed: "2026-08-02T00:00:00Z", stars: 14},
			{name: "fiction-new", pushed: "2026-08-03T00:00:00Z", stars: 4},
		},
		merged: []fictionPR{
			{id: "pr-old", merged: "2026-05-02T00:00:00Z", repo: "fiction-other/kept"},
			{id: "pr-new", merged: "2026-08-04T00:00:00Z", repo: "fiction-other/new"},
		},
	}
	// The live catalog drops fiction-old. Incremental must keep it until reconcile.
	upstream.catalog = next
	second, reason := worker.process(context.Background(), ScanJob{ID: "fiction-incremental-2", Username: initial.login, RequestedAt: 2})
	if second != workerCompleted || reason != "" {
		t.Fatalf("incremental: %v %s", second, reason)
	}
	incremental := loadPersistedScan(t, store, "fiction-incremental-2")

	// A full collect of the pre-delete catalog plus the add/update is the
	// contract incremental must match. The deleted repo remains until reconcile.
	kept := initial
	kept.publicRepos = 3
	kept.repos = []fictionRepo{
		{name: "fiction-new", pushed: "2026-08-03T00:00:00Z", stars: 4},
		{name: "fiction-lib", pushed: "2026-08-02T00:00:00Z", stars: 14},
		{name: "fiction-old", pushed: "2026-05-01T00:00:00Z", stars: 2},
	}
	kept.merged = next.merged
	fullCollector, _ := fictionIncrementalGitHub(t, kept)
	fullCollector.clock = func() time.Time { return clock }
	fullScan, err := fullCollector.Collect(context.Background(), kept.login)
	if err != nil {
		t.Fatal(err)
	}
	assertSameScanContract(t, "incremental", incremental, fullScan)
	if incremental.Metrics.TotalStars != fullScan.Metrics.TotalStars || incremental.Metrics.MergedPRCount != fullScan.Metrics.MergedPRCount {
		t.Fatalf("metrics incremental=%+v full=%+v", incremental.Metrics.TotalStars, fullScan.Metrics.TotalStars)
	}

	// Age threshold forces a full reconcile, which drops fiction-old.
	book, err := store.LoadScanCursors(context.Background(), initial.login)
	if err != nil {
		t.Fatal(err)
	}
	mark := book.Sources[scanCursorRepos]
	mark.ReconciledAt = clock.Add(-scanIncrementalReconcileAge()).UTC().Format(time.RFC3339)
	book.Sources[scanCursorRepos] = mark
	if err := store.SaveScanCursors(context.Background(), book); err != nil {
		t.Fatal(err)
	}
	upstream.catalog = next
	collector.clock = func() time.Time { return clock.Add(scanIncrementalReconcileAge()) }
	third, reason := worker.process(context.Background(), ScanJob{ID: "fiction-incremental-3", Username: initial.login, RequestedAt: 3})
	if third != workerCompleted || reason != "" {
		t.Fatalf("reconcile: %v %s", third, reason)
	}
	reconciledScan := loadPersistedScan(t, store, "fiction-incremental-3")
	reconciledCatalog := next
	reconciledCatalog.publicRepos = 3
	fresh, _ := fictionIncrementalGitHub(t, reconciledCatalog)
	fresh.clock = collector.clock
	fullAfterDelete, err := fresh.Collect(context.Background(), reconciledCatalog.login)
	if err != nil {
		t.Fatal(err)
	}
	assertSameScanContract(t, "reconcile", reconciledScan, fullAfterDelete)
}

func TestCollectFullRewritesCursorsToFullScan(t *testing.T) {
	clock := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
	// publicRepos above the quick page bound forces #582 to deepen.
	catalog := fictionCatalog{
		login:       "fiction-deepen",
		publicRepos: quickRepoPages*githubPageSize + 1,
		repos: []fictionRepo{
			{name: "fiction-lib", pushed: "2026-08-02T00:00:00Z", stars: 8},
			{name: "fiction-new", pushed: "2026-08-03T00:00:00Z", stars: 3},
		},
	}
	discarded := githubRepo{
		Name: "fiction-discard", FullName: catalog.login + "/fiction-discard", Size: 4, StargazersCount: 1,
		PushedAt: stringPointer("2026-04-01T00:00:00Z"),
	}
	seedBook := scanCursorBook{
		Username: catalog.login,
		Sources: map[string]scanCursorWatermark{
			scanCursorRepos: {
				Source: scanCursorRepos, Watermark: "2026-06-01T00:00:00Z", Collection: goCanonicalCollectionVersion,
				ReconciledAt: "2026-08-03T00:00:00Z", UpdatedAt: "2026-08-03T00:00:00Z",
				Repos: []githubRepo{discarded}, ForkCount: 4,
			},
		},
	}

	t.Run("in-process", func(t *testing.T) {
		collector, _ := fictionIncrementalGitHub(t, catalog)
		collector.clock = func() time.Time { return clock }
		store := openScanPersistenceStore(t)
		if err := store.SaveScanCursors(context.Background(), seedBook); err != nil {
			t.Fatal(err)
		}
		worker := NewScanWorker(Config{MaxAttempts: 3, ScanIncrementalEnabled: true}, collector, store, &fakeStatusStore{}, &fakeScanPublisher{}, nil)
		disposition, reason := worker.process(context.Background(), ScanJob{ID: "fiction-deepen-inline", Username: catalog.login, RequestedAt: 1})
		if disposition != workerCompleted || reason != "" {
			t.Fatalf("worker: %v %s", disposition, reason)
		}
		assertDeepenCursorMatchesFullScan(t, store, collector, catalog, discarded.Name)
	})

	t.Run("fan-out", func(t *testing.T) {
		collector, _ := fictionIncrementalGitHub(t, catalog)
		collector.clock = func() time.Time { return clock }
		store := openScanPersistenceStore(t)
		if err := store.SaveScanCursors(context.Background(), seedBook); err != nil {
			t.Fatal(err)
		}
		publisher := &recordingScanPublisher{}
		worker := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true, ScanIncrementalEnabled: true}, collector, store, &fakeStatusStore{}, publisher, nil)
		disposition, reason := worker.process(context.Background(), ScanJob{ID: "fiction-deepen-fanout", Username: catalog.login, RequestedAt: 1})
		if disposition != workerCompleted || reason != "" {
			t.Fatalf("split: %v %s", disposition, reason)
		}
		if len(publisher.parts) == 0 {
			t.Fatal("heavy account did not fan out")
		}
		// Dependents are published only after the independent parts finish,
		// and only the worker that stored the last independent part emits it.
		seen := map[string]bool{}
		var parent scanParentRecord
		for round := 0; round < 4; round++ {
			loaded, err := store.LoadScanParent(context.Background(), "fiction-deepen-fanout")
			if err != nil {
				t.Fatal(err)
			}
			parent = loaded
			if parent.Done {
				break
			}
			progress := false
			for _, part := range append([]ScanPartJob(nil), publisher.parts...) {
				if seen[part.Part] {
					continue
				}
				partDisposition, partReason := worker.processPart(context.Background(), part)
				if partDisposition != workerCompleted || partReason != "" {
					t.Fatalf("part %s: %v %s", part.Part, partDisposition, partReason)
				}
				seen[part.Part] = true
				progress = true
			}
			if !progress && round == 3 {
				t.Fatalf("fan-out parent never completed parts=%v published=%+v seen=%v", parent.Parts, publisher.parts, seen)
			}
		}
		assembleDisposition, assembleReason := worker.processAssemble(context.Background(), ScanAssembleJob{
			ParentID: parent.ID, Username: catalog.login, Phase: scanPhaseAssemble, RequestedAt: 1,
		})
		if assembleDisposition != workerCompleted || assembleReason != "" {
			t.Fatalf("assemble: %v %s", assembleDisposition, assembleReason)
		}
		assertDeepenCursorMatchesFullScan(t, store, collector, catalog, discarded.Name)
	})
}

func assertDeepenCursorMatchesFullScan(t *testing.T, store *TursoStore, collector *GitHubCollector, catalog fictionCatalog, discardedName string) {
	t.Helper()
	loaded, err := store.LoadScanCursors(context.Background(), catalog.login)
	if err != nil {
		t.Fatal(err)
	}
	mark, ok := loaded.source(scanCursorRepos)
	if !ok {
		t.Fatal("deepen wrote no repo cursor")
	}
	if containsRepo(mark.Repos, discardedName) {
		t.Fatalf("discarded incremental repo persisted: %+v", namesOf(mark.Repos))
	}
	var captured []githubRepo
	var forkCount float64
	fullScan, err := collector.CollectFull(context.WithValue(context.Background(), inventoryCapture{}, inventoryCapture{Repos: &captured, ForkCount: &forkCount}), catalog.login)
	if err != nil {
		t.Fatal(err)
	}
	if len(mark.Repos) != len(captured) || mark.ForkCount != forkCount {
		t.Fatalf("cursor repos=%v forks=%v full repos=%v forks=%v", namesOf(mark.Repos), mark.ForkCount, namesOf(captured), forkCount)
	}
	for _, repo := range captured {
		if !containsRepo(mark.Repos, repo.Name) {
			t.Fatalf("full repo %s missing from cursor %v", repo.Name, namesOf(mark.Repos))
		}
	}
	if fullScan.Collection == nil || fullScan.Collection.Mode != "full" {
		t.Fatalf("reference collect mode=%v", fullScan.Collection)
	}
}

func TestCursorSaveConcurrentUpsert(t *testing.T) {
	store := openScanPersistenceStore(t)
	seed := scanCursorBook{Username: "fiction-race", Sources: map[string]scanCursorWatermark{
		scanCursorRepos: {Source: scanCursorRepos, Watermark: "2026-08-01T00:00:00Z", Collection: goCanonicalCollectionVersion},
	}}
	if err := store.SaveScanCursors(context.Background(), seed); err != nil {
		t.Fatal(err)
	}
	const racers = 8
	shared, err := store.LoadScanCursors(context.Background(), "fiction-race")
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	wins := make(chan string, racers)
	conflicts := make(chan struct{}, racers)
	other := make(chan error, racers)
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			loaded := shared
			loaded.Sources = map[string]scanCursorWatermark{}
			for name, mark := range shared.Sources {
				loaded.Sources[name] = mark
			}
			name := fmt.Sprintf("fiction-racer-%d", i)
			stamp := fmt.Sprintf("2026-08-%02dT00:00:00Z", 2+i)
			loaded.Sources[scanCursorRepos] = scanCursorWatermark{
				Source: scanCursorRepos, Watermark: stamp, Collection: goCanonicalCollectionVersion,
				Repos: []githubRepo{{Name: name, FullName: "fiction-race/" + name, PushedAt: &stamp}},
			}
			<-start
			err := store.SaveScanCursors(context.Background(), loaded)
			if errors.Is(err, ErrScanCursorConflict) {
				conflicts <- struct{}{}
				return
			}
			if err != nil {
				other <- err
				return
			}
			wins <- name
		}(i)
	}
	close(start)
	wg.Wait()
	close(wins)
	close(conflicts)
	close(other)
	for err := range other {
		t.Fatal(err)
	}
	winners := []string{}
	for name := range wins {
		winners = append(winners, name)
	}
	lost := 0
	for range conflicts {
		lost++
	}
	if len(winners) != 1 || lost != racers-1 {
		t.Fatalf("winners=%v conflicts=%d", winners, lost)
	}
	loaded, err := store.LoadScanCursors(context.Background(), "fiction-race")
	if err != nil {
		t.Fatal(err)
	}
	mark := loaded.Sources[scanCursorRepos]
	if len(mark.Repos) != 1 || mark.Repos[0].Name != winners[0] {
		t.Fatalf("stored %+v winner %s", mark.Repos, winners[0])
	}
}

func TestFanoutIncrementalPartMergesBeforeAssemble(t *testing.T) {
	catalog := fictionCatalog{
		login:       "fiction-fanout",
		publicRepos: quickRepoPages*githubPageSize + 1,
		repos: []fictionRepo{
			{name: "fiction-lib", pushed: "2026-07-01T00:00:00Z", stars: 8},
		},
		mergedCount: float64(externalMergedPRCap),
		closed:      float64(githubPageSize + 1),
	}
	collector, _ := fictionIncrementalGitHub(t, catalog)
	collector.clock = func() time.Time { return time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC) }
	store := openScanPersistenceStore(t)
	if err := store.SaveScanCursors(context.Background(), scanCursorBook{
		Username: catalog.login,
		Sources: map[string]scanCursorWatermark{
			scanCursorRepos: {
				Source: scanCursorRepos, Watermark: "2026-06-01T00:00:00Z", Collection: goCanonicalCollectionVersion,
				ReconciledAt: "2026-08-03T00:00:00Z", UpdatedAt: "2026-08-03T00:00:00Z",
				Repos: []githubRepo{{
					Name: "fiction-stale", FullName: catalog.login + "/fiction-stale", Size: 10, StargazersCount: 1,
					PushedAt: stringPointer("2026-04-01T00:00:00Z"),
				}},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}
	publisher := &recordingScanPublisher{}
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true, ScanIncrementalEnabled: true}, collector, store, &fakeStatusStore{}, publisher, nil)
	disposition, reason := worker.process(context.Background(), ScanJob{ID: "fiction-fanout-job", Username: catalog.login, RequestedAt: 1})
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("split: %v %s", disposition, reason)
	}
	var reposPart ScanPartJob
	found := false
	for _, part := range publisher.parts {
		if part.Part == scanPartRepos {
			reposPart = part
			found = true
		}
	}
	if !found || reposPart.Since != "2026-06-01T00:00:00Z" {
		t.Fatalf("repos part since=%q parts=%+v", reposPart.Since, publisher.parts)
	}
	parent, err := store.LoadScanParent(context.Background(), "fiction-fanout-job")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := worker.collectPart(context.Background(), collector, reposPart, parent)
	if err != nil {
		t.Fatal(err)
	}
	if !payload.Incremental {
		t.Fatal("repos part was not incremental")
	}
	parent.Payloads = map[string]scanPartPayload{scanPartRepos: payload}
	merged, err := worker.mergeIncrementalPayloads(context.Background(), parent)
	if err != nil {
		t.Fatal(err)
	}
	names := namesOf(merged[scanPartRepos].Repos)
	if !containsRepo(merged[scanPartRepos].Repos, "fiction-lib") || !containsRepo(merged[scanPartRepos].Repos, "fiction-stale") {
		t.Fatalf("merged repos=%v", names)
	}
}

type fictionRepo struct {
	name   string
	pushed string
	stars  float64
}

type fictionPR struct {
	id     string
	merged string
	repo   string
}

type fictionCatalog struct {
	login       string
	publicRepos int
	repos       []fictionRepo
	merged      []fictionPR
	mergedCount float64
	closed      float64
}

type fictionUpstream struct {
	catalog fictionCatalog
}

func (u *fictionUpstream) serve(w http.ResponseWriter, request *http.Request) {
	catalog := u.catalog
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-RateLimit-Remaining", "4000")
	if request.URL.Path == "/users/"+catalog.login {
		publicRepos := catalog.publicRepos
		if publicRepos == 0 {
			publicRepos = len(catalog.repos)
		}
		fmt.Fprintf(w, `{"login":%q,"id":424242,"node_id":"U_FICTION","html_url":"https://github.com/%s","created_at":"2020-01-01T00:00:00Z","followers":4,"following":1,"public_repos":%d,"bio":"fictional"}`, catalog.login, catalog.login, publicRepos)
		return
	}
	if strings.HasPrefix(request.URL.Path, "/users/") && strings.HasSuffix(request.URL.Path, "/events/public") {
		fmt.Fprint(w, `[{"created_at":"2026-08-01T00:00:00Z"}]`)
		return
	}
	if strings.HasPrefix(request.URL.Path, "/users/") && strings.HasSuffix(request.URL.Path, "/repos") {
		fmt.Fprint(w, `[]`)
		return
	}
	if request.URL.Path != "/graphql" {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{}`)
		return
	}
	var body struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	_ = json.NewDecoder(request.Body).Decode(&body)
	nodes := make([]map[string]any, 0, len(catalog.repos))
	for _, repo := range catalog.repos {
		nodes = append(nodes, map[string]any{
			"name": repo.name, "nameWithOwner": catalog.login + "/" + repo.name, "isFork": false,
			"diskUsage": 40, "stargazerCount": repo.stars, "forkCount": 1,
			"description": "Fictional library", "pushedAt": repo.pushed,
			"primaryLanguage":  map[string]any{"name": "Go"},
			"issues":           map[string]any{"totalCount": 0},
			"openPullRequests": map[string]any{"totalCount": 0},
			"repositoryTopics": map[string]any{"nodes": []any{}},
		})
	}
	prNodes := make([]map[string]any, 0, len(catalog.merged))
	for _, pr := range catalog.merged {
		prNodes = append(prNodes, map[string]any{
			"id": pr.id, "mergedAt": pr.merged,
			"repository": map[string]any{
				"nameWithOwner": pr.repo, "stargazerCount": 9, "isPrivate": false, "isFork": false,
				"owner": map[string]any{"login": "fiction-other"},
			},
		})
	}
	mergedCount := catalog.mergedCount
	if mergedCount == 0 {
		mergedCount = float64(len(catalog.merged))
	}
	closed := catalog.closed
	data := map[string]any{
		"user": map[string]any{
			"pronouns":          nil,
			"pinnedItems":       map[string]any{"nodes": []any{}},
			"mergedPRs":         map[string]any{"totalCount": mergedCount},
			"allPRs":            map[string]any{"totalCount": mergedCount},
			"closedPRs":         map[string]any{"totalCount": closed, "nodes": []any{}},
			"issues":            map[string]any{"totalCount": 0},
			"contributionYears": map[string]any{"contributionYears": []int{}},
			"contributionsCollection": map[string]any{
				"totalCommitContributions": 1, "totalPullRequestContributions": len(catalog.merged),
				"totalIssueContributions": 0, "totalPullRequestReviewContributions": 0,
				"contributionCalendar": map[string]any{"totalContributions": 2},
				"contributionYears":    []int{},
			},
			"organizations": map[string]any{"nodes": []any{}},
			"pullRequests":  map[string]any{"nodes": prNodes, "pageInfo": map[string]any{"hasNextPage": false, "endCursor": "cursor-fiction"}},
			"forks":         map[string]any{"totalCount": 4},
			"repositories":  map[string]any{"nodes": nodes, "pageInfo": map[string]any{"hasNextPage": false, "endCursor": "cursor-repos"}},
		},
		"search": map[string]any{"issueCount": 0, "nodes": []any{}, "pageInfo": map[string]any{"hasNextPage": false, "endCursor": nil}},
	}
	encoded, _ := json.Marshal(map[string]any{"data": data})
	_, _ = w.Write(encoded)
}

func fictionIncrementalGitHub(t *testing.T, catalog fictionCatalog) (*GitHubCollector, *fictionUpstream) {
	t.Helper()
	upstream := &fictionUpstream{catalog: catalog}
	server := httptest.NewServer(http.HandlerFunc(upstream.serve))
	t.Cleanup(server.Close)
	collector := NewGitHubCollector(NewGitHubClient("fiction-token").withBaseURL(server.URL).withHTTPClient(server.Client()))
	collector.clock = func() time.Time { return time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC) }
	return collector, upstream
}

func loadPersistedScan(t *testing.T, store *TursoStore, id string) ScanResult {
	t.Helper()
	scan, err := store.GetCollectedScan(context.Background(), id)
	if err != nil || scan == nil {
		t.Fatalf("load %s: %v", id, err)
	}
	return *scan
}

func assertSameScanContract(t *testing.T, label string, got, want ScanResult) {
	t.Helper()
	if got.Collection == nil || want.Collection == nil {
		t.Fatalf("%s missing collection got=%v want=%v", label, got.Collection, want.Collection)
	}
	if got.Collection.Mode != want.Collection.Mode || got.Collection.Coverage != want.Collection.Coverage {
		t.Fatalf("%s coverage got=%s/%s want=%s/%s reasons=%v/%v", label, got.Collection.Mode, got.Collection.Coverage, want.Collection.Mode, want.Collection.Coverage, got.Collection.TruncationReasons, want.Collection.TruncationReasons)
	}
	if got.Scoring.FinalScore != want.Scoring.FinalScore {
		t.Fatalf("%s score got=%v want=%v", label, got.Scoring.FinalScore, want.Scoring.FinalScore)
	}
	if got.Metrics.TotalStars != want.Metrics.TotalStars || got.Metrics.PublicRepos != want.Metrics.PublicRepos || got.Metrics.OriginalRepoCount != want.Metrics.OriginalRepoCount || got.Metrics.MergedPRCount != want.Metrics.MergedPRCount || got.Metrics.ForkRepoCount != want.Metrics.ForkRepoCount {
		t.Fatalf("%s metrics stars=%v/%v repos=%v/%v original=%v/%v merged=%v/%v forks=%v/%v", label,
			got.Metrics.TotalStars, want.Metrics.TotalStars,
			got.Metrics.PublicRepos, want.Metrics.PublicRepos,
			got.Metrics.OriginalRepoCount, want.Metrics.OriginalRepoCount,
			got.Metrics.MergedPRCount, want.Metrics.MergedPRCount,
			got.Metrics.ForkRepoCount, want.Metrics.ForkRepoCount)
	}
	if string(got.SourceStatus) != string(want.SourceStatus) && len(want.SourceStatus) > 0 && len(got.SourceStatus) > 0 {
		t.Fatalf("%s source_status got=%s want=%s", label, got.SourceStatus, want.SourceStatus)
	}
}

func namesOf(repos []githubRepo) []string {
	out := make([]string, 0, len(repos))
	for _, repo := range repos {
		out = append(out, repo.Name)
	}
	return out
}

func containsRepo(repos []githubRepo, name string) bool {
	for _, repo := range repos {
		if repo.Name == name {
			return true
		}
	}
	return false
}
