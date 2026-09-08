package backend

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

func (s *PostgresFeedStore) ClaimFeedJob(ctx context.Context, in FeedJobClaimRequest) (FeedJobClaimResponse, error) {
	var out FeedJobClaimResponse
	if err := validateFeedSourceEvent(in.Event); err != nil {
		return out, err
	}
	if in.LeaseOwner == "" || len(in.LeaseOwner) > 128 || in.LeaseSeconds != 90 || in.WriterEpoch != s.writerEpoch {
		return out, ErrFeedWriterEpoch
	}
	encoded, err := json.Marshal(in.Event)
	if err != nil {
		return out, err
	}
	digest := sha256.Sum256(encoded)
	hash := fmt.Sprintf("%x", digest)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	if err := s.guardFeedWrite(ctx, tx, 0, 0); err != nil {
		return out, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.jobs(event_id,payload,payload_hash,status) VALUES($1,$2::jsonb,$3,'pending') ON CONFLICT(event_id) DO NOTHING`, in.Event.EventID, string(encoded), hash); err != nil {
		return out, err
	}
	var storedHash string
	var activeLease bool
	var available bool
	if err := tx.QueryRowContext(ctx, `SELECT payload_hash,status,attempts,COALESCE(lease_until>now(),false),available_at<=now() FROM feed.jobs WHERE event_id=$1 FOR UPDATE`, in.Event.EventID).Scan(&storedHash, &out.Status, &out.Attempts, &activeLease, &available); err != nil {
		return out, err
	}
	if storedHash != hash {
		return out, ErrFeedJobConflict
	}
	if out.Status == "completed" {
		return out, tx.Commit()
	}
	if out.Status == "leased" && activeLease {
		out.Status = "busy"
		return out, tx.Commit()
	}
	if out.Attempts >= 8 {
		if _, err := tx.ExecContext(ctx, `UPDATE feed.jobs SET status='dead_letter',lease_owner=NULL,lease_until=NULL,last_error=COALESCE(last_error,'lease_exhausted'),updated_at=now() WHERE event_id=$1`, in.Event.EventID); err != nil {
			return out, err
		}
		out.Status = "dead_letter"
		return out, tx.Commit()
	}
	if !available {
		out.Status = "busy"
		return out, tx.Commit()
	}
	var until time.Time
	err = tx.QueryRowContext(ctx, `UPDATE feed.jobs SET status='leased',attempts=attempts+1,lease_owner=$2,lease_until=now()+interval '90 seconds',updated_at=now() WHERE event_id=$1 RETURNING attempts,lease_until`, in.Event.EventID, in.LeaseOwner).Scan(&out.Attempts, &until)
	if err != nil {
		return out, err
	}
	out.Status = "leased"
	out.LeaseUntil = &until
	return out, tx.Commit()
}
func (s *PostgresFeedStore) CompleteFeedJob(ctx context.Context, in FeedJobFinishRequest) error {
	return s.finishFeedJob(ctx, in, true)
}
func (s *PostgresFeedStore) FailFeedJob(ctx context.Context, in FeedJobFinishRequest) error {
	return s.finishFeedJob(ctx, in, false)
}
func (s *PostgresFeedStore) finishFeedJob(ctx context.Context, in FeedJobFinishRequest, complete bool) error {
	if in.WriterEpoch != s.writerEpoch || in.LeaseOwner == "" || len(in.ErrorCode) > 80 {
		return ErrFeedJobLease
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.guardFeedWrite(ctx, tx, 0, 0); err != nil {
		return err
	}
	query := `UPDATE feed.jobs SET status='completed',completed_at=now(),lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE event_id=$1 AND lease_owner=$2 AND status='leased' AND lease_until>now()`
	args := []any{in.EventID, in.LeaseOwner}
	if !complete {
		query = `UPDATE feed.jobs SET status=CASE WHEN attempts>=8 THEN 'dead_letter' ELSE 'pending' END,available_at=now()+make_interval(secs=>LEAST(300,power(2,attempts)::int)),last_error=$3,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE event_id=$1 AND lease_owner=$2 AND status='leased' AND lease_until>now()`
		args = append(args, in.ErrorCode)
	}
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return ErrFeedJobLease
	}
	return tx.Commit()
}
func (s *PostgresFeedStore) ApplyFeedProjection(ctx context.Context, in FeedApplyProjectionRequest) (FeedApplyProjectionResponse, error) {
	var out FeedApplyProjectionResponse
	if in.WriterEpoch != s.writerEpoch || in.SourceVersion < 1 {
		return out, ErrFeedWriterEpoch
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	if err := s.guardFeedWrite(ctx, tx, 0, 0); err != nil {
		return out, err
	}
	var payload []byte
	err = tx.QueryRowContext(ctx, `SELECT payload FROM feed.jobs WHERE event_id=$1 AND lease_owner=$2 AND status='leased' AND lease_until>now() FOR UPDATE`, in.EventID, in.LeaseOwner).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return out, ErrFeedJobLease
	}
	if err != nil {
		return out, err
	}
	var event FeedSourceEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		return out, err
	}
	p := in.Projection.FeedProjectProjection
	if event.SourceVersion != in.SourceVersion || event.AnalysisID != p.AnalysisID || event.AggregateKey != p.RepoKey || event.ReceiptID != in.Receipt.ReceiptID || in.Receipt.SubmittedAt.IsZero() {
		return out, ErrFeedJobConflict
	}
	if in.Receipt.SourceKind != "app_submission" && in.Receipt.SourceKind != "agent_submission" && in.Receipt.SourceKind != "verified_backfill" {
		return out, ErrFeedJobConflict
	}
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('feed-project:' || $1::text,0))`, p.RepoKey); err != nil {
		return out, err
	}
	var currentVersion int64
	err = tx.QueryRowContext(ctx, `SELECT source_version FROM feed.project_submission_evidence WHERE repo_key=$1 FOR UPDATE`, p.RepoKey).Scan(&currentVersion)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	if currentVersion >= in.SourceVersion {
		out.Duplicate = true
		return out, tx.Commit()
	}
	p.ProductTags = []ProductTag{}
	for _, tag := range in.Projection.ProductTags {
		p.ProductTags = append(p.ProductTags, ProductTag{Namespace: tag.Namespace, NamespaceExplicit: tag.NamespaceExplicit, Slug: tag.Slug, Labels: tag.Labels, EvidenceIDs: tag.EvidenceIDs})
	}
	if err := upsertFeedProjectTx(ctx, tx, p); err != nil {
		return out, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO feed.project_submission_evidence(repo_key,source_kind,source_id,submitted_at,source_version,source_event_id,analysis_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(repo_key) DO UPDATE SET source_kind=excluded.source_kind,source_id=excluded.source_id,submitted_at=excluded.submitted_at,source_version=excluded.source_version,source_event_id=excluded.source_event_id,analysis_id=excluded.analysis_id`, p.RepoKey, in.Receipt.SourceKind, in.Receipt.ReceiptID, in.Receipt.SubmittedAt, in.SourceVersion, in.EventID, p.AnalysisID)
	if err != nil {
		return out, err
	}
	return out, tx.Commit()
}
