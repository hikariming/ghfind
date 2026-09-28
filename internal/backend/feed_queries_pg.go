package backend

// SQL builders below are used directly by serving code and by the diagnostic
// registry. Keep eligibility, ordering and transaction behavior in one place.
// The registry grants EXPLAIN permission only to exact, fixed read-only templates;
// it deliberately excludes row locks, arbitrary SQL and all mutations.
func feedRecallPredicates(portable bool) (string, string) {
	provenance := ""
	preferenceSQL := `SELECT tag_id,value,strength FROM feed.user_tag_preferences WHERE github_id=$1`
	if portable {
		preferenceSQL = `SELECT DISTINCT ON(up.tag_id) up.tag_id,up.value,up.strength FROM feed.user_tag_preferences up JOIN feed.tag_definitions td ON td.id=up.tag_id AND td.status='canonical' AND td.taxonomy_version<=(SELECT version FROM feed.taxonomy_versions WHERE state='active') WHERE up.github_id=$1 ORDER BY up.tag_id,CASE up.source WHEN 'explicit' THEN 3 WHEN 'behavior' THEN 2 ELSE 1 END DESC`
		// Keep this correlated probe inside the ordered project index scan.
		// Flattening it into a semi-join caused full catalog/evidence scans and
		// sorting before a Top20/40 LIMIT at 50k projects. OFFSET 0 preserves
		// identical eligibility semantics without truncating unverified rows
		// before the filter or changing PostgreSQL planner settings.
		provenance = " AND EXISTS(SELECT 1 FROM feed.project_submission_evidence e WHERE e.repo_key=p.repo_key AND e.analysis_id=p.analysis_id AND e.revoked_at IS NULL OFFSET 0) " + feedNegativePreferenceSQL("$1")
	}
	return provenance, preferenceSQL
}

// Keep current-analysis validation as a correlated primary-key probe before
// LIMIT. A flattened join scanned/hashed 50k projects and sorted 100k tag rows
// per request. The project PK makes this EXISTS equivalent to the former join;
// OFFSET 0 preserves the bounded affinity-index path without changing ordering.
func feedTagRecallSQL(provenance, preferenceSQL string) string {
	return `WITH prefs AS MATERIALIZED (
          ` + preferenceSQL + `
        ), sampled AS MATERIALIZED (
          SELECT pref.tag_id,pref.value,pref.strength,pt.repo_key,pt.weight,pt.confidence
          FROM prefs pref
          CROSS JOIN LATERAL (
            SELECT pt.repo_key,pt.weight,pt.confidence FROM feed.project_tags pt
            WHERE pt.tag_id=pref.tag_id
            AND EXISTS(SELECT 1 FROM feed.projects current WHERE current.repo_key=pt.repo_key AND current.analysis_id=pt.analysis_id OFFSET 0)
            ORDER BY (pt.weight * pt.confidence) DESC,pt.repo_key
            LIMIT 160
          ) pt
        )
        SELECT sampled.repo_key,
          SUM(sampled.value * sampled.strength * sampled.weight * sampled.confidence) /
            NULLIF(SUM(ABS(sampled.value * sampled.strength * sampled.weight * sampled.confidence)), 0) AS affinity
        FROM sampled
        CROSS JOIN LATERAL (
          SELECT 1 FROM feed.projects p
          WHERE p.repo_key=sampled.repo_key AND p.publishable=true ` + provenance + ` OFFSET 0
        ) p
        WHERE NOT EXISTS (
          SELECT 1 FROM feed.user_project_state ups
          WHERE ups.github_id=$1 AND ups.repo_key=sampled.repo_key AND ups.not_interested=true
        )
        GROUP BY sampled.repo_key ORDER BY affinity DESC,sampled.repo_key LIMIT 80`
}

func feedOrderedRecallSQL(provenance, order string) string {
	return `SELECT p.repo_key FROM feed.projects p
          LEFT JOIN feed.user_project_state ups ON ups.github_id = $1 AND ups.repo_key = p.repo_key
          WHERE p.publishable = true ` + provenance + ` AND COALESCE(ups.not_interested, false) = false
          ORDER BY ` + order + ` LIMIT $2`
}

func feedHydrateCandidatesSQL() string {
	return `SELECT p.repo_key, p.item_id, p.owner_login, p.name, p.canonical_url,
      p.summary, p.language, p.topics, p.project_type, p.lifecycle, p.product_score, p.confidence,
      p.verification_level, p.exposure_band, p.treasure_eligible, p.classic_eligible, p.analyzed_at,
      p.publishable, COALESCE(p.analysis_id,''), COALESCE(p.source_hash,''), ups.not_interested,
      (SELECT MAX(e.occurred_at) FROM feed.events e WHERE e.github_id = $1 AND e.repo_key = p.repo_key AND e.event_type = 'impression'),
      pe.embedding::text
      FROM feed.projects p
      LEFT JOIN feed.user_project_state ups ON ups.github_id = $1 AND ups.repo_key = p.repo_key
      LEFT JOIN feed.project_embeddings pe ON pe.repo_key = p.repo_key AND pe.active = true
      WHERE p.repo_key = ANY($2)`
}

func feedHydrateTagsSQL() string {
	return `SELECT DISTINCT ON(pt.repo_key,td.namespace,td.slug) pt.repo_key, td.id, td.namespace, td.slug, td.label_zh,
      td.label_en, td.description, pt.weight, pt.confidence, pt.taxonomy_version
      FROM feed.project_tags pt JOIN feed.tag_definitions td ON td.id = pt.tag_id
      JOIN feed.projects current ON current.repo_key=pt.repo_key AND current.analysis_id=pt.analysis_id
      WHERE pt.repo_key = ANY($1) AND td.status = 'canonical' AND td.taxonomy_version<=(SELECT version FROM feed.taxonomy_versions WHERE state='active') ORDER BY pt.repo_key, td.namespace, td.slug,CASE pt.source WHEN 'editor' THEN 0 ELSE 1 END,pt.weight DESC,pt.confidence DESC,pt.source`
}

func feedSnapshotAvailableSQL() string {
	return `SELECT p.repo_key,p.analysis_id,p.source_hash FROM feed.projects p
 WHERE p.repo_key=ANY($1) AND p.publishable=true
 AND EXISTS(SELECT 1 FROM feed.project_submission_evidence e WHERE e.repo_key=p.repo_key AND e.analysis_id=p.analysis_id AND e.revoked_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM feed.user_project_state ups WHERE ups.github_id=$2 AND ups.repo_key=p.repo_key AND ups.not_interested=true) ` + feedNegativePreferenceSQL("$2")
}

func feedSnapshotEligibleSQL() string {
	return `SELECT COUNT(*) FROM feed.projects p WHERE p.repo_key=ANY($1) AND p.publishable=true AND EXISTS(SELECT 1 FROM feed.project_submission_evidence e WHERE e.repo_key=p.repo_key AND e.analysis_id=p.analysis_id AND e.revoked_at IS NULL) AND NOT EXISTS(SELECT 1 FROM feed.user_project_state ups WHERE ups.github_id=$2 AND ups.repo_key=p.repo_key AND ups.not_interested=true) ` + feedNegativePreferenceSQL("$2")
}

// FeedDiagnosticReadQuery identifies an exact serving query eligible for bounded
// read-only EXPLAIN. Caller text is never classified by a SQL prefix.
func FeedDiagnosticReadQuery(query string) (string, bool) {
	for name, template := range feedDiagnosticReadQueryRegistry {
		if query == template {
			return name, true
		}
	}
	return "", false
}
func feedDiagnosticReadQueries() map[string]string {
	provenance, prefs := feedRecallPredicates(true)
	return map[string]string{
		"candidates.tag":       feedTagRecallSQL(provenance, prefs),
		"candidates.latest":    feedOrderedRecallSQL(provenance, "p.analyzed_at DESC, p.repo_key"),
		"candidates.quality":   feedOrderedRecallSQL(provenance, "p.product_score DESC, p.confidence DESC, p.repo_key"),
		"candidates.discovery": feedOrderedRecallSQL(provenance, "CASE p.exposure_band WHEN 'low' THEN 0 WHEN 'emerging' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END, p.product_score DESC, p.repo_key"),
		"candidates.hydrate":   feedHydrateCandidatesSQL(),
		"candidates.tags":      feedHydrateTagsSQL(),
		"snapshot.available":   feedSnapshotAvailableSQL(),
		"snapshot.eligible":    feedSnapshotEligibleSQL(),
	}
}

var feedDiagnosticReadQueryRegistry = feedDiagnosticReadQueries()

// FeedDiagnosticReadQueries returns a copy of the exact read-only registry.
// It is for synthetic diagnostics, never a SQL RPC or runtime capability.
func FeedDiagnosticReadQueries() map[string]string {
	out := make(map[string]string, len(feedDiagnosticReadQueryRegistry))
	for name, query := range feedDiagnosticReadQueryRegistry {
		out[name] = query
	}
	return out
}
