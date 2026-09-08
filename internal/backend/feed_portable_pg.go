package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

var ErrFeedWriterEpoch = errors.New("feed writer epoch changed")
var ErrFeedProfileChanged = errors.New("feed profile version changed")

// EnablePortableRuntime requires migration-managed durable sessions and write
// fencing. It does not apply migrations or alter any remote configuration.
func (s *PostgresFeedStore) EnablePortableRuntime(epoch int64) error {
	if epoch < 1 {
		return errors.New("positive writer epoch required")
	}
	s.writerEpoch = epoch
	return nil
}
func (s *PostgresFeedStore) guardFeedWrite(ctx context.Context, tx *sql.Tx, id, expected int64) error {
	if s.writerEpoch == 0 {
		return nil
	}
	var epoch int64
	var enabled bool
	if err := tx.QueryRowContext(ctx, `SELECT writer_epoch,writes_enabled FROM feed.runtime_control WHERE singleton=true FOR SHARE`).Scan(&epoch, &enabled); err != nil {
		return err
	}
	if epoch != s.writerEpoch || !enabled {
		return ErrFeedWriterEpoch
	}
	// Lock even absent identities: deletion and identity recreation cannot race.
	if id > 0 {
		if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('feed-user:' || $1::bigint::text,0))`, id); err != nil {
			return err
		}
	}
	if v, ok := ctx.Value(feedProfileVersionKey{}).(int64); ok {
		expected = v
	}
	if expected > 0 {
		var actual int64
		if err := tx.QueryRowContext(ctx, `SELECT profile_version FROM feed.users WHERE github_id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&actual); err != nil {
			return ErrFeedProfileChanged
		}
		if actual != expected {
			return ErrFeedProfileChanged
		}
	}
	return nil
}
func (s *PostgresFeedStore) PutFeedSession(ctx context.Context, session FeedSession, _ time.Duration) error {
	if session.ID == "" || session.GitHubID < 1 || session.ProfileVersion < 1 || len(session.Items) > 240 || !session.ExpiresAt.After(session.CreatedAt) || session.ExpiresAt.After(session.CreatedAt.Add(FeedSessionTTL)) {
		return errors.New("invalid feed session")
	}
	encoded, err := json.Marshal(feedSessionDTO(session))
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.guardFeedWrite(ctx, tx, session.GitHubID, session.ProfileVersion); err != nil {
		return err
	}
	if err := s.checkFeedTaxonomyTx(ctx, tx, session.TaxonomyVersion); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO feed.sessions(id,github_id,profile_version,snapshot,created_at,expires_at) VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(id) DO NOTHING`, session.ID, session.GitHubID, session.ProfileVersion, string(encoded), session.CreatedAt, session.ExpiresAt)
	if err != nil {
		return err
	}
	var matches bool
	if err := tx.QueryRowContext(ctx, `SELECT github_id=$2 AND snapshot=$3::jsonb FROM feed.sessions WHERE id=$1`, session.ID, session.GitHubID, string(encoded)).Scan(&matches); err != nil {
		return err
	}
	if !matches {
		return errors.New("feed session identity conflict")
	}
	return tx.Commit()
}
func (s *PostgresFeedStore) GetFeedSession(context.Context, string) (*FeedSession, error) {
	return nil, errors.New("actor-scoped session lookup required")
}
func (s *PostgresFeedStore) GetFeedSessionForUser(ctx context.Context, id int64, key string) (*FeedSession, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := s.guardFeedWrite(ctx, tx, id, 0); err != nil {
		return nil, err
	}
	var encoded []byte
	err = tx.QueryRowContext(ctx, `SELECT s.snapshot FROM feed.sessions s JOIN feed.users u ON u.github_id=s.github_id AND u.profile_version=s.profile_version WHERE s.id=$1 AND s.github_id=$2 AND s.expires_at>now() AND u.deleted_at IS NULL AND ($3=false OR (s.snapshot->>'taxonomyVersion')::bigint=(SELECT version FROM feed.taxonomy_versions WHERE state='active'))`, key, id, s.writerEpoch > 0).Scan(&encoded)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrFeedSessionNotFound
	}
	if err != nil {
		return nil, err
	}
	var dto FeedSessionDTO
	if err := json.Unmarshal(encoded, &dto); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	session := dto.session()
	return &session, nil
}
func (s *PostgresFeedStore) DeleteFeedSession(context.Context, string) error {
	return errors.New("actor-scoped session deletion required")
}
func (s *PostgresFeedStore) DeleteFeedSessionForUser(ctx context.Context, id int64, key string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.guardFeedWrite(ctx, tx, id, 0); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM feed.sessions WHERE id=$1 AND github_id=$2`, key, id); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *PostgresFeedStore) GetFeedDeletion(ctx context.Context, id int64, key string) (FeedBridgeDeleteResponse, error) {
	out := FeedBridgeDeleteResponse{DeletionID: key}
	err := s.db.QueryRowContext(ctx, `SELECT cleanup_status FROM feed.user_deletion_tombstones WHERE deletion_id=$1 AND github_id=$2`, key, id).Scan(&out.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return out, ErrFeedDeletionNotFound
	}
	return out, err
}
func (s *PostgresFeedStore) checkFeedAttribution(ctx context.Context, tx *sql.Tx, id int64, requestID, repoKey string) error {
	if s.writerEpoch == 0 {
		return nil
	}
	var requestTaxonomy int64
	err := tx.QueryRowContext(ctx, `SELECT taxonomy_version FROM feed.requests WHERE id=$1 AND github_id=$2`, requestID, id).Scan(&requestTaxonomy)
	if err != nil {
		return fmt.Errorf("invalid feed request attribution: %w", err)
	}
	if err := s.checkFeedTaxonomyTx(ctx, tx, requestTaxonomy); err != nil {
		return err
	}
	var found bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM feed.requests r JOIN feed.served_items si ON si.request_id=r.id WHERE r.id=$1 AND r.github_id=$2 AND si.repo_key=$3 AND r.profile_version<=(SELECT profile_version FROM feed.users WHERE github_id=$2) AND r.profile_version>COALESCE((SELECT MAX(profile_version) FROM feed.user_deletion_tombstones WHERE github_id=$2),0))`, requestID, id, repoKey).Scan(&found)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("invalid feed request attribution")
	}
	return nil
}

func activeFeedTaxonomyTx(ctx context.Context, tx *sql.Tx) (int64, error) {
	var version int64
	err := tx.QueryRowContext(ctx, `SELECT version FROM feed.taxonomy_versions WHERE state='active'`).Scan(&version)
	return version, err
}

// Caller already holds the runtime control row's shared lock. Governance holds
// its exclusive lock, so activation cannot occur between this check and commit.
func (s *PostgresFeedStore) checkFeedTaxonomyTx(ctx context.Context, tx *sql.Tx, expected int64) error {
	if s.writerEpoch == 0 {
		return nil
	}
	active, err := activeFeedTaxonomyTx(ctx, tx)
	if err != nil {
		return err
	}
	if active != expected {
		return ErrFeedTaxonomyChanged
	}
	return nil
}
