package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

type FeedRetentionResult struct{ Events, Requests, Outbox int64 }

type FeedShadowEvaluationResult struct {
	Evaluated     int
	WithPositives int
	RecallSum     float64
}

type FeedOperationalSnapshot struct {
	ProjectionLags map[string]time.Duration
	RecentOrphans  int64
	GorseOverlap   *float64
}

func (s *PostgresFeedStore) ReadFeedOperationalSnapshot(ctx context.Context, now time.Time) (FeedOperationalSnapshot, error) {
	snapshot := FeedOperationalSnapshot{ProjectionLags: map[string]time.Duration{}}
	rows, err := s.db.QueryContext(ctx, `SELECT projection,source_timestamp FROM feed.projection_cursors WHERE source_timestamp IS NOT NULL`)
	if err != nil {
		return snapshot, err
	}
	for rows.Next() {
		var projection string
		var sourceTime time.Time
		if err := rows.Scan(&projection, &sourceTime); err != nil {
			_ = rows.Close()
			return snapshot, err
		}
		snapshot.ProjectionLags[projection] = now.Sub(sourceTime)
	}
	if err := rows.Close(); err != nil {
		return snapshot, err
	}
	if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(invalid_items),0) FROM feed.gorse_shadow_results WHERE created_at >= $1`,
		now.Add(-24*time.Hour)).Scan(&snapshot.RecentOrphans); err != nil {
		return snapshot, err
	}
	var overlap float64
	err = s.db.QueryRowContext(ctx, `SELECT overlap_ratio FROM feed.gorse_shadow_results
	  WHERE error_code IS NULL ORDER BY created_at DESC LIMIT 1`).Scan(&overlap)
	if err == nil {
		snapshot.GorseOverlap = &overlap
	} else if !errors.Is(err, sql.ErrNoRows) {
		return snapshot, err
	}
	return snapshot, nil
}

// EvaluateGorseShadowOutcomes closes a configured outcome window before
// computing Recall@50. A short window is appropriate for early, session-level
// product feedback; recording the exact window keeps later comparisons honest.
func (s *PostgresFeedStore) EvaluateGorseShadowOutcomes(ctx context.Context, now time.Time, outcomeWindow time.Duration, limit int) (FeedShadowEvaluationResult, error) {
	if outcomeWindow < minFeedShadowOutcomeWindow || outcomeWindow > maxFeedShadowOutcomeWindow {
		outcomeWindow = defaultFeedShadowOutcomeWindow
	}
	if limit < 1 || limit > 1000 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, `SELECT g.request_id,g.item_ids,r.github_id,r.created_at
	  FROM feed.gorse_shadow_results g JOIN feed.requests r ON r.id=g.request_id
	  WHERE g.evaluated_at IS NULL AND r.created_at <= $1
	  ORDER BY r.created_at,g.request_id LIMIT $2`, now.Add(-outcomeWindow), limit)
	if err != nil {
		return FeedShadowEvaluationResult{}, fmt.Errorf("list Gorse shadow evaluations: %w", err)
	}
	type pending struct {
		requestID string
		itemIDs   []string
		githubID  int64
		createdAt time.Time
	}
	items := []pending{}
	for rows.Next() {
		var item pending
		var raw []byte
		if err := rows.Scan(&item.requestID, &raw, &item.githubID, &item.createdAt); err != nil {
			_ = rows.Close()
			return FeedShadowEvaluationResult{}, err
		}
		if err := json.Unmarshal(raw, &item.itemIDs); err != nil {
			_ = rows.Close()
			return FeedShadowEvaluationResult{}, fmt.Errorf("decode Gorse shadow items: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Close(); err != nil {
		return FeedShadowEvaluationResult{}, err
	}
	result := FeedShadowEvaluationResult{}
	for _, item := range items {
		positiveRows, err := s.db.QueryContext(ctx, `SELECT DISTINCT p.item_id
		  FROM feed.events e JOIN feed.projects p ON p.repo_key=e.repo_key
		  WHERE e.github_id=$1 AND e.occurred_at >= $2 AND e.occurred_at < $3 AND (
		    e.event_type IN ('save','github_outbound','share') OR
		    (e.event_type='dwell' AND COALESCE((e.metadata->>'qualified')::boolean,false)))`,
			item.githubID, item.createdAt, item.createdAt.Add(outcomeWindow))
		if err != nil {
			return result, err
		}
		positives := map[string]bool{}
		for positiveRows.Next() {
			var id string
			if err := positiveRows.Scan(&id); err != nil {
				_ = positiveRows.Close()
				return result, err
			}
			positives[id] = true
		}
		if err := positiveRows.Close(); err != nil {
			return result, err
		}
		var recall any
		if len(positives) > 0 {
			matched := 0
			for _, id := range item.itemIDs[:minInt(50, len(item.itemIDs))] {
				if positives[id] {
					matched++
				}
			}
			value := float64(matched) / float64(len(positives))
			recall = value
			result.WithPositives++
			result.RecallSum += value
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE feed.gorse_shadow_results SET held_out_positives=$2,
		  recall_at_50=$3,evaluated_at=$4,evaluation_window_seconds=$5
		  WHERE request_id=$1 AND evaluated_at IS NULL`,
			item.requestID, len(positives), recall, now, int64(outcomeWindow/time.Second)); err != nil {
			return result, err
		}
		result.Evaluated++
	}
	return result, nil
}

func (s *PostgresFeedStore) PruneFeedRetention(ctx context.Context, now time.Time) (FeedRetentionResult, error) {
	result := FeedRetentionResult{}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback() //nolint:errcheck
	events, err := tx.ExecContext(ctx, `DELETE FROM feed.events WHERE received_at < $1`, now.Add(-180*24*time.Hour))
	if err != nil {
		return result, fmt.Errorf("prune Feed events: %w", err)
	}
	result.Events, _ = events.RowsAffected()
	requests, err := tx.ExecContext(ctx, `DELETE FROM feed.requests WHERE created_at < $1`, now.Add(-90*24*time.Hour))
	if err != nil {
		return result, fmt.Errorf("prune Feed requests: %w", err)
	}
	result.Requests, _ = requests.RowsAffected()
	outbox, err := tx.ExecContext(ctx, `DELETE FROM feed.event_outbox WHERE delivered_at IS NOT NULL AND delivered_at < $1`, now.Add(-7*24*time.Hour))
	if err != nil {
		return result, fmt.Errorf("prune Feed outbox: %w", err)
	}
	result.Outbox, _ = outbox.RowsAffected()
	if err := tx.Commit(); err != nil {
		return FeedRetentionResult{}, err
	}
	return result, nil
}

type FeedMaintenanceWorker struct {
	store         *PostgresFeedStore
	log           *slog.Logger
	now           func() time.Time
	metrics       *BackendMetrics
	outcomeWindow time.Duration
}

func (w *FeedMaintenanceWorker) UseMetrics(metrics *BackendMetrics) *FeedMaintenanceWorker {
	w.metrics = metrics
	return w
}

func (w *FeedMaintenanceWorker) UseShadowOutcomeWindow(window time.Duration) *FeedMaintenanceWorker {
	if window >= minFeedShadowOutcomeWindow && window <= maxFeedShadowOutcomeWindow {
		w.outcomeWindow = window
	}
	return w
}

func NewFeedMaintenanceWorker(store *PostgresFeedStore, logger *slog.Logger) *FeedMaintenanceWorker {
	if logger == nil {
		logger = slog.Default()
	}
	return &FeedMaintenanceWorker{store: store, log: logger, now: time.Now, outcomeWindow: defaultFeedShadowOutcomeWindow}
}
func (w *FeedMaintenanceWorker) Run(ctx context.Context) error {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		operational, operationalErr := w.store.ReadFeedOperationalSnapshot(ctx, w.now().UTC())
		if operationalErr != nil && ctx.Err() == nil {
			w.log.Error("read Feed operational metrics", "error", operationalErr)
		} else if operationalErr == nil {
			for projection, lag := range operational.ProjectionLags {
				w.metrics.recordFeedProjectionLag(projection, lag)
			}
			w.metrics.recordFeedCatalogOrphans(operational.RecentOrphans)
			if operational.GorseOverlap != nil {
				w.metrics.recordGorseOverlap(*operational.GorseOverlap)
			}
		}
		evaluation, evaluationErr := w.store.EvaluateGorseShadowOutcomes(ctx, w.now().UTC(), w.outcomeWindow, 200)
		if evaluationErr != nil && ctx.Err() == nil {
			w.log.Error("Gorse shadow outcome evaluation failed", "error", evaluationErr)
		} else if evaluation.Evaluated > 0 {
			w.log.Info("Gorse shadow outcomes evaluated", "evaluated", evaluation.Evaluated,
				"with_positives", evaluation.WithPositives, "recall_at_50_sum", evaluation.RecallSum)
		}
		result, err := w.store.PruneFeedRetention(ctx, w.now().UTC())
		if err != nil && ctx.Err() == nil {
			w.log.Error("Feed retention cleanup failed", "error", err)
		} else if err == nil {
			w.log.Info("Feed retention cleanup completed", "events", result.Events, "requests", result.Requests, "outbox", result.Outbox)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
