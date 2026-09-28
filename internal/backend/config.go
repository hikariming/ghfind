// Package backend contains the Go Feed API, storage adapters, and workers.
//
// Its Turso adapters read existing tables and never create or migrate schema.
package backend

import (
	"fmt"
	"net/url"
	"strings"
)

// Config carries the server-only settings of the Feed Go backend. No value here
// is ever sent to a browser.
type Config struct {
	TursoURL                       string
	TursoAuth                      string
	UpstashURL                     string
	UpstashToken                   string
	RabbitURL                      string
	AdminSecret                    string
	AuthSecret                     string
	MaxAttempts                    int
	ProjectAnalysisReconcileSecret string
	CronSecret                     string
	// Feed is an optional, isolated PostgreSQL-backed subsystem; the zero
	// FeedMode is "off".
	FeedMode              FeedMode
	FeedDatabaseURL       string
	FeedSigningSecret     string
	FeedCanaryBPS         int
	FeedGorseLiveBPS      int
	FeedInternalAllowlist []int64
	EmbeddingBaseURL      string
	EmbeddingAPIKey       string
	EmbeddingModel        string
	EmbeddingDimensions   int
	GorseBaseURL          string
	GorseServerAPIKey     string
	GorseAdminAPIKey      string
}

func (c Config) validateFeed() error {
	// A zero-value Config is common in focused unit tests and in embedders that
	// do not use Feed. Treat it exactly like the explicit default, "off".
	if c.FeedMode == "" || c.FeedMode == FeedModeOff {
		return nil
	}
	if !c.FeedMode.Valid() {
		return fmt.Errorf("FEED_MODE must be off, baseline, baseline_gorse_shadow, or gorse_canary")
	}
	if c.FeedGorseLiveBPS > 0 && c.FeedMode != FeedModeGorseCanary {
		return fmt.Errorf("FEED_GORSE_LIVE_BPS requires FEED_MODE=gorse_canary")
	}
	if strings.TrimSpace(c.FeedDatabaseURL) == "" {
		return fmt.Errorf("FEED_DATABASE_URL is required when FEED_MODE is enabled")
	}
	if len(c.FeedSigningSecret) < 32 {
		return fmt.Errorf("FEED_SIGNING_SECRET must contain at least 32 characters when FEED_MODE is enabled")
	}
	if (c.FeedMode == FeedModeGorseShadow || c.FeedMode == FeedModeGorseCanary) && c.GorseBaseURL == "" {
		return fmt.Errorf("GORSE_BASE_URL is required for the configured FEED_MODE")
	}
	if (c.FeedMode == FeedModeGorseShadow || c.FeedMode == FeedModeGorseCanary) && c.GorseServerAPIKey == "" {
		return fmt.Errorf("GORSE_SERVER_API_KEY is required for the configured FEED_MODE")
	}
	if (c.FeedMode == FeedModeGorseShadow || c.FeedMode == FeedModeGorseCanary) && c.GorseAdminAPIKey == "" {
		return fmt.Errorf("GORSE_ADMIN_API_KEY is required for the configured FEED_MODE")
	}
	embeddingConfigured := c.EmbeddingBaseURL != "" || c.EmbeddingAPIKey != "" || c.EmbeddingModel != ""
	if embeddingConfigured && (c.EmbeddingBaseURL == "" || c.EmbeddingAPIKey == "" || c.EmbeddingModel == "") {
		return fmt.Errorf("FEED_EMBEDDING_BASE_URL, FEED_EMBEDDING_API_KEY, and FEED_EMBEDDING_MODEL must be configured together")
	}
	return nil
}

// LibSQLDSN validates and returns the unmodified database URL. The official
// libsql Go driver rejects auth tokens in query parameters; OpenTursoStore
// passes TURSO_AUTH_TOKEN through libsql.WithAuthToken instead.
func (c Config) LibSQLDSN() (string, error) {
	if c.TursoURL == "" {
		return "", fmt.Errorf("TURSO_DATABASE_URL is required")
	}
	if _, err := url.Parse(c.TursoURL); err != nil {
		return "", fmt.Errorf("parse TURSO_DATABASE_URL: %w", err)
	}
	return c.TursoURL, nil
}
