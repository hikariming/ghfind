package backend

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

func (s *PostgresFeedStore) ClaimFeedCleanup(ctx context.Context, in FeedCleanupClaim) (FeedCleanupLease, error) {
	out := FeedCleanupLease{Status: "idle"}
	if in.WriterEpoch != s.writerEpoch || in.LeaseOwner == "" || in.LeaseSeconds != 90 {
		return out, ErrFeedWriterEpoch
	}
	if err := s.ArchiveReady(ctx); err != nil {
		return out, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	if err := s.guardFeedWrite(ctx, tx, 0, 0); err != nil {
		return out, err
	}
	var failures int
	var status string
	err = tx.QueryRowContext(ctx, `SELECT deletion_id,profile_version,cleanup_phase,cleanup_attempts,cleanup_failures,cleanup_status FROM feed.user_deletion_tombstones
 WHERE portable_cleanup AND ((cleanup_status='queued' AND cleanup_available_at<=now()) OR (cleanup_status='running' AND cleanup_lease_until<=now())) ORDER BY requested_at,deletion_id LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&out.DeletionID, &out.ProfileFloor, &out.Phase, &out.Attempts, &failures, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return out, tx.Commit()
	}
	if err != nil {
		return out, err
	}
	if status == "running" {
		failures++
	}
	if failures >= 8 {
		if _, err := tx.ExecContext(ctx, `UPDATE feed.user_deletion_tombstones SET cleanup_status='failed',cleanup_failures=$2,last_error='lease_exhausted',cleanup_lease_owner=NULL,cleanup_lease_until=NULL WHERE deletion_id=$1`, out.DeletionID, failures); err != nil {
			return out, err
		}
		return FeedCleanupLease{Status: "idle"}, tx.Commit()
	}
	var until time.Time
	err = tx.QueryRowContext(ctx, `UPDATE feed.user_deletion_tombstones SET cleanup_status='running',cleanup_attempts=cleanup_attempts+1,cleanup_failures=$3,cleanup_lease_owner=$2,cleanup_lease_until=now()+interval '90 seconds' WHERE deletion_id=$1 RETURNING cleanup_attempts,cleanup_lease_until`, out.DeletionID, in.LeaseOwner, failures).Scan(&out.Attempts, &until)
	if err != nil {
		return out, err
	}
	out.Status = "leased"
	out.Failures = failures
	out.LeaseUntil = &until
	return out, tx.Commit()
}

type feedCleanupRow struct {
	githubID, floor int64
	phase           string
}

func (s *PostgresFeedStore) lockCleanup(ctx context.Context, tx *sql.Tx, in FeedCleanupCommand) (feedCleanupRow, error) {
	var row feedCleanupRow
	if in.WriterEpoch != s.writerEpoch {
		return row, ErrFeedWriterEpoch
	}
	if err := s.guardFeedWrite(ctx, tx, 0, 0); err != nil {
		return row, err
	}
	err := tx.QueryRowContext(ctx, `SELECT github_id,profile_version,cleanup_phase FROM feed.user_deletion_tombstones WHERE deletion_id=$1 AND portable_cleanup AND cleanup_status='running' AND cleanup_lease_owner=$2 AND cleanup_lease_until>now() FOR UPDATE`, in.DeletionID, in.LeaseOwner).Scan(&row.githubID, &row.floor, &row.phase)
	if errors.Is(err, sql.ErrNoRows) {
		return row, ErrFeedJobLease
	}
	return row, err
}
func (s *PostgresFeedStore) StepFeedCleanup(ctx context.Context, in FeedCleanupCommand) (FeedCleanupProgress, error) {
	out := FeedCleanupProgress{Status: "running"}
	if s.archiveObjects == nil {
		return out, errors.New("archive objects unconfigured")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	row, err := s.lockCleanup(ctx, tx, in)
	if err != nil {
		return out, err
	}
	out.Phase = row.phase
	switch row.phase {
	case "primary":
		// Primary facts were atomically removed on acceptance. A restored old actor
		// is removed again; newer generations always survive.
		result, err := tx.ExecContext(ctx, `DELETE FROM feed.users WHERE github_id=$1 AND profile_version<=$2`, row.githubID, row.floor)
		if err != nil {
			return out, err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return out, err
		}
		out.Processed = int(count)
		out.Phase = "archive"
	case "archive":
		rows, err := tx.QueryContext(ctx, `SELECT object_key FROM feed.archive_objects WHERE github_id=$1 AND profile_version<=$2 AND status<>'erased' ORDER BY object_key LIMIT 10`, row.githubID, row.floor)
		if err != nil {
			return out, err
		}
		keys := []string{}
		for rows.Next() {
			var key string
			if err := rows.Scan(&key); err != nil {
				rows.Close()
				return out, err
			}
			keys = append(keys, key)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return out, err
		}
		if err := rows.Close(); err != nil {
			return out, err
		}
		if len(keys) > 0 {
			if err := tx.Commit(); err != nil {
				return out, err
			}
			for _, key := range keys {
				if err := s.archiveObjects.Erase(ctx, key); err != nil {
					return out, err
				}
				checkpoint, err := s.db.BeginTx(ctx, nil)
				if err != nil {
					return out, err
				}
				if _, err := s.lockCleanup(ctx, checkpoint, in); err != nil {
					checkpoint.Rollback()
					return out, err
				}
				_, err = checkpoint.ExecContext(ctx, `UPDATE feed.archive_objects SET status='erased',erased_at=now() WHERE object_key=$1 AND github_id=$2 AND profile_version<=$3`, key, row.githubID, row.floor)
				if err != nil {
					checkpoint.Rollback()
					return out, err
				}
				if err := checkpoint.Commit(); err != nil {
					return out, err
				}
				out.Processed++
			}
			return out, nil
		}
		out.Phase = "semantic"
	case "semantic":
		result, err := tx.ExecContext(ctx, `DELETE FROM feed.user_profile_embeddings WHERE ctid IN (SELECT ctid FROM feed.user_profile_embeddings WHERE github_id=$1 AND profile_version<=$2 LIMIT 100)`, row.githubID, row.floor)
		if err != nil {
			return out, err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return out, err
		}
		out.Processed = int(count)
		if count < 100 {
			out.Phase = "completed"
			out.Status = "completed"
		}
	default:
		return out, errors.New("invalid cleanup phase")
	}
	if _, err := tx.ExecContext(ctx, `UPDATE feed.user_deletion_tombstones SET cleanup_phase=$2,cleanup_status=CASE WHEN $2='completed' THEN 'completed' ELSE 'running' END,completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END,cleanup_lease_owner=CASE WHEN $2='completed' THEN NULL ELSE cleanup_lease_owner END,cleanup_lease_until=CASE WHEN $2='completed' THEN NULL ELSE cleanup_lease_until END WHERE deletion_id=$1`, in.DeletionID, out.Phase); err != nil {
		return out, err
	}
	return out, tx.Commit()
}
func (s *PostgresFeedStore) ReleaseFeedCleanup(ctx context.Context, in FeedCleanupCommand) error {
	return s.finishCleanup(ctx, in, false)
}
func (s *PostgresFeedStore) FailFeedCleanup(ctx context.Context, in FeedCleanupCommand) error {
	return s.finishCleanup(ctx, in, true)
}
func (s *PostgresFeedStore) finishCleanup(ctx context.Context, in FeedCleanupCommand, failed bool) error {
	if len(in.ErrorCode) > 80 {
		return errors.New("cleanup error code too large")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := s.lockCleanup(ctx, tx, in); err != nil {
		return err
	}
	query := `UPDATE feed.user_deletion_tombstones SET cleanup_status='queued',cleanup_available_at=now(),cleanup_lease_owner=NULL,cleanup_lease_until=NULL WHERE deletion_id=$1`
	args := []any{in.DeletionID}
	if failed {
		query = `UPDATE feed.user_deletion_tombstones SET cleanup_status=CASE WHEN cleanup_failures+1>=8 THEN 'failed' ELSE 'queued' END,cleanup_failures=cleanup_failures+1,last_error=$2,cleanup_available_at=now()+make_interval(secs=>LEAST(300,power(2,cleanup_failures+1)::int)),cleanup_lease_owner=NULL,cleanup_lease_until=NULL WHERE deletion_id=$1`
		args = append(args, in.ErrorCode)
	}
	if _, err := tx.ExecContext(ctx, query, args...); err != nil {
		return err
	}
	return tx.Commit()
}

// ReplayFeedCleanup is an operator capability, never mounted on the public Feed
// API. The caller must provide the deployment's protected recovery credentials.
// It resets only an exhausted job, retaining all completed erasure checkpoints.
func (s *PostgresFeedStore) ReplayFeedCleanup(ctx context.Context, deletionID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.guardFeedWrite(ctx, tx, 0, 0); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE feed.user_deletion_tombstones SET cleanup_status='queued',cleanup_failures=0,cleanup_available_at=now(),cleanup_lease_owner=NULL,cleanup_lease_until=NULL WHERE deletion_id=$1 AND portable_cleanup AND cleanup_status='failed'`, deletionID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ErrFeedJobLease
	}
	return tx.Commit()
}
