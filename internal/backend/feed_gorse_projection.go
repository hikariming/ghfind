package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/rabbitmq/amqp091-go"
)

type FeedGorseProjectionStore interface {
	GetFeedProjectForGorse(context.Context, string) (*FeedProject, []float64, error)
	GetFeedUserForGorse(context.Context, int64) (*FeedUser, error)
	SaveGorseShadowResult(context.Context, string, []string, time.Duration, string) error
	MarkGorseUserDeleted(context.Context, string) error
}

func (s *PostgresFeedStore) MarkGorseUserDeleted(ctx context.Context, deletionID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM feed.user_deletion_tombstones WHERE deletion_id=$1`, deletionID)
	return err
}

func (s *PostgresFeedStore) GetFeedProjectForGorse(ctx context.Context, repoKey string) (*FeedProject, []float64, error) {
	var project FeedProject
	var language, topics, embedding sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT p.repo_key,p.item_id,p.owner_login,p.name,p.canonical_url,p.summary,
      p.language,p.topics,p.project_type,p.lifecycle,p.product_score,p.confidence,p.verification_level,
      p.exposure_band,p.treasure_eligible,p.classic_eligible,p.analyzed_at,p.publishable,pe.embedding::text
      FROM feed.projects p LEFT JOIN feed.project_embeddings pe ON pe.repo_key=p.repo_key AND pe.active=true
      WHERE p.repo_key=$1`, strings.ToLower(repoKey)).Scan(&project.RepoKey, &project.ItemID, &project.OwnerLogin, &project.Name,
		&project.CanonicalURL, &project.Summary, &language, &topics, &project.ProjectType, &project.Lifecycle, &project.ProductScore,
		&project.Confidence, &project.VerificationLevel, &project.ExposureBand, &project.TreasureEligible, &project.ClassicEligible,
		&project.AnalyzedAt, &project.Publishable, &embedding)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if language.Valid {
		project.Language = &language.String
	}
	project.Topics = []string{}
	if topics.Valid {
		_ = json.Unmarshal([]byte(topics.String), &project.Topics)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT td.id,td.namespace,td.slug,td.label_zh,td.label_en,td.description,pt.weight,pt.confidence,pt.taxonomy_version
      FROM feed.project_tags pt JOIN feed.tag_definitions td ON td.id=pt.tag_id
      WHERE pt.repo_key=$1 AND td.status='canonical' ORDER BY td.namespace,td.slug`, project.RepoKey)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var tag FeedTag
		if err := rows.Scan(&tag.ID, &tag.Namespace, &tag.Slug, &tag.LabelZH, &tag.LabelEN, &tag.Description, &tag.Weight, &tag.Confidence, &tag.TaxonomyVersion); err != nil {
			return nil, nil, err
		}
		project.Tags = append(project.Tags, tag)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var vector []float64
	if embedding.Valid {
		vector, _ = parsePGVector(embedding.String)
	}
	return &project, vector, nil
}

func (s *PostgresFeedStore) GetFeedUserForGorse(ctx context.Context, githubID int64) (*FeedUser, error) {
	return s.GetFeedUser(ctx, githubID)
}

func (s *PostgresFeedStore) SaveGorseShadowResult(ctx context.Context, requestID string, itemIDs []string, duration time.Duration, errorCode string) error {
	baselineRows, err := s.db.QueryContext(ctx, `SELECT p.item_id FROM feed.served_items si JOIN feed.projects p ON p.repo_key=si.repo_key
      WHERE si.request_id=$1 ORDER BY si.rank LIMIT 100`, requestID)
	if err != nil {
		return err
	}
	baseline := map[string]bool{}
	for baselineRows.Next() {
		var id string
		if err := baselineRows.Scan(&id); err != nil {
			_ = baselineRows.Close()
			return err
		}
		baseline[id] = true
	}
	if err := baselineRows.Close(); err != nil {
		return err
	}
	valid := []string{}
	invalid := 0
	overlap := 0
	for _, id := range uniqueStrings(itemIDs) {
		var publishable bool
		err := s.db.QueryRowContext(ctx, `SELECT publishable FROM feed.projects WHERE item_id=$1`, id).Scan(&publishable)
		if err != nil || !publishable {
			invalid++
			continue
		}
		valid = append(valid, id)
		if baseline[id] {
			overlap++
		}
	}
	ratio := 0.0
	if len(baseline) > 0 {
		ratio = float64(overlap) / float64(len(baseline))
	}
	encoded, _ := json.Marshal(valid)
	var nullableError any
	if errorCode != "" {
		nullableError = errorCode
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO feed.gorse_shadow_results(request_id,item_ids,duration_ms,invalid_items,overlap_ratio,error_code)
      VALUES ($1,$2::jsonb,$3,$4,$5,$6) ON CONFLICT(request_id) DO UPDATE SET item_ids=excluded.item_ids,
      duration_ms=excluded.duration_ms,invalid_items=excluded.invalid_items,overlap_ratio=excluded.overlap_ratio,error_code=excluded.error_code,created_at=now()`,
		requestID, string(encoded), duration.Milliseconds(), invalid, ratio, nullableError)
	return err
}

type FeedGorseProjectionWorker struct {
	config  Config
	store   FeedGorseProjectionStore
	gorse   FeedGorseClient
	log     *slog.Logger
	metrics *BackendMetrics
}

func (w *FeedGorseProjectionWorker) UseMetrics(metrics *BackendMetrics) *FeedGorseProjectionWorker {
	w.metrics = metrics
	return w
}

func NewFeedGorseProjectionWorker(config Config, store FeedGorseProjectionStore, gorse FeedGorseClient, logger *slog.Logger) *FeedGorseProjectionWorker {
	if logger == nil {
		logger = slog.Default()
	}
	return &FeedGorseProjectionWorker{config: config, store: store, gorse: gorse, log: logger}
}

func (w *FeedGorseProjectionWorker) Run(ctx context.Context) error {
	connection, err := amqp091.Dial(w.config.RabbitURL)
	if err != nil {
		return fmt.Errorf("dial RabbitMQ for Gorse projection: %w", err)
	}
	defer connection.Close()
	channel, err := connection.Channel()
	if err != nil {
		return err
	}
	defer channel.Close()
	if err := declareJobTopology(channel); err != nil {
		return err
	}
	if err := channel.Qos(16, 0, false); err != nil {
		return err
	}
	deliveries, err := channel.Consume(feedProjectionQueue, "", false, false, false, false, nil)
	if err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case delivery, open := <-deliveries:
			if !open {
				return fmt.Errorf("Feed Gorse projection delivery channel closed")
			}
			if err := w.handle(ctx, delivery); err != nil {
				w.log.Warn("Gorse projection failed; requeueing", "topic", delivery.RoutingKey, "error", err)
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(2 * time.Second):
				}
				_ = delivery.Nack(false, true)
			} else {
				_ = delivery.Ack(false)
			}
		}
	}
}

func (w *FeedGorseProjectionWorker) handle(ctx context.Context, delivery amqp091.Delivery) error {
	// Baseline mode still drains the durable projection queue so it cannot grow
	// without bound before Gorse is enabled. A later, explicit full rebuild
	// replays all current business facts into a fresh Gorse database.
	if w.gorse == nil {
		switch delivery.RoutingKey {
		case "feed.project-sync.v1", "feed.profile-rebuild.v1", "feed.event-project.v1", "feed.user-delete.v1":
			return nil
		case "feed.gorse-shadow-request.v1":
			var payload struct {
				RequestID string `json:"requestId"`
			}
			if err := json.Unmarshal(delivery.Body, &payload); err != nil {
				return err
			}
			if payload.RequestID == "" {
				return fmt.Errorf("Gorse shadow request id is required")
			}
			// Record a bounded degraded outcome and acknowledge it. Requeueing a
			// shadow-only request while Gorse is deliberately disabled would make
			// an optional recommender create an infinite RabbitMQ hot loop.
			return w.store.SaveGorseShadowResult(ctx, payload.RequestID, nil, 0, "gorse_unavailable")
		default:
			return fmt.Errorf("unknown Feed projection topic %q", delivery.RoutingKey)
		}
	}
	switch delivery.RoutingKey {
	case "feed.project-sync.v1":
		var payload struct {
			RepoKey string `json:"repoKey"`
		}
		if err := json.Unmarshal(delivery.Body, &payload); err != nil {
			return err
		}
		project, embedding, err := w.store.GetFeedProjectForGorse(ctx, payload.RepoKey)
		if err != nil {
			return err
		}
		if project == nil {
			return nil
		}
		return w.gorse.UpsertItem(ctx, FeedGorseItem(*project, embedding))
	case "feed.profile-rebuild.v1":
		var payload struct {
			GitHubID int64 `json:"githubId"`
		}
		if err := json.Unmarshal(delivery.Body, &payload); err != nil {
			return err
		}
		return w.upsertGorseUser(ctx, payload.GitHubID)
	case "feed.event-project.v1":
		var payload struct {
			GitHubID   int64          `json:"githubId"`
			RepoKey    string         `json:"repoKey"`
			Type       FeedEventType  `json:"type"`
			OccurredAt time.Time      `json:"occurredAt"`
			Metadata   map[string]any `json:"metadata"`
		}
		if err := json.Unmarshal(delivery.Body, &payload); err != nil {
			return err
		}
		if payload.Type == FeedEventUnsave || payload.Type == FeedEventUndoNotInterested {
			feedbackType := "save"
			if payload.Type == FeedEventUndoNotInterested {
				feedbackType = "not_interested"
			}
			project, _, err := w.store.GetFeedProjectForGorse(ctx, payload.RepoKey)
			if err != nil || project == nil {
				return err
			}
			return w.gorse.DeleteFeedback(ctx, feedbackType, FeedGorseUserID(payload.GitHubID), project.ItemID)
		}
		feedbackType, value := gorseFeedbackType(payload.Type, payload.Metadata)
		if feedbackType == "" {
			return nil
		}
		if err := w.upsertGorseUser(ctx, payload.GitHubID); err != nil {
			return err
		}
		project, embedding, err := w.store.GetFeedProjectForGorse(ctx, payload.RepoKey)
		if err != nil {
			return err
		}
		if project == nil {
			return nil
		}
		if err := w.gorse.UpsertItem(ctx, FeedGorseItem(*project, embedding)); err != nil {
			return err
		}
		return w.gorse.PutFeedback(ctx, []GorseFeedback{{FeedbackType: feedbackType, UserID: FeedGorseUserID(payload.GitHubID), ItemID: project.ItemID, Value: value, Timestamp: payload.OccurredAt}})
	case "feed.user-delete.v1":
		var payload struct {
			DeletionID  string `json:"deletionId"`
			GorseUserID string `json:"gorseUserId"`
		}
		if err := json.Unmarshal(delivery.Body, &payload); err != nil {
			return err
		}
		if err := w.gorse.DeleteUser(ctx, payload.GorseUserID); err != nil {
			return err
		}
		return w.store.MarkGorseUserDeleted(ctx, payload.DeletionID)
	case "feed.gorse-shadow-request.v1":
		var payload struct {
			RequestID string `json:"requestId"`
			GitHubID  int64  `json:"githubId"`
		}
		if err := json.Unmarshal(delivery.Body, &payload); err != nil {
			return err
		}
		started := time.Now()
		ids, err := w.gorse.Recommend(ctx, FeedGorseUserID(payload.GitHubID), 100)
		if err != nil {
			_ = w.store.SaveGorseShadowResult(ctx, payload.RequestID, nil, time.Since(started), "gorse_unavailable")
			w.metrics.recordGorseShadow(time.Since(started), -1, "error")
			return err
		}
		duration := time.Since(started)
		err = w.store.SaveGorseShadowResult(ctx, payload.RequestID, ids, duration, "")
		if err == nil {
			w.metrics.recordGorseShadow(duration, -1, "ok")
		}
		return err
	default:
		return fmt.Errorf("unknown Feed projection topic %q", delivery.RoutingKey)
	}
}

func (w *FeedGorseProjectionWorker) upsertGorseUser(ctx context.Context, githubID int64) error {
	user, err := w.store.GetFeedUserForGorse(ctx, githubID)
	if err != nil {
		return err
	}
	if user == nil {
		return nil
	}
	tags := []string{}
	for _, preference := range user.Preferences {
		if preference.Value > 0 {
			tags = append(tags, preference.TagID)
		}
	}
	return w.gorse.UpsertUser(ctx, GorseUser{UserID: FeedGorseUserID(githubID), Labels: map[string]any{"tags": uniqueStrings(tags), "embedding": user.Embedding}, Comment: user.Login})
}

func gorseFeedbackType(eventType FeedEventType, metadata map[string]any) (string, float64) {
	switch eventType {
	case FeedEventImpression:
		return "impression", 1
	case FeedEventSave:
		return "save", 1
	case FeedEventGitHubOutbound:
		return "github_outbound", 1
	case FeedEventShare:
		return "share", 1
	case FeedEventNotInterested:
		return "not_interested", -1
	case FeedEventDwell:
		if qualified, _ := metadata["qualified"].(bool); qualified {
			return "qualified_view", 1
		}
	}
	return "", 0
}

var _ FeedGorseProjectionStore = (*PostgresFeedStore)(nil)

func gorseGitHubID(value string) (int64, error) {
	raw := strings.TrimPrefix(value, "gh:")
	return strconv.ParseInt(raw, 10, 64)
}
