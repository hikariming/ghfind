package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

// LoadGorseFeedCandidates treats remote IDs as untrusted suggestions. Every
// item is mapped through the business catalog and re-applies publishability and
// user hard exclusions before it can enter the Go mixer.
func (s *PostgresFeedStore) LoadGorseFeedCandidates(ctx context.Context, user FeedUser, itemIDs []string, limit int) ([]FeedCandidate, error) {
	itemIDs = uniqueStrings(itemIDs)
	if len(itemIDs) == 0 {
		return []FeedCandidate{}, nil
	}
	if len(itemIDs) > 100 {
		itemIDs = itemIDs[:100]
	}
	if limit < 1 || limit > 60 {
		limit = 60
	}
	rows, err := s.db.QueryContext(ctx, `SELECT p.repo_key,p.item_id,p.owner_login,p.name,p.canonical_url,
	  p.summary,p.language,p.topics,p.project_type,p.lifecycle,p.product_score,p.confidence,
	  p.verification_level,p.exposure_band,p.treasure_eligible,p.classic_eligible,p.analyzed_at,p.publishable,
	  (SELECT MAX(e.occurred_at) FROM feed.events e WHERE e.github_id=$1 AND e.repo_key=p.repo_key AND e.event_type='impression'),
	  pe.embedding::text
	  FROM feed.projects p
	  LEFT JOIN feed.project_embeddings pe ON pe.repo_key=p.repo_key AND pe.active=true
	  LEFT JOIN feed.user_project_state ups ON ups.github_id=$1 AND ups.repo_key=p.repo_key
	  WHERE p.item_id=ANY($2) AND p.publishable=true AND COALESCE(ups.not_interested,false)=false
	  ORDER BY array_position($2::text[],p.item_id) LIMIT $3`, user.GitHubID, itemIDs, limit)
	if err != nil {
		return nil, fmt.Errorf("hydrate Gorse Feed candidates: %w", err)
	}
	candidates := []FeedCandidate{}
	byKey := map[string]int{}
	for rows.Next() {
		var candidate FeedCandidate
		var language, topics, embedding sql.NullString
		var seenAt sql.NullTime
		if err := rows.Scan(&candidate.Project.RepoKey, &candidate.Project.ItemID, &candidate.Project.OwnerLogin,
			&candidate.Project.Name, &candidate.Project.CanonicalURL, &candidate.Project.Summary, &language, &topics,
			&candidate.Project.ProjectType, &candidate.Project.Lifecycle, &candidate.Project.ProductScore,
			&candidate.Project.Confidence, &candidate.Project.VerificationLevel, &candidate.Project.ExposureBand,
			&candidate.Project.TreasureEligible, &candidate.Project.ClassicEligible, &candidate.Project.AnalyzedAt,
			&candidate.Project.Publishable, &seenAt, &embedding); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if language.Valid {
			candidate.Project.Language = &language.String
		}
		candidate.Project.Topics = []string{}
		if topics.Valid {
			_ = json.Unmarshal([]byte(topics.String), &candidate.Project.Topics)
		}
		if seenAt.Valid {
			candidate.SeenAt = &seenAt.Time
		}
		if embedding.Valid {
			candidate.Embedding, _ = parsePGVector(embedding.String)
		}
		candidate.Sources = []string{"gorse"}
		byKey[candidate.Project.RepoKey] = len(candidates)
		candidates = append(candidates, candidate)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return candidates, nil
	}
	keys := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		keys = append(keys, candidate.Project.RepoKey)
	}
	tagRows, err := s.db.QueryContext(ctx, `SELECT pt.repo_key,td.id,td.namespace,td.slug,td.label_zh,
	  td.label_en,td.description,pt.weight,pt.confidence,pt.taxonomy_version
	  FROM feed.project_tags pt JOIN feed.tag_definitions td ON td.id=pt.tag_id AND td.status='canonical'
	  WHERE pt.repo_key=ANY($1) ORDER BY pt.repo_key,td.namespace,td.slug`, keys)
	if err != nil {
		return nil, err
	}
	for tagRows.Next() {
		var key string
		var tag FeedTag
		if err := tagRows.Scan(&key, &tag.ID, &tag.Namespace, &tag.Slug, &tag.LabelZH, &tag.LabelEN,
			&tag.Description, &tag.Weight, &tag.Confidence, &tag.TaxonomyVersion); err != nil {
			_ = tagRows.Close()
			return nil, err
		}
		if index, found := byKey[key]; found {
			candidates[index].Project.Tags = append(candidates[index].Project.Tags, tag)
		}
	}
	if err := tagRows.Close(); err != nil {
		return nil, err
	}
	return candidates, nil
}
