package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
)

// These plans mirror the bounded portable PostgreSQL recall paths at the named
// baseline. The report includes SQL so later changes cannot masquerade as these
// earlier query measurements. EXPLAIN is read-only and only touches the fixture.
func plans(ctx context.Context, db *sql.DB, out string) error {
	provenance := ` AND EXISTS(SELECT 1 FROM feed.project_submission_evidence e WHERE e.repo_key=p.repo_key AND e.analysis_id=p.analysis_id) `
	queries := map[string]string{}
	for _, q := range []struct {
		name, order string
		limit       string
	}{{"latest", "p.analyzed_at DESC,p.repo_key", "40"}, {"quality", "p.product_score DESC,p.confidence DESC,p.repo_key", "20"}, {"discovery", "CASE p.exposure_band WHEN 'low' THEN 0 WHEN 'emerging' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END,p.product_score DESC,p.repo_key", "20"}} {
		queries[q.name] = `SELECT p.repo_key FROM feed.projects p LEFT JOIN feed.user_project_state ups ON ups.github_id=$1 AND ups.repo_key=p.repo_key WHERE p.publishable=true ` + provenance + ` AND COALESCE(ups.not_interested,false)=false ORDER BY ` + q.order + ` LIMIT ` + q.limit
	}
	queries["tag"] = `WITH prefs AS MATERIALIZED (SELECT DISTINCT ON(tag_id) tag_id,value,strength FROM feed.user_tag_preferences WHERE github_id=$1 ORDER BY tag_id,CASE source WHEN 'explicit' THEN 3 WHEN 'behavior' THEN 2 ELSE 1 END DESC), sampled AS MATERIALIZED (SELECT pref.tag_id,pref.value,pref.strength,pt.repo_key,pt.weight,pt.confidence FROM prefs pref CROSS JOIN LATERAL (SELECT repo_key,weight,confidence FROM feed.project_tags pt WHERE pt.tag_id=pref.tag_id ORDER BY (pt.weight*pt.confidence) DESC,repo_key LIMIT 160) pt) SELECT sampled.repo_key,SUM(sampled.value*sampled.strength*sampled.weight*sampled.confidence)/NULLIF(SUM(ABS(sampled.value*sampled.strength*sampled.weight*sampled.confidence)),0) affinity FROM sampled CROSS JOIN LATERAL (SELECT 1 FROM feed.projects p WHERE p.repo_key=sampled.repo_key AND p.publishable=true ` + provenance + ` OFFSET 0) p WHERE NOT EXISTS(SELECT 1 FROM feed.user_project_state ups WHERE ups.github_id=$1 AND ups.repo_key=sampled.repo_key AND ups.not_interested=true) GROUP BY sampled.repo_key ORDER BY affinity DESC,sampled.repo_key LIMIT 80`
	queries["high_user_impression"] = `SELECT MAX(occurred_at) FROM feed.events WHERE github_id=$1 AND repo_key='capacity-owner-00000/synthetic-project-00000' AND event_type='impression'`
	result := map[string]any{}
	for name, query := range queries {
		var plan json.RawMessage
		if err := db.QueryRowContext(ctx, `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) `+query, highUser).Scan(&plan); err != nil {
			return err
		}
		result[name] = map[string]any{"sql": query, "plan": plan}
	}
	bytes, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(out, "query-plans.json"), bytes, 0600)
}
