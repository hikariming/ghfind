package backend

import (
	"context"
	"fmt"
	"time"
)

const (
	developerFacetCategoryLimit = 100
	developersPerFacetLimit     = 250
	developersCacheControl      = "public, s-maxage=300, stale-while-revalidate=1800"
)

// FacetCategory is the public category-grid record returned by /api/developers.
type FacetCategory struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

// DevelopersStore is the existing Turso read model for the public directory.
// It only queries score and developer_facet data; it does not create or migrate
// either schema.
type DevelopersStore interface {
	GetFacetCategories(context.Context, string) ([]FacetCategory, error)
	GetDevelopersByFacet(context.Context, string, string) ([]LeaderboardEntry, error)
}

// DeveloperCache keeps using the existing Upstash cache keys created by Next.
type DeveloperCache interface {
	GetFacetCategories(context.Context, string) ([]FacetCategory, bool, error)
	SetFacetCategories(context.Context, string, []FacetCategory) error
	GetFacetDevelopers(context.Context, string, string) ([]LeaderboardEntry, bool, error)
	SetFacetDevelopers(context.Context, string, string, []LeaderboardEntry) error
}

func validFacetType(value string) bool {
	return value == "language" || value == "org" || value == "repo"
}

func (s *TursoStore) GetFacetCategories(ctx context.Context, facetType string) ([]FacetCategory, error) {
	if !validFacetType(facetType) {
		return nil, fmt.Errorf("invalid facet type %q", facetType)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT f.facet_value AS value, COUNT(*) AS count
		FROM developer_facets AS f
		JOIN scores AS s ON s.username = f.username
		WHERE f.facet_type = ?
		  AND s.hidden = 0
		  AND s.score_version = ?
		  AND s.final_score >= ?
		GROUP BY f.facet_value
		ORDER BY count DESC, f.facet_value ASC
		LIMIT ?`, facetType, canonicalScoreVersion, leaderboardMinScore, developerFacetCategoryLimit)
	if err != nil {
		return nil, fmt.Errorf("list %s facet categories: %w", facetType, err)
	}
	defer rows.Close()
	result := []FacetCategory{}
	for rows.Next() {
		var category FacetCategory
		if err := rows.Scan(&category.Value, &category.Count); err != nil {
			return nil, fmt.Errorf("scan %s facet category: %w", facetType, err)
		}
		result = append(result, category)
	}
	return result, rows.Err()
}

func (s *TursoStore) GetDevelopersByFacet(
	ctx context.Context,
	facetType, facetValue string,
) ([]LeaderboardEntry, error) {
	if !validFacetType(facetType) {
		return nil, fmt.Errorf("invalid facet type %q", facetType)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
		s.final_score, s.tier, s.tags, s.score_version,
		MAX(COALESCE(stats.lookup_count, 0), ?) AS lookup_count,
		0 AS recent_lookup_count,
		stats.last_lookup_at AS last_lookup_at
		FROM developer_facets AS f
		JOIN scores AS s ON s.username = f.username
		LEFT JOIN account_stats AS stats ON stats.username = s.username
		WHERE f.facet_type = ?
		  AND f.facet_value = ?
		  AND s.hidden = 0
		  AND s.score_version = ?
		  AND s.final_score >= ?
		ORDER BY s.final_score DESC, s.scanned_at DESC
		LIMIT ?`, minimumRecordedLookups, facetType, facetValue, canonicalScoreVersion, leaderboardMinScore, developersPerFacetLimit)
	if err != nil {
		return nil, fmt.Errorf("list %s developers: %w", facetType, err)
	}
	defer rows.Close()
	now := time.Now().UnixMilli()
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
