package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

type FeedOutboxMessage struct {
	ID           int64
	AggregateKey string
	Topic        string
	Payload      json.RawMessage
	Attempts     int
}

type FeedOutboxStore interface {
	ClaimFeedOutbox(context.Context, string, int, time.Duration) ([]FeedOutboxMessage, error)
	CompleteFeedOutbox(context.Context, int64, string) error
	FailFeedOutbox(context.Context, int64, string, string, time.Time) error
}

type FeedOutboxPublisher interface {
	PublishFeedOutbox(context.Context, FeedOutboxMessage) error
}

func (s *PostgresFeedStore) ClaimFeedOutbox(ctx context.Context, worker string, limit int, lease time.Duration) ([]FeedOutboxMessage, error) {
	if limit < 1 || limit > 500 {
		limit = 100
	}
	if lease < 5*time.Second {
		lease = 30 * time.Second
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	rows, err := tx.QueryContext(ctx, `WITH claimed AS (
        SELECT id FROM feed.event_outbox
        WHERE delivered_at IS NULL AND available_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1
      )
      UPDATE feed.event_outbox o SET locked_by=$2, locked_until=now()+($3 * interval '1 millisecond'),
        attempts=o.attempts+1
      FROM claimed WHERE o.id=claimed.id
      RETURNING o.id,o.aggregate_key,o.topic,o.payload,o.attempts`, limit, worker, lease.Milliseconds())
	if err != nil {
		return nil, fmt.Errorf("claim Feed outbox: %w", err)
	}
	messages := []FeedOutboxMessage{}
	for rows.Next() {
		var message FeedOutboxMessage
		var payload []byte
		if err := rows.Scan(&message.ID, &message.AggregateKey, &message.Topic, &payload, &message.Attempts); err != nil {
			_ = rows.Close()
			return nil, err
		}
		message.Payload = append(json.RawMessage(nil), payload...)
		messages = append(messages, message)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return messages, nil
}

func (s *PostgresFeedStore) CompleteFeedOutbox(ctx context.Context, id int64, worker string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE feed.event_outbox SET delivered_at=now(),
      locked_by=NULL,locked_until=NULL,last_error=NULL WHERE id=$1 AND locked_by=$2 AND delivered_at IS NULL`, id, worker)
	if err != nil {
		return fmt.Errorf("complete Feed outbox: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows != 1 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *PostgresFeedStore) FailFeedOutbox(ctx context.Context, id int64, worker, failure string, retryAt time.Time) error {
	if len(failure) > 1000 {
		failure = failure[:1000]
	}
	_, err := s.db.ExecContext(ctx, `UPDATE feed.event_outbox SET available_at=$3,
      locked_by=NULL,locked_until=NULL,last_error=$4 WHERE id=$1 AND locked_by=$2 AND delivered_at IS NULL`,
		id, worker, retryAt, failure)
	return err
}

type FeedOutboxRelay struct {
	store     FeedOutboxStore
	publisher FeedOutboxPublisher
	workerID  string
	log       *slog.Logger
	now       func() time.Time
}

func NewFeedOutboxRelay(store FeedOutboxStore, publisher FeedOutboxPublisher, logger *slog.Logger) (*FeedOutboxRelay, error) {
	id, err := NewFeedID("outbox")
	if err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &FeedOutboxRelay{store: store, publisher: publisher, workerID: id, log: logger, now: time.Now}, nil
}

func (r *FeedOutboxRelay) RelayOnce(ctx context.Context) (int, error) {
	messages, err := r.store.ClaimFeedOutbox(ctx, r.workerID, 100, 30*time.Second)
	if err != nil {
		return 0, err
	}
	delivered := 0
	for _, message := range messages {
		if err := validateFeedOutboxTopic(message.Topic); err != nil {
			_ = r.store.FailFeedOutbox(ctx, message.ID, r.workerID, err.Error(), r.now().UTC().Add(24*time.Hour))
			r.log.Error("invalid Feed outbox topic", "id", message.ID, "topic", message.Topic)
			continue
		}
		if err := r.publisher.PublishFeedOutbox(ctx, message); err != nil {
			delay := retryDelay(message.Attempts)
			_ = r.store.FailFeedOutbox(ctx, message.ID, r.workerID, err.Error(), r.now().UTC().Add(delay))
			continue
		}
		if err := r.store.CompleteFeedOutbox(ctx, message.ID, r.workerID); err != nil {
			return delivered, err
		}
		delivered++
	}
	return delivered, nil
}

func (r *FeedOutboxRelay) Run(ctx context.Context) error {
	// Five seconds still keeps normal projection lag well under the five-minute
	// SLO while avoiding a one-log-per-second loop during a Feed PostgreSQL
	// outage. Original worker consumers run in independent goroutines.
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if _, err := r.RelayOnce(ctx); err != nil && ctx.Err() == nil {
			r.log.Error("Feed outbox relay failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func validateFeedOutboxTopic(topic string) error {
	switch strings.TrimSpace(topic) {
	case "feed.event-project.v1", "feed.project-sync.v1", "feed.profile-rebuild.v1", "feed.user-delete.v1", "feed.gorse-shadow-request.v1":
		return nil
	default:
		return fmt.Errorf("unsupported Feed outbox topic %q", topic)
	}
}

var _ FeedOutboxStore = (*PostgresFeedStore)(nil)
