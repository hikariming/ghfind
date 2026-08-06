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
	roastArtifactVersion    = "v10"
	legacyRoastScoreVersion = "v5"
	legacyRoastVersion      = "v5"
)

type RoastScoreIdentity struct {
	ScannedAt int64
	Token     string
}

type StoredRoast struct {
	Username   string
	FinalScore float64
	Tier       string
	Tags       Tags
	RoastLine  RoastLine
	Report     string
}

type CanonicalRoastScan struct {
	Scan         ScanResult
	SnapshotHash string
}

// RoastStore exposes only the existing persistence used by the report stream.
// It neither creates a schema nor stores a BYO provider credential.
type RoastStore interface {
	GetCanonicalRoastScan(context.Context, string) (*CanonicalRoastScan, error)
	GetLegacyRoast(context.Context, string, roastLanguage) (*StoredRoast, error)
	GetArchivedRoast(context.Context, string, roastLanguage) (*StoredRoast, error)
	GetRoastScoreIdentity(context.Context, string, string) (*RoastScoreIdentity, error)
	GetRoastScannedAt(context.Context, string) (*int64, error)
	PersistRoast(context.Context, string, string, roastLanguage, RoastScoreIdentity, Tags, RoastLine, time.Time) (bool, error)
	GetRoastRank(context.Context, float64) (*RoastRank, error)
}

type RoastRank struct {
	Below int
	Total int
	Rank  int
}

func (s *TursoStore) GetCanonicalRoastScan(ctx context.Context, username string) (*CanonicalRoastScan, error) {
	var snapshot, snapshotHash string
	err := s.db.QueryRowContext(ctx, `SELECT r.snapshot, r.snapshot_hash
      FROM public_scan_runs r
      INNER JOIN scores s ON s.username = r.username
        AND s.hidden = 0
        AND s.score_version = ?
        AND s.score_source_collection_version = ?
        AND s.score_source_snapshot_hash = r.snapshot_hash
      WHERE r.username = ?
        AND r.score_version = ?
        AND r.collection_version = ?
        AND r.state = 'complete_public'
        AND r.snapshot IS NOT NULL
        AND r.snapshot_hash IS NOT NULL
      ORDER BY s.scanned_at DESC, r.completed_at DESC, r.id DESC
      LIMIT 1`, canonicalScoreVersion, goCanonicalCollectionVersion, strings.ToLower(username), canonicalScoreVersion, goCanonicalCollectionVersion).Scan(&snapshot, &snapshotHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read canonical roast scan: %w", err)
	}
	if !canonicalSnapshotHashPattern.MatchString(snapshotHash) {
		return nil, nil
	}
	digest := sha256.Sum256([]byte(snapshot))
	if hex.EncodeToString(digest[:]) != snapshotHash {
		return nil, nil
	}
	var scan ScanResult
	if err := json.Unmarshal([]byte(snapshot), &scan); err != nil {
		return nil, nil
	}
	if !strings.EqualFold(scan.Metrics.Username, username) {
		return nil, nil
	}
	return &CanonicalRoastScan{Scan: scan, SnapshotHash: snapshotHash}, nil
}

func (s *TursoStore) GetLegacyRoast(ctx context.Context, username string, language roastLanguage) (*StoredRoast, error) {
	return s.readStoredRoast(ctx, username, language, true)
}

func (s *TursoStore) GetArchivedRoast(ctx context.Context, username string, language roastLanguage) (*StoredRoast, error) {
	return s.readStoredRoast(ctx, username, language, false)
}

func (s *TursoStore) readStoredRoast(ctx context.Context, username string, language roastLanguage, legacy bool) (*StoredRoast, error) {
	column, versionColumn := "roast", "roast_version"
	if language == roastLanguageEN {
		column, versionColumn = "roast_en", "roast_en_version"
	}
	query := fmt.Sprintf(`SELECT username, final_score, tier, tags, roast_line, %s
      FROM scores WHERE username = ? AND hidden = 0
        AND score_version = ?
        AND %s = ?
        AND %s IS NOT NULL AND %s != ''
      LIMIT 1`, column, versionColumn, column, column)
	args := []any{strings.ToLower(username), roastArtifactVersion, roastArtifactVersion}
	if legacy {
		query = fmt.Sprintf(`SELECT username, final_score, tier, tags, roast_line, %s
        FROM scores WHERE username = ? AND hidden = 0
          AND score_version = ?
          AND %s = ?
          AND %s IS NOT NULL AND %s != ''
        LIMIT 1`, column, versionColumn, column, column)
		args = []any{strings.ToLower(username), legacyRoastScoreVersion, legacyRoastVersion}
	} else {
		query = fmt.Sprintf(`SELECT username, final_score, tier, tags, roast_line, %s
        FROM scores WHERE username = ? AND hidden = 0
          AND score_version = ?
          AND score_source_collection_version = ?
          AND length(score_source_snapshot_hash) = 64
          AND score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'
          AND %s = ?
          AND %s IS NOT NULL AND %s != ''
        LIMIT 1`, column, versionColumn, column, column)
		args = []any{strings.ToLower(username), canonicalScoreVersion, goCanonicalCollectionVersion, roastArtifactVersion}
	}
	var result StoredRoast
	var tags, roastLine string
	err := s.db.QueryRowContext(ctx, query, args...).Scan(&result.Username, &result.FinalScore, &result.Tier, &tags, &roastLine, &result.Report)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read stored roast: %w", err)
	}
	result.Tags, result.RoastLine = parseTags(tags), parseRoastLine(roastLine)
	return &result, nil
}

func (s *TursoStore) GetRoastScoreIdentity(ctx context.Context, username, snapshotHash string) (*RoastScoreIdentity, error) {
	if !canonicalSnapshotHashPattern.MatchString(snapshotHash) {
		return nil, nil
	}
	var identity RoastScoreIdentity
	err := s.db.QueryRowContext(ctx, `SELECT scanned_at, score_write_token FROM scores
      WHERE username = ? AND hidden = 0 AND score_version = ?
        AND score_source_collection_version = ?
        AND score_source_snapshot_hash = ? LIMIT 1`, strings.ToLower(username), canonicalScoreVersion, goCanonicalCollectionVersion, snapshotHash).Scan(&identity.ScannedAt, &identity.Token)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read roast score identity: %w", err)
	}
	if identity.ScannedAt <= 0 || identity.Token == "" {
		return nil, nil
	}
	return &identity, nil
}

func (s *TursoStore) GetRoastScannedAt(ctx context.Context, username string) (*int64, error) {
	var scannedAt int64
	err := s.db.QueryRowContext(ctx, `SELECT scanned_at FROM scores WHERE username = ? AND hidden = 0 LIMIT 1`, strings.ToLower(username)).Scan(&scannedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read roast scanned at: %w", err)
	}
	return &scannedAt, nil
}

// PersistRoast uses the prior score-write token and scan time as a compare and
// swap. A late stream cannot attach prose to a newer score; cache warming must
// happen only after this transaction reports success.
func (s *TursoStore) PersistRoast(ctx context.Context, username, report string, language roastLanguage, identity RoastScoreIdentity, tags Tags, roastLine RoastLine, now time.Time) (bool, error) {
	column, versionColumn := "roast", "roast_version"
	if language == roastLanguageEN {
		column, versionColumn = "roast_en", "roast_en_version"
	}
	encodedTags, err := json.Marshal(tags)
	if err != nil {
		return false, fmt.Errorf("encode roast tags: %w", err)
	}
	encodedLine, err := json.Marshal(roastLine)
	if err != nil {
		return false, fmt.Errorf("encode roast line: %w", err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin roast persistence: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	updated, err := tx.ExecContext(ctx, fmt.Sprintf(`UPDATE scores SET %s = ?, %s = ?,
      tags = COALESCE(?, tags), roast_line = COALESCE(?, roast_line)
      WHERE username = ? AND score_version = ? AND score_source_collection_version = ?
        AND length(score_source_snapshot_hash) = 64
        AND score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'
        AND score_write_token = ? AND scanned_at = ?`, column, versionColumn),
		report, roastArtifactVersion, string(encodedTags), string(encodedLine), strings.ToLower(username), canonicalScoreVersion, goCanonicalCollectionVersion, identity.Token, identity.ScannedAt)
	if err != nil {
		return false, fmt.Errorf("update roast: %w", err)
	}
	changed, err := updated.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read roast update result: %w", err)
	}
	if changed != 1 {
		return false, nil
	}
	snapshotID, err := newUUIDv4()
	if err != nil {
		return false, err
	}
	inserted, err := tx.ExecContext(ctx, fmt.Sprintf(`INSERT INTO score_snapshots
      (id, username, display_name, avatar_url, profile_url, final_score, tier,
       tags, roast_line, score_version, roast_version, roast_lang, bot_score,
       sub_scores, generated_at)
      SELECT ?, username, display_name, avatar_url, profile_url, final_score, tier,
       tags, roast_line, score_version, ?, ?, bot_score, sub_scores, ?
      FROM scores WHERE username = ? AND score_version = ?
        AND score_source_collection_version = ?
        AND length(score_source_snapshot_hash) = 64
        AND score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'
        AND score_write_token = ? AND scanned_at = ?
        AND %s = ? AND %s = ?`, versionColumn, column),
		snapshotID, roastArtifactVersion, string(language), now.UnixMilli(), strings.ToLower(username), canonicalScoreVersion, goCanonicalCollectionVersion, identity.Token, identity.ScannedAt, roastArtifactVersion, report)
	if err != nil {
		return false, fmt.Errorf("insert roast snapshot: %w", err)
	}
	created, err := inserted.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read roast snapshot result: %w", err)
	}
	if created != 1 {
		return false, nil
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit roast persistence: %w", err)
	}
	return true, nil
}

func (s *TursoStore) GetRoastRank(ctx context.Context, score float64) (*RoastRank, error) {
	var above, below, total int
	err := s.db.QueryRowContext(ctx, `SELECT
      COALESCE(SUM(CASE WHEN final_score > ? THEN 1 ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN final_score < ? THEN 1 ELSE 0 END), 0),
      COUNT(*) FROM scores WHERE hidden = 0 AND score_version = ?
        AND score_source_collection_version = ?
        AND length(score_source_snapshot_hash) = 64
        AND score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'`, score, score, canonicalScoreVersion, goCanonicalCollectionVersion).Scan(&above, &below, &total)
	if err != nil {
		return nil, fmt.Errorf("read roast rank: %w", err)
	}
	if total <= 1 {
		return nil, nil
	}
	return &RoastRank{Below: below, Total: total, Rank: above + 1}, nil
}
