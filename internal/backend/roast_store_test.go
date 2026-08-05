package backend

import (
	"context"
	"testing"
	"time"
)

func TestRoastStoreUsesCanonicalSnapshotIdentityAndCASPersistence(t *testing.T) {
	store := openScanPersistenceStore(t)
	scan := ScanResult{
		Metrics:  RawMetrics{Username: "alice", Followers: 12, TotalStars: 1200, MergedPRCount: 1, TotalPRCount: 1, AccountAgeYears: 3, ContributionYearsActive: 2, NonemptyOriginalRepoCount: 1, LastYearContributions: 10, DaysSinceLastActivity: floatPointer(1)},
		TopRepos: []TopRepo{}, RecentPRs: []RecentPR{}, FloodPRTitles: []string{}, ImpactRepos: []ImpactRepo{}, VerifiedImpactPRs: []RecentPR{}, SignatureWork: BuildRecentSignatureWork(nil, nil), PinnedRepos: []string{}, Organizations: []string{},
	}
	scan.Scoring = Score(scan.Metrics)
	if created, err := store.PersistCollectedScan(context.Background(), ScanJob{ID: "job_roast_store", Username: "alice", RequestedAt: 1}, scan); err != nil || !created {
		t.Fatalf("created=%v err=%v", created, err)
	}
	canonical, err := store.GetCanonicalRoastScan(context.Background(), "alice")
	if err != nil || canonical == nil || canonical.Scan.Metrics.Username != "alice" || !canonicalSnapshotHashPattern.MatchString(canonical.SnapshotHash) {
		t.Fatalf("canonical=%#v err=%v", canonical, err)
	}
	identity, err := store.GetRoastScoreIdentity(context.Background(), "alice", canonical.SnapshotHash)
	if err != nil || identity == nil || identity.Token == "" || identity.ScannedAt <= 0 {
		t.Fatalf("identity=%#v err=%v", identity, err)
	}
	persisted, err := store.PersistRoast(context.Background(), "alice", "## Alice\nreport", roastLanguageZH, *identity, Tags{ZH: []string{"工程"}, EN: []string{"engineering"}}, RoastLine{ZH: "有料", EN: "has receipts"}, time.Now())
	if err != nil || !persisted {
		t.Fatalf("persisted=%v err=%v", persisted, err)
	}
	archived, err := store.GetArchivedRoast(context.Background(), "alice", roastLanguageZH)
	if err != nil || archived == nil || archived.Report != "## Alice\nreport" || archived.RoastLine.ZH != "有料" {
		t.Fatalf("archived=%#v err=%v", archived, err)
	}
	if changed, err := store.db.Exec(`UPDATE scores SET score_write_token = 'newer' WHERE username = 'alice'`); err != nil {
		t.Fatal(err)
	} else if rows, _ := changed.RowsAffected(); rows != 1 {
		t.Fatalf("changed rows=%d", rows)
	}
	persisted, err = store.PersistRoast(context.Background(), "alice", "stale overwrite", roastLanguageZH, *identity, Tags{}, RoastLine{}, time.Now())
	if err != nil || persisted {
		t.Fatalf("stale persisted=%v err=%v", persisted, err)
	}
}
