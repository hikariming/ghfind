package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/rabbitmq/amqp091-go"
)

const (
	jobsExchange              = "ghfind.jobs.v1"
	deadLetterExchange        = "ghfind.jobs.dlx.v1"
	feedProjectionQueue       = "ghfind.feed-projection.v1"
	feedProjectionDeadQueue   = "ghfind.feed-projection.dead.v1"
	feedProjectionDeadKey     = "feed.projection.dead.v1"
	feedCatalogSyncKey        = "feed.catalog-sync.v1"
	feedCatalogSyncRetryKey   = "feed.catalog-sync.retry.v1"
	feedCatalogSyncDeadKey    = "feed.catalog-sync.dead.v1"
	feedCatalogSyncQueue      = "ghfind.feed-catalog-sync.v1"
	feedCatalogSyncRetryQueue = "ghfind.feed-catalog-sync.retry.v1"
	feedCatalogSyncDeadQueue  = "ghfind.feed-catalog-sync.dead.v1"
	// workerDeliveryTimeout bounds each retry/dead-letter publish so a stalled
	// broker cannot hold a delivery forever.
	workerDeliveryTimeout = 10 * time.Second
)

// FeedCatalogSyncJob is emitted only after the authoritative Turso analysis
// transaction commits. PostgreSQL projection is idempotent; RequestedAt and
// AnalysisID make retries auditable while the periodic sweep recovers a rare
// cross-database publish loss.
type FeedCatalogSyncJob struct {
	RepoKey     string `json:"repo_key"`
	AnalysisID  string `json:"analysis_id"`
	Attempt     int    `json:"attempt"`
	RequestedAt int64  `json:"requested_at"`
}

type FeedCatalogSyncPublisher interface {
	PublishFeedCatalogSync(context.Context, FeedCatalogSyncJob) error
	PublishFeedCatalogSyncRetry(context.Context, FeedCatalogSyncJob, time.Duration) error
	PublishFeedCatalogSyncDead(context.Context, FeedCatalogSyncJob, string) error
}

// RabbitPublisher opens a short-lived AMQP channel for each confirmed publish.
// AMQP channels are not safe for concurrent HTTP handlers, while a connection
// is; this keeps API admission correct under concurrent traffic.
type RabbitPublisher struct {
	url        string
	mu         sync.Mutex
	connection *amqp091.Connection
}

func OpenRabbitPublisher(url string) (*RabbitPublisher, error) {
	if url == "" {
		return nil, fmt.Errorf("RABBITMQ_URL is required")
	}
	publisher := &RabbitPublisher{url: url}
	channel, err := publisher.openChannel()
	if err != nil {
		return nil, err
	}
	_ = channel.Close()
	return publisher, nil
}

func (p *RabbitPublisher) Close() error {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.connection == nil || p.connection.IsClosed() {
		return nil
	}
	err := p.connection.Close()
	p.connection = nil
	return err
}

func (p *RabbitPublisher) Ping(ctx context.Context) error {
	channel, err := p.openChannel()
	if err != nil {
		return fmt.Errorf("open RabbitMQ health channel: %w", err)
	}
	defer channel.Close()
	return declareJobTopology(channel)
}

func (p *RabbitPublisher) PublishFeedCatalogSync(ctx context.Context, job FeedCatalogSyncJob) error {
	return p.publishConfirmed(ctx, jobsExchange, feedCatalogSyncKey, job.AnalysisID, job, "", nil)
}

func (p *RabbitPublisher) PublishFeedCatalogSyncRetry(ctx context.Context, job FeedCatalogSyncJob, delay time.Duration) error {
	if delay <= 0 {
		return fmt.Errorf("Feed catalog retry delay must be positive")
	}
	return p.publishConfirmed(ctx, jobsExchange, feedCatalogSyncRetryKey, job.AnalysisID, job,
		strconv.FormatInt(delay.Milliseconds(), 10), nil)
}

func (p *RabbitPublisher) PublishFeedCatalogSyncDead(ctx context.Context, job FeedCatalogSyncJob, reason string) error {
	return p.publishConfirmed(ctx, deadLetterExchange, feedCatalogSyncDeadKey, job.AnalysisID, job, "",
		amqp091.Table{"x-ghfind-failure": reason})
}

func (p *RabbitPublisher) PublishFeedOutbox(ctx context.Context, message FeedOutboxMessage) error {
	if err := validateFeedOutboxTopic(message.Topic); err != nil {
		return err
	}
	return p.publishConfirmed(ctx, jobsExchange, message.Topic, fmt.Sprintf("feed-outbox-%d", message.ID),
		json.RawMessage(message.Payload), "", amqp091.Table{"x-ghfind-aggregate": message.AggregateKey})
}

// publishConfirmed opens a short-lived channel, declares the topology, and
// waits for the broker confirm so a caller never reports a queued job the
// broker did not durably accept.
func (p *RabbitPublisher) publishConfirmed(
	ctx context.Context,
	exchange, routingKey, messageID string,
	job any,
	expiration string,
	headers amqp091.Table,
) error {
	body, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshal job: %w", err)
	}
	channel, err := p.openChannel()
	if err != nil {
		return fmt.Errorf("open RabbitMQ publish channel: %w", err)
	}
	defer channel.Close()
	if err := declareJobTopology(channel); err != nil {
		return err
	}
	if err := channel.Confirm(false); err != nil {
		return fmt.Errorf("enable RabbitMQ publisher confirms: %w", err)
	}
	confirmations := channel.NotifyPublish(make(chan amqp091.Confirmation, 1))
	if err := channel.PublishWithContext(ctx, exchange, routingKey, false, false, amqp091.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp091.Persistent,
		MessageId:    messageID,
		Timestamp:    time.Now().UTC(),
		Expiration:   expiration,
		Headers:      headers,
		Body:         body,
	}); err != nil {
		return fmt.Errorf("publish RabbitMQ job: %w", err)
	}
	select {
	case confirmation, open := <-confirmations:
		if !open || !confirmation.Ack {
			return fmt.Errorf("RabbitMQ did not confirm job publish")
		}
		return nil
	case <-ctx.Done():
		return fmt.Errorf("wait for RabbitMQ confirmation: %w", ctx.Err())
	}
}

// openChannel lazily reconnects after a broker restart. A broken API-side
// publisher must recover on the next request rather than remain permanently
// unready until its container happens to be recycled.
func (p *RabbitPublisher) openChannel() (*amqp091.Channel, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.connection == nil || p.connection.IsClosed() {
		connection, err := amqp091.Dial(p.url)
		if err != nil {
			return nil, fmt.Errorf("dial RabbitMQ: %w", err)
		}
		p.connection = connection
	}
	channel, err := p.connection.Channel()
	if err != nil {
		_ = p.connection.Close()
		p.connection = nil
		return nil, fmt.Errorf("open RabbitMQ channel: %w", err)
	}
	return channel, nil
}

func declareJobTopology(channel *amqp091.Channel) error {
	if err := channel.ExchangeDeclare(jobsExchange, amqp091.ExchangeDirect, true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare jobs exchange: %w", err)
	}
	if err := channel.ExchangeDeclare(deadLetterExchange, amqp091.ExchangeDirect, true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare dead-letter exchange: %w", err)
	}
	if _, err := channel.QueueDeclare(feedProjectionQueue, true, false, false, false, amqp091.Table{
		"x-dead-letter-exchange": deadLetterExchange, "x-dead-letter-routing-key": feedProjectionDeadKey,
	}); err != nil {
		return fmt.Errorf("declare Feed projection queue: %w", err)
	}
	for _, routingKey := range []string{"feed.event-project.v1", "feed.project-sync.v1", "feed.profile-rebuild.v1", "feed.user-delete.v1", "feed.gorse-shadow-request.v1"} {
		if err := channel.QueueBind(feedProjectionQueue, routingKey, jobsExchange, false, nil); err != nil {
			return fmt.Errorf("bind Feed projection queue for %s: %w", routingKey, err)
		}
	}
	if _, err := channel.QueueDeclare(feedProjectionDeadQueue, true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare Feed projection dead queue: %w", err)
	}
	if err := channel.QueueBind(feedProjectionDeadQueue, feedProjectionDeadKey, deadLetterExchange, false, nil); err != nil {
		return fmt.Errorf("bind Feed projection dead queue: %w", err)
	}
	if _, err := channel.QueueDeclare(feedCatalogSyncQueue, true, false, false, false, amqp091.Table{
		"x-dead-letter-exchange": deadLetterExchange, "x-dead-letter-routing-key": feedCatalogSyncDeadKey,
	}); err != nil {
		return fmt.Errorf("declare Feed catalog sync queue: %w", err)
	}
	if err := channel.QueueBind(feedCatalogSyncQueue, feedCatalogSyncKey, jobsExchange, false, nil); err != nil {
		return fmt.Errorf("bind Feed catalog sync queue: %w", err)
	}
	if _, err := channel.QueueDeclare(feedCatalogSyncRetryQueue, true, false, false, false, amqp091.Table{
		"x-dead-letter-exchange": jobsExchange, "x-dead-letter-routing-key": feedCatalogSyncKey,
	}); err != nil {
		return fmt.Errorf("declare Feed catalog sync retry queue: %w", err)
	}
	if err := channel.QueueBind(feedCatalogSyncRetryQueue, feedCatalogSyncRetryKey, jobsExchange, false, nil); err != nil {
		return fmt.Errorf("bind Feed catalog sync retry queue: %w", err)
	}
	if _, err := channel.QueueDeclare(feedCatalogSyncDeadQueue, true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare Feed catalog sync dead queue: %w", err)
	}
	if err := channel.QueueBind(feedCatalogSyncDeadQueue, feedCatalogSyncDeadKey, deadLetterExchange, false, nil); err != nil {
		return fmt.Errorf("bind Feed catalog sync dead queue: %w", err)
	}
	return nil
}

func retryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := 2 * time.Second
	for i := 1; i < attempt && delay < 2*time.Minute; i++ {
		delay *= 2
	}
	if delay > 2*time.Minute {
		return 2 * time.Minute
	}
	return delay
}
