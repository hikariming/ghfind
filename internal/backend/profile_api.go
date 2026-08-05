package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
)

const profileCacheControl = "public, max-age=0, s-maxage=300, stale-while-revalidate=600"

// ProfileDetail is the public, version-gated profile artifact rendered by Next
// pages and image cards. It intentionally mirrors the legacy AccountDetail
// JSON shape so renderers do not need a Turso client to remain compatible.
type ProfileDetail struct {
	Username           string    `json:"username"`
	DisplayName        *string   `json:"display_name"`
	AvatarURL          *string   `json:"avatar_url"`
	ProfileURL         *string   `json:"profile_url"`
	FinalScore         float64   `json:"final_score"`
	Tier               string    `json:"tier"`
	Tags               Tags      `json:"tags"`
	SubScores          SubScores `json:"sub_scores"`
	RoastLine          RoastLine `json:"roast_line"`
	Roast              *string   `json:"roast"`
	RoastEN            *string   `json:"roast_en"`
	ScoreVersion       *string   `json:"score_version"`
	LegacyReadFallback bool      `json:"legacy_read_fallback"`
	CollectionVersion  *string   `json:"score_source_collection_version"`
	SnapshotHash       *string   `json:"score_source_snapshot_hash"`
	ScannedAt          int64     `json:"scanned_at"`
	PrevScore          *float64  `json:"prev_score"`
	PrevScannedAt      *int64    `json:"prev_scanned_at"`
}

type ProfileCardMetrics struct {
	AccountAgeYears         float64 `json:"account_age_years"`
	CreatedAt               *string `json:"created_at"`
	Followers               float64 `json:"followers"`
	PublicRepos             float64 `json:"public_repos"`
	TotalStars              float64 `json:"total_stars"`
	MaxStars                float64 `json:"max_stars"`
	OriginalRepoCount       float64 `json:"original_repo_count"`
	MergedPRCount           float64 `json:"merged_pr_count"`
	ImpactPRCount           float64 `json:"impact_pr_count"`
	VerifiedImpactPRCount   float64 `json:"verified_impact_pr_count"`
	CoreImpactPRCount       float64 `json:"core_impact_pr_count"`
	ImpactRepoCount         float64 `json:"impact_repo_count"`
	MaxImpactRepoStars      float64 `json:"max_impact_repo_stars"`
	LastYearContributions   float64 `json:"last_year_contributions"`
	ContributionYearsActive float64 `json:"contribution_years_active"`
}

type ProfileSnapshotView struct {
	TopRepos      []TopRepo          `json:"top_repos"`
	ImpactRepos   []ImpactRepo       `json:"impact_repos"`
	SignatureWork *SignatureWork     `json:"signature_work"`
	PinnedRepos   []string           `json:"pinned_repos"`
	Organizations []string           `json:"organizations"`
	Bio           *string            `json:"bio"`
	Company       *string            `json:"company"`
	Metrics       ProfileCardMetrics `json:"metrics"`
	ScannedAt     int64              `json:"scanned_at"`
}

// ProfileRank has the same rounded-score semantics as getRankCached: hidden
// accounts are omitted and accounts in the same displayed tenth share a rank.
type ProfileRank struct {
	Rank  int `json:"rank"`
	Total int `json:"total"`
	Below int `json:"below"`
}

type ProfileMatchup struct {
	HandleA       string     `json:"handleA"`
	HandleB       string     `json:"handleB"`
	Winner        *string    `json:"winner"`
	Bucket        string     `json:"bucket"`
	Gap           float64    `json:"gap"`
	ScoreA        float64    `json:"scoreA"`
	ScoreB        float64    `json:"scoreB"`
	Verdict       *RoastLine `json:"verdict"`
	Advice        *RoastLine `json:"advice"`
	VerdictSource *string    `json:"verdictSource"`
	ViewCount     int        `json:"viewCount"`
	CreatedAt     int64      `json:"createdAt"`
	UpdatedAt     int64      `json:"updatedAt"`
}

type ProfilePresentation struct {
	Detail           *ProfileDetail         `json:"detail"`
	Snapshot         *ProfileSnapshotView   `json:"snapshot"`
	Rank             *ProfileRank           `json:"rank"`
	Percentile       *ScorePercentile       `json:"percentile"`
	Delta            *float64               `json:"delta"`
	Similar          []LeaderboardEntry     `json:"similar"`
	CommonProjects   []ProfileCommonProject `json:"common_projects"`
	Battles          []ProfileMatchup       `json:"battles"`
	FacetRank        *FacetRankData         `json:"facetRank"`
	ExistingRepoKeys []string               `json:"existing_repo_keys"`
}

// ProfileCommonProject is the deliberately lean model used by the profile
// page's "common projects" pills. The full project directory keeps its own
// richer endpoint; a profile must not trigger that graph-wide aggregation.
type ProfileCommonProject struct {
	Repo struct {
		RepoKey       string  `json:"repo_key"`
		NameWithOwner string  `json:"name_with_owner"`
		Language      *string `json:"language"`
	} `json:"repo"`
	AvgScore float64 `json:"avgScore"`
}

type ProfileStore interface {
	GetProfileDetail(context.Context, string) (*ProfileDetail, error)
	GetProfileSnapshot(context.Context, string) (*ProfileSnapshotView, error)
	GetProfileRank(context.Context, float64) (*ProfileRank, error)
	GetSimilarProfiles(context.Context, string, float64, SubScores, int) ([]LeaderboardEntry, error)
	GetCommonProfileProjects(context.Context, string, []string, int) ([]ProfileCommonProject, error)
	GetProfileMatchups(context.Context, string, int) ([]ProfileMatchup, error)
	GetProfileMatchup(context.Context, string, string) (*ProfileMatchup, error)
	GetTrendingProfileMatchups(context.Context, int) ([]ProfileMatchup, error)
	GetExistingRepoKeys(context.Context, []string) ([]string, error)
}

func nullableProfileString(value sql.NullString) *string {
	if !value.Valid || value.String == "" {
		return nil
	}
	result := value.String
	return &result
}

func nullableProfileFloat(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	result := value.Float64
	return &result
}

func nullableProfileInt(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	result := value.Int64
	return &result
}

func (s *TursoStore) GetProfileDetail(ctx context.Context, username string) (*ProfileDetail, error) {
	var detail ProfileDetail
	var display, avatar, profile, tags, line, roast, roastEN, version, collection, hash, roastVersion, roastENVersion sql.NullString
	var rawSubScores string
	var previousScore sql.NullFloat64
	var previousScannedAt sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT username, display_name, avatar_url, profile_url, final_score, tier,
		tags, roast_line, sub_scores, roast, roast_en, score_version,
		score_source_collection_version, score_source_snapshot_hash,
		roast_version, roast_en_version, scanned_at, prev_score, prev_scanned_at
		FROM scores WHERE username = ? AND hidden = 0 LIMIT 1`, strings.ToLower(username)).Scan(
		&detail.Username, &display, &avatar, &profile, &detail.FinalScore, &detail.Tier,
		&tags, &line, &rawSubScores, &roast, &roastEN, &version, &collection, &hash,
		&roastVersion, &roastENVersion, &detail.ScannedAt, &previousScore, &previousScannedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read profile detail: %w", err)
	}

	current := version.String == canonicalScoreVersion
	canonical := current && collection.String == goCanonicalCollectionVersion && canonicalSnapshotHashPattern.MatchString(hash.String)
	legacy := version.String == legacyRoastScoreVersion && ((roastVersion.String == legacyRoastVersion && roast.Valid && roast.String != "") || (roastENVersion.String == legacyRoastVersion && roastEN.Valid && roastEN.String != ""))
	if !current && !legacy {
		return nil, nil
	}

	detail.DisplayName = nullableProfileString(display)
	detail.AvatarURL = nullableProfileString(avatar)
	detail.ProfileURL = nullableProfileString(profile)
	detail.Tags = parseTags(tags.String)
	detail.RoastLine = parseRoastLine(line.String)
	detail.SubScores = parseSubScores(rawSubScores)
	detail.ScoreVersion = nullableProfileString(version)
	detail.CollectionVersion = nullableProfileString(collection)
	detail.SnapshotHash = nullableProfileString(hash)
	detail.LegacyReadFallback = legacy
	detail.PrevScore = nullableProfileFloat(previousScore)
	detail.PrevScannedAt = nullableProfileInt(previousScannedAt)
	if (canonical && roastVersion.String == roastArtifactVersion) || (legacy && roastVersion.String == legacyRoastVersion) {
		detail.Roast = nullableProfileString(roast)
	}
	if (canonical && roastENVersion.String == roastArtifactVersion) || (legacy && roastENVersion.String == legacyRoastVersion) {
		detail.RoastEN = nullableProfileString(roastEN)
	}
	return &detail, nil
}

func decodeJSONSlice[T any](raw sql.NullString) []T {
	if !raw.Valid || raw.String == "" {
		return []T{}
	}
	var result []T
	if err := json.Unmarshal([]byte(raw.String), &result); err != nil {
		return []T{}
	}
	// A column may legitimately hold the JSON literal `null` (written by an
	// older indexer); consumers and the public contract always expect [].
	if result == nil {
		return []T{}
	}
	return result
}

func (s *TursoStore) GetProfileSnapshot(ctx context.Context, username string) (*ProfileSnapshotView, error) {
	var topRepos, impactRepos, signature, pinned, organizations, metrics sql.NullString
	var scannedAt int64
	err := s.db.QueryRowContext(ctx, `SELECT top_repos, impact_repos, signature_work, pinned_repos, organizations, metrics, scanned_at
		FROM profile_snapshots WHERE username = ? AND scan_version = ?
		ORDER BY scanned_at DESC LIMIT 1`, strings.ToLower(username), canonicalScoreVersion).Scan(
		&topRepos, &impactRepos, &signature, &pinned, &organizations, &metrics, &scannedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read profile snapshot: %w", err)
	}
	view := &ProfileSnapshotView{
		TopRepos:      decodeJSONSlice[TopRepo](topRepos),
		ImpactRepos:   decodeJSONSlice[ImpactRepo](impactRepos),
		PinnedRepos:   decodeJSONSlice[string](pinned),
		Organizations: decodeJSONSlice[string](organizations),
		ScannedAt:     scannedAt,
	}
	if signature.Valid && signature.String != "" {
		var parsed SignatureWork
		if json.Unmarshal([]byte(signature.String), &parsed) == nil {
			view.SignatureWork = &parsed
		}
	}
	if metrics.Valid && metrics.String != "" {
		var parsed RawMetrics
		if json.Unmarshal([]byte(metrics.String), &parsed) == nil {
			view.Bio, view.Company = parsed.Bio, parsed.Company
			view.Metrics = ProfileCardMetrics{
				AccountAgeYears: parsed.AccountAgeYears, CreatedAt: parsed.CreatedAt, Followers: parsed.Followers,
				PublicRepos: parsed.PublicRepos, TotalStars: parsed.TotalStars, MaxStars: parsed.MaxStars,
				OriginalRepoCount: parsed.OriginalRepoCount, MergedPRCount: parsed.MergedPRCount,
				ImpactPRCount: parsed.ImpactPRCount, VerifiedImpactPRCount: valueOrZero(parsed.VerifiedImpactPRCount),
				CoreImpactPRCount: valueOrZero(parsed.CoreImpactPRCount), ImpactRepoCount: valueOrZero(parsed.ImpactRepoCount),
				MaxImpactRepoStars: parsed.MaxImpactRepoStars, LastYearContributions: parsed.LastYearContributions,
				ContributionYearsActive: parsed.ContributionYearsActive,
			}
		}
	}
	return view, nil
}

func (s *TursoStore) GetProfileRank(ctx context.Context, score float64) (*ProfileRank, error) {
	bucket := int(math.Floor(score*10 + 0.5))
	var above, below, total int
	err := s.db.QueryRowContext(ctx, `SELECT
		COALESCE(SUM(CASE WHEN CAST(ROUND(final_score * 10) AS INTEGER) > ? THEN 1 ELSE 0 END), 0),
		COALESCE(SUM(CASE WHEN CAST(ROUND(final_score * 10) AS INTEGER) < ? THEN 1 ELSE 0 END), 0),
		COUNT(*) FROM scores WHERE hidden = 0 AND score_version = ?`, bucket, bucket, canonicalScoreVersion).Scan(&above, &below, &total)
	if err != nil {
		return nil, fmt.Errorf("read profile rank: %w", err)
	}
	if total <= 1 {
		return nil, nil
	}
	return &ProfileRank{Rank: above + 1, Total: total, Below: below}, nil
}

func similarDistance(left, right SubScores) float64 {
	return math.Sqrt(
		math.Pow((left.AccountMaturity-right.AccountMaturity)/10, 2) +
			math.Pow((left.OriginalProjectQuality-right.OriginalProjectQuality)/18, 2) +
			math.Pow((left.ContributionQuality-right.ContributionQuality)/27, 2) +
			math.Pow((left.EcosystemImpact-right.EcosystemImpact)/20, 2) +
			math.Pow((left.CommunityInfluence-right.CommunityInfluence)/8, 2) +
			math.Pow((left.ActivityAuthenticity-right.ActivityAuthenticity)/17, 2),
	)
}

type similarProfile struct {
	entry  LeaderboardEntry
	scores SubScores
}

func (s *TursoStore) GetSimilarProfiles(ctx context.Context, username string, finalScore float64, subScores SubScores, limit int) ([]LeaderboardEntry, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT s.username, s.display_name, s.avatar_url, s.profile_url, s.final_score, s.tier,
		s.tags, s.sub_scores, MAX(COALESCE(stats.lookup_count, 0), 1) AS lookup_count
		FROM scores AS s LEFT JOIN account_stats AS stats ON stats.username = s.username
		WHERE s.hidden = 0 AND s.score_version = ?
			AND s.score_source_collection_version = ?
			AND length(s.score_source_snapshot_hash) = 64
			AND s.score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'
			AND s.username != ? AND s.final_score BETWEEN ? AND ?
		ORDER BY s.final_score DESC LIMIT 300`, canonicalScoreVersion, goCanonicalCollectionVersion, strings.ToLower(username), finalScore-10, finalScore+10)
	if err != nil {
		return nil, fmt.Errorf("read similar profiles: %w", err)
	}
	defer rows.Close()
	candidates := []similarProfile{}
	for rows.Next() {
		var candidate similarProfile
		var display, avatar, profile, tags, rawScores sql.NullString
		if err := rows.Scan(&candidate.entry.Username, &display, &avatar, &profile, &candidate.entry.FinalScore, &candidate.entry.Tier, &tags, &rawScores, &candidate.entry.LookupCount); err != nil {
			return nil, fmt.Errorf("scan similar profile: %w", err)
		}
		candidate.entry.DisplayName = nullableProfileString(display)
		candidate.entry.AvatarURL = nullableProfileString(avatar)
		candidate.entry.ProfileURL = nullableProfileString(profile)
		candidate.entry.Tags = parseTags(tags.String)
		candidate.scores = parseSubScores(rawScores.String)
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return similarDistance(subScores, candidates[i].scores) < similarDistance(subScores, candidates[j].scores)
	})
	if limit < 1 {
		return []LeaderboardEntry{}, nil
	}
	if limit > len(candidates) {
		limit = len(candidates)
	}
	result := make([]LeaderboardEntry, 0, limit)
	for _, candidate := range candidates[:limit] {
		result = append(result, candidate.entry)
	}
	return result, nil
}

func (s *TursoStore) GetCommonProfileProjects(ctx context.Context, username string, similar []string, limit int) ([]ProfileCommonProject, error) {
	if limit < 1 || len(similar) == 0 {
		return []ProfileCommonProject{}, nil
	}
	if limit > 50 {
		limit = 50
	}
	seen := map[string]bool{}
	result := []ProfileCommonProject{}
	for _, candidate := range similar {
		if len(result) >= limit {
			break
		}
		rows, err := s.db.QueryContext(ctx, `SELECT r.repo_key, r.name_with_owner, r.language, AVG(s.final_score)
			FROM repo_developers AS mine
			JOIN repo_developers AS theirs ON theirs.repo_key = mine.repo_key AND theirs.username = ?
			JOIN repos AS r ON r.repo_key = mine.repo_key
			JOIN repo_developers AS members ON members.repo_key = mine.repo_key
			JOIN scores AS s ON s.username = members.username
			WHERE mine.username = ? AND s.hidden = 0 AND s.score_version = ?
				AND s.score_source_collection_version = ?
				AND length(s.score_source_snapshot_hash) = 64
				AND s.score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'
			GROUP BY r.repo_key ORDER BY AVG(s.final_score) DESC, r.repo_key ASC LIMIT ?`,
			strings.ToLower(candidate), strings.ToLower(username), canonicalScoreVersion, goCanonicalCollectionVersion, limit)
		if err != nil {
			return nil, fmt.Errorf("read profile common projects: %w", err)
		}
		for rows.Next() {
			var item ProfileCommonProject
			var language sql.NullString
			if err := rows.Scan(&item.Repo.RepoKey, &item.Repo.NameWithOwner, &language, &item.AvgScore); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan profile common project: %w", err)
			}
			item.Repo.Language = nullableProfileString(language)
			item.AvgScore = math.Round(item.AvgScore*10) / 10
			if !seen[item.Repo.RepoKey] {
				seen[item.Repo.RepoKey] = true
				result = append(result, item)
			}
			if len(result) >= limit {
				break
			}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		_ = rows.Close()
	}
	return result, nil
}

func decodeNullableRoastLine(raw sql.NullString) *RoastLine {
	if !raw.Valid || raw.String == "" {
		return nil
	}
	line := parseRoastLine(raw.String)
	return &line
}

func scanProfileMatchup(scanner interface{ Scan(...any) error }) (*ProfileMatchup, error) {
	var matchup ProfileMatchup
	var winner, verdict, advice, source sql.NullString
	err := scanner.Scan(&matchup.HandleA, &matchup.HandleB, &winner, &matchup.Bucket, &matchup.Gap, &matchup.ScoreA, &matchup.ScoreB, &verdict, &advice, &source, &matchup.ViewCount, &matchup.CreatedAt, &matchup.UpdatedAt)
	if err != nil {
		return nil, err
	}
	matchup.Winner = nullableProfileString(winner)
	matchup.Verdict = decodeNullableRoastLine(verdict)
	matchup.Advice = decodeNullableRoastLine(advice)
	matchup.VerdictSource = nullableProfileString(source)
	return &matchup, nil
}

const profileMatchupColumns = "handle_a, handle_b, winner, bucket, gap, score_a, score_b, verdict, advice, verdict_source, view_count, created_at, updated_at"

func (s *TursoStore) GetProfileMatchup(ctx context.Context, a, b string) (*ProfileMatchup, error) {
	row := s.db.QueryRowContext(ctx, "SELECT "+profileMatchupColumns+" FROM vs_matchups WHERE handle_a = ? AND handle_b = ? LIMIT 1", strings.ToLower(a), strings.ToLower(b))
	matchup, err := scanProfileMatchup(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read profile matchup: %w", err)
	}
	return matchup, nil
}

func (s *TursoStore) profileMatchupList(ctx context.Context, query string, args ...any) ([]ProfileMatchup, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []ProfileMatchup{}
	for rows.Next() {
		matchup, err := scanProfileMatchup(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *matchup)
	}
	return result, rows.Err()
}

func (s *TursoStore) GetProfileMatchups(ctx context.Context, username string, limit int) ([]ProfileMatchup, error) {
	if limit < 1 {
		limit = 1
	} else if limit > 50 {
		limit = 50
	}
	return s.profileMatchupList(ctx, "SELECT "+profileMatchupColumns+" FROM vs_matchups WHERE handle_a = ? OR handle_b = ? ORDER BY updated_at DESC LIMIT ?", strings.ToLower(username), strings.ToLower(username), limit)
}

func (s *TursoStore) GetTrendingProfileMatchups(ctx context.Context, limit int) ([]ProfileMatchup, error) {
	if limit < 1 {
		limit = 1
	} else if limit > 100 {
		limit = 100
	}
	return s.profileMatchupList(ctx, "SELECT "+profileMatchupColumns+" FROM vs_matchups WHERE verdict_source = 'llm' AND score_a >= ? AND score_b >= ? ORDER BY view_count DESC, updated_at DESC LIMIT ?", vsMinimumScore, vsMinimumScore, limit)
}

func (s *TursoStore) GetExistingRepoKeys(ctx context.Context, keys []string) ([]string, error) {
	unique := map[string]bool{}
	for _, key := range keys {
		if normalized := strings.ToLower(strings.TrimSpace(key)); normalized != "" {
			unique[normalized] = true
		}
	}
	if len(unique) == 0 {
		return []string{}, nil
	}
	values := make([]string, 0, len(unique))
	for key := range unique {
		values = append(values, key)
	}
	sort.Strings(values)
	placeholders := strings.TrimRight(strings.Repeat("?,", len(values)), ",")
	args := make([]any, len(values))
	for index, value := range values {
		args[index] = value
	}
	rows, err := s.db.QueryContext(ctx, "SELECT repo_key FROM repos WHERE repo_key IN ("+placeholders+")", args...)
	if err != nil {
		return nil, fmt.Errorf("read existing repo keys: %w", err)
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		result = append(result, key)
	}
	return result, rows.Err()
}

func profileSnapshotRepoKeys(snapshot *ProfileSnapshotView) []string {
	if snapshot == nil {
		return nil
	}
	keys := make([]string, 0, len(snapshot.TopRepos)+len(snapshot.ImpactRepos))
	for _, repo := range snapshot.TopRepos {
		if repo.NameWithOwner != nil {
			keys = append(keys, *repo.NameWithOwner)
		} else if repo.OwnerLogin != nil && repo.Name != "" {
			keys = append(keys, *repo.OwnerLogin+"/"+repo.Name)
		}
	}
	for _, repo := range snapshot.ImpactRepos {
		keys = append(keys, repo.Repo)
	}
	return keys
}

func (s *APIServer) profile(w http.ResponseWriter, request *http.Request) {
	username := strictGitHubUsername(request.PathValue("username"))
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_username"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	store, ok := s.scores.(ProfileStore)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "profile_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
		return
	}
	detail, err := store.GetProfileDetail(request.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "profile_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
		return
	}
	if detail == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"}, map[string]string{"Cache-Control": scoreMissCache})
		return
	}
	snapshot, snapshotErr := store.GetProfileSnapshot(request.Context(), detail.Username)
	rank, rankErr := store.GetProfileRank(request.Context(), detail.FinalScore)
	similar, similarErr := store.GetSimilarProfiles(request.Context(), detail.Username, detail.FinalScore, detail.SubScores, 6)
	commonUsernames := make([]string, 0, minInt(3, len(similar)))
	for _, candidate := range similar {
		if len(commonUsernames) == 3 {
			break
		}
		commonUsernames = append(commonUsernames, candidate.Username)
	}
	commonProjects, commonErr := store.GetCommonProfileProjects(request.Context(), detail.Username, commonUsernames, 6)
	battles, battlesErr := store.GetProfileMatchups(request.Context(), detail.Username, 8)
	if snapshotErr != nil || rankErr != nil || similarErr != nil || commonErr != nil || battlesErr != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "profile_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
		return
	}
	var facet *FacetRankData
	if s.facetRanks != nil {
		facet, _ = s.facetRanks.GetFacetRank(request.Context(), detail.Username)
	}
	var delta *float64
	if badgeStore, ok := s.scores.(BadgeStore); ok {
		badge, err := badgeStore.GetBadgeData(request.Context(), detail.Username, s.clock().UTC())
		if err == nil {
			delta = badge.Delta
		}
	}
	keys, keysErr := store.GetExistingRepoKeys(request.Context(), profileSnapshotRepoKeys(snapshot))
	if keysErr != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "profile_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
		return
	}
	payload := ProfilePresentation{Detail: detail, Snapshot: snapshot, Rank: rank, Delta: delta, Similar: similar, CommonProjects: commonProjects, Battles: battles, FacetRank: facet, ExistingRepoKeys: keys}
	payload.Percentile = s.scorePercentile(request.Context(), detail.FinalScore)
	writeJSON(w, http.StatusOK, payload, map[string]string{"Cache-Control": profileCacheControl})
}

// profileLiveScan exposes only an already-cached scan for the transient
// pending-profile shell. It never starts collection or writes a score; the
// browser can therefore refresh while a submitted scan is still in flight.
func (s *APIServer) profileLiveScan(w http.ResponseWriter, request *http.Request) {
	username := strictGitHubUsername(request.PathValue("username"))
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_username"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	if s.scanCache == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"}, map[string]string{"Cache-Control": scoreMissCache})
		return
	}
	scan, err := s.scanCache.GetCachedScan(request.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "scan_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
		return
	}
	if scan == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"}, map[string]string{"Cache-Control": scoreMissCache})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scan": scan}, map[string]string{"Cache-Control": "no-store"})
}

func (s *APIServer) vsMatchup(w http.ResponseWriter, request *http.Request) {
	a, b := strictGitHubUsername(request.PathValue("a")), strictGitHubUsername(request.PathValue("b"))
	if a == "" || b == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_username"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	store, ok := s.scores.(ProfileStore)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "profile_unavailable"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	left, errA := store.GetProfileDetail(request.Context(), a)
	right, errB := store.GetProfileDetail(request.Context(), b)
	matchup, errM := store.GetProfileMatchup(request.Context(), a, b)
	if errA != nil || errB != nil || errM != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "profile_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"a": left, "b": right, "matchup": matchup}, map[string]string{"Cache-Control": profileCacheControl})
}

func (s *APIServer) trendingVsMatchups(w http.ResponseWriter, request *http.Request) {
	store, ok := s.scores.(ProfileStore)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "profile_unavailable"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	matchups, err := store.GetTrendingProfileMatchups(request.Context(), 40)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "profile_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"matchups": matchups}, map[string]string{"Cache-Control": profileCacheControl})
}

// Compile-time assertions keep all production interfaces co-located with their
// Turso implementation while lightweight test fixtures may opt out.
var _ ProfileStore = (*TursoStore)(nil)
