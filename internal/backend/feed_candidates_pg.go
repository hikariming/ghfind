package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

func (s *PostgresFeedStore) LoadFeedCandidates(ctx context.Context, user FeedUser, limit int) ([]FeedCandidate, map[string]int, error) {
	if limit < 1 {
		limit = 240
	}
	if limit > 500 {
		limit = 500
	}
	type candidateSignal struct {
		sources  map[string]bool
		tag      *float64
		semantic *float64
	}
	signals := map[string]*candidateSignal{}
	add := func(key, source string, tag, semantic *float64) {
		key = strings.ToLower(strings.TrimSpace(key))
		if key == "" {
			return
		}
		signal := signals[key]
		if signal == nil {
			signal = &candidateSignal{sources: map[string]bool{}}
			signals[key] = signal
		}
		signal.sources[source] = true
		if tag != nil {
			value := *tag
			signal.tag = &value
		}
		if semantic != nil {
			value := *semantic
			signal.semantic = &value
		}
	}

	tagRows, err := s.db.QueryContext(ctx, `SELECT pt.repo_key,
      SUM(pref.value * pref.strength * pt.weight * pt.confidence) /
        NULLIF(SUM(ABS(pref.value * pref.strength * pt.weight * pt.confidence)), 0) AS affinity
      FROM feed.user_tag_preferences pref
      JOIN feed.project_tags pt ON pt.tag_id = pref.tag_id
      JOIN feed.projects p ON p.repo_key = pt.repo_key AND p.publishable = true
      LEFT JOIN feed.user_project_state ups ON ups.github_id = pref.github_id AND ups.repo_key = pt.repo_key
      WHERE pref.github_id = $1 AND COALESCE(ups.not_interested, false) = false
      GROUP BY pt.repo_key ORDER BY affinity DESC, pt.repo_key LIMIT 80`, user.GitHubID)
	if err != nil {
		return nil, nil, fmt.Errorf("load tag Feed candidates: %w", err)
	}
	for tagRows.Next() {
		var key string
		var affinity float64
		if err := tagRows.Scan(&key, &affinity); err != nil {
			_ = tagRows.Close()
			return nil, nil, err
		}
		add(key, "tag", &affinity, nil)
	}
	if err := tagRows.Close(); err != nil {
		return nil, nil, err
	}

	vectorRows, err := s.db.QueryContext(ctx, `SELECT pe.repo_key, 1 - (pe.embedding <=> upe.embedding) AS similarity
	      FROM feed.user_profile_embeddings upe
	      JOIN feed.users fu ON fu.github_id=upe.github_id AND fu.profile_version=upe.profile_version
      JOIN feed.project_embeddings pe ON pe.active = true AND pe.model = upe.model AND pe.dimensions = upe.dimensions
      JOIN feed.projects p ON p.repo_key = pe.repo_key AND p.publishable = true
      LEFT JOIN feed.user_project_state ups ON ups.github_id = upe.github_id AND ups.repo_key = pe.repo_key
      WHERE upe.github_id = $1 AND upe.active = true AND COALESCE(ups.not_interested, false) = false
      ORDER BY pe.embedding <=> upe.embedding, pe.repo_key LIMIT 80`, user.GitHubID)
	if err != nil {
		return nil, nil, fmt.Errorf("load vector Feed candidates: %w", err)
	}
	for vectorRows.Next() {
		var key string
		var similarity float64
		if err := vectorRows.Scan(&key, &similarity); err != nil {
			_ = vectorRows.Close()
			return nil, nil, err
		}
		add(key, "semantic", nil, &similarity)
	}
	if err := vectorRows.Close(); err != nil {
		return nil, nil, err
	}

	for _, source := range []struct {
		name  string
		order string
		limit int
	}{
		{name: "latest", order: "p.analyzed_at DESC, p.repo_key", limit: 40},
		{name: "quality", order: "p.product_score DESC, p.confidence DESC, p.repo_key", limit: 20},
		{name: "discovery", order: "CASE p.exposure_band WHEN 'low' THEN 0 WHEN 'emerging' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END, p.product_score DESC, p.repo_key", limit: 20},
	} {
		rows, err := s.db.QueryContext(ctx, `SELECT p.repo_key FROM feed.projects p
          LEFT JOIN feed.user_project_state ups ON ups.github_id = $1 AND ups.repo_key = p.repo_key
          WHERE p.publishable = true AND COALESCE(ups.not_interested, false) = false
          ORDER BY `+source.order+` LIMIT $2`, user.GitHubID, source.limit)
		if err != nil {
			return nil, nil, fmt.Errorf("load %s Feed candidates: %w", source.name, err)
		}
		for rows.Next() {
			var key string
			if err := rows.Scan(&key); err != nil {
				_ = rows.Close()
				return nil, nil, err
			}
			add(key, source.name, nil, nil)
		}
		if err := rows.Close(); err != nil {
			return nil, nil, err
		}
	}

	counts := map[string]int{}
	for _, signal := range signals {
		for source := range signal.sources {
			counts[source]++
		}
	}
	keys := make([]string, 0, len(signals))
	for key := range signals {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if len(keys) == 0 {
		return []FeedCandidate{}, counts, nil
	}
	if len(keys) > limit {
		keys = keys[:limit]
	}

	rows, err := s.db.QueryContext(ctx, `SELECT p.repo_key, p.item_id, p.owner_login, p.name, p.canonical_url,
      p.summary, p.language, p.topics, p.project_type, p.lifecycle, p.product_score, p.confidence,
      p.verification_level, p.exposure_band, p.treasure_eligible, p.classic_eligible, p.analyzed_at,
      p.publishable, ups.not_interested,
      (SELECT MAX(e.occurred_at) FROM feed.events e WHERE e.github_id = $1 AND e.repo_key = p.repo_key AND e.event_type = 'impression'),
      pe.embedding::text
      FROM feed.projects p
      LEFT JOIN feed.user_project_state ups ON ups.github_id = $1 AND ups.repo_key = p.repo_key
      LEFT JOIN feed.project_embeddings pe ON pe.repo_key = p.repo_key AND pe.active = true
      WHERE p.repo_key = ANY($2)`, user.GitHubID, keys)
	if err != nil {
		return nil, nil, fmt.Errorf("hydrate Feed candidates: %w", err)
	}
	candidates := make([]FeedCandidate, 0, len(keys))
	byKey := map[string]int{}
	for rows.Next() {
		var candidate FeedCandidate
		var language, topics, embedding sql.NullString
		var notInterested sql.NullBool
		var seenAt sql.NullTime
		if err := rows.Scan(
			&candidate.Project.RepoKey, &candidate.Project.ItemID, &candidate.Project.OwnerLogin, &candidate.Project.Name,
			&candidate.Project.CanonicalURL, &candidate.Project.Summary, &language, &topics, &candidate.Project.ProjectType,
			&candidate.Project.Lifecycle, &candidate.Project.ProductScore, &candidate.Project.Confidence,
			&candidate.Project.VerificationLevel, &candidate.Project.ExposureBand, &candidate.Project.TreasureEligible,
			&candidate.Project.ClassicEligible, &candidate.Project.AnalyzedAt, &candidate.Project.Publishable,
			&notInterested, &seenAt, &embedding,
		); err != nil {
			_ = rows.Close()
			return nil, nil, fmt.Errorf("scan Feed candidate: %w", err)
		}
		if language.Valid {
			candidate.Project.Language = &language.String
		}
		candidate.Project.Topics = []string{}
		if topics.Valid {
			_ = json.Unmarshal([]byte(topics.String), &candidate.Project.Topics)
		}
		candidate.NotInterested = notInterested.Valid && notInterested.Bool
		if seenAt.Valid {
			candidate.SeenAt = &seenAt.Time
		}
		if embedding.Valid {
			candidate.Embedding, _ = parsePGVector(embedding.String)
		}
		signal := signals[candidate.Project.RepoKey]
		for source := range signal.sources {
			candidate.Sources = append(candidate.Sources, source)
		}
		candidate.Sources = uniqueStrings(candidate.Sources)
		candidate.TagAffinity, candidate.SemanticSimilarity = signal.tag, signal.semantic
		candidates = append(candidates, candidate)
		byKey[candidate.Project.RepoKey] = len(candidates) - 1
	}
	if err := rows.Close(); err != nil {
		return nil, nil, err
	}

	tagRows, err = s.db.QueryContext(ctx, `SELECT pt.repo_key, td.id, td.namespace, td.slug, td.label_zh,
      td.label_en, td.description, pt.weight, pt.confidence, pt.taxonomy_version
      FROM feed.project_tags pt JOIN feed.tag_definitions td ON td.id = pt.tag_id
      WHERE pt.repo_key = ANY($1) AND td.status = 'canonical' ORDER BY pt.repo_key, td.namespace, td.slug`, keys)
	if err != nil {
		return nil, nil, fmt.Errorf("hydrate Feed candidate tags: %w", err)
	}
	for tagRows.Next() {
		var key string
		var tag FeedTag
		if err := tagRows.Scan(&key, &tag.ID, &tag.Namespace, &tag.Slug, &tag.LabelZH, &tag.LabelEN, &tag.Description, &tag.Weight, &tag.Confidence, &tag.TaxonomyVersion); err != nil {
			_ = tagRows.Close()
			return nil, nil, err
		}
		if index, ok := byKey[key]; ok {
			candidates[index].Project.Tags = append(candidates[index].Project.Tags, tag)
		}
	}
	if err := tagRows.Close(); err != nil {
		return nil, nil, err
	}
	return candidates, counts, nil
}

func parsePGVector(value string) ([]float64, error) {
	value = strings.TrimSpace(value)
	if len(value) < 2 || value[0] != '[' || value[len(value)-1] != ']' {
		return nil, fmt.Errorf("invalid pgvector")
	}
	value = strings.TrimSpace(value[1 : len(value)-1])
	if value == "" {
		return []float64{}, nil
	}
	parts := strings.Split(value, ",")
	result := make([]float64, len(parts))
	for index, part := range parts {
		parsed, err := strconv.ParseFloat(strings.TrimSpace(part), 64)
		if err != nil {
			return nil, fmt.Errorf("parse pgvector element: %w", err)
		}
		result[index] = parsed
	}
	return result, nil
}
