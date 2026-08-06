package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
)

type UserSuggestion struct {
	Username    string  `json:"username"`
	DisplayName *string `json:"display_name"`
	AvatarURL   *string `json:"avatar_url"`
	FinalScore  float64 `json:"final_score"`
	Tier        string  `json:"tier"`
}

type RepoSuggestion struct {
	RepoKey       string   `json:"repo_key"`
	NameWithOwner string   `json:"name_with_owner"`
	OwnerLogin    string   `json:"owner_login"`
	Name          string   `json:"name"`
	Description   *string  `json:"description"`
	Stars         int      `json:"stars"`
	Forks         *int     `json:"forks"`
	Language      *string  `json:"language"`
	Topics        []string `json:"topics"`
	Href          string   `json:"href"`
}

type FacetSuggestion struct {
	Value string `json:"value"`
	Count int    `json:"count"`
	Type  string `json:"type"`
	Href  string `json:"href"`
}

type DiscoverySearchResult struct {
	Users  []UserSuggestion  `json:"users"`
	Repos  []RepoSuggestion  `json:"repos"`
	Facets []FacetSuggestion `json:"facets"`
}

type DiscoveryStore interface {
	SearchDiscovery(context.Context, string) (DiscoverySearchResult, error)
}

func emptyDiscovery() DiscoverySearchResult {
	return DiscoverySearchResult{Users: []UserSuggestion{}, Repos: []RepoSuggestion{}, Facets: []FacetSuggestion{}}
}

// SearchDiscovery ports the existing omnibox read model. Each subquery fails
// independently to an empty group, matching the current client-safe behavior
// instead of making an autocomplete keystroke a hard 500.
func (s *TursoStore) SearchDiscovery(ctx context.Context, rawQuery string) (DiscoverySearchResult, error) {
	query := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(rawQuery), "@"))
	if query == "" {
		return emptyDiscovery(), nil
	}
	users, usersErr := s.searchUsers(ctx, query)
	repos, reposErr := s.searchRepos(ctx, query)
	languages, languageErr := s.facetCategories(ctx, "language")
	organizations, organizationErr := s.facetCategories(ctx, "org")
	if usersErr != nil {
		users = []UserSuggestion{}
	}
	if reposErr != nil {
		repos = []RepoSuggestion{}
	}
	if languageErr != nil {
		languages = []facetCategory{}
	}
	if organizationErr != nil {
		organizations = []facetCategory{}
	}

	facets := make([]FacetSuggestion, 0, 6)
	for _, category := range append(languages, organizations...) {
		if !strings.HasPrefix(strings.ToLower(category.Value), query) {
			continue
		}
		facets = append(facets, FacetSuggestion{
			Value: category.Value,
			Count: category.Count,
			Type:  category.Type,
			Href:  "/developers/" + category.Type + "/" + encodeSegments(category.Value),
		})
	}
	sort.Slice(facets, func(i, j int) bool {
		if facets[i].Count != facets[j].Count {
			return facets[i].Count > facets[j].Count
		}
		return facets[i].Value < facets[j].Value
	})
	if len(facets) > 6 {
		facets = facets[:6]
	}
	return DiscoverySearchResult{Users: users, Repos: repos, Facets: facets}, nil
}

func (s *TursoStore) searchUsers(ctx context.Context, query string) ([]UserSuggestion, error) {
	like := escapeLike(query) + "%"
	rows, err := s.db.QueryContext(ctx, `SELECT username, display_name, avatar_url, final_score, tier
		FROM scores
		WHERE hidden = 0 AND score_version = ? AND username LIKE ? ESCAPE '\\'
		ORDER BY final_score DESC LIMIT 6`, canonicalScoreVersion, like)
	if err != nil {
		return nil, fmt.Errorf("search users: %w", err)
	}
	defer rows.Close()
	result := []UserSuggestion{}
	for rows.Next() {
		var suggestion UserSuggestion
		var displayName, avatarURL sql.NullString
		if err := rows.Scan(&suggestion.Username, &displayName, &avatarURL, &suggestion.FinalScore, &suggestion.Tier); err != nil {
			return nil, fmt.Errorf("scan user suggestion: %w", err)
		}
		suggestion.DisplayName = nullableString(displayName)
		suggestion.AvatarURL = nullableString(avatarURL)
		result = append(result, suggestion)
	}
	return result, rows.Err()
}

func (s *TursoStore) searchRepos(ctx context.Context, query string) ([]RepoSuggestion, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT repo_key, name_with_owner, owner_login, name, description,
		stars, forks, language, topics
		FROM repos
		WHERE lower(repo_key) LIKE ? OR lower(name) LIKE ?
		ORDER BY stars DESC, repo_key ASC LIMIT 4`, query+"%", query+"%")
	if err != nil {
		return nil, fmt.Errorf("search repos: %w", err)
	}
	defer rows.Close()
	result := []RepoSuggestion{}
	for rows.Next() {
		var suggestion RepoSuggestion
		var description, language, topics sql.NullString
		var forks sql.NullInt64
		if err := rows.Scan(
			&suggestion.RepoKey, &suggestion.NameWithOwner, &suggestion.OwnerLogin, &suggestion.Name,
			&description, &suggestion.Stars, &forks, &language, &topics,
		); err != nil {
			return nil, fmt.Errorf("scan repo suggestion: %w", err)
		}
		suggestion.Description = nullableString(description)
		suggestion.Language = nullableString(language)
		if forks.Valid {
			value := int(forks.Int64)
			suggestion.Forks = &value
		}
		if topics.Valid {
			_ = json.Unmarshal([]byte(topics.String), &suggestion.Topics)
		}
		if suggestion.Topics == nil {
			suggestion.Topics = []string{}
		}
		suggestion.Href = "/developers/repo/" + encodeSegments(suggestion.RepoKey)
		result = append(result, suggestion)
	}
	return result, rows.Err()
}

type facetCategory struct {
	Value string
	Count int
	Type  string
}

func (s *TursoStore) facetCategories(ctx context.Context, facetType string) ([]facetCategory, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT f.facet_value, COUNT(*) AS count
		FROM developer_facets AS f
		JOIN scores AS s ON s.username = f.username
		WHERE f.facet_type = ? AND s.hidden = 0 AND s.score_version = ? AND s.final_score >= 60
		GROUP BY f.facet_value ORDER BY count DESC, f.facet_value ASC LIMIT 100`, facetType, canonicalScoreVersion)
	if err != nil {
		return nil, fmt.Errorf("list %s facets: %w", facetType, err)
	}
	defer rows.Close()
	result := []facetCategory{}
	for rows.Next() {
		var category facetCategory
		category.Type = facetType
		if err := rows.Scan(&category.Value, &category.Count); err != nil {
			return nil, fmt.Errorf("scan %s facet: %w", facetType, err)
		}
		result = append(result, category)
	}
	return result, rows.Err()
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	copy := value.String
	return &copy
}

func escapeLike(value string) string {
	replacer := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_")
	return replacer.Replace(value)
}

func encodeSegments(value string) string {
	parts := strings.Split(value, "/")
	for index := range parts {
		parts[index] = url.PathEscape(parts[index])
	}
	return strings.Join(parts, "/")
}
