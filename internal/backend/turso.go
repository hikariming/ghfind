package backend

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/tursodatabase/libsql-client-go/libsql"
)

var ErrScoreNotFound = errors.New("score not found")

// Keep this synchronized with src/lib/cache-version.ts. Querying only this
// version preserves the public-read semantics of the existing Next handlers.
// It aliases the write-side constant in scan_persistence.go so a scoring-rule
// bump (v9 -> v10) is a one-line change with no read/write drift.
const canonicalScoreVersion = goCanonicalScoreVersion

// ScoreCountStore is the read-model contract needed by the first migrated
// public endpoint. It is intentionally small so it can be parity-tested
// without a live Turso database.
type ScoreCountStore interface {
	ScoreCount(context.Context) (*int, error)
}

// ScoreSnapshotStore persists the result of the first real asynchronous
// workload. score_snapshots is an existing append-only table; no new table or
// migration is introduced for queue state.
type ScoreSnapshotStore interface {
	PersistScoreSnapshot(context.Context, ScoreSnapshotJob) (created bool, err error)
}

// TursoStore uses the official remote libSQL driver and existing credentials.
type TursoStore struct {
	db *sql.DB
}

func OpenTursoStore(config Config) (*TursoStore, error) {
	dsn, err := config.LibSQLDSN()
	if err != nil {
		return nil, err
	}
	options := []libsql.Option{}
	if config.TursoAuth != "" && !strings.HasPrefix(dsn, "file:") {
		options = append(options, libsql.WithAuthToken(config.TursoAuth))
	}
	connector, err := libsql.NewConnector(dsn, options...)
	if err != nil {
		return nil, fmt.Errorf("create libsql connector: %w", err)
	}
	db := sql.OpenDB(connector)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetMaxIdleConns(4)
	db.SetMaxOpenConns(16)
	return &TursoStore{db: db}, nil
}

func (s *TursoStore) Close() error { return s.db.Close() }

func (s *TursoStore) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

// ScoreCount preserves the all-time semantics of the existing /api/stats
// implementation: hidden and legacy rows count too.
func (s *TursoStore) ScoreCount(ctx context.Context) (*int, error) {
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM scores").Scan(&total); err != nil {
		return nil, fmt.Errorf("count scores: %w", err)
	}
	return &total, nil
}

// PersistScoreSnapshot atomically materializes an existing score row into the
// existing score_snapshots history table. The job ID is the snapshot primary
// key, making redelivery safe: INSERT OR IGNORE creates at most one row.
func (s *TursoStore) PersistScoreSnapshot(ctx context.Context, job ScoreSnapshotJob) (bool, error) {
	var exists int
	err := s.db.QueryRowContext(
		ctx,
		"SELECT 1 FROM scores WHERE username = ? LIMIT 1",
		job.Username,
	).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrScoreNotFound
	}
	if err != nil {
		return false, fmt.Errorf("read score for snapshot: %w", err)
	}

	result, err := s.db.ExecContext(
		ctx,
		`INSERT OR IGNORE INTO score_snapshots
			(id, username, display_name, avatar_url, profile_url, final_score, tier,
			 tags, roast_line, bot_score, sub_scores, score_version, roast_version,
			 roast_lang, generated_at)
		 SELECT ?, username, display_name, avatar_url, profile_url, final_score, tier,
			 tags, roast_line, bot_score, sub_scores, COALESCE(NULLIF(score_version, ''), 'unknown'),
			 'snapshot-worker-v1', 'zh', ?
		 FROM scores
		 WHERE username = ?`,
		job.ID,
		time.Now().UnixMilli(),
		job.Username,
	)
	if err != nil {
		return false, fmt.Errorf("insert score snapshot: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read snapshot rows affected: %w", err)
	}
	return rows == 1, nil
}
