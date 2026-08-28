package backend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type FeedEmbeddingTarget struct {
	Kind           string
	ID             string
	Descriptor     string
	DescriptorHash string
}

type FeedEmbeddingStore interface {
	ListPendingFeedEmbeddings(context.Context, string, int) ([]FeedEmbeddingTarget, error)
	SaveFeedEmbedding(context.Context, FeedEmbeddingTarget, string, []float64) error
	RecordFeedEmbeddingFailure(context.Context, FeedEmbeddingTarget, string, error, time.Time) (bool, error)
	ActivateFeedEmbeddingModel(context.Context, string) (bool, error)
	ListPendingFeedProfiles(context.Context, string, int) ([]int64, error)
	RebuildFeedUserProfile(context.Context, int64, string, time.Time) (bool, error)
}

type FeedEmbeddingProvider interface {
	Embed(context.Context, string) ([]float64, error)
}

type OpenAICompatibleEmbeddingProvider struct {
	endpoint   string
	apiKey     string
	model      string
	dimensions int
	client     *http.Client
}

func NewFeedEmbeddingProvider(config Config) (*OpenAICompatibleEmbeddingProvider, error) {
	if config.EmbeddingBaseURL == "" || config.EmbeddingAPIKey == "" || config.EmbeddingModel == "" {
		return nil, fmt.Errorf("Feed embedding provider is not configured")
	}
	return &OpenAICompatibleEmbeddingProvider{
		endpoint: strings.TrimRight(config.EmbeddingBaseURL, "/") + "/embeddings", apiKey: config.EmbeddingAPIKey,
		model: config.EmbeddingModel, dimensions: config.EmbeddingDimensions,
		client: &http.Client{Timeout: 30 * time.Second},
	}, nil
}

func (p *OpenAICompatibleEmbeddingProvider) Embed(ctx context.Context, descriptor string) ([]float64, error) {
	body := map[string]any{"model": p.model, "input": descriptor, "encoding_format": "float"}
	if p.dimensions > 0 {
		body["dimensions"] = p.dimensions
	}
	encoded, _ := json.Marshal(body)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+p.apiKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := p.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("call embedding provider: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("embedding provider returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(data)))
	}
	var payload struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
			Index     int       `json:"index"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &payload); err != nil || len(payload.Data) != 1 {
		return nil, fmt.Errorf("invalid embedding provider response")
	}
	vector := payload.Data[0].Embedding
	if len(vector) != p.dimensions {
		return nil, fmt.Errorf("embedding dimensions %d, expected %d", len(vector), p.dimensions)
	}
	for _, value := range vector {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, fmt.Errorf("embedding contains a non-finite value")
		}
	}
	return vector, nil
}

func descriptorHash(descriptor string) string {
	digest := sha256.Sum256([]byte(descriptor))
	return hex.EncodeToString(digest[:])
}

func (s *PostgresFeedStore) ListPendingFeedEmbeddings(ctx context.Context, model string, limit int) ([]FeedEmbeddingTarget, error) {
	if limit < 1 || limit > 100 {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, `SELECT 'project',p.repo_key,p.descriptor,p.descriptor_hash
	      FROM feed.projects p LEFT JOIN feed.projection_failures f
	        ON f.projection='embedding:' || $1 AND f.source_ref='project:' || p.repo_key
	      WHERE p.publishable=true AND NOT EXISTS (
	        SELECT 1 FROM feed.project_embeddings e WHERE e.repo_key=p.repo_key AND e.model=$1 AND e.descriptor_hash=p.descriptor_hash)
	      AND (f.id IS NULL OR f.source_hash IS DISTINCT FROM p.descriptor_hash OR f.resolved_at IS NOT NULL
	        OR (f.dead_lettered_at IS NULL AND f.available_at <= now()))
	      ORDER BY p.repo_key LIMIT $2`, model, limit)
	if err != nil {
		return nil, fmt.Errorf("list pending Feed embeddings: %w", err)
	}
	targets := []FeedEmbeddingTarget{}
	for rows.Next() {
		var target FeedEmbeddingTarget
		if err := rows.Scan(&target.Kind, &target.ID, &target.Descriptor, &target.DescriptorHash); err != nil {
			return nil, err
		}
		targets = append(targets, target)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(targets) >= limit {
		return targets, nil
	}
	tagRows, err := s.db.QueryContext(ctx, `SELECT t.id,concat_ws(E'\n',t.namespace||':'||t.slug,t.label_en,t.label_zh,t.description),e.descriptor_hash,
	        f.source_hash,f.available_at,f.dead_lettered_at,f.resolved_at
	      FROM feed.tag_definitions t LEFT JOIN LATERAL (
	        SELECT descriptor_hash FROM feed.tag_embeddings candidate
	        WHERE candidate.tag_id=t.id AND candidate.model=$1 ORDER BY generated_at DESC LIMIT 1
	      ) e ON true
	      LEFT JOIN feed.projection_failures f ON f.projection='embedding:' || $1 AND f.source_ref='tag:' || t.id
	      WHERE t.status='canonical' ORDER BY t.id`, model)
	if err != nil {
		return nil, fmt.Errorf("list pending Feed tag embeddings: %w", err)
	}
	defer tagRows.Close()
	for tagRows.Next() && len(targets) < limit {
		var target FeedEmbeddingTarget
		var currentHash *string
		var failureHash sql.NullString
		var availableAt, deadLetteredAt, resolvedAt sql.NullTime
		target.Kind = "tag"
		if err := tagRows.Scan(&target.ID, &target.Descriptor, &currentHash, &failureHash, &availableAt, &deadLetteredAt, &resolvedAt); err != nil {
			return nil, err
		}
		target.DescriptorHash = descriptorHash(target.Descriptor)
		failedCurrentDescriptor := failureHash.Valid && failureHash.String == target.DescriptorHash && !resolvedAt.Valid
		retryReady := !deadLetteredAt.Valid && (!availableAt.Valid || !availableAt.Time.After(time.Now().UTC()))
		if (currentHash == nil || *currentHash != target.DescriptorHash) && (!failedCurrentDescriptor || retryReady) {
			targets = append(targets, target)
		}
	}
	return targets, tagRows.Err()
}

func (s *PostgresFeedStore) SaveFeedEmbedding(ctx context.Context, target FeedEmbeddingTarget, model string, embedding []float64) error {
	if target.DescriptorHash != descriptorHash(target.Descriptor) || len(embedding) == 0 {
		return fmt.Errorf("invalid Feed embedding target")
	}
	vector := formatPGVector(embedding)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	var activeModel string
	if err := tx.QueryRowContext(ctx, `SELECT active_model FROM feed.embedding_model_state WHERE singleton=true FOR UPDATE`).Scan(&activeModel); err != nil {
		return err
	}
	activateNow := activeModel == model
	switch target.Kind {
	case "project":
		if activateNow {
			if _, err := tx.ExecContext(ctx, `UPDATE feed.project_embeddings SET active=false WHERE repo_key=$1 AND active=true`, target.ID); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO feed.project_embeddings
          (repo_key,model,dimensions,descriptor_hash,embedding,active)
          VALUES ($1,$2,$3,$4,$5::vector,$6)
          ON CONFLICT (repo_key,model,descriptor_hash) DO UPDATE SET embedding=excluded.embedding,dimensions=excluded.dimensions,active=excluded.active,generated_at=now()`,
			target.ID, model, len(embedding), target.DescriptorHash, vector, activateNow)
		if err == nil && activateNow {
			payload, _ := json.Marshal(map[string]any{"repoKey": target.ID, "embeddingModel": model, "descriptorHash": target.DescriptorHash})
			_, err = tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
			  VALUES ($1,'feed.project-sync.v1',$2::jsonb,$3) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
				target.ID, string(payload), "project-embedding:"+target.ID+":"+model+":"+target.DescriptorHash)
		}
	case "tag":
		if activateNow {
			if _, err := tx.ExecContext(ctx, `UPDATE feed.tag_embeddings SET active=false WHERE tag_id=$1 AND active=true`, target.ID); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO feed.tag_embeddings
          (tag_id,model,dimensions,descriptor_hash,embedding,active)
          VALUES ($1,$2,$3,$4,$5::vector,$6)
          ON CONFLICT (tag_id,model,descriptor_hash) DO UPDATE SET embedding=excluded.embedding,dimensions=excluded.dimensions,active=excluded.active,generated_at=now()`,
			target.ID, model, len(embedding), target.DescriptorHash, vector, activateNow)
	default:
		return fmt.Errorf("unknown Feed embedding target kind %q", target.Kind)
	}
	if err != nil {
		return fmt.Errorf("save Feed embedding: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE feed.embedding_model_state SET building_model=$1,updated_at=now() WHERE singleton=true AND active_model<>$1`, model); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE feed.projection_failures SET resolved_at=now(),dead_lettered_at=NULL
	  WHERE projection=$1 AND source_ref=$2 AND source_hash=$3 AND resolved_at IS NULL`,
		"embedding:"+model, target.Kind+":"+target.ID, target.DescriptorHash); err != nil {
		return fmt.Errorf("resolve Feed embedding failure: %w", err)
	}
	return tx.Commit()
}

func (s *PostgresFeedStore) ActivateFeedEmbeddingModel(ctx context.Context, model string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext('ghfind-feed-embedding-activation'))`); err != nil {
		return false, err
	}
	var activeModel string
	if err := tx.QueryRowContext(ctx, `SELECT active_model FROM feed.embedding_model_state WHERE singleton=true FOR UPDATE`).Scan(&activeModel); err != nil {
		return false, err
	}
	if activeModel == model {
		return true, nil
	}
	var missingProjects, missingTags int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.projects p WHERE p.publishable=true AND NOT EXISTS (
	  SELECT 1 FROM feed.project_embeddings e WHERE e.repo_key=p.repo_key AND e.model=$1 AND e.descriptor_hash=p.descriptor_hash)`, model).Scan(&missingProjects); err != nil {
		return false, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.tag_definitions t WHERE t.status='canonical' AND NOT EXISTS (
	  SELECT 1 FROM feed.tag_embeddings e WHERE e.tag_id=t.id AND e.model=$1)`, model).Scan(&missingTags); err != nil {
		return false, err
	}
	if missingProjects+missingTags > 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE feed.embedding_model_state SET building_model=$1,updated_at=now() WHERE singleton=true`, model); err != nil {
			return false, err
		}
		return false, tx.Commit()
	}
	if _, err := tx.ExecContext(ctx, `UPDATE feed.project_embeddings SET active=false WHERE active=true`); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE feed.project_embeddings e SET active=true FROM feed.projects p
	  WHERE e.repo_key=p.repo_key AND e.model=$1 AND e.descriptor_hash=p.descriptor_hash`, model); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE feed.tag_embeddings SET active=false WHERE active=true`); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE feed.tag_embeddings SET active=true WHERE model=$1`, model); err != nil {
		return false, err
	}
	activationID, err := NewFeedID("embedding_activation")
	if err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE feed.embedding_model_state SET active_model=$1,building_model='',activated_at=now(),updated_at=now() WHERE singleton=true`, model); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE feed.users SET profile_version=profile_version+1,updated_at=now()`); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
	  SELECT repo_key,'feed.project-sync.v1',jsonb_build_object('repoKey',repo_key,'embeddingModel',$1::text),$2 || ':project:' || repo_key
	  FROM feed.projects`, model, activationID); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
	  SELECT 'gh:' || github_id,'feed.profile-rebuild.v1',jsonb_build_object('githubId',github_id,'embeddingModel',$1::text),$2 || ':user:' || github_id
	  FROM feed.users`, model, activationID); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *PostgresFeedStore) RecordFeedEmbeddingFailure(
	ctx context.Context,
	target FeedEmbeddingTarget,
	model string,
	failure error,
	now time.Time,
) (bool, error) {
	if failure == nil || target.DescriptorHash == "" {
		return false, fmt.Errorf("embedding failure and descriptor hash are required")
	}
	message := failure.Error()
	if len(message) > 1000 {
		message = message[:1000]
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback() //nolint:errcheck
	var attempts int
	err = tx.QueryRowContext(ctx, `INSERT INTO feed.projection_failures
	  (projection,source_ref,source_hash,error_code,error_message,attempts,first_failed_at,last_failed_at,available_at,resolved_at,dead_lettered_at)
	  VALUES ($1,$2,$3,'embedding_provider',$4,1,$5,$5,$5,NULL,NULL)
	  ON CONFLICT(projection,source_ref) DO UPDATE SET
	    source_hash=excluded.source_hash,error_code=excluded.error_code,error_message=excluded.error_message,
	    attempts=CASE WHEN feed.projection_failures.source_hash IS DISTINCT FROM excluded.source_hash THEN 1 ELSE feed.projection_failures.attempts+1 END,
	    first_failed_at=CASE WHEN feed.projection_failures.source_hash IS DISTINCT FROM excluded.source_hash THEN excluded.first_failed_at ELSE feed.projection_failures.first_failed_at END,
	    last_failed_at=excluded.last_failed_at,resolved_at=NULL,dead_lettered_at=NULL
	  RETURNING attempts`, "embedding:"+model, target.Kind+":"+target.ID, target.DescriptorHash, message, now).Scan(&attempts)
	if err != nil {
		return false, fmt.Errorf("record Feed embedding failure: %w", err)
	}
	delay := 30 * time.Second
	for retry := 1; retry < attempts && delay < 6*time.Hour; retry++ {
		delay *= 2
	}
	if delay > 6*time.Hour {
		delay = 6 * time.Hour
	}
	dead := attempts >= 8
	_, err = tx.ExecContext(ctx, `UPDATE feed.projection_failures SET available_at=$4,
	  dead_lettered_at=CASE WHEN $5 THEN $3::timestamptz ELSE NULL END
	  WHERE projection=$1 AND source_ref=$2`, "embedding:"+model, target.Kind+":"+target.ID, now, now.Add(delay), dead)
	if err != nil {
		return false, fmt.Errorf("schedule Feed embedding retry: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return dead, nil
}

func formatPGVector(vector []float64) string {
	parts := make([]string, len(vector))
	for index, value := range vector {
		parts[index] = strconv.FormatFloat(value, 'g', -1, 64)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func (s *PostgresFeedStore) ListPendingFeedProfiles(ctx context.Context, model string, limit int) ([]int64, error) {
	if limit < 1 || limit > 100 {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, `SELECT u.github_id FROM feed.users u
	      WHERE u.deleted_at IS NULL AND (u.embedding_profile_version <> u.profile_version OR u.embedding_model <> $1)
      ORDER BY u.updated_at,u.github_id LIMIT $2`, model, limit)
	if err != nil {
		return nil, fmt.Errorf("list pending Feed profiles: %w", err)
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *PostgresFeedStore) RebuildFeedUserProfile(ctx context.Context, githubID int64, model string, now time.Time) (bool, error) {
	var profileVersion int64
	if err := s.db.QueryRowContext(ctx, `SELECT profile_version FROM feed.users WHERE github_id=$1 AND deleted_at IS NULL`, githubID).Scan(&profileVersion); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	type weightedVector struct {
		vector []float64
		weight float64
	}
	signals := []weightedVector{}
	rows, err := s.db.QueryContext(ctx, `SELECT te.embedding::text,p.value*p.strength
      FROM feed.user_tag_preferences p JOIN feed.tag_embeddings te ON te.tag_id=p.tag_id AND te.model=$2 AND te.active=true
      WHERE p.github_id=$1`, githubID, model)
	if err != nil {
		return false, err
	}
	for rows.Next() {
		var raw string
		var weight float64
		if err := rows.Scan(&raw, &weight); err != nil {
			_ = rows.Close()
			return false, err
		}
		vector, parseErr := parsePGVector(raw)
		if parseErr == nil {
			signals = append(signals, weightedVector{vector, weight})
		}
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	rows, err = s.db.QueryContext(ctx, `SELECT pe.embedding::text,
        CASE WHEN ups.not_interested THEN -1.0 WHEN ups.saved THEN 0.75 ELSE 0 END
      FROM feed.user_project_state ups JOIN feed.project_embeddings pe ON pe.repo_key=ups.repo_key AND pe.model=$2 AND pe.active=true
      WHERE ups.github_id=$1 AND (ups.saved OR ups.not_interested)`, githubID, model)
	if err != nil {
		return false, err
	}
	for rows.Next() {
		var raw string
		var weight float64
		if err := rows.Scan(&raw, &weight); err != nil {
			_ = rows.Close()
			return false, err
		}
		vector, parseErr := parsePGVector(raw)
		if parseErr == nil {
			signals = append(signals, weightedVector{vector, weight})
		}
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	rows, err = s.db.QueryContext(ctx, `SELECT pe.embedding::text,e.event_type,e.occurred_at,e.metadata
      FROM feed.events e JOIN feed.project_embeddings pe ON pe.repo_key=e.repo_key AND pe.model=$2 AND pe.active=true
      WHERE e.github_id=$1 AND e.occurred_at >= $3 AND (e.event_type IN ('github_outbound','share')
        OR (e.event_type='dwell' AND COALESCE((e.metadata->>'qualified')::boolean,false)))`, githubID, model, now.Add(-365*24*time.Hour))
	if err != nil {
		return false, err
	}
	for rows.Next() {
		var raw, eventType string
		var occurred time.Time
		var metadata []byte
		if err := rows.Scan(&raw, &eventType, &occurred, &metadata); err != nil {
			_ = rows.Close()
			return false, err
		}
		base := .2
		if eventType == "github_outbound" || eventType == "share" {
			base = .5
		}
		weight := base * math.Pow(.5, math.Max(0, now.Sub(occurred).Hours())/(90*24))
		vector, parseErr := parsePGVector(raw)
		if parseErr == nil {
			signals = append(signals, weightedVector{vector, weight})
		}
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	if len(signals) == 0 {
		return s.markFeedProfileEmbeddingEmpty(ctx, githubID, profileVersion, model)
	}
	dimensions := len(signals[0].vector)
	combined := make([]float64, dimensions)
	for _, signal := range signals {
		if len(signal.vector) != dimensions {
			continue
		}
		for i, value := range signal.vector {
			combined[i] += signal.weight * value
		}
	}
	norm := 0.0
	for _, value := range combined {
		norm += value * value
	}
	norm = math.Sqrt(norm)
	if norm == 0 {
		return s.markFeedProfileEmbeddingEmpty(ctx, githubID, profileVersion, model)
	}
	for i := range combined {
		combined[i] /= norm
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err = tx.ExecContext(ctx, `UPDATE feed.user_profile_embeddings SET active=false WHERE github_id=$1 AND active=true`, githubID); err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO feed.user_profile_embeddings(github_id,model,dimensions,profile_version,embedding,active)
      SELECT $1,$2,$3,$4,$5::vector,true FROM feed.users WHERE github_id=$1 AND profile_version=$4
      ON CONFLICT (github_id,model,profile_version) DO UPDATE SET embedding=excluded.embedding,dimensions=excluded.dimensions,active=true,generated_at=now()`,
		githubID, model, dimensions, profileVersion, formatPGVector(combined))
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if count == 0 {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE feed.users SET embedding_profile_version=$2,embedding_model=$3 WHERE github_id=$1 AND profile_version=$2`, githubID, profileVersion, model); err != nil {
		return false, err
	}
	if err := queueFeedProfileProjection(ctx, tx, githubID, profileVersion, model); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *PostgresFeedStore) markFeedProfileEmbeddingEmpty(ctx context.Context, githubID, profileVersion int64, model string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.ExecContext(ctx, `UPDATE feed.user_profile_embeddings SET active=false WHERE github_id=$1 AND active=true`, githubID); err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE feed.users SET embedding_profile_version=$2,embedding_model=$3 WHERE github_id=$1 AND profile_version=$2`, githubID, profileVersion, model)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if count == 0 {
		return false, nil
	}
	if err := queueFeedProfileProjection(ctx, tx, githubID, profileVersion, model); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func queueFeedProfileProjection(ctx context.Context, tx *sql.Tx, githubID, profileVersion int64, model string) error {
	payload, _ := json.Marshal(map[string]any{"githubId": githubID, "profileVersion": profileVersion, "embeddingModel": model})
	_, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
	  VALUES ($1,'feed.profile-rebuild.v1',$2::jsonb,$3) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
		fmt.Sprintf("gh:%d", githubID), string(payload), fmt.Sprintf("profile-rebuild:%d:%s:%d", githubID, model, profileVersion))
	return err
}

type FeedEmbeddingWorker struct {
	store    FeedEmbeddingStore
	provider FeedEmbeddingProvider
	model    string
	log      *slog.Logger
}

func NewFeedEmbeddingWorker(store FeedEmbeddingStore, provider FeedEmbeddingProvider, model string, logger *slog.Logger) *FeedEmbeddingWorker {
	if logger == nil {
		logger = slog.Default()
	}
	return &FeedEmbeddingWorker{store: store, provider: provider, model: model, log: logger}
}

func (w *FeedEmbeddingWorker) Run(ctx context.Context) error {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		targets, err := w.store.ListPendingFeedEmbeddings(ctx, w.model, 20)
		if err != nil && ctx.Err() == nil {
			w.log.Error("list pending Feed embeddings", "error", err)
		}
		for _, target := range targets {
			vector, embedErr := w.provider.Embed(ctx, target.Descriptor)
			if embedErr != nil {
				dead, recordErr := w.store.RecordFeedEmbeddingFailure(ctx, target, w.model, embedErr, time.Now().UTC())
				w.log.Warn("generate Feed embedding", "kind", target.Kind, "id", target.ID, "dead_lettered", dead, "error", embedErr, "record_error", recordErr)
				break // avoid burning provider quota during an outage
			}
			if saveErr := w.store.SaveFeedEmbedding(ctx, target, w.model, vector); saveErr != nil {
				w.log.Error("save Feed embedding", "kind", target.Kind, "id", target.ID, "error", saveErr)
				break
			}
		}
		active, activationErr := w.store.ActivateFeedEmbeddingModel(ctx, w.model)
		if activationErr != nil && ctx.Err() == nil {
			w.log.Error("activate Feed embedding model", "model", w.model, "error", activationErr)
		}
		profiles := []int64{}
		var profileErr error
		if active {
			profiles, profileErr = w.store.ListPendingFeedProfiles(ctx, w.model, 20)
		}
		if profileErr != nil && ctx.Err() == nil {
			w.log.Error("list pending Feed profiles", "error", profileErr)
		}
		for _, githubID := range profiles {
			if _, rebuildErr := w.store.RebuildFeedUserProfile(ctx, githubID, w.model, time.Now().UTC()); rebuildErr != nil {
				w.log.Error("rebuild Feed profile embedding", "github_id", githubID, "error", rebuildErr)
				break
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

var _ FeedEmbeddingStore = (*PostgresFeedStore)(nil)
