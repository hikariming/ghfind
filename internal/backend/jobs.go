package backend

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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
	scoreSnapshotRoutingKey   = "score.snapshot.v1"
	scoreSnapshotRetryKey     = "score.snapshot.retry.v1"
	scoreSnapshotDeadKey      = "score.snapshot.dead.v1"
	scoreSnapshotQueue        = "ghfind.score-snapshot.v1"
	scoreSnapshotRetryQueue   = "ghfind.score-snapshot.retry.v1"
	scoreSnapshotDeadQueue    = "ghfind.score-snapshot.dead.v1"
	ScoreSnapshotJobKind      = "score_snapshot.v1"
	scanRoutingKey            = "scan.quick.v1"
	scanRetryKey              = "scan.quick.retry.v1"
	scanDeadKey               = "scan.quick.dead.v1"
	scanQueue                 = "ghfind.scan.quick.v1"
	scanRetryQueue            = "ghfind.scan.quick.retry.v1"
	scanDeadQueue             = "ghfind.scan.quick.dead.v1"
	ScanJobKind               = "scan.quick.v1"
	projectAnalysisKey        = "project-analysis.v1"
	projectAnalysisRetryKey   = "project-analysis.retry.v1"
	projectAnalysisDeadKey    = "project-analysis.dead.v1"
	projectAnalysisQueue      = "ghfind.project-analysis.v1"
	projectAnalysisRetryQueue = "ghfind.project-analysis.retry.v1"
	projectAnalysisDeadQueue  = "ghfind.project-analysis.dead.v1"
	ProjectAnalysisJobKind    = "project-analysis.v1"
)

// ScoreSnapshotJob carries no secret and is safe to persist in RabbitMQ. Its
// ID is also the Turso snapshot primary key, which makes every delivery idempotent.
type ScoreSnapshotJob struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	Attempt     int    `json:"attempt"`
	RequestedAt int64  `json:"requested_at"`
}

type ScoreSnapshotPublisher interface {
	PublishScoreSnapshot(context.Context, ScoreSnapshotJob) error
	PublishRetry(context.Context, ScoreSnapshotJob, time.Duration) error
	PublishDead(context.Context, ScoreSnapshotJob, string) error
	Ping(context.Context) error
	Close() error
}

// ScanJobPublisher is deliberately separate from the historical score-snapshot
// publisher: a scan runs GitHub collection + Go scoring + Turso persistence in
// an independently restartable worker, not in an API handler.
type ScanJobPublisher interface {
	PublishScan(context.Context, ScanJob) error
	PublishScanRetry(context.Context, ScanJob, time.Duration) error
	PublishScanDead(context.Context, ScanJob, string) error
}

// ProjectAnalysisJob references one project_analysis_runs row. The durable
// analysis state lives in Turso; the broker only triggers worker passes.
type ProjectAnalysisJob struct {
	ID          string `json:"id"`
	Attempt     int    `json:"attempt"`
	RequestedAt int64  `json:"requested_at"`
}

// ProjectAnalysisJobPublisher admits and reschedules project analysis work.
// The API enqueues new runs; the worker republishes transient failures and
// dead-letters permanent ones.
type ProjectAnalysisJobPublisher interface {
	PublishProjectAnalysis(context.Context, ProjectAnalysisJob) error
	PublishProjectAnalysisRetry(context.Context, ProjectAnalysisJob, time.Duration) error
	PublishProjectAnalysisDead(context.Context, ProjectAnalysisJob, string) error
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

func (p *RabbitPublisher) PublishScoreSnapshot(ctx context.Context, job ScoreSnapshotJob) error {
	return p.publishConfirmed(ctx, jobsExchange, scoreSnapshotRoutingKey, job.ID, job, "", nil)
}

func (p *RabbitPublisher) PublishRetry(ctx context.Context, job ScoreSnapshotJob, delay time.Duration) error {
	if delay <= 0 {
		return fmt.Errorf("retry delay must be positive")
	}
	// AMQP expiration is a decimal millisecond string, not a Go duration.
	return p.publishConfirmed(ctx, jobsExchange, scoreSnapshotRetryKey, job.ID, job, strconv.FormatInt(delay.Milliseconds(), 10), nil)
}

func (p *RabbitPublisher) PublishDead(ctx context.Context, job ScoreSnapshotJob, reason string) error {
	return p.publishConfirmed(ctx, deadLetterExchange, scoreSnapshotDeadKey, job.ID, job, "", amqp091.Table{
		"x-ghfind-failure": reason,
	})
}

func (p *RabbitPublisher) PublishScan(ctx context.Context, job ScanJob) error {
	return p.publishConfirmed(ctx, jobsExchange, scanRoutingKey, job.ID, job, "", nil)
}

func (p *RabbitPublisher) PublishScanRetry(ctx context.Context, job ScanJob, delay time.Duration) error {
	if delay <= 0 {
		return fmt.Errorf("retry delay must be positive")
	}
	return p.publishConfirmed(ctx, jobsExchange, scanRetryKey, job.ID, job, strconv.FormatInt(delay.Milliseconds(), 10), nil)
}

func (p *RabbitPublisher) PublishScanDead(ctx context.Context, job ScanJob, reason string) error {
	return p.publishConfirmed(ctx, deadLetterExchange, scanDeadKey, job.ID, job, "", amqp091.Table{"x-ghfind-failure": reason})
}

func (p *RabbitPublisher) PublishProjectAnalysis(ctx context.Context, job ProjectAnalysisJob) error {
	return p.publishConfirmed(ctx, jobsExchange, projectAnalysisKey, job.ID, job, "", nil)
}

func (p *RabbitPublisher) PublishProjectAnalysisRetry(ctx context.Context, job ProjectAnalysisJob, delay time.Duration) error {
	if delay <= 0 {
		return fmt.Errorf("retry delay must be positive")
	}
	return p.publishConfirmed(ctx, jobsExchange, projectAnalysisRetryKey, job.ID, job, strconv.FormatInt(delay.Milliseconds(), 10), nil)
}

func (p *RabbitPublisher) PublishProjectAnalysisDead(ctx context.Context, job ProjectAnalysisJob, reason string) error {
	return p.publishConfirmed(ctx, deadLetterExchange, projectAnalysisDeadKey, job.ID, job, "", amqp091.Table{"x-ghfind-failure": reason})
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
	if _, err := channel.QueueDeclare(scoreSnapshotQueue, true, false, false, false, amqp091.Table{
		"x-dead-letter-exchange":    deadLetterExchange,
		"x-dead-letter-routing-key": scoreSnapshotDeadKey,
	}); err != nil {
		return fmt.Errorf("declare score snapshot queue: %w", err)
	}
	if err := channel.QueueBind(scoreSnapshotQueue, scoreSnapshotRoutingKey, jobsExchange, false, nil); err != nil {
		return fmt.Errorf("bind score snapshot queue: %w", err)
	}
	if _, err := channel.QueueDeclare(scoreSnapshotRetryQueue, true, false, false, false, amqp091.Table{
		"x-dead-letter-exchange":    jobsExchange,
		"x-dead-letter-routing-key": scoreSnapshotRoutingKey,
	}); err != nil {
		return fmt.Errorf("declare score snapshot retry queue: %w", err)
	}
	if err := channel.QueueBind(scoreSnapshotRetryQueue, scoreSnapshotRetryKey, jobsExchange, false, nil); err != nil {
		return fmt.Errorf("bind score snapshot retry queue: %w", err)
	}
	if _, err := channel.QueueDeclare(scoreSnapshotDeadQueue, true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare score snapshot dead queue: %w", err)
	}
	if err := channel.QueueBind(scoreSnapshotDeadQueue, scoreSnapshotDeadKey, deadLetterExchange, false, nil); err != nil {
		return fmt.Errorf("bind score snapshot dead queue: %w", err)
	}
	if _, err := channel.QueueDeclare(scanQueue, true, false, false, false, amqp091.Table{
		"x-dead-letter-exchange":    deadLetterExchange,
		"x-dead-letter-routing-key": scanDeadKey,
	}); err != nil {
		return fmt.Errorf("declare scan queue: %w", err)
	}
	if err := channel.QueueBind(scanQueue, scanRoutingKey, jobsExchange, false, nil); err != nil {
		return fmt.Errorf("bind scan queue: %w", err)
	}
	if _, err := channel.QueueDeclare(scanRetryQueue, true, false, false, false, amqp091.Table{
		"x-dead-letter-exchange":    jobsExchange,
		"x-dead-letter-routing-key": scanRoutingKey,
	}); err != nil {
		return fmt.Errorf("declare scan retry queue: %w", err)
	}
	if err := channel.QueueBind(scanRetryQueue, scanRetryKey, jobsExchange, false, nil); err != nil {
		return fmt.Errorf("bind scan retry queue: %w", err)
	}
	if _, err := channel.QueueDeclare(scanDeadQueue, true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare scan dead queue: %w", err)
	}
	if err := channel.QueueBind(scanDeadQueue, scanDeadKey, deadLetterExchange, false, nil); err != nil {
		return fmt.Errorf("bind scan dead queue: %w", err)
	}
	if _, err := channel.QueueDeclare(projectAnalysisQueue, true, false, false, false, amqp091.Table{
		"x-dead-letter-exchange":    deadLetterExchange,
		"x-dead-letter-routing-key": projectAnalysisDeadKey,
	}); err != nil {
		return fmt.Errorf("declare project analysis queue: %w", err)
	}
	if err := channel.QueueBind(projectAnalysisQueue, projectAnalysisKey, jobsExchange, false, nil); err != nil {
		return fmt.Errorf("bind project analysis queue: %w", err)
	}
	if _, err := channel.QueueDeclare(projectAnalysisRetryQueue, true, false, false, false, amqp091.Table{
		"x-dead-letter-exchange":    jobsExchange,
		"x-dead-letter-routing-key": projectAnalysisKey,
	}); err != nil {
		return fmt.Errorf("declare project analysis retry queue: %w", err)
	}
	if err := channel.QueueBind(projectAnalysisRetryQueue, projectAnalysisRetryKey, jobsExchange, false, nil); err != nil {
		return fmt.Errorf("bind project analysis retry queue: %w", err)
	}
	if _, err := channel.QueueDeclare(projectAnalysisDeadQueue, true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare project analysis dead queue: %w", err)
	}
	if err := channel.QueueBind(projectAnalysisDeadQueue, projectAnalysisDeadKey, deadLetterExchange, false, nil); err != nil {
		return fmt.Errorf("bind project analysis dead queue: %w", err)
	}
	return nil
}

// NewJobID returns an opaque random id for callers that did not provide an
// idempotency key. Hex is intentionally used because it is URL-safe.
func NewJobID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate job ID: %w", err)
	}
	return "job_" + hex.EncodeToString(bytes), nil
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
