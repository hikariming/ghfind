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

	// Tag retrieval is deliberately bounded per preference before affinity is
	// aggregated. Exact aggregation would scan every project carrying a popular
	// tag (50k+ in a mature catalog) merely to return 80 candidates. The
	// expression index gives each of the at-most-30 preferences a stable, high
	// confidence fanout; the final affinity query then selects the global Top80.
	// This is a candidate-recall approximation, never a governance decision.
	if len(user.Preferences) > 0 {
		tagRows, err := s.db.QueryContext(ctx, `WITH prefs AS MATERIALIZED (
          SELECT tag_id,value,strength FROM feed.user_tag_preferences WHERE github_id=$1
        ), sampled AS MATERIALIZED (
          SELECT pref.tag_id,pref.value,pref.strength,pt.repo_key,pt.weight,pt.confidence
          FROM prefs pref
          CROSS JOIN LATERAL (
            SELECT repo_key,weight,confidence FROM feed.project_tags pt
            WHERE pt.tag_id=pref.tag_id
            ORDER BY (pt.weight * pt.confidence) DESC,repo_key
            LIMIT 160
          ) pt
        )
        SELECT sampled.repo_key,
          SUM(sampled.value * sampled.strength * sampled.weight * sampled.confidence) /
            NULLIF(SUM(ABS(sampled.value * sampled.strength * sampled.weight * sampled.confidence)), 0) AS affinity
        FROM sampled
        CROSS JOIN LATERAL (
          SELECT 1 FROM feed.projects p
          WHERE p.repo_key=sampled.repo_key AND p.publishable=true OFFSET 0
        ) p
        WHERE NOT EXISTS (
          SELECT 1 FROM feed.user_project_state ups
          WHERE ups.github_id=$1 AND ups.repo_key=sampled.repo_key AND ups.not_interested=true
        )
        GROUP BY sampled.repo_key ORDER BY affinity DESC,sampled.repo_key LIMIT 80`, user.GitHubID)
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
	}

	// GetFeedUser has already read and version-checked the active user vector.
	// Passing that scalar into the candidate query avoids joining users and the
	// active profile vector once per catalog row. The shape also permits a
	// future dimension-specific HNSW expression index without changing the API
	// contract; exact cosine remains the safe default while the catalog is small.
	if len(user.Embedding) > 0 && user.embeddingModel != "" && user.embeddingDimensions > 0 {
		embeddingExpression, parameterExpression := feedVectorDistanceExpressions(user.embeddingDimensions)
		vectorQuery := fmt.Sprintf(`SELECT pe.repo_key,
            1 - (%s <=> %s) AS similarity
          FROM feed.project_embeddings pe
          JOIN feed.projects p ON p.repo_key=pe.repo_key AND p.publishable=true
          WHERE pe.active=true AND pe.model=$2 AND pe.dimensions=$3
            AND NOT EXISTS (
              SELECT 1 FROM feed.user_project_state ups
              WHERE ups.github_id=$4 AND ups.repo_key=pe.repo_key AND ups.not_interested=true
            )
	          ORDER BY %s <=> %s LIMIT 80`, embeddingExpression, parameterExpression, embeddingExpression, parameterExpression)
		vectorRows, err := s.db.QueryContext(ctx, vectorQuery,
			pgVectorLiteral(user.Embedding), user.embeddingModel, user.embeddingDimensions, user.GitHubID)
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

	tagRows, err := s.db.QueryContext(ctx, `SELECT pt.repo_key, td.id, td.namespace, td.slug, td.label_zh,
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

func pgVectorLiteral(values []float64) string {
	parts := make([]string, len(values))
	for index, value := range values {
		parts[index] = strconv.FormatFloat(value, 'g', -1, 64)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func feedVectorDistanceExpressions(dimensions int) (embedding, parameter string) {
	// pgvector HNSW requires a fixed-dimension expression. The migration role
	// creates those indexes once an active corpus reaches 50k. Exact cosine is
	// retained for unsupported dimensions, while halfvec keeps 2001-4000-dim
	// provider models indexable without changing stored source vectors.
	switch {
	case dimensions > 0 && dimensions <= 2_000:
		kind := fmt.Sprintf("vector(%d)", dimensions)
		return "pe.embedding::" + kind, "$1::" + kind
	case dimensions > 2_000 && dimensions <= 4_000:
		kind := fmt.Sprintf("halfvec(%d)", dimensions)
		return "pe.embedding::" + kind, "$1::" + kind
	default:
		return "pe.embedding", "$1::vector"
	}
}
