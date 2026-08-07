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
	roastCacheTTL = 24 * time.Hour
	roastLockTTL  = 270 * time.Second
)

// CachedRoast is deliberately wire-compatible with src/lib/redis.ts. The
// fields remain optional where old cache records did not yet contain them, so a
// rollout can read an existing value rather than forcing every account to pay
// for a regeneration.
type CachedRoast struct {
	Report       string    `json:"report"`
	SnapshotHash string    `json:"snapshot_hash,omitempty"`
	Delta        float64   `json:"delta"`
	Tags         Tags      `json:"tags"`
	FinalScore   *float64  `json:"final_score,omitempty"`
	Tier         *string   `json:"tier,omitempty"`
	RoastLine    RoastLine `json:"roast_line,omitempty"`
}

type RoastCache interface {
	GetCachedRoast(context.Context, string, roastLanguage) (*CachedRoast, error)
	SetCachedRoast(context.Context, string, roastLanguage, CachedRoast) error
	ClearCachedRoast(context.Context, string, roastLanguage) error
	TryAcquireRoastLock(context.Context, string, roastLanguage) (bool, error)
	ReleaseRoastLock(context.Context, string, roastLanguage) error
	HasRoastLock(context.Context, string, roastLanguage) (bool, error)
}

type roastLanguage string

const (
	roastLanguageZH roastLanguage = "zh"
	roastLanguageEN roastLanguage = "en"
)

func normalizeRoastLanguage(value string) roastLanguage {
	if strings.ToLower(strings.TrimSpace(value)) == "zh" {
		return roastLanguageZH
	}
	return roastLanguageEN
}

func roastCacheKey(username string, language roastLanguage) string {
	return "roast:v10:v9:v4:" + string(language) + ":" + strings.ToLower(strings.TrimSpace(username))
}

func roastLockKey(username string, language roastLanguage) string {
	return "lock:roast:v10:v9:v4:" + string(language) + ":" + strings.ToLower(strings.TrimSpace(username))
}

func (s *UpstashStatusStore) GetCachedRoast(ctx context.Context, username string, language roastLanguage) (*CachedRoast, error) {
	raw, found, err := s.command(ctx, "GET", roastCacheKey(username, language))
	if err != nil || !found || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, err
	}
	var roast CachedRoast
	if err := decodeRedisJSON(raw, &roast); err != nil {
		return nil, fmt.Errorf("decode cached roast: %w", err)
	}
	if roast.Report == "" {
		return nil, fmt.Errorf("cached roast has no report")
	}
	return &roast, nil
}

func (s *UpstashStatusStore) SetCachedRoast(ctx context.Context, username string, language roastLanguage, roast CachedRoast) error {
	encoded, err := json.Marshal(roast)
	if err != nil {
		return fmt.Errorf("encode cached roast: %w", err)
	}
	_, _, err = s.command(ctx, "SET", roastCacheKey(username, language), string(encoded), "EX", int(roastCacheTTL.Seconds()))
	return err
}

func (s *UpstashStatusStore) ClearCachedRoast(ctx context.Context, username string, language roastLanguage) error {
	_, _, err := s.command(ctx, "DEL", roastCacheKey(username, language))
	return err
}

func (s *UpstashStatusStore) TryAcquireRoastLock(ctx context.Context, username string, language roastLanguage) (bool, error) {
	raw, _, err := s.command(ctx, "SET", roastLockKey(username, language), "1", "NX", "EX", int(roastLockTTL.Seconds()))
	if err != nil || len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return false, err
	}
	var result string
	if err := json.Unmarshal(raw, &result); err != nil {
		return false, fmt.Errorf("decode roast lock: %w", err)
	}
	return result == "OK", nil
}

func (s *UpstashStatusStore) ReleaseRoastLock(ctx context.Context, username string, language roastLanguage) error {
	_, _, err := s.command(ctx, "DEL", roastLockKey(username, language))
	return err
}

func (s *UpstashStatusStore) HasRoastLock(ctx context.Context, username string, language roastLanguage) (bool, error) {
	raw, found, err := s.command(ctx, "GET", roastLockKey(username, language))
	return err == nil && found && len(raw) > 0 && !bytes.Equal(raw, []byte("null")), err
}
