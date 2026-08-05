package backend

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

const heatLookupWindow = 24 * time.Hour

// RecordAccountLookup is the Turso source-of-truth gate used after a successful
// scan. `ipHash` was salted before queueing and cannot be converted back to an
// address. Replays inside 24 hours are accepted but do not move public heat.
func (s *TursoStore) RecordAccountLookup(ctx context.Context, username, ipHash string, now time.Time) (bool, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	if username == "" || ipHash == "" {
		return false, fmt.Errorf("lookup username and hash are required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin account lookup: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var countedAt int64
	err = tx.QueryRowContext(ctx, `INSERT INTO account_lookup_limits (username, ip_hash, last_counted_at)
      VALUES (?, ?, ?)
      ON CONFLICT(username, ip_hash) DO UPDATE SET last_counted_at = excluded.last_counted_at
      WHERE account_lookup_limits.last_counted_at <= ?
      RETURNING last_counted_at`, username, ipHash, now.UnixMilli(), now.Add(-heatLookupWindow).UnixMilli()).Scan(&countedAt)
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("commit unchanged account lookup: %w", err)
		}
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("gate account lookup: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO account_stats (username, lookup_count, first_lookup_at, last_lookup_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        lookup_count = account_stats.lookup_count + 1,
        last_lookup_at = excluded.last_lookup_at`, username, now.UnixMilli(), now.UnixMilli()); err != nil {
		return false, fmt.Errorf("increment account lookup: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit account lookup: %w", err)
	}
	return true, nil
}

func (s *TursoStore) RecordCampaignParticipant(ctx context.Context, campaign, username string, now time.Time) (bool, error) {
	if !validCampaign(campaign) {
		return false, fmt.Errorf("unknown campaign %q", campaign)
	}
	result, err := s.db.ExecContext(ctx, `INSERT INTO campaign_participants (campaign, username, joined_at)
      VALUES (?, ?, ?) ON CONFLICT(campaign, username) DO NOTHING`, campaign, strings.ToLower(strings.TrimSpace(username)), now.UnixMilli())
	if err != nil {
		return false, fmt.Errorf("record campaign participant: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read campaign participant result: %w", err)
	}
	return rows == 1, nil
}

func recordSuccessfulScanOutcome(
	ctx context.Context,
	outcomes ScanOutcomeStore,
	gate LookupGate,
	revisions CampaignRevisionWriter,
	username, lookupHash, campaign string,
	now time.Time,
) {
	if outcomes == nil {
		return
	}
	if lookupHash != "" {
		acquired := false
		shouldRecord := true
		gateKey := "heat:gate:" + strings.ToLower(username) + ":" + lookupHash
		if gate != nil {
			ok, err := gate.TryAcquireLookupGate(ctx, gateKey)
			if err == nil {
				acquired, shouldRecord = ok, ok
			}
		}
		if shouldRecord {
			if _, err := outcomes.RecordAccountLookup(ctx, username, lookupHash, now); err != nil && acquired && gate != nil {
				_ = gate.ReleaseLookupGate(context.Background(), gateKey)
			}
		}
	}
	if campaign == "" {
		return
	}
	joined, err := outcomes.RecordCampaignParticipant(ctx, campaign, username, now)
	if err == nil && joined && revisions != nil {
		_ = revisions.BumpCampaignLeaderboardRevision(context.Background(), campaign)
	}
}
