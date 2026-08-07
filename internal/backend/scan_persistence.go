package backend

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	// goCanonicalScoreVersion is the single source for both the score_version
	// written on every scan and every read filter (canonicalScoreVersion in
	// turso.go aliases it). A scoring-rule bump changes this one line, in the
	// same review as src/lib/cache-version.ts and release-versions.json.
	goCanonicalScoreVersion      = "v9"
	goCanonicalCollectionVersion = "v4"
	progressMinGapMilliseconds   = int64(time.Hour / time.Millisecond)
)

var ErrScanJobConflict = errors.New("scan job conflicts with an existing result")

// ScanJob carries no credentials. It is safe for RabbitMQ and makes the
// existing public_scan_runs.id the durable idempotency key for a quick scan.
type ScanJob struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	Attempt     int    `json:"attempt"`
	RequestedAt int64  `json:"requested_at"`
	// LookupHash is a salted, non-reversible network identifier. Never put a
	// raw client IP or any browser credential on RabbitMQ.
	LookupHash string `json:"lookup_hash,omitempty"`
	Campaign   string `json:"campaign,omitempty"`
	FlightLock bool   `json:"flight_lock,omitempty"`
}

type ScanResultStore interface {
	PersistCollectedScan(context.Context, ScanJob, ScanResult) (created bool, err error)
	GetCollectedScan(context.Context, string) (*ScanResult, error)
}

// ScanOutcomeStore owns the durable, post-success side effects from the former
// Next scan route. They are intentionally separate from score persistence: a
// heat counter outage must not roll back an already-complete public scan.
type ScanOutcomeStore interface {
	RecordAccountLookup(context.Context, string, string, time.Time) (bool, error)
	RecordCampaignParticipant(context.Context, string, string, time.Time) (bool, error)
}

func (s *TursoStore) PersistCollectedScan(ctx context.Context, job ScanJob, scan ScanResult) (bool, error) {
	if job.ID == "" || job.Username == "" || !strings.EqualFold(job.Username, scan.Metrics.Username) {
		return false, fmt.Errorf("invalid scan persistence identity")
	}
	snapshot, err := json.Marshal(scan)
	if err != nil {
		return false, fmt.Errorf("encode collected scan: %w", err)
	}
	hash := sha256.Sum256(snapshot)
	snapshotHash := hex.EncodeToString(hash[:])
	scannedAt := time.Now().UTC().UnixMilli()
	if job.RequestedAt > 0 && job.RequestedAt > scannedAt {
		scannedAt = job.RequestedAt
	}
	token, err := NewJobID()
	if err != nil {
		return false, err
	}
	subScores, err := json.Marshal(scan.Scoring.SubScores)
	if err != nil {
		return false, fmt.Errorf("encode sub scores: %w", err)
	}
	metrics, err := json.Marshal(scan.Metrics)
	if err != nil {
		return false, fmt.Errorf("encode metrics: %w", err)
	}
	topRepos, _ := json.Marshal(scan.TopRepos)
	impactRepos, _ := json.Marshal(scan.ImpactRepos)
	verifiedPRs, _ := json.Marshal(scan.VerifiedImpactPRs)
	pinnedRepos, _ := json.Marshal(scan.PinnedRepos)
	organizations, _ := json.Marshal(scan.Organizations)
	signatureWork, _ := json.Marshal(scan.SignatureWork)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin scan persistence: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var existingHash string
	err = tx.QueryRowContext(ctx, "SELECT snapshot_hash FROM public_scan_runs WHERE id = ? LIMIT 1", job.ID).Scan(&existingHash)
	if err == nil {
		if existingHash == snapshotHash {
			return false, nil
		}
		return false, ErrScanJobConflict
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("read existing scan result: %w", err)
	}

	username := strings.ToLower(scan.Metrics.Username)
	if _, err := tx.ExecContext(ctx, `INSERT INTO public_scan_runs
      (id, username, score_version, collection_version, state, coverage,
       source_status, quick_scan, snapshot, snapshot_hash, started_at,
       completed_at, updated_at)
      VALUES (?, ?, ?, ?, 'complete_public', 'complete_public', ?, ?, ?, ?, ?, ?, ?)`,
		job.ID, username, goCanonicalScoreVersion, goCanonicalCollectionVersion,
		`{"quick":"complete","original_repos":"complete","native_prs":"complete","workflow_landings":"complete","commit_recovery":"complete"}`,
		string(snapshot), string(snapshot), snapshotHash, scannedAt, scannedAt, scannedAt); err != nil {
		return false, fmt.Errorf("insert public scan result: %w", err)
	}

	var previousScannedAt sql.NullInt64
	var previousVersion, previousCollection string
	err = tx.QueryRowContext(ctx, `SELECT scanned_at, COALESCE(score_version, ''), COALESCE(score_source_collection_version, '')
      FROM scores WHERE username = ? LIMIT 1`, username).Scan(&previousScannedAt, &previousVersion, &previousCollection)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("read current score: %w", err)
	}
	if err == nil && previousVersion == goCanonicalScoreVersion && previousCollection == goCanonicalCollectionVersion && previousScannedAt.Valid && previousScannedAt.Int64 > scannedAt {
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("commit superseded scan archive: %w", err)
		}
		return false, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		_, err = tx.ExecContext(ctx, `INSERT INTO scores
          (username, display_name, avatar_url, profile_url, final_score, tier, tags,
           roast_line, score_version, score_write_token, score_source_collection_version,
           score_source_snapshot_hash, bot_score, sub_scores, scanned_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			username, scan.Metrics.Name, scan.Metrics.AvatarURL, scan.Metrics.ProfileURL,
			scan.Scoring.FinalScore, scan.Scoring.Tier, `{"zh":[],"en":[]}`, `{"zh":"","en":""}`,
			goCanonicalScoreVersion, token, goCanonicalCollectionVersion, snapshotHash,
			SpamBotScore(scan.Metrics), string(subScores), scannedAt)
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE scores SET
          prev_score = CASE WHEN ? - scanned_at >= ? THEN final_score ELSE prev_score END,
          prev_scanned_at = CASE WHEN ? - scanned_at >= ? THEN scanned_at ELSE prev_scanned_at END,
          display_name = ?, avatar_url = ?, profile_url = ?, final_score = ?, tier = ?,
          tags = ?, roast_line = ?, score_version = ?, score_write_token = ?,
          score_source_collection_version = ?, score_source_snapshot_hash = ?,
          bot_score = ?, sub_scores = ?, scanned_at = ?,
          roast = NULL, roast_version = NULL, roast_en = NULL, roast_en_version = NULL
          WHERE username = ?`,
			scannedAt, progressMinGapMilliseconds, scannedAt, progressMinGapMilliseconds,
			scan.Metrics.Name, scan.Metrics.AvatarURL, scan.Metrics.ProfileURL, scan.Scoring.FinalScore, scan.Scoring.Tier,
			`{"zh":[],"en":[]}`, `{"zh":"","en":""}`, goCanonicalScoreVersion, token,
			goCanonicalCollectionVersion, snapshotHash, SpamBotScore(scan.Metrics), string(subScores), scannedAt, username)
	}
	if err != nil {
		return false, fmt.Errorf("upsert canonical score: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO account_stats (username, lookup_count, first_lookup_at, last_lookup_at)
      VALUES (?, 1, ?, ?) ON CONFLICT(username) DO UPDATE SET
      lookup_count = MAX(account_stats.lookup_count, excluded.lookup_count)`, username, scannedAt, scannedAt); err != nil {
		return false, fmt.Errorf("ensure score account stats: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO profile_snapshots
      (id, username, scanned_at, top_repos, impact_repos, verified_prs, metrics,
       pinned_repos, organizations, signature_work, scan_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		job.ID+"-profile", username, scannedAt, string(topRepos), string(impactRepos), string(verifiedPRs), string(metrics),
		string(pinnedRepos), string(organizations), string(signatureWork), goCanonicalScoreVersion); err != nil {
		return false, fmt.Errorf("insert profile snapshot: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit collected scan: %w", err)
	}
	// This mirrors the prior fire-and-forget recordProfileSnapshot work. The
	// canonical score/snapshot transaction above is already durable; stale
	// discovery/project indexes are repairable and must not turn a successful
	// public scan into a retry.
	_ = s.materializeProfileIndexes(ctx, username, scan, scannedAt)
	return true, nil
}

func (s *TursoStore) GetCollectedScan(ctx context.Context, jobID string) (*ScanResult, error) {
	var encoded string
	err := s.db.QueryRowContext(ctx, `SELECT snapshot FROM public_scan_runs
      WHERE id = ? AND state = 'complete_public' LIMIT 1`, jobID).Scan(&encoded)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read collected scan: %w", err)
	}
	var scan ScanResult
	if err := json.Unmarshal([]byte(encoded), &scan); err != nil {
		return nil, fmt.Errorf("decode collected scan: %w", err)
	}
	// Source data may be stale only if a pre-Go row slipped in; recomputing from
	// raw metrics preserves the published score formula on every read.
	scan.Scoring = Score(scan.Metrics)
	return &scan, nil
}
