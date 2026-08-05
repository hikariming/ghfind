package backend

import (
	"context"
	"fmt"
	"time"
)

const (
	campaignLeaderboardLimit        = 500
	campaignLeaderboardCacheControl = "public, s-maxage=10, stale-while-revalidate=30"
)

type CampaignLeaderboardStore interface {
	GetCampaignLeaderboard(context.Context, string) ([]LeaderboardEntry, error)
}

func validCampaign(value string) bool { return value == "advx" }

func (s *TursoStore) GetCampaignLeaderboard(ctx context.Context, campaign string) ([]LeaderboardEntry, error) {
	if !validCampaign(campaign) {
		return nil, fmt.Errorf("unknown campaign %q", campaign)
	}
	now := time.Now().UnixMilli()
	recentCutoff := now - int64(weeklyBaselineWindow/time.Millisecond)
	rows, err := s.db.QueryContext(ctx, `SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
		s.final_score, s.tier, s.tags, s.score_version,
		MAX(COALESCE(stats.lookup_count, 0), ?) AS lookup_count,
		COALESCE(recent.recent_lookup_count, 0) AS recent_lookup_count,
		stats.last_lookup_at AS last_lookup_at
		FROM campaign_participants AS participant
		JOIN scores AS s ON s.username = participant.username
		LEFT JOIN account_stats AS stats ON stats.username = s.username
		LEFT JOIN (
			SELECT username, COUNT(*) AS recent_lookup_count
			FROM account_lookup_limits
			WHERE last_counted_at >= ?
			GROUP BY username
		) AS recent ON recent.username = s.username
		WHERE participant.campaign = ?
		  AND s.hidden = 0
		  AND s.score_version = ?
		ORDER BY s.final_score DESC, s.scanned_at DESC
		LIMIT ?`, minimumRecordedLookups, recentCutoff, campaign, canonicalScoreVersion, campaignLeaderboardLimit)
	if err != nil {
		return nil, fmt.Errorf("query campaign leaderboard: %w", err)
	}
	defer rows.Close()
	entries := []LeaderboardEntry{}
	for rows.Next() {
		entry, err := scanLeaderboardEntry(rows, false, now)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}
