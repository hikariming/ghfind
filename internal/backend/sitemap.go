package backend

import (
	"context"
	"fmt"
	"net/http"
)

// SitemapStore serves the bounded, indexable public URL inventory. It is kept
// separate from profile presentation because sitemap regeneration is cached by
// Next and must not incur the per-profile related-data reads.
type SitemapStore interface {
	GetPublicSitemapProfiles(context.Context, float64) ([]SitemapProfile, error)
	GetIndexableSitemapMatchups(context.Context, float64) ([]SitemapMatchup, error)
}

type SitemapProfile struct {
	Username  string `json:"username"`
	ScannedAt int64  `json:"scanned_at"`
}

type SitemapMatchup struct {
	A         string `json:"a"`
	B         string `json:"b"`
	UpdatedAt int64  `json:"updatedAt"`
}

func (s *TursoStore) GetPublicSitemapProfiles(ctx context.Context, minimumScore float64) ([]SitemapProfile, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT username, scanned_at FROM scores
		WHERE hidden = 0 AND score_version = ? AND final_score >= ?
		ORDER BY username ASC`, canonicalScoreVersion, minimumScore)
	if err != nil {
		return nil, fmt.Errorf("read sitemap profiles: %w", err)
	}
	defer rows.Close()
	result := []SitemapProfile{}
	for rows.Next() {
		var profile SitemapProfile
		if err := rows.Scan(&profile.Username, &profile.ScannedAt); err != nil {
			return nil, err
		}
		result = append(result, profile)
	}
	return result, rows.Err()
}

func (s *TursoStore) GetIndexableSitemapMatchups(ctx context.Context, minimumScore float64) ([]SitemapMatchup, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT handle_a, handle_b, updated_at FROM vs_matchups
		WHERE verdict IS NOT NULL AND score_a >= ? AND score_b >= ?`, minimumScore, minimumScore)
	if err != nil {
		return nil, fmt.Errorf("read sitemap matchups: %w", err)
	}
	defer rows.Close()
	result := []SitemapMatchup{}
	for rows.Next() {
		var matchup SitemapMatchup
		if err := rows.Scan(&matchup.A, &matchup.B, &matchup.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, matchup)
	}
	return result, rows.Err()
}

func (s *APIServer) sitemapInventory(w http.ResponseWriter, request *http.Request) {
	store, ok := s.scores.(SitemapStore)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "sitemap_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	profiles, profilesErr := store.GetPublicSitemapProfiles(request.Context(), leaderboardMinScore)
	matchups, matchupsErr := store.GetIndexableSitemapMatchups(request.Context(), vsMinimumScore)
	if profilesErr != nil || matchupsErr != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "sitemap_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profiles": profiles, "matchups": matchups}, map[string]string{"Cache-Control": "public, s-maxage=3600, stale-while-revalidate=3600"})
}

var _ SitemapStore = (*TursoStore)(nil)
