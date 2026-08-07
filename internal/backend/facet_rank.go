package backend

import (
	"context"
	"database/sql"
	"fmt"
)

const facetRankCacheControl = "public, s-maxage=300, stale-while-revalidate=600"

type FacetRankAhead struct {
	Username   string  `json:"username"`
	FinalScore float64 `json:"final_score"`
}

// FacetRankData preserves the camelCase data shape of the existing endpoint.
type FacetRankData struct {
	FacetType  string          `json:"facetType"`
	FacetValue string          `json:"facetValue"`
	Rank       int             `json:"rank"`
	Total      int             `json:"total"`
	Ahead      *FacetRankAhead `json:"ahead"`
}

type FacetRankStore interface {
	GetFacetRank(context.Context, string) (*FacetRankData, error)
}

func (s *TursoStore) GetFacetRank(ctx context.Context, username string) (*FacetRankData, error) {
	var canonicalUsername string
	var score float64
	err := s.db.QueryRowContext(ctx, `SELECT username, final_score
		FROM scores
		WHERE username = ? AND hidden = 0 AND score_version = ?
		LIMIT 1`, username, canonicalScoreVersion).Scan(&canonicalUsername, &score)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read facet-rank score brief: %w", err)
	}
	if score < leaderboardMinScore {
		return nil, nil
	}

	var facetValue string
	err = s.db.QueryRowContext(ctx, `SELECT facet_value FROM developer_facets
		WHERE username = ? AND facet_type = 'language'
		ORDER BY weight DESC LIMIT 1`, canonicalUsername).Scan(&facetValue)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read primary facet: %w", err)
	}
	var above, total int
	if err := s.db.QueryRowContext(ctx, `SELECT
		COALESCE(SUM(CASE WHEN s.final_score > ? THEN 1 ELSE 0 END), 0),
		COUNT(*)
		FROM developer_facets AS f
		JOIN scores AS s ON s.username = f.username
		WHERE f.facet_type = 'language'
		  AND f.facet_value = ?
		  AND s.hidden = 0
		  AND s.score_version = ?
		  AND s.final_score >= ?`, score, facetValue, canonicalScoreVersion, leaderboardMinScore).Scan(&above, &total); err != nil {
		return nil, fmt.Errorf("count facet rank: %w", err)
	}
	if total <= 1 {
		return nil, nil
	}
	result := &FacetRankData{
		FacetType: "language", FacetValue: facetValue, Rank: above + 1, Total: total,
	}
	var ahead FacetRankAhead
	err = s.db.QueryRowContext(ctx, `SELECT s.username, s.final_score
		FROM developer_facets AS f
		JOIN scores AS s ON s.username = f.username
		WHERE f.facet_type = 'language'
		  AND f.facet_value = ?
		  AND s.hidden = 0
		  AND s.score_version = ?
		  AND s.final_score > ?
		ORDER BY s.final_score ASC
		LIMIT 1`, facetValue, canonicalScoreVersion, score).Scan(&ahead.Username, &ahead.FinalScore)
	if err == nil {
		result.Ahead = &ahead
	} else if err != sql.ErrNoRows {
		return nil, fmt.Errorf("read facet-rank ahead account: %w", err)
	}
	return result, nil
}
