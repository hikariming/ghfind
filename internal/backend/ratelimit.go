package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

const rateLimitUnavailableRetry = 15

type RateLimitResult struct {
	Success     bool
	Limit       int
	Remaining   int
	ResetAt     time.Time
	Unavailable bool
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
		Success: remaining >= 0, Limit: limit, Remaining: max(0, int(remaining)),
		ResetAt: time.UnixMilli((bucket + 1) * windowMS),
	}, nil
}
