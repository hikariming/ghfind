package backend

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

type FeedColdStartSource interface {
	GetFeedColdStartFacets(context.Context, string) ([]DeveloperFacet, error)
}

func (s *TursoStore) GetFeedColdStartFacets(ctx context.Context, login string) ([]DeveloperFacet, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT facet_type,facet_value,weight FROM developer_facets
      WHERE username=? AND facet_type IN ('language','repo') ORDER BY facet_type,weight DESC,facet_value LIMIT 50`, strings.ToLower(login))
	if err != nil {
		return nil, fmt.Errorf("read Feed cold-start facets: %w", err)
	}
	defer rows.Close()
	facets := []DeveloperFacet{}
	for rows.Next() {
		var facet DeveloperFacet
		if err := rows.Scan(&facet.Type, &facet.Value, &facet.Weight); err != nil {
			return nil, err
		}
		facets = append(facets, facet)
	}
	return facets, rows.Err()
}

var nonTagSlugCharacters = regexp.MustCompile(`[^a-z0-9]+`)

func feedFacetSlug(value string) string {
	return strings.Trim(nonTagSlugCharacters.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-"), "-")
}

func (s *PostgresFeedStore) SeedFeedGraphPreferences(ctx context.Context, githubID int64, facets []DeveloperFacet) (bool, error) {
	sort.Slice(facets, func(i, j int) bool {
		if facets[i].Type != facets[j].Type {
			return facets[i].Type < facets[j].Type
		}
		if facets[i].Value != facets[j].Value {
			return facets[i].Value < facets[j].Value
		}
		return facets[i].Weight < facets[j].Weight
	})
	encoded, _ := json.Marshal(facets)
	digest := sha256.Sum256(encoded)
	sourceHash := hex.EncodeToString(digest[:])
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback() //nolint:errcheck
	var currentHash string
	if err := tx.QueryRowContext(ctx, `SELECT graph_source_hash FROM feed.users WHERE github_id=$1 FOR UPDATE`, githubID).Scan(&currentHash); err != nil {
		return false, err
	}
	if currentHash == sourceHash {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM feed.user_tag_preferences WHERE github_id=$1 AND source='graph'`, githubID); err != nil {
		return false, err
	}
	var version int64
	if err := tx.QueryRowContext(ctx, `SELECT version FROM feed.taxonomy_versions WHERE state='active'`).Scan(&version); err != nil {
		return false, err
	}
	maxLanguage := 0.0
	for _, facet := range facets {
		if facet.Type == "language" && facet.Weight > maxLanguage {
			maxLanguage = facet.Weight
		}
	}
	for _, facet := range facets {
		switch facet.Type {
		case "language":
			slug := feedFacetSlug(facet.Value)
			if slug == "" {
				continue
			}
			strength := .2
			if maxLanguage > 0 {
				strength += .15 * facet.Weight / maxLanguage
			}
			if strength > 0.35 {
				strength = .35
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO feed.user_tag_preferences(github_id,tag_id,value,source,strength,taxonomy_version)
          SELECT $1,id,1,'graph',$3,$4 FROM feed.tag_definitions WHERE id=$2 AND status='canonical'
          ON CONFLICT(github_id,tag_id,source) DO UPDATE SET value=1,strength=excluded.strength,taxonomy_version=excluded.taxonomy_version`, githubID, "stack:"+slug, strength, version)
		case "repo":
			repoKey := strings.ToLower(strings.TrimSpace(facet.Value))
			_, err = tx.ExecContext(ctx, `INSERT INTO feed.user_tag_preferences(github_id,tag_id,value,source,strength,taxonomy_version)
          SELECT $1,pt.tag_id,1,'graph',LEAST(0.35,0.20+0.15*pt.weight),$3 FROM feed.project_tags pt
          WHERE pt.repo_key=$2 ON CONFLICT(github_id,tag_id,source) DO UPDATE SET value=1,strength=excluded.strength,taxonomy_version=excluded.taxonomy_version`, githubID, repoKey, version)
		}
		if err != nil {
			return false, err
		}
	}
	var profileVersion int64
	if err := tx.QueryRowContext(ctx, `UPDATE feed.users SET graph_source_hash=$2,
	  profile_version=profile_version+1,updated_at=now() WHERE github_id=$1 RETURNING profile_version`,
		githubID, sourceHash).Scan(&profileVersion); err != nil {
		return false, err
	}
	payload, _ := json.Marshal(map[string]any{"githubId": githubID, "profileVersion": profileVersion, "source": "graph"})
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
	  VALUES ($1,'feed.profile-rebuild.v1',$2::jsonb,$3) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
		fmt.Sprintf("gh:%d", githubID), string(payload), fmt.Sprintf("profile-graph:%d:%d", githubID, profileVersion)); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *APIServer) ensureFeedUser(ctx context.Context, session OAuthSession) (*FeedUser, error) {
	user, err := s.feed.EnsureFeedUser(ctx, session)
	if err != nil {
		return nil, err
	}
	source, ok := s.scores.(FeedColdStartSource)
	if !ok {
		return user, nil
	}
	facets, err := source.GetFeedColdStartFacets(ctx, session.Login)
	if err != nil {
		return user, nil
	}
	changed, err := s.feed.SeedFeedGraphPreferences(ctx, session.GitHubID, facets)
	if err != nil {
		return nil, err
	}
	if changed {
		return s.feed.GetFeedUser(ctx, session.GitHubID)
	}
	return user, nil
}

var _ FeedColdStartSource = (*TursoStore)(nil)
