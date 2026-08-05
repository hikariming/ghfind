package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

const (
	leaderboardLimit       = 500
	leaderboardMinScore    = 60
	minimumRecordedLookups = 1
)

type LeaderboardEntry struct {
	Username          string   `json:"username"`
	DisplayName       *string  `json:"display_name"`
	AvatarURL         *string  `json:"avatar_url"`
	ProfileURL        *string  `json:"profile_url"`
	FinalScore        float64  `json:"final_score"`
	Tier              string   `json:"tier"`
	Tags              Tags     `json:"tags"`
	LookupCount       int      `json:"lookup_count"`
	RecentLookupCount int      `json:"recent_lookup_count"`
	TrendingScore     float64  `json:"trending_score"`
	PrevScore         *float64 `json:"prev_score,omitempty"`
	Delta             *float64 `json:"delta,omitempty"`
	lastLookupAt      *int64
}

type Tags struct {
	ZH []string `json:"zh"`
	EN []string `json:"en"`
}

type LeaderboardStore interface {
	GetLeaderboard(context.Context, string, string) ([]LeaderboardEntry, error)
}

type LeaderboardCache interface {
	GetLeaderboard(context.Context, string, string) ([]LeaderboardEntry, bool, error)
	SetLeaderboard(context.Context, string, string, []LeaderboardEntry) error
}

func (s *TursoStore) GetLeaderboard(ctx context.Context, view, window string) ([]LeaderboardEntry, error) {
	if !validLeaderboardView(view) {
		view = "trending"
	}
	if !validLeaderboardWindow(window) {
		window = "all"
	}
	now := time.Now().UnixMilli()
	cutoff, activeOnly := leaderboardWindowCutoff(window, now)
	switch view {
	case "score":
		return s.orderedLeaderboard(ctx, cutoff, activeOnly, "s.final_score DESC, s.scanned_at DESC", false, now, leaderboardLimit)
	case "heat":
		order := "lookup_count DESC, s.final_score DESC, s.scanned_at DESC"
		if activeOnly {
			order = "recent_lookup_count DESC, s.final_score DESC, s.scanned_at DESC"
		}
		return s.orderedLeaderboard(ctx, cutoff, activeOnly, order, false, now, leaderboardLimit)
	case "progress":
		return s.progressLeaderboard(ctx, cutoff, activeOnly, now)
	default:
		// The Next implementation ranks the complete candidate set in memory and
		// only then trims to 500. Applying SQL LIMIT first (even with a stable
		// alphabetical order) would silently exclude a later, hotter account.
		entries, err := s.orderedLeaderboard(ctx, cutoff, activeOnly, "s.username ASC", false, now, 0)
		if err != nil {
			return nil, err
		}
		sort.SliceStable(entries, func(i, j int) bool { return trendingBefore(entries[i], entries[j], now) })
		if len(entries) > leaderboardLimit {
			entries = entries[:leaderboardLimit]
		}
		return entries, nil
	}
}

func (s *TursoStore) orderedLeaderboard(
	ctx context.Context,
	cutoff int64,
	activeOnly bool,
	order string,
	includeProgress bool,
	now int64,
	limit int,
) ([]LeaderboardEntry, error) {
	progressColumn := ""
	if includeProgress {
		progressColumn = ", s.prev_score"
	}
	activeClause := ""
	if activeOnly {
		activeClause = "AND recent.recent_lookup_count > 0"
	}
	query := fmt.Sprintf(`SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
  s.final_score, s.tier, s.tags, s.score_version%s,
  MAX(COALESCE(stats.lookup_count, 0), ?) AS lookup_count,
  COALESCE(recent.recent_lookup_count, 0) AS recent_lookup_count,
  stats.last_lookup_at AS last_lookup_at
FROM scores AS s
LEFT JOIN account_stats AS stats ON stats.username = s.username
LEFT JOIN (
  SELECT username, COUNT(*) AS recent_lookup_count
  FROM account_lookup_limits WHERE last_counted_at >= ? GROUP BY username
) AS recent ON recent.username = s.username
WHERE s.hidden = 0 AND s.score_version = ? AND s.final_score >= ? %s
ORDER BY %s`, progressColumn, activeClause, order)
	args := []any{minimumRecordedLookups, cutoff, canonicalScoreVersion, leaderboardMinScore}
	if limit > 0 {
		query += " LIMIT ?"
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query %s leaderboard: %w", order, err)
	}
	defer rows.Close()
	entries := []LeaderboardEntry{}
	for rows.Next() {
		entry, err := scanLeaderboardEntry(rows, includeProgress, now)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func (s *TursoStore) progressLeaderboard(ctx context.Context, cutoff int64, activeOnly bool, now int64) ([]LeaderboardEntry, error) {
	activeClause := ""
	if activeOnly {
		activeClause = "AND recent.recent_lookup_count > 0"
	}
	query := fmt.Sprintf(`SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
  s.final_score, s.tier, s.tags, s.score_version, s.prev_score,
	  MAX(COALESCE(stats.lookup_count, 0), ?) AS lookup_count,
  COALESCE(recent.recent_lookup_count, 0) AS recent_lookup_count,
  stats.last_lookup_at AS last_lookup_at
FROM scores AS s
LEFT JOIN account_stats AS stats ON stats.username = s.username
LEFT JOIN (
  SELECT username, COUNT(*) AS recent_lookup_count
  FROM account_lookup_limits WHERE last_counted_at >= ? GROUP BY username
) AS recent ON recent.username = s.username
WHERE s.hidden = 0 AND s.score_version = ? AND s.prev_score IS NOT NULL
  AND s.final_score > s.prev_score %s
ORDER BY (s.final_score - s.prev_score) DESC, s.scanned_at DESC LIMIT ?`, activeClause)
	rows, err := s.db.QueryContext(ctx, query, minimumRecordedLookups, cutoff, canonicalScoreVersion, leaderboardLimit)
	if err != nil {
		return nil, fmt.Errorf("query progress leaderboard: %w", err)
	}
	defer rows.Close()
	entries := []LeaderboardEntry{}
	for rows.Next() {
		entry, err := scanLeaderboardEntry(rows, true, now)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

type rowScanner interface{ Scan(...any) error }

func scanLeaderboardEntry(rows rowScanner, includesProgress bool, now int64) (LeaderboardEntry, error) {
	var entry LeaderboardEntry
	var displayName, avatarURL, profileURL, tags, version sql.NullString
	var lastLookup sql.NullInt64
	var prev sql.NullFloat64
	scanArgs := []any{
		&entry.Username, &displayName, &avatarURL, &profileURL, &entry.FinalScore,
		&entry.Tier, &tags, &version,
	}
	if includesProgress {
		scanArgs = append(scanArgs, &prev)
	}
	scanArgs = append(scanArgs, &entry.LookupCount, &entry.RecentLookupCount, &lastLookup)
	if err := rows.Scan(scanArgs...); err != nil {
		return LeaderboardEntry{}, fmt.Errorf("scan leaderboard entry: %w", err)
	}
	entry.DisplayName = nullableString(displayName)
	entry.AvatarURL = nullableString(avatarURL)
	entry.ProfileURL = nullableString(profileURL)
	entry.Tags = parseTags(tags.String)
	entry.LookupCount = maxInt(minimumRecordedLookups, entry.LookupCount)
	entry.RecentLookupCount = maxInt(0, entry.RecentLookupCount)
	if lastLookup.Valid {
		value := lastLookup.Int64
		entry.lastLookupAt = &value
	}
	entry.TrendingScore = computeTrendingScore(entry, now)
	if includesProgress && prev.Valid {
		value := prev.Float64
		entry.PrevScore = &value
		delta := entry.FinalScore - value
		entry.Delta = &delta
	}
	return entry, nil
}

func parseTags(raw string) Tags {
	parsed := Tags{ZH: []string{}, EN: []string{}}
	if raw == "" {
		return parsed
	}
	_ = json.Unmarshal([]byte(raw), &parsed)
	if parsed.ZH == nil {
		parsed.ZH = []string{}
	}
	if parsed.EN == nil {
		parsed.EN = []string{}
	}
	return parsed
}

func leaderboardWindowCutoff(window string, now int64) (cutoff int64, activeOnly bool) {
	switch window {
	case "24h":
		return now - int64(24*time.Hour/time.Millisecond), true
	case "7d":
		return now - int64(7*24*time.Hour/time.Millisecond), true
	case "30d":
		return now - int64(30*24*time.Hour/time.Millisecond), true
	default:
		return now - int64(7*24*time.Hour/time.Millisecond), false
	}
}

func validLeaderboardView(value string) bool {
	return value == "trending" || value == "score" || value == "heat" || value == "progress"
}

func validLeaderboardWindow(value string) bool {
	return value == "all" || value == "24h" || value == "7d" || value == "30d"
}

func computeTrendingScore(entry LeaderboardEntry, now int64) float64 {
	recentHeat := clamp((math.Log1p(float64(entry.RecentLookupCount))/math.Log1p(20))*100, 0, 100)
	recency := 0.0
	if entry.lastLookupAt != nil {
		ageHours := math.Max(0, float64(now-*entry.lastLookupAt)/float64(time.Hour/time.Millisecond))
		recency = math.Exp(-ageHours/(24*7)) * 100
	}
	return clamp(entry.FinalScore, 0, 100)*0.8 + recentHeat*0.15 + recency*0.05
}

func trendingBefore(left, right LeaderboardEntry, now int64) bool {
	leftTrend := computeTrendingScore(left, now)
	rightTrend := computeTrendingScore(right, now)
	if leftTrend != rightTrend {
		return leftTrend > rightTrend
	}
	if left.FinalScore != right.FinalScore {
		return left.FinalScore > right.FinalScore
	}
	if left.LookupCount != right.LookupCount {
		return left.LookupCount > right.LookupCount
	}
	return strings.Compare(left.Username, right.Username) < 0
}

func clamp(value, min, max float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return min
	}
	return math.Min(max, math.Max(min, value))
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
