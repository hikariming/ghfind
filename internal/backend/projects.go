package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

type ProjectRepo struct {
	RepoKey       string   `json:"repo_key"`
	NameWithOwner string   `json:"name_with_owner"`
	OwnerLogin    string   `json:"owner_login"`
	Name          string   `json:"name"`
	Description   *string  `json:"description"`
	Stars         float64  `json:"stars"`
	Forks         *float64 `json:"forks"`
	Language      *string  `json:"language"`
	Topics        []string `json:"topics"`
}

type ProjectOwner struct {
	Username    string  `json:"username"`
	DisplayName *string `json:"display_name"`
	AvatarURL   *string `json:"avatar_url"`
	FinalScore  float64 `json:"final_score"`
	Tier        string  `json:"tier"`
}

type ProjectSummary struct {
	Count      int     `json:"count"`
	AvgScore   float64 `json:"avgScore"`
	TierCounts []struct {
		Tier  string `json:"tier"`
		Count int    `json:"count"`
	} `json:"tierCounts"`
}

type ProjectOverview struct {
	Repo    ProjectRepo    `json:"repo"`
	Owner   *ProjectOwner  `json:"owner"`
	Summary ProjectSummary `json:"summary"`
}

func projectRepoFromRow(scanner interface{ Scan(...any) error }) (ProjectRepo, error) {
	var repo ProjectRepo
	var description, language, topics sql.NullString
	var forks sql.NullFloat64
	err := scanner.Scan(&repo.RepoKey, &repo.NameWithOwner, &repo.OwnerLogin, &repo.Name, &description, &repo.Stars, &forks, &language, &topics)
	if err != nil {
		return repo, err
	}
	if description.Valid && description.String != "" {
		repo.Description = &description.String
	}
	if language.Valid && language.String != "" {
		repo.Language = &language.String
	}
	if forks.Valid {
		repo.Forks = &forks.Float64
	}
	// A NULL, malformed, or JSON-null topics column is published as [].
	repo.Topics = []string{}
	if topics.Valid && topics.String != "" {
		if err := json.Unmarshal([]byte(topics.String), &repo.Topics); err != nil || repo.Topics == nil {
			repo.Topics = []string{}
		}
	}
	return repo, nil
}

// ListFeedProjectOverviews reads only the repository metadata used by the Feed
// descriptor. The public project overview also computes owner and contributor
// aggregates, which would turn a catalog reconciliation into an N+1 workload
// against the same Turso database serving existing product routes.
func (s *TursoStore) ListFeedProjectOverviews(ctx context.Context, repoKeys []string) (map[string]*ProjectOverview, error) {
	result := make(map[string]*ProjectOverview, len(repoKeys))
	values := make([]string, 0, len(repoKeys))
	seen := map[string]bool{}
	for _, repoKey := range repoKeys {
		repoKey = strings.ToLower(strings.TrimSpace(repoKey))
		if repoKey != "" && !seen[repoKey] {
			seen[repoKey] = true
			values = append(values, repoKey)
		}
	}
	if len(values) == 0 {
		return result, nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(values)), ",")
	args := make([]any, len(values))
	for index := range values {
		args[index] = values[index]
	}
	rows, err := s.db.QueryContext(ctx, `SELECT repo_key,name_with_owner,owner_login,name,description,stars,forks,language,topics
		FROM repos WHERE repo_key IN (`+placeholders+`) ORDER BY repo_key`, args...)
	if err != nil {
		return nil, fmt.Errorf("read Feed project metadata: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		repo, err := projectRepoFromRow(rows)
		if err != nil {
			return nil, fmt.Errorf("scan Feed project metadata: %w", err)
		}
		result[repo.RepoKey] = &ProjectOverview{Repo: repo}
	}
	return result, rows.Err()
}
