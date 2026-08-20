package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/hikariming/ghfind/internal/feedmigration"

	_ "github.com/jackc/pgx/v5/stdlib"
)

var (
	ErrFeedTaxonomyChanged   = errors.New("Feed taxonomy version changed")
	ErrFeedProjectNotFound   = errors.New("Feed project not found")
	ErrFeedInvalidStatePatch = errors.New("exactly one Feed project state field must be changed")
)

type FeedRequestRecord struct {
	ID              string
	User            FeedUser
	Seed            string
	CandidateCounts map[string]int
	Degraded        []string
	Duration        time.Duration
	Items           []FeedRankedItem
}

type FeedStatePatch struct {
	Saved         *bool  `json:"saved,omitempty"`
	NotInterested *bool  `json:"notInterested,omitempty"`
	RequestID     string `json:"-"`
}

type FeedProjectState struct {
	RepoKey       string `json:"repoKey"`
	Saved         bool   `json:"saved"`
	NotInterested bool   `json:"notInterested"`
}

type AcceptedFeedEvent struct {
	Input     FeedEventInput
	RequestID string
	Metadata  map[string]any
}

type FeedEventAppendResult struct {
	Accepted  int `json:"accepted"`
	Duplicate int `json:"duplicate"`
}

type FeedDataStore interface {
	Ping(context.Context) error
	ActiveTaxonomyVersion(context.Context) (int64, error)
	ListFeedTags(context.Context) ([]FeedTag, int64, error)
	EnsureFeedUser(context.Context, OAuthSession) (*FeedUser, error)
	GetFeedUser(context.Context, int64) (*FeedUser, error)
	ClaimFeedGraphRefresh(context.Context, int64, int64, time.Time, time.Duration, time.Duration) (bool, error)
	FailFeedGraphRefresh(context.Context, int64, time.Time, time.Duration) error
	ReplaceExplicitFeedPreferences(context.Context, int64, int64, []FeedPreference) (*FeedUser, error)
	SeedFeedGraphPreferences(context.Context, int64, []DeveloperFacet) (bool, error)
	LoadFeedCandidates(context.Context, FeedUser, int) ([]FeedCandidate, map[string]int, error)
	LoadGorseFeedCandidates(context.Context, FeedUser, []string, int) ([]FeedCandidate, error)
	AvailableFeedRepoKeys(context.Context, int64, []string) (map[string]bool, error)
	SaveFeedRequest(context.Context, FeedRequestRecord) error
	SetFeedProjectState(context.Context, int64, string, FeedStatePatch, time.Time) (FeedProjectState, error)
	AppendFeedEvents(context.Context, int64, []AcceptedFeedEvent) (FeedEventAppendResult, error)
	DeleteFeedProfile(context.Context, int64, time.Time) (string, error)
	UpsertFeedProject(context.Context, FeedProjectProjection) error
	FeedProjectSourceHashes(context.Context, []string) (map[string]string, error)
	AcquireFeedReconcileLease(context.Context, string, time.Time, time.Duration) (bool, error)
	ReleaseFeedReconcileLease(context.Context, string) error
	FinalizeFeedProjectReconcile(context.Context, []string, time.Time) (int64, error)
	MarkFeedReconcile(context.Context, string, time.Time, bool) error
	LoadFeedProjectChangeCursor(context.Context) (FeedProjectChangeCursor, bool, error)
	SaveFeedProjectChangeCursor(context.Context, FeedProjectChangeCursor) error
	Close() error
}

type PostgresFeedStore struct {
	db   *sql.DB
	mode FeedMode
}

func OpenPostgresFeedStore(config Config) (*PostgresFeedStore, error) {
	if strings.TrimSpace(config.FeedDatabaseURL) == "" {
		return nil, fmt.Errorf("FEED_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", config.FeedDatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("open Feed PostgreSQL: %w", err)
	}
	db.SetMaxOpenConns(24)
	db.SetMaxIdleConns(8)
	db.SetConnMaxIdleTime(5 * time.Minute)
	db.SetConnMaxLifetime(30 * time.Minute)
	store := &PostgresFeedStore{db: db, mode: config.FeedMode}
	// sql.Open only validates the DSN and creates a lazy pool. Do not ping here:
	// Feed is an optional fault domain, so a PostgreSQL outage or an incomplete
	// migration must degrade /api/feed/* without preventing the score API or the
	// three pre-existing worker consumers from starting. The migration binary
	// and the dedicated /feed-readyz probe perform strict schema validation.
	return store, nil
}

func (s *PostgresFeedStore) Close() error { return s.db.Close() }

func (s *PostgresFeedStore) Ping(ctx context.Context) error {
	var projectsTable *string
	var vectorInstalled bool
	if err := s.db.QueryRowContext(ctx, `SELECT to_regclass('feed.projects')::text,
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')`).Scan(&projectsTable, &vectorInstalled); err != nil {
		return fmt.Errorf("verify Feed PostgreSQL: %w", err)
	}
	if projectsTable == nil || *projectsTable == "" {
		return fmt.Errorf("Feed PostgreSQL migrations have not been applied")
	}
	if !vectorInstalled {
		return fmt.Errorf("Feed PostgreSQL pgvector extension is not enabled")
	}
	required, err := feedmigration.RequiredMigrations()
	if err != nil {
		return fmt.Errorf("load embedded Feed migration requirements: %w", err)
	}
	applied := make(map[int64]string, len(required))
	rows, err := s.db.QueryContext(ctx, `SELECT version,name FROM feed.schema_migrations ORDER BY version`)
	if err != nil {
		return fmt.Errorf("read Feed migration ledger: %w", err)
	}
	for rows.Next() {
		var version int64
		var name string
		if err := rows.Scan(&version, &name); err != nil {
			rows.Close()
			return fmt.Errorf("scan Feed migration ledger: %w", err)
		}
		applied[version] = name
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("read Feed migration ledger: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close Feed migration ledger: %w", err)
	}
	if len(applied) != len(required) {
		return fmt.Errorf("Feed PostgreSQL migrations are incomplete: applied=%d required=%d", len(applied), len(required))
	}
	for _, migration := range required {
		if applied[migration.Version] != migration.Name {
			return fmt.Errorf("Feed PostgreSQL migration %d (%s) is missing or mismatched", migration.Version, migration.Name)
		}
	}
	var activeTaxonomies, activeAlgorithms int
	if err := s.db.QueryRowContext(ctx, `SELECT
	  (SELECT COUNT(*) FROM feed.taxonomy_versions WHERE state='active'),
	  (SELECT COUNT(*) FROM feed.algorithm_configs WHERE state='active')`).Scan(&activeTaxonomies, &activeAlgorithms); err != nil {
		return fmt.Errorf("verify Feed active configuration: %w", err)
	}
	if activeTaxonomies != 1 {
		return fmt.Errorf("Feed PostgreSQL requires exactly one active taxonomy, found %d", activeTaxonomies)
	}
	if activeAlgorithms != 1 {
		return fmt.Errorf("Feed PostgreSQL requires exactly one active algorithm configuration, found %d", activeAlgorithms)
	}
	return nil
}

func (s *PostgresFeedStore) FeedProjectSourceHashes(ctx context.Context, repoKeys []string) (map[string]string, error) {
	result := make(map[string]string, len(repoKeys))
	if len(repoKeys) == 0 {
		return result, nil
	}
	// A project hidden because it disappeared from Turso must be projected
	// again even when its source payload is byte-for-byte identical. Excluding
	// that tombstone state from the hash fast path lets UpsertFeedProject clear
	// missing_from_source and restore the current publication decision.
	rows, err := s.db.QueryContext(ctx, `SELECT repo_key,source_hash FROM feed.projects
	  WHERE repo_key = ANY($1) AND blocked_reason IS DISTINCT FROM 'missing_from_source'`, repoKeys)
	if err != nil {
		return nil, fmt.Errorf("read Feed project source hashes: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var repoKey, sourceHash string
		if err := rows.Scan(&repoKey, &sourceHash); err != nil {
			return nil, err
		}
		result[repoKey] = sourceHash
	}
	return result, rows.Err()
}

func (s *PostgresFeedStore) AcquireFeedReconcileLease(
	ctx context.Context,
	workerID string,
	now time.Time,
	ttl time.Duration,
) (bool, error) {
	if strings.TrimSpace(workerID) == "" || ttl <= 0 {
		return false, fmt.Errorf("Feed reconciliation lease requires worker id and positive ttl")
	}
	var acquired bool
	err := s.db.QueryRowContext(ctx, `INSERT INTO feed.projection_cursors
      (projection,cursor_value,source_timestamp,consecutive_clean_runs,locked_by,locked_until)
      VALUES ('turso-projects','0',NULL,0,$1,$2)
      ON CONFLICT (projection) DO UPDATE SET locked_by=excluded.locked_by,locked_until=excluded.locked_until
      WHERE feed.projection_cursors.locked_until IS NULL
         OR feed.projection_cursors.locked_until < $3
         OR feed.projection_cursors.locked_by = $1
      RETURNING true`, workerID, now.Add(ttl), now).Scan(&acquired)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("acquire Feed reconciliation lease: %w", err)
	}
	return acquired, nil
}

func (s *PostgresFeedStore) ReleaseFeedReconcileLease(ctx context.Context, workerID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE feed.projection_cursors
      SET locked_by=NULL,locked_until=NULL,updated_at=now()
      WHERE projection='turso-projects' AND locked_by=$1`, workerID)
	if err != nil {
		return fmt.Errorf("release Feed reconciliation lease: %w", err)
	}
	return nil
}

// RenewFeedReconcileLease keeps a long keyset sweep single-owner while still
// allowing another worker to recover within one minute after a process crash.
// An already expired lease cannot be resurrected: the caller must abort rather
// than race a new owner through the destructive missing-project finalization.
func (s *PostgresFeedStore) RenewFeedReconcileLease(
	ctx context.Context,
	workerID string,
	now time.Time,
	ttl time.Duration,
) (bool, error) {
	if strings.TrimSpace(workerID) == "" || ttl <= 0 {
		return false, fmt.Errorf("Feed reconciliation lease renewal requires worker id and positive ttl")
	}
	var renewed bool
	err := s.db.QueryRowContext(ctx, `UPDATE feed.projection_cursors
      SET locked_until=$3,updated_at=now()
      WHERE projection='turso-projects' AND locked_by=$1 AND locked_until > $2
      RETURNING true`, workerID, now, now.Add(ttl)).Scan(&renewed)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("renew Feed reconciliation lease: %w", err)
	}
	return renewed, nil
}

func (s *PostgresFeedStore) ActiveTaxonomyVersion(ctx context.Context) (int64, error) {
	var version int64
	if err := s.db.QueryRowContext(ctx, `SELECT version FROM feed.taxonomy_versions WHERE state = 'active' LIMIT 1`).Scan(&version); err != nil {
		return 0, fmt.Errorf("read active Feed taxonomy: %w", err)
	}
	return version, nil
}

func (s *PostgresFeedStore) ListFeedTags(ctx context.Context) ([]FeedTag, int64, error) {
	version, err := s.ActiveTaxonomyVersion(ctx)
	if err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, namespace, slug, label_zh, label_en, description, taxonomy_version
      FROM feed.tag_definitions WHERE status = 'canonical' AND taxonomy_version <= $1
      ORDER BY namespace, slug`, version)
	if err != nil {
		return nil, 0, fmt.Errorf("list Feed tags: %w", err)
	}
	defer rows.Close()
	tags := []FeedTag{}
	for rows.Next() {
		var tag FeedTag
		if err := rows.Scan(&tag.ID, &tag.Namespace, &tag.Slug, &tag.LabelZH, &tag.LabelEN, &tag.Description, &tag.TaxonomyVersion); err != nil {
			return nil, 0, fmt.Errorf("scan Feed tag: %w", err)
		}
		tags = append(tags, tag)
	}
	return tags, version, rows.Err()
}

func (s *PostgresFeedStore) EnsureFeedUser(ctx context.Context, session OAuthSession) (*FeedUser, error) {
	version, err := s.ActiveTaxonomyVersion(ctx)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	var profileVersion int64
	err = tx.QueryRowContext(ctx, `INSERT INTO feed.users
      (github_id, login, avatar_url, taxonomy_version)
      VALUES ($1, $2, NULLIF($3, ''), $4)
      ON CONFLICT (github_id) DO UPDATE SET
        login = excluded.login, avatar_url = excluded.avatar_url,
        taxonomy_version = excluded.taxonomy_version, updated_at = now(), deleted_at = NULL
	  RETURNING profile_version`, session.GitHubID, strings.ToLower(session.Login), session.AvatarURL, version).Scan(&profileVersion)
	if err != nil {
		return nil, fmt.Errorf("upsert Feed user: %w", err)
	}
	payload, _ := json.Marshal(map[string]any{"githubId": session.GitHubID, "profileVersion": profileVersion})
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
	  VALUES ($1,'feed.profile-rebuild.v1',$2::jsonb,$3) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
		fmt.Sprintf("gh:%d", session.GitHubID), string(payload),
		fmt.Sprintf("profile-identity:%d:%s:%d", session.GitHubID, strings.ToLower(session.Login), profileVersion)); err != nil {
		return nil, fmt.Errorf("queue Feed user projection: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetFeedUser(ctx, session.GitHubID)
}

func (s *PostgresFeedStore) GetFeedUser(ctx context.Context, githubID int64) (*FeedUser, error) {
	var user FeedUser
	if err := s.db.QueryRowContext(ctx, `SELECT github_id, login, COALESCE(avatar_url, ''), taxonomy_version, profile_version
      FROM feed.users WHERE github_id = $1 AND deleted_at IS NULL`, githubID).Scan(
		&user.GitHubID, &user.Login, &user.AvatarURL, &user.TaxonomyVersion, &user.ProfileVersion,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("read Feed user: %w", err)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT tag_id, value, source, strength, taxonomy_version
      FROM feed.user_tag_preferences WHERE github_id = $1 ORDER BY source, tag_id`, githubID)
	if err != nil {
		return nil, fmt.Errorf("read Feed preferences: %w", err)
	}
	defer rows.Close()
	user.Preferences = []FeedPreference{}
	for rows.Next() {
		var preference FeedPreference
		if err := rows.Scan(&preference.TagID, &preference.Value, &preference.Source, &preference.Strength, &preference.TaxonomyVersion); err != nil {
			return nil, fmt.Errorf("scan Feed preference: %w", err)
		}
		user.Preferences = append(user.Preferences, preference)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var vectorText, vectorModel sql.NullString
	var vectorDimensions sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `SELECT e.embedding::text,e.model,e.dimensions FROM feed.user_profile_embeddings e
	      JOIN feed.users u ON u.github_id=e.github_id AND u.profile_version=e.profile_version
	      WHERE e.github_id = $1 AND e.active = true LIMIT 1`, githubID).Scan(&vectorText, &vectorModel, &vectorDimensions); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("read Feed user embedding: %w", err)
	}
	if vectorText.Valid {
		user.Embedding, _ = parsePGVector(vectorText.String)
		user.embeddingModel = vectorModel.String
		user.embeddingDimensions = int(vectorDimensions.Int64)
	}
	return &user, nil
}

// ClaimFeedGraphRefresh grants one API process the right to read a user's
// Turso facets. The materialized profile is valid for refreshAfter unless the
// active taxonomy has changed. The short lease makes a crashed refresher
// recoverable without allowing a thundering herd of homepage requests.
func (s *PostgresFeedStore) ClaimFeedGraphRefresh(
	ctx context.Context,
	githubID, taxonomyVersion int64,
	now time.Time,
	refreshAfter, leaseTTL time.Duration,
) (bool, error) {
	if refreshAfter <= 0 || leaseTTL <= 0 {
		return false, fmt.Errorf("Feed graph refresh requires positive refresh and lease durations")
	}
	var claimed bool
	err := s.db.QueryRowContext(ctx, `UPDATE feed.users
	  SET graph_refresh_locked_until=$3, updated_at=now()
	  WHERE github_id=$1 AND deleted_at IS NULL
	    AND (graph_refresh_locked_until IS NULL OR graph_refresh_locked_until < $2)
	    AND (graph_checked_at IS NULL OR graph_checked_at <= $4 OR graph_taxonomy_version <> $5)
	  RETURNING true`, githubID, now, now.Add(leaseTTL), now.Add(-refreshAfter), taxonomyVersion).Scan(&claimed)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("claim Feed graph refresh: %w", err)
	}
	return claimed, nil
}

// FailFeedGraphRefresh retains the prior materialized preferences and applies
// bounded retry backoff. A transient Turso outage must never clear a user's
// cold-start profile or make every Feed request hit Turso.
func (s *PostgresFeedStore) FailFeedGraphRefresh(ctx context.Context, githubID int64, now time.Time, retryAfter time.Duration) error {
	if retryAfter <= 0 {
		return fmt.Errorf("Feed graph refresh retry duration must be positive")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE feed.users
	  SET graph_refresh_locked_until=$2, updated_at=now()
	  WHERE github_id=$1 AND deleted_at IS NULL`, githubID, now.Add(retryAfter))
	if err != nil {
		return fmt.Errorf("back off Feed graph refresh: %w", err)
	}
	if affected, err := result.RowsAffected(); err != nil {
		return err
	} else if affected != 1 {
		return fmt.Errorf("Feed user %d disappeared while backing off graph refresh", githubID)
	}
	return nil
}

// AvailableFeedRepoKeys re-applies the two request-time hard filters that may
// change while a 30-minute Feed session is cached in Upstash. Ranking remains
// stable, but a moderator removal or a user's not-interested action can never
// leak through a later cursor page.
func (s *PostgresFeedStore) AvailableFeedRepoKeys(ctx context.Context, githubID int64, repoKeys []string) (map[string]bool, error) {
	available := make(map[string]bool, len(repoKeys))
	if len(repoKeys) == 0 {
		return available, nil
	}
	rows, err := s.db.QueryContext(ctx, `SELECT p.repo_key
	  FROM feed.projects p
	  LEFT JOIN feed.user_project_state ups ON ups.github_id=$1 AND ups.repo_key=p.repo_key
	  WHERE p.repo_key = ANY($2) AND p.publishable=true
	    AND COALESCE(ups.not_interested,false)=false`, githubID, repoKeys)
	if err != nil {
		return nil, fmt.Errorf("revalidate Feed page: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var repoKey string
		if err := rows.Scan(&repoKey); err != nil {
			return nil, err
		}
		available[repoKey] = true
	}
	return available, rows.Err()
}

func (s *PostgresFeedStore) ReplaceExplicitFeedPreferences(ctx context.Context, githubID, taxonomyVersion int64, preferences []FeedPreference) (*FeedUser, error) {
	if len(preferences) > 30 {
		return nil, fmt.Errorf("at most 30 Feed preferences are allowed")
	}
	unique := map[string]int{}
	ids := make([]string, 0, len(preferences))
	for _, preference := range preferences {
		if strings.TrimSpace(preference.TagID) == "" || (preference.Value != -1 && preference.Value != 1) {
			return nil, fmt.Errorf("invalid Feed preference")
		}
		if _, exists := unique[preference.TagID]; exists {
			return nil, fmt.Errorf("duplicate Feed preference %q", preference.TagID)
		}
		unique[preference.TagID] = preference.Value
		ids = append(ids, preference.TagID)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	var activeVersion int64
	if err := tx.QueryRowContext(ctx, `SELECT version FROM feed.taxonomy_versions WHERE state = 'active' LIMIT 1`).Scan(&activeVersion); err != nil {
		return nil, fmt.Errorf("read active Feed taxonomy: %w", err)
	}
	if activeVersion != taxonomyVersion {
		return nil, ErrFeedTaxonomyChanged
	}
	if len(ids) > 0 {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.tag_definitions
          WHERE id = ANY($1) AND status = 'canonical' AND taxonomy_version <= $2`, ids, activeVersion).Scan(&count); err != nil {
			return nil, fmt.Errorf("validate Feed preference tags: %w", err)
		}
		if count != len(ids) {
			return nil, fmt.Errorf("one or more Feed tags are not active")
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM feed.user_tag_preferences WHERE github_id = $1 AND source = 'explicit'`, githubID); err != nil {
		return nil, fmt.Errorf("clear explicit Feed preferences: %w", err)
	}
	for _, preference := range preferences {
		if _, err := tx.ExecContext(ctx, `INSERT INTO feed.user_tag_preferences
          (github_id, tag_id, value, source, strength, taxonomy_version)
          VALUES ($1, $2, $3, 'explicit', 1, $4)`, githubID, preference.TagID, preference.Value, activeVersion); err != nil {
			return nil, fmt.Errorf("insert Feed preference: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE feed.users SET profile_version = profile_version + 1,
      taxonomy_version = $2, updated_at = now() WHERE github_id = $1`, githubID, activeVersion); err != nil {
		return nil, fmt.Errorf("bump Feed profile: %w", err)
	}
	payload, _ := json.Marshal(map[string]any{"githubId": githubID, "taxonomyVersion": activeVersion})
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox (aggregate_key,topic,payload)
      VALUES ($1,'feed.profile-rebuild.v1',$2::jsonb)`, fmt.Sprintf("gh:%d", githubID), string(payload)); err != nil {
		return nil, fmt.Errorf("queue Feed profile rebuild: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetFeedUser(ctx, githubID)
}

func (s *PostgresFeedStore) SaveFeedRequest(ctx context.Context, record FeedRequestRecord) error {
	candidateCounts, _ := json.Marshal(record.CandidateCounts)
	degraded, _ := json.Marshal(record.Degraded)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	_, err = tx.ExecContext(ctx, `INSERT INTO feed.requests
      (id, github_id, algorithm_version, taxonomy_version, profile_version, seed, candidate_counts, degraded, duration_ms)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`, record.ID, record.User.GitHubID,
		FeedAlgorithmVersion, record.User.TaxonomyVersion, record.User.ProfileVersion, record.Seed,
		string(candidateCounts), string(degraded), record.Duration.Milliseconds())
	if err != nil {
		return fmt.Errorf("insert Feed request: %w", err)
	}
	for _, item := range record.Items {
		sources, _ := json.Marshal(item.CandidateSources)
		reasons, _ := json.Marshal(item.ReasonCodes)
		features, _ := json.Marshal(item.Features)
		_, err = tx.ExecContext(ctx, `INSERT INTO feed.served_items
          (request_id, repo_key, rank, candidate_sources, reason_codes, feature_snapshot, score, exploration, propensity)
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)`, record.ID,
			item.Project.RepoKey, item.Rank, string(sources), string(reasons), string(features), item.Score, item.Exploration, item.Propensity)
		if err != nil {
			return fmt.Errorf("insert Feed served item: %w", err)
		}
	}
	if s.mode == FeedModeGorseShadow || s.mode == FeedModeGorseCanary {
		payload, _ := json.Marshal(map[string]any{"requestId": record.ID, "githubId": record.User.GitHubID})
		if _, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
		  VALUES ($1,'feed.gorse-shadow-request.v1',$2::jsonb,$3)
		  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
			fmt.Sprintf("gh:%d", record.User.GitHubID), string(payload), "gorse-shadow:"+record.ID); err != nil {
			return fmt.Errorf("queue Gorse shadow request: %w", err)
		}
	}
	return tx.Commit()
}

func (s *PostgresFeedStore) SetFeedProjectState(ctx context.Context, githubID int64, repoKey string, patch FeedStatePatch, now time.Time) (FeedProjectState, error) {
	if (patch.Saved == nil) == (patch.NotInterested == nil) {
		return FeedProjectState{}, ErrFeedInvalidStatePatch
	}
	repoKey = strings.ToLower(strings.TrimSpace(repoKey))
	eventID, err := NewFeedID("event")
	if err != nil {
		return FeedProjectState{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return FeedProjectState{}, err
	}
	defer tx.Rollback() //nolint:errcheck
	var state FeedProjectState
	changed := true
	if patch.Saved != nil {
		eventType := FeedEventUnsave
		if *patch.Saved {
			eventType = FeedEventSave
		}
		err = tx.QueryRowContext(ctx, `INSERT INTO feed.user_project_state
          (github_id, repo_key, saved, saved_at, updated_at)
		  VALUES ($1, $2, $3, CASE WHEN $3 THEN $4::timestamptz ELSE NULL END, $4::timestamptz)
		  ON CONFLICT (github_id, repo_key) DO UPDATE SET saved = excluded.saved,
		    saved_at = excluded.saved_at, updated_at = excluded.updated_at
		  WHERE feed.user_project_state.saved IS DISTINCT FROM excluded.saved
		  RETURNING repo_key, saved, not_interested`, githubID, repoKey, *patch.Saved, now).Scan(&state.RepoKey, &state.Saved, &state.NotInterested)
		if errors.Is(err, sql.ErrNoRows) {
			changed = false
			err = tx.QueryRowContext(ctx, `SELECT repo_key,saved,not_interested FROM feed.user_project_state WHERE github_id=$1 AND repo_key=$2`, githubID, repoKey).
				Scan(&state.RepoKey, &state.Saved, &state.NotInterested)
		} else if err == nil {
			err = insertFeedEventTx(ctx, tx, eventID, githubID, repoKey, patch.RequestID, eventType, now, map[string]any{"value": *patch.Saved})
		}
	} else {
		eventType := FeedEventUndoNotInterested
		if *patch.NotInterested {
			eventType = FeedEventNotInterested
		}
		err = tx.QueryRowContext(ctx, `INSERT INTO feed.user_project_state
          (github_id, repo_key, not_interested, not_interested_at, updated_at)
		  VALUES ($1, $2, $3, CASE WHEN $3 THEN $4::timestamptz ELSE NULL END, $4::timestamptz)
		  ON CONFLICT (github_id, repo_key) DO UPDATE SET not_interested = excluded.not_interested,
		    not_interested_at = excluded.not_interested_at, updated_at = excluded.updated_at
		  WHERE feed.user_project_state.not_interested IS DISTINCT FROM excluded.not_interested
		  RETURNING repo_key, saved, not_interested`, githubID, repoKey, *patch.NotInterested, now).Scan(&state.RepoKey, &state.Saved, &state.NotInterested)
		if errors.Is(err, sql.ErrNoRows) {
			changed = false
			err = tx.QueryRowContext(ctx, `SELECT repo_key,saved,not_interested FROM feed.user_project_state WHERE github_id=$1 AND repo_key=$2`, githubID, repoKey).
				Scan(&state.RepoKey, &state.Saved, &state.NotInterested)
		} else if err == nil {
			err = insertFeedEventTx(ctx, tx, eventID, githubID, repoKey, patch.RequestID, eventType, now, map[string]any{"value": *patch.NotInterested})
		}
	}
	if err != nil {
		if strings.Contains(err.Error(), "foreign key") {
			return FeedProjectState{}, ErrFeedProjectNotFound
		}
		return FeedProjectState{}, fmt.Errorf("update Feed project state: %w", err)
	}
	if changed {
		if _, err := tx.ExecContext(ctx, `UPDATE feed.users SET profile_version=profile_version+1,updated_at=now() WHERE github_id=$1`, githubID); err != nil {
			return FeedProjectState{}, fmt.Errorf("bump Feed profile state version: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return FeedProjectState{}, err
	}
	return state, nil
}

func (s *PostgresFeedStore) AppendFeedEvents(ctx context.Context, githubID int64, events []AcceptedFeedEvent) (FeedEventAppendResult, error) {
	result := FeedEventAppendResult{}
	if len(events) == 0 {
		return result, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback() //nolint:errcheck
	type eventRow struct {
		ID         string         `json:"id"`
		RepoKey    string         `json:"repo_key"`
		RequestID  string         `json:"request_id,omitempty"`
		EventType  FeedEventType  `json:"event_type"`
		OccurredAt time.Time      `json:"occurred_at"`
		Metadata   map[string]any `json:"metadata"`
	}
	batch := make([]eventRow, 0, len(events))
	for _, event := range events {
		batch = append(batch, eventRow{
			ID: event.Input.ID, RepoKey: strings.ToLower(event.Input.RepoKey), RequestID: event.RequestID,
			EventType: event.Input.Type, OccurredAt: event.Input.OccurredAt, Metadata: event.Metadata,
		})
	}
	encoded, err := json.Marshal(batch)
	if err != nil {
		return result, fmt.Errorf("encode Feed event batch: %w", err)
	}
	// One set-based statement inserts the immutable facts and their transactional
	// outbox projection. A 50-event client batch previously performed 100 SQL
	// statements inside a single transaction; at the documented 50 concurrent
	// writers that alone exceeded the 200ms p95 event SLO.
	rows, err := tx.QueryContext(ctx, `WITH input AS (
      SELECT id,lower(repo_key) AS repo_key,NULLIF(request_id,'') AS request_id,event_type,occurred_at,metadata
      FROM jsonb_to_recordset($2::jsonb) AS value(
        id TEXT, repo_key TEXT, request_id TEXT, event_type TEXT, occurred_at TIMESTAMPTZ, metadata JSONB
      )
    ), inserted AS (
      INSERT INTO feed.events (id,github_id,repo_key,request_id,event_type,occurred_at,metadata)
      SELECT id,$1,repo_key,request_id,event_type,occurred_at,metadata FROM input
      ON CONFLICT (id) DO NOTHING
      RETURNING id,repo_key,event_type,occurred_at,metadata
    ), queued AS (
      INSERT INTO feed.event_outbox (event_id,aggregate_key,topic,payload)
      SELECT id,'gh:' || $1::text,'feed.event-project.v1',jsonb_build_object(
        'eventId',id,'githubId',$1,'repoKey',repo_key,'type',event_type,
        'occurredAt',occurred_at,'metadata',metadata
      ) FROM inserted
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    )
    SELECT id FROM inserted`, githubID, string(encoded))
	if err != nil {
		return result, fmt.Errorf("append Feed event batch: %w", err)
	}
	insertedIDs := make(map[string]bool, len(events))
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return result, fmt.Errorf("scan appended Feed event: %w", err)
		}
		insertedIDs[id] = true
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return result, fmt.Errorf("append Feed event batch rows: %w", err)
	}
	if err := rows.Close(); err != nil {
		return result, fmt.Errorf("close appended Feed event batch: %w", err)
	}
	profileChanged := false
	for _, event := range events {
		if insertedIDs[event.Input.ID] {
			result.Accepted++
			qualified, _ := event.Metadata["qualified"].(bool)
			if event.Input.Type == FeedEventGitHubOutbound || event.Input.Type == FeedEventShare || (event.Input.Type == FeedEventDwell && qualified) {
				profileChanged = true
			}
		} else {
			result.Duplicate++
		}
	}
	if profileChanged {
		if _, err := tx.ExecContext(ctx, `UPDATE feed.users SET profile_version=profile_version+1,updated_at=now() WHERE github_id=$1`, githubID); err != nil {
			return result, fmt.Errorf("bump Feed behavior profile version: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return FeedEventAppendResult{}, err
	}
	return result, nil
}

func insertFeedEventTx(ctx context.Context, tx *sql.Tx, id string, githubID int64, repoKey, requestID string, eventType FeedEventType, occurredAt time.Time, metadata map[string]any) error {
	_, err := insertFeedEventTxResult(ctx, tx, id, githubID, repoKey, requestID, eventType, occurredAt, metadata)
	return err
}

func insertFeedEventTxResult(ctx context.Context, tx *sql.Tx, id string, githubID int64, repoKey, requestID string, eventType FeedEventType, occurredAt time.Time, metadata map[string]any) (bool, error) {
	encoded, _ := json.Marshal(metadata)
	var nullableRequest any
	if requestID != "" {
		nullableRequest = requestID
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO feed.events
      (id, github_id, repo_key, request_id, event_type, occurred_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (id) DO NOTHING`,
		id, githubID, strings.ToLower(repoKey), nullableRequest, eventType, occurredAt, string(encoded))
	if err != nil {
		return false, fmt.Errorf("insert Feed event: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if rows == 0 {
		return false, nil
	}
	payload, _ := json.Marshal(map[string]any{"eventId": id, "githubId": githubID, "repoKey": strings.ToLower(repoKey), "type": eventType, "occurredAt": occurredAt, "metadata": metadata})
	_, err = tx.ExecContext(ctx, `INSERT INTO feed.event_outbox (event_id, aggregate_key, topic, payload)
      VALUES ($1, $2, 'feed.event-project.v1', $3::jsonb) ON CONFLICT (event_id) DO NOTHING`,
		id, fmt.Sprintf("gh:%d", githubID), string(payload))
	if err != nil {
		return false, fmt.Errorf("insert Feed event outbox: %w", err)
	}
	return true, nil
}

func (s *PostgresFeedStore) DeleteFeedProfile(ctx context.Context, githubID int64, now time.Time) (string, error) {
	deletionID, err := NewFeedID("feed_delete")
	if err != nil {
		return "", err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback() //nolint:errcheck
	payload, _ := json.Marshal(map[string]any{"deletionId": deletionID, "gorseUserId": fmt.Sprintf("gh:%d", githubID), "requestedAt": now})
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.user_deletion_tombstones
	  (deletion_id,github_id,gorse_user_id,requested_at) VALUES ($1,$2,$3,$4)`,
		deletionID, githubID, fmt.Sprintf("gh:%d", githubID), now); err != nil {
		return "", fmt.Errorf("persist Feed user deletion tombstone: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox (aggregate_key, topic, payload)
      VALUES ($1, 'feed.user-delete.v1', $2::jsonb)`, fmt.Sprintf("gh:%d", githubID), string(payload)); err != nil {
		return "", fmt.Errorf("queue Feed user deletion: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM feed.users WHERE github_id = $1`, githubID); err != nil {
		return "", fmt.Errorf("delete Feed profile: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return deletionID, nil
}

func (s *PostgresFeedStore) MarkFeedReconcile(ctx context.Context, cursor string, sourceTime time.Time, clean bool) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO feed.projection_cursors
      (projection, cursor_value, source_timestamp, consecutive_clean_runs)
      VALUES ('turso-projects', $1, $2, CASE WHEN $3 THEN 1 ELSE 0 END)
      ON CONFLICT (projection) DO UPDATE SET cursor_value = excluded.cursor_value,
        source_timestamp = excluded.source_timestamp,
        consecutive_clean_runs = CASE WHEN $3 THEN feed.projection_cursors.consecutive_clean_runs + 1 ELSE 0 END,
        updated_at = now()`, cursor, sourceTime, clean)
	return err
}

func (s *PostgresFeedStore) LoadFeedProjectChangeCursor(ctx context.Context) (FeedProjectChangeCursor, bool, error) {
	var encoded string
	err := s.db.QueryRowContext(ctx, `SELECT cursor_value FROM feed.projection_cursors
	  WHERE projection='turso-projects-incremental'`).Scan(&encoded)
	if errors.Is(err, sql.ErrNoRows) {
		return FeedProjectChangeCursor{}, false, nil
	}
	if err != nil {
		return FeedProjectChangeCursor{}, false, fmt.Errorf("read Feed project change cursor: %w", err)
	}
	var cursor FeedProjectChangeCursor
	if err := json.Unmarshal([]byte(encoded), &cursor); err != nil {
		return FeedProjectChangeCursor{}, false, fmt.Errorf("decode Feed project change cursor: %w", err)
	}
	if cursor.UpdatedAt < 0 || (cursor.UpdatedAt == 0 && cursor.RepoKey != "") || cursor.SourceCount < 0 {
		return FeedProjectChangeCursor{}, false, fmt.Errorf("invalid Feed project change cursor")
	}
	return cursor, true, nil
}

func (s *PostgresFeedStore) SaveFeedProjectChangeCursor(ctx context.Context, cursor FeedProjectChangeCursor) error {
	if cursor.UpdatedAt < 0 || cursor.SourceCount < 0 {
		return fmt.Errorf("invalid Feed project change cursor")
	}
	cursor.RepoKey = strings.ToLower(strings.TrimSpace(cursor.RepoKey))
	encoded, err := json.Marshal(cursor)
	if err != nil {
		return err
	}
	var sourceTimestamp any
	if cursor.UpdatedAt > 0 {
		sourceTimestamp = time.UnixMilli(cursor.UpdatedAt).UTC()
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO feed.projection_cursors
	  (projection,cursor_value,source_timestamp,consecutive_clean_runs)
	  VALUES ('turso-projects-incremental',$1,$2,0)
	  ON CONFLICT (projection) DO UPDATE SET cursor_value=excluded.cursor_value,
	    source_timestamp=excluded.source_timestamp,updated_at=now()`, string(encoded), sourceTimestamp)
	if err != nil {
		return fmt.Errorf("save Feed project change cursor: %w", err)
	}
	return nil
}

func (s *PostgresFeedStore) FinalizeFeedProjectReconcile(ctx context.Context, seen []string, now time.Time) (int64, error) {
	if len(seen) == 0 {
		return 0, fmt.Errorf("refusing to finalize an empty Feed project snapshot")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback() //nolint:errcheck
	rows, err := tx.QueryContext(ctx, `UPDATE feed.projects SET publishable=false,
	      blocked_reason='missing_from_source',projection_version=projection_version+1,projected_at=$2,updated_at=now()
	      WHERE NOT (repo_key = ANY($1)) AND publishable=true AND projected_at < $2
	      RETURNING repo_key,projection_version`, seen, now)
	if err != nil {
		return 0, fmt.Errorf("hide missing Feed projects: %w", err)
	}
	type hiddenProject struct {
		repoKey string
		version int64
	}
	hidden := []hiddenProject{}
	for rows.Next() {
		var project hiddenProject
		if err := rows.Scan(&project.repoKey, &project.version); err != nil {
			_ = rows.Close()
			return 0, err
		}
		hidden = append(hidden, project)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	for _, project := range hidden {
		payload, _ := json.Marshal(map[string]any{"repoKey": project.repoKey, "publishable": false, "projectionVersion": project.version})
		if _, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
		  VALUES ($1,'feed.project-sync.v1',$2::jsonb,$3) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
			project.repoKey, string(payload), fmt.Sprintf("project-sync:%s:%d", project.repoKey, project.version)); err != nil {
			return 0, fmt.Errorf("queue hidden Feed project: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return int64(len(hidden)), nil
}

var _ FeedDataStore = (*PostgresFeedStore)(nil)
