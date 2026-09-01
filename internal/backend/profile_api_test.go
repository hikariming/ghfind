package backend

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func openProfileAPITestStore(t *testing.T) *TursoStore {
	t.Helper()
	store, err := OpenTursoStore(Config{TursoURL: "file:" + filepath.Join(t.TempDir(), "profile-api.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	for _, statement := range []string{
		`CREATE TABLE scores (
			username TEXT PRIMARY KEY, display_name TEXT, avatar_url TEXT, profile_url TEXT,
			final_score REAL NOT NULL, tier TEXT NOT NULL, tags TEXT, roast_line TEXT, sub_scores TEXT,
			roast TEXT, roast_en TEXT, score_version TEXT, score_source_collection_version TEXT,
			score_source_snapshot_hash TEXT, roast_version TEXT, roast_en_version TEXT, scanned_at INTEGER,
			prev_score REAL, prev_scanned_at INTEGER, hidden INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE profile_snapshots (
			id TEXT PRIMARY KEY, username TEXT, scanned_at INTEGER, top_repos TEXT, impact_repos TEXT,
			verified_prs TEXT, metrics TEXT, pinned_repos TEXT, organizations TEXT, signature_work TEXT, scan_version TEXT
		)`,
		`CREATE TABLE account_stats (username TEXT PRIMARY KEY, lookup_count INTEGER, last_lookup_at INTEGER)`,
		`CREATE TABLE account_lookup_limits (username TEXT, last_counted_at INTEGER)`,
		`CREATE TABLE developer_facets (username TEXT, facet_type TEXT, facet_value TEXT, weight REAL)`,
		`CREATE TABLE score_snapshots (id TEXT PRIMARY KEY, username TEXT, final_score REAL, generated_at INTEGER)`,
		`CREATE TABLE public_scan_runs (
			id TEXT PRIMARY KEY, username TEXT, score_version TEXT, collection_version TEXT, state TEXT,
			snapshot TEXT, snapshot_hash TEXT
		)`,
		`CREATE TABLE vs_matchups (
			handle_a TEXT, handle_b TEXT, winner TEXT, bucket TEXT, gap REAL, score_a REAL, score_b REAL,
			verdict TEXT, advice TEXT, verdict_source TEXT, view_count INTEGER, created_at INTEGER, updated_at INTEGER,
			PRIMARY KEY(handle_a, handle_b)
		)`,
		`CREATE TABLE repos (
			repo_key TEXT PRIMARY KEY, name_with_owner TEXT, owner_login TEXT, name TEXT,
			description TEXT, stars REAL, forks REAL, language TEXT, topics TEXT
		)`,
		`CREATE TABLE repo_developers (repo_key TEXT, username TEXT)`,
	} {
		if _, err := store.db.Exec(statement); err != nil {
			t.Fatalf("create profile test schema: %v", err)
		}
	}
	return store
}

func insertProfileAPITestScore(t *testing.T, store *TursoStore, username string, score float64) {
	t.Helper()
	_, err := store.db.Exec(`INSERT INTO scores
		(username, display_name, avatar_url, profile_url, final_score, tier, tags, roast_line, sub_scores,
		 roast, roast_en, score_version, score_source_collection_version, score_source_snapshot_hash,
		 roast_version, roast_en_version, scanned_at, prev_score, prev_scanned_at, hidden)
		VALUES (?, ?, ?, ?, ?, '顶级', '{"zh":["工程"],"en":["engineering"]}', '{"zh":"一句","en":"line"}',
		'{"account_maturity":8,"original_project_quality":12,"contribution_quality":19,"ecosystem_impact":14,"community_influence":5,"activity_authenticity":13}',
		'中文报告', 'English report', 'v9', 'v4', ?, 'v10', 'v10', 1000, 70, 100, 0)`,
		username, username, "https://avatars.example/"+username, "https://github.com/"+username, score, strings.Repeat("a", 64))
	if err != nil {
		t.Fatalf("insert score %s: %v", username, err)
	}
	_, err = store.db.Exec(`INSERT INTO public_scan_runs
		(id, username, score_version, collection_version, state, snapshot, snapshot_hash)
		VALUES (?, ?, 'v9', 'v4', 'complete_public', ?, ?)`,
		"scan-"+username, username,
		fmt.Sprintf(`{"scoring":{"sub_scores":{"account_maturity":8,"original_project_quality":12,"contribution_quality":19,"ecosystem_impact":14,"community_influence":5,"activity_authenticity":13},"base_score":%.2f,"red_flags":[{"flag":"mostly_forks","penalty":10,"detail":"Mostly forks"}],"total_penalty":10,"final_score":%.2f,"tier":"顶级","tier_label":"test"}}`, score+10, score),
		strings.Repeat("a", 64))
	if err != nil {
		t.Fatalf("insert score snapshot %s: %v", username, err)
	}
}

func TestProfilePresentationPreservesVersionGatedPublicFields(t *testing.T) {
	store := openProfileAPITestStore(t)
	insertProfileAPITestScore(t, store, "octocat", 88.2)
	insertProfileAPITestScore(t, store, "similar", 87.9)
	for _, username := range []string{"octocat", "similar"} {
		if _, err := store.db.Exec(`INSERT INTO account_stats (username, lookup_count, last_lookup_at) VALUES (?, 4, 0)`, username); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.db.Exec(`INSERT INTO profile_snapshots
		(id, username, scanned_at, top_repos, impact_repos, metrics, pinned_repos, organizations, signature_work, scan_version)
		VALUES ('profile', 'octocat', 1000, '[{"name":"demo","name_with_owner":"octocat/demo","stars":9,"forks":0,"open_issues":0,"size":1,"language":"Go"}]',
		'[{"repo":"acme/core","stars":1000,"commits":2,"prs":1}]',
		'{"bio":"builds reliable things","followers":5,"public_repos":2,"total_stars":9}', '["octocat/demo"]', '["acme"]',
		'{"impact_repo_representatives":[],"work_clusters":[],"source":"recent_sample"}', 'v9')`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO vs_matchups
		(handle_a, handle_b, winner, bucket, gap, score_a, score_b, verdict, advice, verdict_source, view_count, created_at, updated_at)
		VALUES ('octocat', 'similar', 'octocat', 'edge', 0.3, 88.2, 87.9, '{"zh":"胜","en":"wins"}', NULL, 'llm', 3, 1, 2)`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO repos (repo_key, name_with_owner, owner_login, name, stars, language, topics) VALUES ('shared/repo', 'shared/repo', 'shared', 'repo', 9, 'Go', '[]')`); err != nil {
		t.Fatal(err)
	}
	for _, username := range []string{"octocat", "similar"} {
		if _, err := store.db.Exec(`INSERT INTO repo_developers (repo_key, username) VALUES ('shared/repo', ?)`, username); err != nil {
			t.Fatal(err)
		}
	}

	server := NewAPIServer(Config{}, store, &fakeStatusStore{}, &fakePublisher{})
	request := httptest.NewRequest(http.MethodGet, "/api/profile/OctoCat", nil)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	for _, fragment := range []string{
		`"username":"octocat"`, `"roast":"中文报告"`, `"roast_en":"English report"`,
		`"bio":"builds reliable things"`, `"rank":1`, `"handleA":"octocat"`,
		`"repo_key":"shared/repo"`, `"score_breakdown":{"base_score":98.2,"total_penalty":10,"applied_penalty":10,"red_flags":[{"flag":"mostly_forks"`,
	} {
		if !strings.Contains(body, fragment) {
			t.Fatalf("missing %s in %s", fragment, body)
		}
	}
	if got := response.Header().Get("Cache-Control"); got != profileCacheControl {
		t.Fatalf("cache-control=%q", got)
	}
}

func TestProfileDetailRejectsNonCanonicalRowsWithoutLegacyArtifact(t *testing.T) {
	store := openProfileAPITestStore(t)
	_, err := store.db.Exec(`INSERT INTO scores
		(username, final_score, tier, tags, roast_line, sub_scores, score_version, scanned_at, hidden)
		VALUES ('old', 80, '顶级', '{}', '{}', '{}', 'v8', 1, 0)`)
	if err != nil {
		t.Fatal(err)
	}
	detail, err := store.GetProfileDetail(context.Background(), "old")
	if err != nil {
		t.Fatal(err)
	}
	if detail != nil {
		t.Fatalf("detail=%#v, want nil", detail)
	}
}

func TestProfileDetailFallsBackWithoutInventingRedFlags(t *testing.T) {
	store := openProfileAPITestStore(t)
	insertProfileAPITestScore(t, store, "fallback", 60)
	if _, err := store.db.Exec(`DELETE FROM public_scan_runs WHERE username = 'fallback'`); err != nil {
		t.Fatal(err)
	}

	detail, err := store.GetProfileDetail(context.Background(), "fallback")
	if err != nil {
		t.Fatal(err)
	}
	if detail == nil || detail.ScoreBreakdown == nil {
		t.Fatalf("detail=%#v", detail)
	}
	if detail.ScoreBreakdown.Complete {
		t.Fatal("fallback breakdown must not claim complete red-flag evidence")
	}
	if detail.ScoreBreakdown.BaseScore != 71 || detail.ScoreBreakdown.AppliedPenalty != 11 {
		t.Fatalf("breakdown=%#v", detail.ScoreBreakdown)
	}
	if len(detail.ScoreBreakdown.RedFlags) != 0 {
		t.Fatalf("red flags=%#v, want none", detail.ScoreBreakdown.RedFlags)
	}
}
