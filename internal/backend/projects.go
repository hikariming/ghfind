package backend

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
)

const projectsCacheControl = "public, max-age=0, s-maxage=300, stale-while-revalidate=600"

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

type ProjectListItem struct {
	Repo             ProjectRepo    `json:"repo"`
	ContributorCount int            `json:"contributorCount"`
	AvgScore         float64        `json:"avgScore"`
	EliteCount       int            `json:"eliteCount"`
	Momentum         float64        `json:"momentum"`
	QualityScore     float64        `json:"qualityScore"`
	TopContributors  []ProjectOwner `json:"topContributors"`
}

type RelatedProject struct {
	Project                ProjectListItem `json:"project"`
	SharedContributorCount int             `json:"sharedContributorCount"`
}

type ProjectListOptions struct {
	Sort     string
	Language string
	Limit    int
	Offset   int
	RepoKeys []string
}

type ProjectsStore interface {
	GetProjects(context.Context, ProjectListOptions) ([]ProjectListItem, error)
	GetProjectOverview(context.Context, string) (*ProjectOverview, error)
	GetRelatedProjects(context.Context, string, int) ([]RelatedProject, error)
}

func projectRepoFromRow(scanner interface{ Scan(...any) error }) (ProjectRepo, error) {
	var repo ProjectRepo
	var description, language, topics sql.NullString
	var forks sql.NullFloat64
	err := scanner.Scan(&repo.RepoKey, &repo.NameWithOwner, &repo.OwnerLogin, &repo.Name, &description, &repo.Stars, &forks, &language, &topics)
	if err != nil {
		return repo, err
	}
	repo.Description, repo.Language = nullableProfileString(description), nullableProfileString(language)
	repo.Forks = nullableProfileFloat(forks)
	repo.Topics = decodeJSONSlice[string](topics)
	return repo, nil
}

func projectQuality(avg float64, count int) float64 {
	if count <= 0 || math.IsNaN(avg) || math.IsInf(avg, 0) {
		return 0
	}
	return avg * math.Log2(float64(count)+1)
}

func projectOptions(options ProjectListOptions) ProjectListOptions {
	if options.Sort != "stars" && options.Sort != "momentum" {
		options.Sort = "quality"
	}
	if options.Limit < 1 {
		options.Limit = 24
	}
	if options.Limit > 200 {
		options.Limit = 200
	}
	if options.Offset < 0 {
		options.Offset = 0
	}
	return options
}

func projectOrder(left, right ProjectListItem, mode string) bool {
	var primary float64
	switch mode {
	case "stars":
		primary = right.Repo.Stars - left.Repo.Stars
	case "momentum":
		primary = right.Momentum - left.Momentum
		if primary == 0 {
			primary = right.QualityScore - left.QualityScore
		}
	default:
		primary = right.QualityScore - left.QualityScore
		if primary == 0 {
			primary = right.Repo.Stars - left.Repo.Stars
		}
	}
	return primary < 0 || (primary == 0 && left.Repo.RepoKey < right.Repo.RepoKey)
}

func (s *TursoStore) GetProjects(ctx context.Context, input ProjectListOptions) ([]ProjectListItem, error) {
	options := projectOptions(input)
	where := ""
	args := []any{time.Now().UnixMilli() - int64(7*24*time.Hour/time.Millisecond), canonicalScoreVersion, goCanonicalCollectionVersion}
	if options.Language != "" {
		where = "WHERE lower(r.language) = lower(?)"
		args = append(args, options.Language)
	}
	if len(options.RepoKeys) > 0 {
		values := make([]string, 0, len(options.RepoKeys))
		for _, key := range options.RepoKeys {
			if key = strings.ToLower(strings.TrimSpace(key)); key != "" {
				values = append(values, key)
			}
		}
		if len(values) == 0 {
			return []ProjectListItem{}, nil
		}
		placeholders := strings.TrimRight(strings.Repeat("?,", len(values)), ",")
		if where == "" {
			where = "WHERE r.repo_key IN (" + placeholders + ")"
		} else {
			where += " AND r.repo_key IN (" + placeholders + ")"
		}
		for _, value := range values {
			args = append(args, value)
		}
	}
	rows, err := s.db.QueryContext(ctx, `WITH edges AS (
		SELECT DISTINCT repo_key, username FROM repo_developers
	), recent AS (
		SELECT username, COUNT(*) AS recent_lookup_count FROM account_lookup_limits
		WHERE last_counted_at >= ? GROUP BY username
	)
	SELECT r.repo_key, r.name_with_owner, r.owner_login, r.name, r.description, r.stars, r.forks, r.language, r.topics,
		COUNT(*) AS contributor_count, AVG(s.final_score) AS avg_score,
		SUM(CASE WHEN s.tier IN ('夯', '顶级') THEN 1 ELSE 0 END) AS elite_count,
		COALESCE(SUM(recent.recent_lookup_count), 0) AS recent_lookup_count
	FROM repos AS r JOIN edges ON edges.repo_key = r.repo_key
		JOIN scores AS s ON s.username = edges.username AND s.hidden = 0
		AND s.score_version = ? AND s.score_source_collection_version = ?
		AND length(s.score_source_snapshot_hash) = 64 AND s.score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'
		LEFT JOIN recent ON recent.username = edges.username
	`+where+` GROUP BY r.repo_key`, args...)
	if err != nil {
		return nil, fmt.Errorf("read projects: %w", err)
	}
	defer rows.Close()
	items := []ProjectListItem{}
	for rows.Next() {
		var item ProjectListItem
		var description, language, topics sql.NullString
		var forks sql.NullFloat64
		var recent int
		if err := rows.Scan(&item.Repo.RepoKey, &item.Repo.NameWithOwner, &item.Repo.OwnerLogin, &item.Repo.Name, &description, &item.Repo.Stars, &forks, &language, &topics, &item.ContributorCount, &item.AvgScore, &item.EliteCount, &recent); err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		item.Repo.Description, item.Repo.Language, item.Repo.Forks = nullableProfileString(description), nullableProfileString(language), nullableProfileFloat(forks)
		item.Repo.Topics = decodeJSONSlice[string](topics)
		item.AvgScore = math.Round(item.AvgScore*10) / 10
		item.QualityScore = projectQuality(item.AvgScore, item.ContributorCount)
		if item.ContributorCount > 0 {
			item.Momentum = math.Round((float64(recent)/math.Sqrt(float64(item.ContributorCount)))*10) / 10
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(items, func(i, j int) bool { return projectOrder(items[i], items[j], options.Sort) })
	if options.Offset >= len(items) {
		return []ProjectListItem{}, nil
	}
	end := options.Offset + options.Limit
	if end > len(items) {
		end = len(items)
	}
	items = items[options.Offset:end]
	if err := s.attachProjectTopContributors(ctx, items); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *TursoStore) attachProjectTopContributors(ctx context.Context, items []ProjectListItem) error {
	for index := range items {
		// The public contract is an array; a repo with no scored contributors
		// must emit [] rather than null so Next card renderers can .map safely.
		items[index].TopContributors = make([]ProjectOwner, 0, 3)
		rows, err := s.db.QueryContext(ctx, `SELECT s.username, s.display_name, s.avatar_url, s.final_score, s.tier
			FROM (SELECT DISTINCT username FROM repo_developers WHERE repo_key = ?) AS edges
			JOIN scores AS s ON s.username = edges.username
			WHERE s.hidden = 0 AND s.score_version = ? AND s.score_source_collection_version = ?
				AND length(s.score_source_snapshot_hash) = 64 AND s.score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'
				AND s.final_score >= ? ORDER BY s.final_score DESC, s.username ASC LIMIT 3`, items[index].Repo.RepoKey, canonicalScoreVersion, goCanonicalCollectionVersion, leaderboardMinScore)
		if err != nil {
			return err
		}
		for rows.Next() {
			var contributor ProjectOwner
			var display, avatar sql.NullString
			if err := rows.Scan(&contributor.Username, &display, &avatar, &contributor.FinalScore, &contributor.Tier); err != nil {
				_ = rows.Close()
				return err
			}
			contributor.DisplayName, contributor.AvatarURL = nullableProfileString(display), nullableProfileString(avatar)
			items[index].TopContributors = append(items[index].TopContributors, contributor)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		_ = rows.Close()
	}
	return nil
}

func (s *TursoStore) GetProjectOverview(ctx context.Context, key string) (*ProjectOverview, error) {
	key = strings.ToLower(strings.TrimSpace(key))
	var repo ProjectRepo
	row := s.db.QueryRowContext(ctx, `SELECT repo_key, name_with_owner, owner_login, name, description, stars, forks, language, topics FROM repos WHERE repo_key = ?`, key)
	if parsed, err := projectRepoFromRow(row); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("read project overview: %w", err)
	} else {
		repo = parsed
	}
	result := &ProjectOverview{Repo: repo}
	var owner ProjectOwner
	var display, avatar sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT username, display_name, avatar_url, final_score, tier FROM scores
		WHERE username = ? AND hidden = 0 AND score_version = ? AND score_source_collection_version = ?
		AND length(score_source_snapshot_hash) = 64 AND score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*' LIMIT 1`, repo.OwnerLogin, canonicalScoreVersion, goCanonicalCollectionVersion).Scan(&owner.Username, &display, &avatar, &owner.FinalScore, &owner.Tier)
	if err == nil {
		owner.DisplayName, owner.AvatarURL = nullableProfileString(display), nullableProfileString(avatar)
		result.Owner = &owner
	} else if err != sql.ErrNoRows {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT s.tier, s.final_score FROM repo_developers AS rd JOIN scores AS s ON s.username = rd.username
		WHERE rd.repo_key = ? AND s.hidden = 0 AND s.score_version = ? AND s.score_source_collection_version = ?
		AND length(s.score_source_snapshot_hash) = 64 AND s.score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'`, key, canonicalScoreVersion, goCanonicalCollectionVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int{}
	sum, count := 0.0, 0
	for rows.Next() {
		var tier string
		var score float64
		if err := rows.Scan(&tier, &score); err != nil {
			return nil, err
		}
		counts[tier]++
		sum += score
		count++
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result.Summary.Count = count
	if count > 0 {
		result.Summary.AvgScore = math.Round(sum/float64(count)*10) / 10
	}
	for _, tier := range []string{"夯", "顶级", "人上人", "NPC", "拉完了"} {
		if counts[tier] > 0 {
			result.Summary.TierCounts = append(result.Summary.TierCounts, struct {
				Tier  string `json:"tier"`
				Count int    `json:"count"`
			}{Tier: tier, Count: counts[tier]})
		}
	}
	return result, nil
}

func (s *TursoStore) GetRelatedProjects(ctx context.Context, key string, limit int) ([]RelatedProject, error) {
	key = strings.ToLower(strings.TrimSpace(key))
	if limit < 1 {
		return []RelatedProject{}, nil
	}
	if limit > 50 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `SELECT rd.repo_key, COUNT(DISTINCT rd.username) FROM
		(SELECT DISTINCT username FROM repo_developers WHERE repo_key = ?) AS mine
		JOIN repo_developers AS rd ON rd.username = mine.username WHERE rd.repo_key <> ?
		GROUP BY rd.repo_key ORDER BY COUNT(DISTINCT rd.username) DESC, rd.repo_key ASC LIMIT ?`, key, key, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts, keys := map[string]int{}, []string{}
	for rows.Next() {
		var repo string
		var count int
		if err := rows.Scan(&repo, &count); err != nil {
			return nil, err
		}
		counts[repo] = count
		keys = append(keys, repo)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	projects, err := s.GetProjects(ctx, ProjectListOptions{RepoKeys: keys, Limit: len(keys)})
	if err != nil {
		return nil, err
	}
	result := make([]RelatedProject, 0, len(projects))
	for _, project := range projects {
		result = append(result, RelatedProject{Project: project, SharedContributorCount: counts[project.Repo.RepoKey]})
	}
	sort.SliceStable(result, func(i, j int) bool {
		return result[i].SharedContributorCount > result[j].SharedContributorCount || (result[i].SharedContributorCount == result[j].SharedContributorCount && result[i].Project.QualityScore > result[j].Project.QualityScore)
	})
	return result, nil
}

func (s *APIServer) projects(w http.ResponseWriter, request *http.Request) {
	store, ok := s.scores.(ProjectsStore)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "projects_unavailable"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	options := ProjectListOptions{Sort: request.URL.Query().Get("sort"), Language: strings.TrimSpace(request.URL.Query().Get("language")), Limit: boundedQueryInt(request, "limit", 24, 1, 200), Offset: boundedQueryInt(request, "offset", 0, 0, int(^uint(0)>>1))}
	items, err := store.GetProjects(request.Context(), options)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "projects_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": items}, map[string]string{"Cache-Control": projectsCacheControl})
}

func (s *APIServer) projectDetail(w http.ResponseWriter, request *http.Request) {
	store, ok := s.scores.(ProjectsStore)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "projects_unavailable"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	key := strings.ToLower(request.PathValue("owner") + "/" + request.PathValue("repo"))
	overview, overviewErr := store.GetProjectOverview(request.Context(), key)
	if overviewErr != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "projects_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	if overview == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"}, map[string]string{"Cache-Control": scoreMissCache})
		return
	}
	related, relatedErr := store.GetRelatedProjects(request.Context(), key, 6)
	if relatedErr != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "projects_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"overview": overview, "related": related}, map[string]string{"Cache-Control": projectsCacheControl})
}

var _ ProjectsStore = (*TursoStore)(nil)
