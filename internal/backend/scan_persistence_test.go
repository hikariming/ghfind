package backend

import (
	"context"
	"path/filepath"
	"testing"
)

func openScanPersistenceStore(t *testing.T) *TursoStore {
	t.Helper()
	store, err := OpenTursoStore(Config{TursoURL: "file:" + filepath.Join(t.TempDir(), "scan-persistence.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	for _, statement := range []string{
		`CREATE TABLE scores (username TEXT PRIMARY KEY, display_name TEXT, avatar_url TEXT, profile_url TEXT, final_score REAL, tier TEXT, tags TEXT, roast_line TEXT, score_version TEXT, score_write_token TEXT, score_source_collection_version TEXT, score_source_snapshot_hash TEXT, bot_score REAL, sub_scores TEXT, scanned_at INTEGER, prev_score REAL, prev_scanned_at INTEGER, roast TEXT, roast_version TEXT, roast_en TEXT, roast_en_version TEXT, followers INTEGER, total_stars INTEGER, hidden INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE account_stats (username TEXT PRIMARY KEY, lookup_count INTEGER, first_lookup_at INTEGER, last_lookup_at INTEGER)`,
		`CREATE TABLE public_scan_runs (id TEXT PRIMARY KEY, username TEXT, score_version TEXT, collection_version TEXT, state TEXT, coverage TEXT, source_status TEXT, quick_scan TEXT, snapshot TEXT, snapshot_hash TEXT, started_at INTEGER, completed_at INTEGER, updated_at INTEGER)`,
		`CREATE TABLE score_snapshots (id TEXT PRIMARY KEY, username TEXT, display_name TEXT, avatar_url TEXT, profile_url TEXT, final_score REAL, tier TEXT, tags TEXT, roast_line TEXT, score_version TEXT, roast_version TEXT, roast_lang TEXT, bot_score REAL, sub_scores TEXT, generated_at INTEGER)`,
		`CREATE TABLE profile_snapshots (id TEXT PRIMARY KEY, username TEXT, scanned_at INTEGER, top_repos TEXT, impact_repos TEXT, verified_prs TEXT, metrics TEXT, pinned_repos TEXT, organizations TEXT, signature_work TEXT, scan_version TEXT)`,
		`CREATE TABLE developer_facets (username TEXT, facet_type TEXT, facet_value TEXT, weight REAL, PRIMARY KEY (username, facet_type, facet_value))`,
		`CREATE TABLE repos (repo_key TEXT PRIMARY KEY, name_with_owner TEXT, owner_login TEXT, name TEXT, description TEXT, stars INTEGER, forks INTEGER, language TEXT, topics TEXT, updated_at INTEGER)`,
		`CREATE TABLE repo_developers (repo_key TEXT, username TEXT, relation TEXT, commits INTEGER, prs INTEGER, weight REAL, updated_at INTEGER, PRIMARY KEY (repo_key, username, relation))`,
	} {
		if _, err := store.db.Exec(statement); err != nil {
			t.Fatalf("create scan schema: %v", err)
		}
	}
	return store
}

func TestPersistCollectedScanIsAtomicIdempotentAndQueryable(t *testing.T) {
	store := openScanPersistenceStore(t)
	metrics := RawMetrics{Username: "alice", Name: stringPointer("Alice"), Followers: 12, TotalStars: 1200, MergedPRCount: 1, TotalPRCount: 1, AccountAgeYears: 3, ContributionYearsActive: 2, NonemptyOriginalRepoCount: 1, LastYearContributions: 10, DaysSinceLastActivity: floatPointer(1)}
	scan := ScanResult{Metrics: metrics, TopRepos: []TopRepo{{Name: "cool", OwnerLogin: stringPointer("Alice"), NameWithOwner: stringPointer("Alice/Cool"), Stars: 1200, Forks: 4, Language: stringPointer("Rust"), Languages: []RepoLanguage{{Name: "Rust", Size: 80}, {Name: "Go", Size: 20}}, Topics: []string{"tools"}}}, RecentPRs: []RecentPR{}, FloodPRTitles: []string{}, ImpactRepos: []ImpactRepo{{Repo: "langgenius/dify", Stars: 60000, Commits: 12, PRs: 3}}, VerifiedImpactPRs: []RecentPR{}, SignatureWork: BuildRecentSignatureWork(nil, nil), PinnedRepos: []string{}, Organizations: []string{"openai"}}
	scan.Scoring = Score(scan.Metrics)
	job := ScanJob{ID: "job_scan_idempotent", Username: "alice", RequestedAt: 1}
	created, err := store.PersistCollectedScan(context.Background(), job, scan)
	if err != nil || !created {
		t.Fatalf("first persistence created=%v err=%v", created, err)
	}
	created, err = store.PersistCollectedScan(context.Background(), job, scan)
	if err != nil || created {
		t.Fatalf("duplicate persistence created=%v err=%v", created, err)
	}
	got, err := store.GetCollectedScan(context.Background(), job.ID)
	if err != nil || got == nil || got.Metrics.Username != "alice" || got.Scoring.FinalScore != scan.Scoring.FinalScore {
		t.Fatalf("got=%#v err=%v", got, err)
	}
	var runs, profiles int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM public_scan_runs`).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM profile_snapshots`).Scan(&profiles); err != nil {
		t.Fatal(err)
	}
	if runs != 1 || profiles != 1 {
		t.Fatalf("runs=%d profiles=%d", runs, profiles)
	}
	var facets, repos, links, followers, totalStars int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM developer_facets WHERE username = 'alice'`).Scan(&facets); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM repos`).Scan(&repos); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM repo_developers WHERE username = 'alice'`).Scan(&links); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT followers, total_stars FROM scores WHERE username = 'alice'`).Scan(&followers, &totalStars); err != nil {
		t.Fatal(err)
	}
	if facets != 4 || repos != 2 || links != 2 || followers != 12 || totalStars != 1200 {
		t.Fatalf("facets=%d repos=%d links=%d followers=%d total_stars=%d", facets, repos, links, followers, totalStars)
	}
}
