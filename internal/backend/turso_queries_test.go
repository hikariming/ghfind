package backend

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

func openQueryTestStore(t *testing.T) *TursoStore {
	t.Helper()
	store, err := OpenTursoStore(Config{TursoURL: "file:" + filepath.Join(t.TempDir(), "backend-test.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	for _, statement := range []string{
		`CREATE TABLE scores (
			username TEXT PRIMARY KEY, display_name TEXT, avatar_url TEXT, profile_url TEXT,
			final_score REAL NOT NULL, tier TEXT NOT NULL, tags TEXT, score_version TEXT,
			hidden INTEGER NOT NULL DEFAULT 0, scanned_at INTEGER NOT NULL, prev_score REAL, prev_scanned_at INTEGER,
			roast_line TEXT, bot_score REAL, sub_scores TEXT
		)`,
		`CREATE TABLE account_stats (
			username TEXT PRIMARY KEY, lookup_count INTEGER, last_lookup_at INTEGER
		)`,
		`CREATE TABLE account_lookup_limits (username TEXT NOT NULL, last_counted_at INTEGER NOT NULL)`,
		`CREATE TABLE developer_facets (
			username TEXT NOT NULL, facet_type TEXT NOT NULL, facet_value TEXT NOT NULL, weight REAL
		)`,
		`CREATE TABLE campaign_participants (campaign TEXT NOT NULL, username TEXT NOT NULL)`,
		`CREATE TABLE score_snapshots (
			id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT, avatar_url TEXT,
			profile_url TEXT, final_score REAL NOT NULL, tier TEXT NOT NULL, tags TEXT,
			roast_line TEXT, bot_score REAL, sub_scores TEXT, score_version TEXT NOT NULL,
			roast_version TEXT NOT NULL, roast_lang TEXT NOT NULL, generated_at INTEGER NOT NULL
		)`,
	} {
		if _, err := store.db.Exec(statement); err != nil {
			t.Fatalf("create test schema: %v", err)
		}
	}
	return store
}

func insertQueryTestScore(t *testing.T, store *TursoStore, username string, score float64, scannedAt int64) {
	t.Helper()
	_, err := store.db.Exec(`INSERT INTO scores
		(username, display_name, avatar_url, profile_url, final_score, tier, tags, score_version, hidden, scanned_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
		username, username, "https://avatars.example/"+username, "https://github.com/"+username,
		score, "顶级", `{"zh":["工程"],"en":["engineering"]}`, canonicalScoreVersion, scannedAt)
	if err != nil {
		t.Fatalf("insert score %s: %v", username, err)
	}
}

func TestTursoTrendingRanksBeforeApplyingThePublicLimit(t *testing.T) {
	store := openQueryTestStore(t)
	now := time.Now().UnixMilli()
	for index := 0; index < leaderboardLimit; index++ {
		insertQueryTestScore(t, store, fmt.Sprintf("a-%03d", index), 60, now-int64(index))
	}
	insertQueryTestScore(t, store, "z-hot", 100, now)
	if _, err := store.db.Exec(`INSERT INTO account_stats (username, lookup_count, last_lookup_at) VALUES (?, ?, ?)`, "z-hot", 20, now); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO account_lookup_limits (username, last_counted_at) VALUES (?, ?)`, "z-hot", now); err != nil {
		t.Fatal(err)
	}

	entries, err := store.GetLeaderboard(context.Background(), "trending", "all")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != leaderboardLimit || entries[0].Username != "z-hot" {
		t.Fatalf("top %d entries = %d, first = %q", leaderboardLimit, len(entries), entries[0].Username)
	}
}

func TestTursoDeveloperDirectoryUsesExistingPublicReadFilters(t *testing.T) {
	store := openQueryTestStore(t)
	now := time.Now().UnixMilli()
	insertQueryTestScore(t, store, "octocat", 90, now)
	insertQueryTestScore(t, store, "hubot", 80, now-1)
	if _, err := store.db.Exec(`INSERT INTO developer_facets (username, facet_type, facet_value, weight) VALUES
		('octocat', 'language', 'Go', 90), ('hubot', 'language', 'Go', 75), ('octocat', 'repo', 'openai/gpt', 1)`); err != nil {
		t.Fatal(err)
	}

	categories, err := store.GetFacetCategories(context.Background(), "language")
	if err != nil {
		t.Fatal(err)
	}
	if len(categories) != 1 || categories[0] != (FacetCategory{Value: "Go", Count: 2}) {
		t.Fatalf("categories = %#v", categories)
	}
	entries, err := store.GetDevelopersByFacet(context.Background(), "language", "Go")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Username != "octocat" || entries[0].RecentLookupCount != 0 || entries[0].LookupCount != 1 {
		t.Fatalf("entries = %#v", entries)
	}
	if _, err := store.db.Exec(`UPDATE scores SET final_score = 95 WHERE username = 'hubot'`); err != nil {
		t.Fatal(err)
	}
	rank, err := store.GetFacetRank(context.Background(), "octocat")
	if err != nil || rank == nil || rank.Rank != 2 || rank.Total != 2 || rank.Ahead == nil || rank.Ahead.Username != "hubot" {
		t.Fatalf("rank=%#v err=%v", rank, err)
	}
	if _, err := store.db.Exec(`INSERT INTO campaign_participants (campaign, username) VALUES ('advx', 'octocat')`); err != nil {
		t.Fatal(err)
	}
	campaignEntries, err := store.GetCampaignLeaderboard(context.Background(), "advx")
	if err != nil || len(campaignEntries) != 1 || campaignEntries[0].Username != "octocat" {
		t.Fatalf("campaign entries=%#v err=%v", campaignEntries, err)
	}
}

func TestTursoSnapshotWriteIsIdempotentAndDoesNotMutateScores(t *testing.T) {
	store := openQueryTestStore(t)
	insertQueryTestScore(t, store, "octocat", 90, time.Now().UnixMilli())
	job := ScoreSnapshotJob{ID: "job_0123456789abcdef", Username: "octocat", RequestedAt: time.Now().UnixMilli()}
	created, err := store.PersistScoreSnapshot(context.Background(), job)
	if err != nil || !created {
		t.Fatalf("first snapshot created=%v err=%v", created, err)
	}
	created, err = store.PersistScoreSnapshot(context.Background(), job)
	if err != nil || created {
		t.Fatalf("duplicate snapshot created=%v err=%v", created, err)
	}
	var snapshots, scores int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM score_snapshots`).Scan(&snapshots); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM scores`).Scan(&scores); err != nil {
		t.Fatal(err)
	}
	if snapshots != 1 || scores != 1 {
		t.Fatalf("snapshots=%d scores=%d", snapshots, scores)
	}
}

func TestTursoBadgeDataUsesSnapshotThenPreviousScoreFallback(t *testing.T) {
	store := openQueryTestStore(t)
	now := time.Unix(1_700_000_000, 0).UTC()
	insertQueryTestScore(t, store, "octocat", 90, now.UnixMilli())
	if _, err := store.db.Exec(`UPDATE scores SET prev_score = 70, prev_scanned_at = ? WHERE username = 'octocat'`, now.Add(-8*24*time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	data, err := store.GetBadgeData(context.Background(), "octocat", now)
	if err != nil || data.Delta == nil || *data.Delta != 20 {
		t.Fatalf("previous-score fallback data=%#v err=%v", data, err)
	}
	if _, err := store.db.Exec(`INSERT INTO score_snapshots
		(id, username, final_score, tier, score_version, roast_version, roast_lang, generated_at)
		VALUES ('old', 'octocat', 84, '顶级', 'v9', 'v1', 'zh', ?)`, now.Add(-8*24*time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	data, err = store.GetBadgeData(context.Background(), "octocat", now)
	if err != nil || data.Delta == nil || *data.Delta != 6 {
		t.Fatalf("snapshot baseline data=%#v err=%v", data, err)
	}
}
