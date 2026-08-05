package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	verdictCacheTTL = 5 * 24 * time.Hour
	verdictLockTTL  = time.Minute
)

type CachedVerdict struct {
	Verdict RoastLine `json:"verdict"`
	Advice  RoastLine `json:"advice"`
	Winner  *string   `json:"winner"`
	Bucket  string    `json:"bucket"`
}

type VerdictCache interface {
	GetCachedVerdict(context.Context, string, string) (*CachedVerdict, error)
	SetCachedVerdict(context.Context, string, string, CachedVerdict) error
	TryAcquireVerdictLock(context.Context, string, string) (bool, error)
	ReleaseVerdictLock(context.Context, string, string) error
	HasVerdictLock(context.Context, string, string) (bool, error)
}

func verdictPair(a, b string) string {
	a, b = strings.ToLower(strings.TrimSpace(a)), strings.ToLower(strings.TrimSpace(b))
	if a > b {
		a, b = b, a
	}
	return a + "|" + b
}

func verdictCacheKey(a, b string) string { return "verdict:v1:" + verdictPair(a, b) }
func verdictLockKey(a, b string) string  { return "lock:verdict:" + verdictPair(a, b) }

func (s *UpstashStatusStore) GetCachedVerdict(ctx context.Context, a, b string) (*CachedVerdict, error) {
	raw, found, err := s.command(ctx, "GET", verdictCacheKey(a, b))
	if err != nil || !found || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, err
	}
	var verdict CachedVerdict
	if err := decodeRedisJSON(raw, &verdict); err != nil {
		return nil, fmt.Errorf("decode cached verdict: %w", err)
	}
	if verdict.Bucket == "" {
		return nil, fmt.Errorf("cached verdict has no bucket")
	}
	return &verdict, nil
}

func (s *UpstashStatusStore) SetCachedVerdict(ctx context.Context, a, b string, verdict CachedVerdict) error {
	encoded, err := json.Marshal(verdict)
	if err != nil {
		return fmt.Errorf("encode cached verdict: %w", err)
	}
	_, _, err = s.command(ctx, "SET", verdictCacheKey(a, b), string(encoded), "EX", int(verdictCacheTTL.Seconds()))
	return err
}

func (s *UpstashStatusStore) TryAcquireVerdictLock(ctx context.Context, a, b string) (bool, error) {
	raw, _, err := s.command(ctx, "SET", verdictLockKey(a, b), "1", "NX", "EX", int(verdictLockTTL.Seconds()))
	if err != nil || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return false, err
	}
	var result string
	if err := json.Unmarshal(raw, &result); err != nil {
		return false, fmt.Errorf("decode verdict lock: %w", err)
	}
	return result == "OK", nil
}

func (s *UpstashStatusStore) ReleaseVerdictLock(ctx context.Context, a, b string) error {
	_, _, err := s.command(ctx, "DEL", verdictLockKey(a, b))
	return err
}

func (s *UpstashStatusStore) HasVerdictLock(ctx context.Context, a, b string) (bool, error) {
	raw, found, err := s.command(ctx, "GET", verdictLockKey(a, b))
	return err == nil && found && len(raw) > 0 && !bytes.Equal(raw, []byte("null")), err
}
