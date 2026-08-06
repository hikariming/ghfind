package backend

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"
)

const weeklyBaselineWindow = 7 * 24 * time.Hour

// BadgeData is the Go-owned, public read model consumed by the Next SVG
// renderer. The renderer intentionally stays in Next; it contains no database
// or cache access once this contract is enabled.
type BadgeData struct {
	FinalScore *float64 `json:"final_score"`
	Tier       *string  `json:"tier"`
	Delta      *float64 `json:"delta"`
}

type BadgeStore interface {
	GetBadgeData(context.Context, string, time.Time) (BadgeData, error)
}

func (s *TursoStore) GetBadgeData(ctx context.Context, username string, now time.Time) (BadgeData, error) {
	var score float64
	var tier string
	var prevScore sql.NullFloat64
	var prevScannedAt sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT final_score, tier, prev_score, prev_scanned_at
		FROM scores
		WHERE username = ? AND hidden = 0 AND score_version = ?
		LIMIT 1`, username, canonicalScoreVersion).Scan(&score, &tier, &prevScore, &prevScannedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return BadgeData{}, nil
	}
	if err != nil {
		return BadgeData{}, fmt.Errorf("read badge score: %w", err)
	}
	data := BadgeData{FinalScore: &score, Tier: &tier}
	cutoff := now.Add(-weeklyBaselineWindow).UnixMilli()
	baseline, found := s.weeklySnapshotBaseline(ctx, username, cutoff)
	if !found && prevScore.Valid && prevScannedAt.Valid && prevScannedAt.Int64 <= cutoff {
		baseline = prevScore.Float64
		found = true
	}
	if found {
		delta := score - baseline
		if math.Abs(delta) >= 0.05 {
			data.Delta = &delta
		}
	}
	return data, nil
}

// weeklySnapshotBaseline mirrors getWeeklyBaselines(): when multiple snapshot
// rows share the latest qualifying timestamp, take their MAX(final_score).
// An old deployment can lack the historical table; that must degrade to the
// existing prev-score fallback rather than make an embed fail.
func (s *TursoStore) weeklySnapshotBaseline(ctx context.Context, username string, cutoff int64) (float64, bool) {
	var score sql.NullFloat64
	err := s.db.QueryRowContext(ctx, `SELECT MAX(final_score)
		FROM score_snapshots
		WHERE username = ?
		  AND generated_at = (
			SELECT MAX(generated_at) FROM score_snapshots
			WHERE username = ? AND generated_at <= ?
		  )`, username, username, cutoff).Scan(&score)
	if err != nil || !score.Valid {
		return 0, false
	}
	return score.Float64, true
}
