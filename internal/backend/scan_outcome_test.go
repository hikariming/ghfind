package backend

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func openScanOutcomeStore(t *testing.T) *TursoStore {
	t.Helper()
	store, err := OpenTursoStore(Config{TursoURL: "file:" + filepath.Join(t.TempDir(), "scan-outcome.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	for _, statement := range []string{
		`CREATE TABLE account_stats (username TEXT PRIMARY KEY, lookup_count INTEGER NOT NULL, first_lookup_at INTEGER NOT NULL, last_lookup_at INTEGER NOT NULL)`,
		`CREATE TABLE account_lookup_limits (username TEXT NOT NULL, ip_hash TEXT NOT NULL, last_counted_at INTEGER NOT NULL, PRIMARY KEY (username, ip_hash))`,
		`CREATE TABLE campaign_participants (campaign TEXT NOT NULL, username TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (campaign, username))`,
	} {
		if _, err := store.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	return store
}

func TestScanOutcomeUsesDurableTwentyFourHourHeatGateAndCampaignIdempotency(t *testing.T) {
	store := openScanOutcomeStore(t)
	now := time.Unix(1_700_000_000, 0).UTC()
	counted, err := store.RecordAccountLookup(context.Background(), "Alice", "salted-hash", now)
	if err != nil || !counted {
		t.Fatalf("first lookup counted=%v err=%v", counted, err)
	}
	counted, err = store.RecordAccountLookup(context.Background(), "alice", "salted-hash", now.Add(time.Hour))
	if err != nil || counted {
		t.Fatalf("replay lookup counted=%v err=%v", counted, err)
	}
	counted, err = store.RecordAccountLookup(context.Background(), "alice", "salted-hash", now.Add(heatLookupWindow))
	if err != nil || !counted {
		t.Fatalf("next-window lookup counted=%v err=%v", counted, err)
	}
	var count int
	if err := store.db.QueryRow(`SELECT lookup_count FROM account_stats WHERE username = 'alice'`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("lookup_count=%d err=%v", count, err)
	}
	joined, err := store.RecordCampaignParticipant(context.Background(), "advx", "Alice", now)
	if err != nil || !joined {
		t.Fatalf("first campaign join=%v err=%v", joined, err)
	}
	joined, err = store.RecordCampaignParticipant(context.Background(), "advx", "alice", now)
	if err != nil || joined {
		t.Fatalf("duplicate campaign join=%v err=%v", joined, err)
	}
}
