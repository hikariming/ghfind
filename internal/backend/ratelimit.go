package backend

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"
)

const (
	publicReadRateLimit        = 10
	publicReadRateWindow       = time.Minute
	rateLimitUnavailableRetry  = 15
	upstashSlidingWindowScript = `local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, 0, tonumber(oldest[2]) + window}
end
redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], window)
return {1, limit - count - 1, now + window}`
)

type RateLimitResult struct {
	Success     bool
	Limit       int
	Remaining   int
	ResetAt     time.Time
	Unavailable bool
}

type PublicRateLimiter interface {
	LimitPublicRead(context.Context, string, time.Time) (RateLimitResult, error)
	LimitCampaignLeaderboardRead(context.Context, string, time.Time) (RateLimitResult, error)
	LimitScanPrincipal(context.Context, string, time.Time) (RateLimitResult, error)
	LimitScanNetwork(context.Context, string, time.Time) (RateLimitResult, error)
}

// VerdictRateLimiter is deliberately separate from PublicRateLimiter: the
// versus verdict endpoint has both a short burst budget and an operator-cost
// daily budget. Its Redis keys and weighted-window algorithm match the former
// @upstash/ratelimit implementation exactly, so a cutover neither erases an
// existing user's quota nor creates a parallel limiter.
type VerdictRateLimiter interface {
	LimitVerdict(context.Context, string, time.Time) (VerdictRateLimitResult, error)
}

type VerdictRateLimitResult struct {
	Success     bool
	Unavailable bool
}

// RoastRateLimiter retains both the inexpensive request budgets (which cover
// BYO-key calls too) and the operator-credit generation budgets. Keeping these
// methods together makes the required ordering explicit in the Go roast route.
type RoastRateLimiter interface {
	LimitRoastRequest(context.Context, string, time.Time) (RateLimitResult, error)
	LimitRoastRequestNetwork(context.Context, string, time.Time) (RateLimitResult, error)
	LimitRoastGeneration(context.Context, string, time.Time) (RateLimitResult, error)
	LimitRoastNetworkGeneration(context.Context, string, time.Time) (RateLimitResult, error)
}

// MCPRateLimiter is intentionally separate from the browser-facing limits.
// The public MCP transport is unauthenticated and an autonomous client can
// invoke several expensive tools in one connection, so it keeps the legacy
// tighter per-network budget and, crucially, its existing Redis keyspace.
type MCPRateLimiter interface {
	LimitMCP(context.Context, string, time.Time) (RateLimitResult, error)
}

type FeedRateLimiter interface {
	LimitFeed(context.Context, int64, string, time.Time) (RateLimitResult, error)
}

func (s *UpstashStatusStore) LimitFeed(ctx context.Context, githubID int64, kind string, now time.Time) (RateLimitResult, error) {
	limit := 60
	switch kind {
	case "events":
		limit = 120
	case "write":
		limit = 20
	}
	return s.limitLegacySlidingWindow(ctx, "rl:feed:"+kind, strconv.FormatInt(githubID, 10), limit, time.Minute, now)
}

// LimitPublicRead uses an atomic Redis sliding window. Its state is deliberately
// namespaced independently from Next's client library internals, while keeping
// the same ten-per-minute budget and fail-closed behavior for protected reads.
func (s *UpstashStatusStore) LimitPublicRead(ctx context.Context, principal string, now time.Time) (RateLimitResult, error) {
	return s.limitSlidingWindow(ctx, "scan", principal, publicReadRateLimit, now)
}

func (s *UpstashStatusStore) LimitCampaignLeaderboardRead(ctx context.Context, principal string, now time.Time) (RateLimitResult, error) {
	return s.limitSlidingWindow(ctx, "campaign-leaderboard-read", principal, 600, now)
}

func (s *UpstashStatusStore) LimitScanPrincipal(ctx context.Context, principal string, now time.Time) (RateLimitResult, error) {
	return s.limitSlidingWindow(ctx, "scan-principal", principal, 10, now)
}

func (s *UpstashStatusStore) LimitScanNetwork(ctx context.Context, principal string, now time.Time) (RateLimitResult, error) {
	return s.limitSlidingWindow(ctx, "scan-network", principal, 60, now)
}

const legacyUpstashSlidingWindowScript = `
  local currentKey  = KEYS[1]
  local previousKey = KEYS[2]
  local dynamicLimitKey = KEYS[3]
  local tokens      = tonumber(ARGV[1])
  local now         = ARGV[2]
  local window      = ARGV[3]
  local incrementBy = tonumber(ARGV[4])

  local effectiveLimit = tokens
  if dynamicLimitKey ~= "" then
    local dynamicLimit = redis.call("GET", dynamicLimitKey)
    if dynamicLimit then
      effectiveLimit = tonumber(dynamicLimit)
    end
  end

  local requestsInCurrentWindow = redis.call("GET", currentKey)
  if requestsInCurrentWindow == false then
    requestsInCurrentWindow = 0
  end
  local requestsInPreviousWindow = redis.call("GET", previousKey)
  if requestsInPreviousWindow == false then
    requestsInPreviousWindow = 0
  end
  local percentageInCurrent = ( now % window ) / window
  requestsInPreviousWindow = math.floor(( 1 - percentageInCurrent ) * requestsInPreviousWindow)
  if incrementBy > 0 and requestsInPreviousWindow + requestsInCurrentWindow >= effectiveLimit then
    return {-1, effectiveLimit}
  end
  local newValue = redis.call("INCRBY", currentKey, incrementBy)
  if newValue == incrementBy then
    redis.call("PEXPIRE", currentKey, window * 2 + 1000)
  end
  return {effectiveLimit - ( newValue + requestsInPreviousWindow ), effectiveLimit}
`

// LimitVerdict keeps the Next route's two concurrent budgets and exact
// `rl:verdict:{m,d}:<ip>:<bucket>` key layout. The raw principal is intentional:
// it is compatibility state written by the existing Upstash library, not a new
// telemetry key. The Go route only accepts a gateway-signed value for it.
func (s *UpstashStatusStore) LimitVerdict(ctx context.Context, principal string, now time.Time) (VerdictRateLimitResult, error) {
	type result struct {
		allowed bool
		err     error
	}
	results := make(chan result, 2)
	for _, budget := range []struct {
		prefix string
		limit  int
		window time.Duration
	}{
		{prefix: "rl:verdict:m", limit: 6, window: time.Minute},
		{prefix: "rl:verdict:d", limit: 40, window: 24 * time.Hour},
	} {
		budget := budget
		go func() {
			limited, err := s.limitLegacySlidingWindow(ctx, budget.prefix, principal, budget.limit, budget.window, now)
			results <- result{allowed: limited.Success, err: err}
		}()
	}
	first, second := <-results, <-results
	if first.err != nil {
		return VerdictRateLimitResult{Unavailable: true}, first.err
	}
	if second.err != nil {
		return VerdictRateLimitResult{Unavailable: true}, second.err
	}
	return VerdictRateLimitResult{Success: first.allowed && second.allowed}, nil
}

func (s *UpstashStatusStore) LimitRoastRequest(ctx context.Context, principal string, now time.Time) (RateLimitResult, error) {
	return s.limitLegacySlidingWindow(ctx, "rl:roast-request", principal, 20, time.Minute, now)
}

func (s *UpstashStatusStore) LimitRoastRequestNetwork(ctx context.Context, principal string, now time.Time) (RateLimitResult, error) {
	return s.limitLegacySlidingWindow(ctx, "rl:roast-request-network", principal, 120, time.Minute, now)
}

// LimitProjectAnalysis mirrors checkProjectAnalysisRateLimit in src/lib/redis.ts:
// a separate, tighter budget of 5 submissions per 60 minutes because each
// analysis starts a long-running agent. When Redis is unavailable the result
// keeps the existing Go unavailable semantics (no in-memory fallback).
func (s *UpstashStatusStore) LimitProjectAnalysis(ctx context.Context, principal string, now time.Time) (RateLimitResult, error) {
	return s.limitLegacySlidingWindow(ctx, "rl:project-analysis", principal, 5, time.Hour, now)
}

// LimitMCP retains the exact @upstash/ratelimit sliding-window state that the
// former Next MCP handler wrote: prefix "rl:mcp", 15 requests per 60 seconds,
// with the client IP as the identifier. This makes the cutover quota-neutral.
func (s *UpstashStatusStore) LimitMCP(ctx context.Context, principal string, now time.Time) (RateLimitResult, error) {
	return s.limitLegacySlidingWindow(ctx, "rl:mcp", principal, 15, time.Minute, now)
}

func (s *UpstashStatusStore) LimitRoastGeneration(ctx context.Context, principal string, now time.Time) (RateLimitResult, error) {
	return s.limitLegacyBudgetPair(ctx, principal, now, []legacyRateBudget{
		{prefix: "rl:roast:m", limit: 8, window: time.Minute},
		{prefix: "rl:roast:d", limit: 60, window: 24 * time.Hour},
	})
}

func (s *UpstashStatusStore) LimitRoastNetworkGeneration(ctx context.Context, principal string, now time.Time) (RateLimitResult, error) {
	return s.limitLegacyBudgetPair(ctx, principal, now, []legacyRateBudget{
		{prefix: "rl:roast-network:m", limit: 48, window: time.Minute},
		{prefix: "rl:roast-network:d", limit: 480, window: 24 * time.Hour},
	})
}

type legacyRateBudget struct {
	prefix string
	limit  int
	window time.Duration
}

func (s *UpstashStatusStore) limitLegacyBudgetPair(ctx context.Context, principal string, now time.Time, budgets []legacyRateBudget) (RateLimitResult, error) {
	type result struct {
		limit RateLimitResult
		err   error
	}
	results := make(chan result, len(budgets))
	for _, budget := range budgets {
		budget := budget
		go func() {
			limited, err := s.limitLegacySlidingWindow(ctx, budget.prefix, principal, budget.limit, budget.window, now)
			results <- result{limit: limited, err: err}
		}()
	}
	combined := RateLimitResult{Success: true}
	for range budgets {
		result := <-results
		if result.err != nil {
			return RateLimitResult{Unavailable: true}, result.err
		}
		combined.Success = combined.Success && result.limit.Success
		// The former Next handler intentionally returned no rate-limit fields for
		// these paired budgets. Carry only success/unavailability to retain that
		// public response contract.
	}
	return combined, nil
}

func (s *UpstashStatusStore) limitLegacySlidingWindow(ctx context.Context, prefix, principal string, limit int, window time.Duration, now time.Time) (RateLimitResult, error) {
	windowMS := window.Milliseconds()
	nowMS := now.UnixMilli()
	bucket := nowMS / windowMS
	identifier := prefix + ":" + principal
	currentKey := identifier + ":" + strconv.FormatInt(bucket, 10)
	previousKey := identifier + ":" + strconv.FormatInt(bucket-1, 10)
	raw, _, err := s.command(ctx, "EVAL", legacyUpstashSlidingWindowScript, 3, currentKey, previousKey, "", limit, nowMS, windowMS, 1)
	if err != nil {
		return RateLimitResult{Unavailable: true}, err
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || len(values) != 2 {
		if err == nil {
			err = fmt.Errorf("unexpected legacy sliding-window result length %d", len(values))
		}
		return RateLimitResult{Unavailable: true}, fmt.Errorf("decode legacy sliding-window result: %w", err)
	}
	var remaining int64
	if err := json.Unmarshal(values[0], &remaining); err != nil {
		var encoded string
		if stringErr := json.Unmarshal(values[0], &encoded); stringErr != nil {
			return RateLimitResult{Unavailable: true}, fmt.Errorf("parse legacy sliding-window remaining: %w", err)
		}
		remaining, err = strconv.ParseInt(encoded, 10, 64)
		if err != nil {
			return RateLimitResult{Unavailable: true}, fmt.Errorf("parse legacy sliding-window remaining: %w", err)
		}
	}
	return RateLimitResult{
		Success: remaining >= 0, Limit: limit, Remaining: maxInt(0, int(remaining)),
		ResetAt: time.UnixMilli((bucket + 1) * windowMS),
	}, nil
}

func (s *UpstashStatusStore) limitSlidingWindow(
	ctx context.Context,
	namespace, principal string,
	limit int,
	now time.Time,
) (RateLimitResult, error) {
	member, err := NewJobID()
	if err != nil {
		return RateLimitResult{Unavailable: true}, err
	}
	digest := sha256.Sum256([]byte(principal))
	key := "ghfind:backend:rate-limit:v1:" + namespace + ":" + fmt.Sprintf("%x", digest[:])
	windowMS := int64(publicReadRateWindow / time.Millisecond)
	raw, _, err := s.command(ctx, "EVAL", upstashSlidingWindowScript, 1, key,
		now.UnixMilli(), windowMS, limit, member)
	if err != nil {
		return RateLimitResult{Unavailable: true}, err
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return RateLimitResult{Unavailable: true}, fmt.Errorf("decode sliding-window result: %w", err)
	}
	if len(values) != 3 {
		return RateLimitResult{Unavailable: true}, fmt.Errorf("unexpected sliding-window result length %d", len(values))
	}
	parse := func(index int) (int64, error) {
		var number int64
		if err := json.Unmarshal(values[index], &number); err == nil {
			return number, nil
		}
		var text string
		if err := json.Unmarshal(values[index], &text); err != nil {
			return 0, err
		}
		return strconv.ParseInt(text, 10, 64)
	}
	allowed, err := parse(0)
	if err != nil {
		return RateLimitResult{Unavailable: true}, fmt.Errorf("parse rate-limit allowance: %w", err)
	}
	remaining, err := parse(1)
	if err != nil {
		return RateLimitResult{Unavailable: true}, fmt.Errorf("parse rate-limit remaining: %w", err)
	}
	reset, err := parse(2)
	if err != nil {
		return RateLimitResult{Unavailable: true}, fmt.Errorf("parse rate-limit reset: %w", err)
	}
	return RateLimitResult{
		Success: allowed == 1, Limit: limit, Remaining: int(remaining), ResetAt: time.UnixMilli(reset),
	}, nil
}

func rateLimitHeaders(result RateLimitResult, now time.Time) map[string]string {
	if result.Unavailable {
		return map[string]string{"Retry-After": strconv.Itoa(rateLimitUnavailableRetry)}
	}
	if result.Limit <= 0 {
		return map[string]string{}
	}
	resetSeconds := int(math.Max(0, math.Ceil(result.ResetAt.Sub(now).Seconds())))
	headers := map[string]string{
		"RateLimit-Limit":     strconv.Itoa(result.Limit),
		"RateLimit-Remaining": strconv.Itoa(maxInt(0, result.Remaining)),
		"RateLimit-Reset":     strconv.Itoa(resetSeconds),
	}
	if !result.Success {
		if resetSeconds < 1 {
			resetSeconds = 1
		}
		headers["Retry-After"] = strconv.Itoa(resetSeconds)
	}
	return headers
}
