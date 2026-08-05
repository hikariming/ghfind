// Package backend contains the long-lived Go API and worker processes.
//
// It deliberately shares the existing Turso and Upstash resources with the
// Next application during migration. It never creates or migrates schema.
package backend

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAPIListenAddr           = ":8080"
	defaultWorkerMetricsListenAddr = ":9090"
	defaultStatusTTL               = 7 * 24 * time.Hour
	defaultMaxAttempts             = 5
	defaultMosooAPIBase            = "https://try.mosoo.ai/api/v1"
	defaultMosooRequestTimeout     = 15 * time.Second
	defaultProjectAnalysisTimeout  = 15 * time.Minute
	// Project analysis runs are concurrency-capped because each one holds a
	// long-lived Cattle Agent thread.
	defaultProjectAnalysisConcurrency       = 3
	maxProjectAnalysisConcurrency           = 20
	defaultProjectAnalysisCreateMaxAttempts = 3
	maxProjectAnalysisCreateMaxAttempts     = 10
	defaultProjectAnalysisCreateRetryBase   = 5 * time.Second
	maxProjectAnalysisCreateRetryBase       = time.Minute
	// Scan concurrency scales with the GitHub token pool: 8 in-flight scans
	// for the first PAT (burst responsiveness) plus 4 per additional PAT
	// (each token's hourly quota feeds about four concurrent latency-bound
	// scans), capped at 20. The floor keeps a tokenless local worker
	// functional; ValidateWorker still requires a token for real scans.
	scanConcurrencyBase     = 8
	scanConcurrencyPerToken = 4
	minScanConcurrency      = 2
	maxScanConcurrency      = 20
)

// Config is shared by the API and worker. Secrets are intentionally all
// server-only variables; no value here is ever sent to a browser.
type Config struct {
	APIListenAddr           string
	WorkerMetricsListenAddr string
	TursoURL                string
	TursoAuth               string
	UpstashURL              string
	UpstashToken            string
	RabbitURL               string
	AdminSecret             string
	GitHubToken             string
	CLIAPIKey               string
	TurnstileSecret         string
	AuthSecret              string
	GitHubOAuthID           string
	GitHubOAuthSecret       string
	PublicSiteURL           string
	LLMAPIKey               string
	LLMBaseURL              string
	LLMModel                string
	LLMLegacyOpenRouter     bool
	LLMFallbackAPIKey       string
	LLMFallbackBaseURL      string
	LLMFallbackModel        string
	VerdictGatewaySecret    string
	TrustVercelHeaders      bool
	StatusTTL               time.Duration
	MaxAttempts             int
	ScanConcurrency         int
	// Mosoo project analysis settings mirror the TypeScript environment of
	// src/lib/mosoo-project-analysis.ts and project-analysis-service.ts.
	MosooAPIBase                     string
	MosooAPIToken                    string
	MosooProjectAgentID              string
	MosooUserID                      string
	MosooRequestTimeout              time.Duration
	ProjectAnalysisTimeout           time.Duration
	ProjectAnalysisConcurrency       int
	ProjectAnalysisCreateMaxAttempts int
	ProjectAnalysisCreateRetryBase   time.Duration
	ProjectAnalysisRuntimeAllowlist  []string
	ProjectAnalysisReconcileSecret   string
	CronSecret                       string
}

// LoadConfigFromEnv reads the existing Turso/Upstash names plus the new broker
// configuration. Validation is performed by the process that needs a given
// dependency so a diagnostic command can still run without every secret.
func LoadConfigFromEnv() Config {
	return Config{
		APIListenAddr:                    apiListenAddrFromEnv(),
		WorkerMetricsListenAddr:          strings.TrimSpace(envOr("GHFIND_WORKER_METRICS_LISTEN_ADDR", defaultWorkerMetricsListenAddr)),
		TursoURL:                         strings.TrimSpace(os.Getenv("TURSO_DATABASE_URL")),
		TursoAuth:                        strings.TrimSpace(os.Getenv("TURSO_AUTH_TOKEN")),
		UpstashURL:                       strings.TrimRight(strings.TrimSpace(os.Getenv("UPSTASH_REDIS_REST_URL")), "/"),
		UpstashToken:                     strings.TrimSpace(os.Getenv("UPSTASH_REDIS_REST_TOKEN")),
		RabbitURL:                        strings.TrimSpace(os.Getenv("RABBITMQ_URL")),
		AdminSecret:                      strings.TrimSpace(os.Getenv("ADMIN_SECRET")),
		GitHubToken:                      strings.TrimSpace(os.Getenv("GITHUB_TOKEN")),
		CLIAPIKey:                        strings.TrimSpace(os.Getenv("GITHUB_ROAST_CLI_API_KEY")),
		TurnstileSecret:                  strings.TrimSpace(os.Getenv("TURNSTILE_SECRET_KEY")),
		AuthSecret:                       strings.TrimSpace(os.Getenv("AUTH_SECRET")),
		GitHubOAuthID:                    strings.TrimSpace(os.Getenv("AUTH_GITHUB_ID")),
		GitHubOAuthSecret:                strings.TrimSpace(os.Getenv("AUTH_GITHUB_SECRET")),
		PublicSiteURL:                    strings.TrimRight(strings.TrimSpace(envOr("PUBLIC_SITE_URL", os.Getenv("NEXT_PUBLIC_SITE_URL"))), "/"),
		LLMAPIKey:                        strings.TrimSpace(envOr("LLM_API_KEY", os.Getenv("OPENROUTER_API_KEY"))),
		LLMBaseURL:                       strings.TrimRight(strings.TrimSpace(envOr("LLM_BASE_URL", os.Getenv("OPENROUTER_BASE_URL"))), "/"),
		LLMModel:                         strings.TrimSpace(envOr("LLM_MODEL", os.Getenv("OPENROUTER_MODEL"))),
		LLMLegacyOpenRouter:              strings.TrimSpace(os.Getenv("LLM_API_KEY")) == "" && strings.TrimSpace(os.Getenv("OPENROUTER_API_KEY")) != "",
		LLMFallbackAPIKey:                strings.TrimSpace(os.Getenv("LLM_FALLBACK_API_KEY")),
		LLMFallbackBaseURL:               strings.TrimRight(strings.TrimSpace(os.Getenv("LLM_FALLBACK_BASE_URL")), "/"),
		LLMFallbackModel:                 strings.TrimSpace(os.Getenv("LLM_FALLBACK_MODEL")),
		VerdictGatewaySecret:             strings.TrimSpace(os.Getenv("GHFIND_VERDICT_GATEWAY_SECRET")),
		TrustVercelHeaders:               strings.TrimSpace(os.Getenv("GHFIND_TRUST_VERCEL_HEADERS")) == "1",
		StatusTTL:                        durationEnv("GHFIND_JOB_STATUS_TTL", defaultStatusTTL),
		MaxAttempts:                      intEnv("GHFIND_JOB_MAX_ATTEMPTS", defaultMaxAttempts),
		ScanConcurrency:                  scanConcurrencyFromEnv(os.Getenv("GITHUB_TOKEN")),
		MosooAPIBase:                     strings.TrimRight(envOr("MOSOO_API_BASE", defaultMosooAPIBase), "/"),
		MosooAPIToken:                    strings.TrimSpace(os.Getenv("MOSOO_API_TOKEN")),
		MosooProjectAgentID:              strings.TrimSpace(os.Getenv("MOSOO_PROJECT_AGENT_ID")),
		MosooUserID:                      strings.TrimSpace(envOr("MOSOO_PROJECT_USER_ID", "ghfind")),
		MosooRequestTimeout:              millisDurationEnv("MOSOO_PROJECT_REQUEST_TIMEOUT_MS", time.Second, defaultMosooRequestTimeout),
		ProjectAnalysisTimeout:           millisDurationEnv("PROJECT_ANALYSIS_TIMEOUT_MS", time.Minute, defaultProjectAnalysisTimeout),
		ProjectAnalysisConcurrency:       projectAnalysisConcurrencyFromEnv(),
		ProjectAnalysisCreateMaxAttempts: clampIntEnv("PROJECT_ANALYSIS_CREATE_MAX_ATTEMPTS", defaultProjectAnalysisCreateMaxAttempts, 1, maxProjectAnalysisCreateMaxAttempts),
		ProjectAnalysisCreateRetryBase:   clampDurationEnv("PROJECT_ANALYSIS_CREATE_RETRY_BASE_MS", defaultProjectAnalysisCreateRetryBase, time.Second, maxProjectAnalysisCreateRetryBase),
		ProjectAnalysisRuntimeAllowlist:  projectAnalysisAllowlistFromEnv(os.Getenv("PROJECT_ANALYSIS_RUNTIME_ALLOWLIST")),
		ProjectAnalysisReconcileSecret:   strings.TrimSpace(os.Getenv("PROJECT_ANALYSIS_RECONCILE_SECRET")),
		CronSecret:                       strings.TrimSpace(os.Getenv("CRON_SECRET")),
	}
}

// ProjectAnalysisExecutionMode mirrors projectAnalysisExecutionMode: only an
// exact, case-insensitive owner/repo match against the allowlist lets the
// Agent execute repository code; everything else stays source-only.
func (c Config) ProjectAnalysisExecutionMode(repoKey string) string {
	normalized := strings.ToLower(strings.TrimSpace(repoKey))
	for _, entry := range c.ProjectAnalysisRuntimeAllowlist {
		if entry == normalized {
			return MosooExecutionRuntime
		}
	}
	return MosooExecutionSource
}

// ProjectAnalysisCreateAttemptLease mirrors createAttemptLeaseMs: the request
// timeout plus a five-second grace window.
func (c Config) ProjectAnalysisCreateAttemptLease() time.Duration {
	return c.MosooRequestTimeout + 5*time.Second
}

// projectAnalysisConcurrencyFromEnv reads GHFIND_PROJECT_ANALYSIS_CONCURRENCY
// and falls back to the TypeScript variable PROJECT_ANALYSIS_MAX_CONCURRENCY.
func projectAnalysisConcurrencyFromEnv() int {
	if value := strings.TrimSpace(os.Getenv("GHFIND_PROJECT_ANALYSIS_CONCURRENCY")); value != "" {
		return clampIntValue(value, defaultProjectAnalysisConcurrency, 1, maxProjectAnalysisConcurrency)
	}
	return clampIntEnv("PROJECT_ANALYSIS_MAX_CONCURRENCY", defaultProjectAnalysisConcurrency, 1, maxProjectAnalysisConcurrency)
}

func projectAnalysisAllowlistFromEnv(raw string) []string {
	entries := []string{}
	for _, entry := range strings.Split(raw, ",") {
		if trimmed := strings.ToLower(strings.TrimSpace(entry)); trimmed != "" {
			entries = append(entries, trimmed)
		}
	}
	return entries
}

// millisDurationEnv parses a millisecond integer environment variable. Values
// below the minimum fall back to the default, matching the TypeScript guards.
func millisDurationEnv(name string, minimum, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	millis, err := strconv.Atoi(value)
	if err != nil || time.Duration(millis)*time.Millisecond < minimum {
		return fallback
	}
	return time.Duration(millis) * time.Millisecond
}

func clampIntEnv(name string, fallback, minimum, maximum int) int {
	return clampIntValue(strings.TrimSpace(os.Getenv(name)), fallback, minimum, maximum)
}

func clampIntValue(raw string, fallback, minimum, maximum int) int {
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < minimum {
		return fallback
	}
	if parsed > maximum {
		return maximum
	}
	return parsed
}

func clampDurationEnv(name string, fallback, minimum, maximum time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	millis, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	parsed := time.Duration(millis) * time.Millisecond
	if parsed < minimum {
		return fallback
	}
	if parsed > maximum {
		return maximum
	}
	return parsed
}

// scanConcurrencyFromEnv honors an explicit GHFIND_SCAN_WORKER_CONCURRENCY;
// otherwise it sizes the scan worker to the token pool: 8 in-flight scans for
// one PAT, +4 per additional PAT, capped at 20 — so adding PATs to
// GITHUB_TOKEN automatically raises throughput with no other change.
func scanConcurrencyFromEnv(rawTokens string) int {
	if value := intEnv("GHFIND_SCAN_WORKER_CONCURRENCY", 0); value > 0 {
		return value
	}
	tokens := len(ParseGitHubTokens(rawTokens))
	if tokens < 1 {
		return minScanConcurrency
	}
	concurrency := scanConcurrencyBase + scanConcurrencyPerToken*(tokens-1)
	if concurrency > maxScanConcurrency {
		return maxScanConcurrency
	}
	return concurrency
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func apiListenAddrFromEnv() string {
	if value := strings.TrimSpace(os.Getenv("GHFIND_API_LISTEN_ADDR")); value != "" {
		return value
	}
	if port := strings.TrimSpace(os.Getenv("PORT")); port != "" {
		return ":" + strings.TrimPrefix(port, ":")
	}
	return defaultAPIListenAddr
}

func durationEnv(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func intEnv(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return fallback
	}
	return parsed
}

func (c Config) validateSharedDependencies() error {
	if strings.TrimSpace(c.TursoURL) == "" {
		return fmt.Errorf("TURSO_DATABASE_URL is required")
	}
	if strings.TrimSpace(c.RabbitURL) == "" {
		return fmt.Errorf("RABBITMQ_URL is required")
	}
	if strings.TrimSpace(c.UpstashURL) == "" || strings.TrimSpace(c.UpstashToken) == "" {
		return fmt.Errorf("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required")
	}
	if c.MaxAttempts < 1 {
		return fmt.Errorf("GHFIND_JOB_MAX_ATTEMPTS must be positive")
	}
	return nil
}

// ValidateAPI rejects partial production configuration before the process
// begins accepting traffic. The API owns both public reads and authenticated
// durable-job admission, so its internal secret is mandatory at startup.
func (c Config) ValidateAPI() error {
	if err := c.validateSharedDependencies(); err != nil {
		return err
	}
	if strings.TrimSpace(c.AdminSecret) == "" {
		return fmt.Errorf("ADMIN_SECRET is required")
	}
	return nil
}

// ValidateWorker requires every dependency needed to process and expose a
// terminal result, but not ADMIN_SECRET: the worker never accepts HTTP input.
func (c Config) ValidateWorker() error {
	if err := c.validateSharedDependencies(); err != nil {
		return err
	}
	if strings.TrimSpace(c.GitHubToken) == "" {
		return fmt.Errorf("GITHUB_TOKEN is required for scan worker")
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
