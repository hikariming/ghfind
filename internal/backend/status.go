package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// JobState is exposed by the authenticated job-status endpoint.
type JobState string

const (
	JobQueued    JobState = "queued"
	JobRunning   JobState = "running"
	JobRetrying  JobState = "retrying"
	JobCompleted JobState = "completed"
	JobFailed    JobState = "failed"
)

// JobStatus is stored in the existing Upstash deployment with a finite TTL.
// Results themselves live in Turso; this record only makes asynchronous state
// queryable and operationally observable.
type JobStatus struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Username  string    `json:"username"`
	State     JobState  `json:"state"`
	Attempt   int       `json:"attempt"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Error     string    `json:"error,omitempty"`
}

type JobStatusStore interface {
	Put(context.Context, JobStatus) error
	Get(context.Context, string) (*JobStatus, error)
	Ping(context.Context) error
}

// StatsCache preserves the existing `stats:count` cache contract while the
// ownership of /api/stats moves from Next to Go.
type StatsCache interface {
	GetStats(context.Context) (*int, error)
	SetStats(context.Context, int) error
}

// ScanCache preserves the existing public scan cache contract. The key and
// TTL deliberately match src/lib/redis.ts so a cache value written before or
// after the Go cutover is usable by both runtimes.
type ScanCache interface {
	GetCachedScan(context.Context, string) (*ScanResult, error)
	SetCachedScan(context.Context, string, ScanResult) error
}

// LookupGate is the existing Upstash shield before Turso's authoritative heat
// transaction. It prevents a cached-link burst from opening many DB writes.
type LookupGate interface {
	TryAcquireLookupGate(context.Context, string) (bool, error)
	ReleaseLookupGate(context.Context, string) error
}

// ScanFlightGate is the distributed single-flight lock shared with the former
// Next coalesceScan implementation. It protects GitHub's budget on a cold
// cache burst; Turso remains the durable idempotency authority.
type ScanFlightGate interface {
	TryAcquireScanFlight(context.Context, string) (bool, error)
	ReleaseScanFlight(context.Context, string) error
}

type CampaignRevisionWriter interface {
	BumpCampaignLeaderboardRevision(context.Context, string) error
}

// ProjectAnalysisResultCache mirrors the best-effort completed-analysis index
// from src/lib/redis.ts. The value is a plain analysis ID and the durable
// Turso record remains the source of truth.
type ProjectAnalysisResultCache interface {
	GetCachedProjectAnalysisID(context.Context, string) (string, error)
	SetCachedProjectAnalysisID(context.Context, string, string) error
	ClearCachedProjectAnalysisID(context.Context, string) error
}

const scanCacheTTL = 24 * time.Hour
const scanFlightTTL = 75 * time.Second

// projectAnalysisResultTTL matches PROJECT_ANALYSIS_RESULT_TTL_SECONDS
// (30 days) in src/lib/redis.ts.
const projectAnalysisResultTTL = 30 * 24 * time.Hour

type UpstashStatusStore struct {
	baseURL string
	token   string
	ttl     time.Duration
	client  *http.Client
}

func NewUpstashStatusStore(config Config) (*UpstashStatusStore, error) {
	if config.UpstashURL == "" || config.UpstashToken == "" {
		return nil, fmt.Errorf("Upstash URL and token are required")
	}
	return &UpstashStatusStore{
		baseURL: strings.TrimRight(config.UpstashURL, "/"),
		token:   config.UpstashToken,
		ttl:     config.StatusTTL,
		client:  &http.Client{Timeout: 5 * time.Second},
	}, nil
}

func (s *UpstashStatusStore) Ping(ctx context.Context) error {
	_, found, err := s.command(ctx, "PING")
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("Upstash PING returned no result")
	}
	return nil
}

func (s *UpstashStatusStore) Put(ctx context.Context, status JobStatus) error {
	payload, err := json.Marshal(status)
	if err != nil {
		return fmt.Errorf("marshal job status: %w", err)
	}
	_, _, err = s.command(ctx, "SET", statusKey(status.ID), string(payload), "EX", int(s.ttl.Seconds()))
	return err
}

func (s *UpstashStatusStore) Get(ctx context.Context, id string) (*JobStatus, error) {
	raw, found, err := s.command(ctx, "GET", statusKey(id))
	if err != nil || !found || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, err
	}
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return nil, fmt.Errorf("decode Upstash status value: %w", err)
	}
	var status JobStatus
	if err := json.Unmarshal([]byte(encoded), &status); err != nil {
		return nil, fmt.Errorf("decode stored job status: %w", err)
	}
	return &status, nil
}

func (s *UpstashStatusStore) GetStats(ctx context.Context) (*int, error) {
	raw, found, err := s.command(ctx, "GET", "stats:count")
	if err != nil || !found || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, err
	}
	var value int
	if err := json.Unmarshal(raw, &value); err == nil {
		return &value, nil
	}
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return nil, fmt.Errorf("decode cached stats: %w", err)
	}
	if _, err := fmt.Sscanf(encoded, "%d", &value); err != nil {
		return nil, fmt.Errorf("parse cached stats: %w", err)
	}
	return &value, nil
}

func (s *UpstashStatusStore) SetStats(ctx context.Context, total int) error {
	_, _, err := s.command(ctx, "SET", "stats:count", total, "EX", 60)
	return err
}

func (s *UpstashStatusStore) GetCachedScan(ctx context.Context, username string) (*ScanResult, error) {
	raw, found, err := s.command(ctx, "GET", scanCacheKey(username))
	if err != nil || !found || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, err
	}
	var scan ScanResult
	if err := decodeRedisJSON(raw, &scan); err != nil {
		return nil, fmt.Errorf("decode cached scan: %w", err)
	}
	if scan.Metrics.Username == "" {
		return nil, fmt.Errorf("cached scan has no username")
	}
	// The cache is raw collection data, never authority for a score. Recompute
	// it so values written by Next and Go share the current exact Go formula.
	scan.Scoring = Score(scan.Metrics)
	return &scan, nil
}

func (s *UpstashStatusStore) SetCachedScan(ctx context.Context, username string, scan ScanResult) error {
	encoded, err := json.Marshal(scan)
	if err != nil {
		return fmt.Errorf("encode scan cache: %w", err)
	}
	_, _, err = s.command(ctx, "SET", scanCacheKey(username), string(encoded), "EX", int(scanCacheTTL.Seconds()))
	return err
}

func (s *UpstashStatusStore) TryAcquireLookupGate(ctx context.Context, key string) (bool, error) {
	raw, _, err := s.command(ctx, "SET", key, "1", "NX", "EX", int(heatLookupWindow.Seconds()))
	if err != nil || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return false, err
	}
	var result string
	if err := json.Unmarshal(raw, &result); err != nil {
		return false, fmt.Errorf("decode lookup gate: %w", err)
	}
	return result == "OK", nil
}

func (s *UpstashStatusStore) ReleaseLookupGate(ctx context.Context, key string) error {
	_, _, err := s.command(ctx, "DEL", key)
	return err
}

func (s *UpstashStatusStore) TryAcquireScanFlight(ctx context.Context, username string) (bool, error) {
	raw, _, err := s.command(ctx, "SET", scanFlightKey(username), "1", "NX", "EX", int(scanFlightTTL.Seconds()))
	if err != nil || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return false, err
	}
	var result string
	if err := json.Unmarshal(raw, &result); err != nil {
		return false, fmt.Errorf("decode scan flight gate: %w", err)
	}
	return result == "OK", nil
}

func (s *UpstashStatusStore) ReleaseScanFlight(ctx context.Context, username string) error {
	_, _, err := s.command(ctx, "DEL", scanFlightKey(username))
	return err
}

func (s *UpstashStatusStore) GetCachedProjectAnalysisID(ctx context.Context, fingerprint string) (string, error) {
	raw, found, err := s.command(ctx, "GET", projectAnalysisResultKey(fingerprint))
	if err != nil || !found || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return "", err
	}
	var analysisID string
	if err := decodeRedisJSON(raw, &analysisID); err != nil {
		return "", fmt.Errorf("decode cached project analysis: %w", err)
	}
	return analysisID, nil
}

func (s *UpstashStatusStore) SetCachedProjectAnalysisID(ctx context.Context, fingerprint, analysisID string) error {
	_, _, err := s.command(ctx, "SET", projectAnalysisResultKey(fingerprint), analysisID, "EX", int(projectAnalysisResultTTL.Seconds()))
	return err
}

func (s *UpstashStatusStore) ClearCachedProjectAnalysisID(ctx context.Context, fingerprint string) error {
	_, _, err := s.command(ctx, "DEL", projectAnalysisResultKey(fingerprint))
	return err
}

func (s *UpstashStatusStore) BumpCampaignLeaderboardRevision(ctx context.Context, campaign string) error {
	if !validCampaign(campaign) {
		return fmt.Errorf("unknown campaign %q", campaign)
	}
	key := "campaign-leaderboard:" + campaign + ":revision"
	if _, _, err := s.command(ctx, "INCR", key); err != nil {
		return err
	}
	_, _, err := s.command(ctx, "EXPIRE", key, int((7 * 24 * time.Hour).Seconds()))
	return err
}

func (s *UpstashStatusStore) GetLeaderboard(ctx context.Context, view, window string) ([]LeaderboardEntry, bool, error) {
	raw, found, err := s.command(ctx, "GET", "leaderboard:"+view+":"+window)
	if err != nil || !found || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, false, err
	}
	var entries []LeaderboardEntry
	if err := decodeRedisJSON(raw, &entries); err != nil {
		return nil, false, fmt.Errorf("decode cached leaderboard: %w", err)
	}
	if entries == nil {
		entries = []LeaderboardEntry{}
	}
	return entries, true, nil
}

func (s *UpstashStatusStore) SetLeaderboard(ctx context.Context, view, window string, entries []LeaderboardEntry) error {
	encoded, err := json.Marshal(entries)
	if err != nil {
		return fmt.Errorf("encode leaderboard cache: %w", err)
	}
	_, _, err = s.command(ctx, "SET", "leaderboard:"+view+":"+window, string(encoded), "EX", 300)
	return err
}

func (s *UpstashStatusStore) GetFacetCategories(ctx context.Context, facetType string) ([]FacetCategory, bool, error) {
	raw, found, err := s.command(ctx, "GET", "facets:cat:"+facetType)
	if err != nil || !found || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, false, err
	}
	var categories []FacetCategory
	if err := decodeRedisJSON(raw, &categories); err != nil {
		return nil, false, fmt.Errorf("decode cached facet categories: %w", err)
	}
	if categories == nil {
		categories = []FacetCategory{}
	}
	return categories, true, nil
}

func (s *UpstashStatusStore) SetFacetCategories(ctx context.Context, facetType string, categories []FacetCategory) error {
	encoded, err := json.Marshal(categories)
	if err != nil {
		return fmt.Errorf("encode facet categories cache: %w", err)
	}
	_, _, err = s.command(ctx, "SET", "facets:cat:"+facetType, string(encoded), "EX", 600)
	return err
}

func (s *UpstashStatusStore) GetFacetDevelopers(ctx context.Context, facetType, value string) ([]LeaderboardEntry, bool, error) {
	raw, found, err := s.command(ctx, "GET", "facets:list:"+facetType+":"+value)
	if err != nil || !found || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, false, err
	}
	var entries []LeaderboardEntry
	if err := decodeRedisJSON(raw, &entries); err != nil {
		return nil, false, fmt.Errorf("decode cached facet developers: %w", err)
	}
	if entries == nil {
		entries = []LeaderboardEntry{}
	}
	return entries, true, nil
}

func (s *UpstashStatusStore) SetFacetDevelopers(ctx context.Context, facetType, value string, entries []LeaderboardEntry) error {
	encoded, err := json.Marshal(entries)
	if err != nil {
		return fmt.Errorf("encode facet developers cache: %w", err)
	}
	_, _, err = s.command(ctx, "SET", "facets:list:"+facetType+":"+value, string(encoded), "EX", 600)
	return err
}

func (s *UpstashStatusStore) GetCampaignLeaderboardRevision(ctx context.Context, campaign string) (*int64, error) {
	raw, found, err := s.command(ctx, "GET", "campaign-leaderboard:"+campaign+":revision")
	if err != nil || !found || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, err
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err == nil {
		return &value, nil
	}
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return nil, fmt.Errorf("decode campaign leaderboard revision: %w", err)
	}
	if _, err := fmt.Sscan(encoded, &value); err != nil {
		return nil, fmt.Errorf("parse campaign leaderboard revision: %w", err)
	}
	return &value, nil
}

func decodeRedisJSON(raw json.RawMessage, target any) error {
	if err := json.Unmarshal(raw, target); err == nil {
		return nil
	}
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return err
	}
	return json.Unmarshal([]byte(encoded), target)
}

func statusKey(id string) string { return "ghfind:backend:job-status:v1:" + id }

func scanCacheKey(username string) string {
	return "scan:v4:" + strings.ToLower(strings.TrimSpace(username))
}

func scanFlightKey(username string) string {
	return "lock:scan:v4:" + strings.ToLower(strings.TrimSpace(username))
}

// projectAnalysisResultKey matches projectAnalysisResultKey in src/lib/redis.ts
// so a completed-analysis index entry is readable from both runtimes.
func projectAnalysisResultKey(fingerprint string) string {
	return "project-analysis:completed:v1:" + fingerprint
}

// command uses Upstash's documented POST command-array format. Keeping this
// tiny client in-house avoids changing Redis deployment or introducing a TCP
// endpoint that the existing REST-only configuration does not expose.
func (s *UpstashStatusStore) command(ctx context.Context, command ...any) (json.RawMessage, bool, error) {
	body, err := json.Marshal(command)
	if err != nil {
		return nil, false, fmt.Errorf("marshal Upstash command: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL, bytes.NewReader(body))
	if err != nil {
		return nil, false, fmt.Errorf("create Upstash request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("call Upstash: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, false, fmt.Errorf("read Upstash response: %w", err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, false, fmt.Errorf("Upstash returned HTTP %d", response.StatusCode)
	}
	var envelope struct {
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, false, fmt.Errorf("decode Upstash response: %w", err)
	}
	if envelope.Error != "" {
		return nil, false, fmt.Errorf("Upstash command failed: %s", envelope.Error)
	}
	return envelope.Result, envelope.Result != nil, nil
}
