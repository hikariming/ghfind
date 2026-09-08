package backend

import (
	"context"
	"database/sql"
	"time"
)

// Signals are deduplicated at actor/project/signal scope, so repeated event IDs
// or repeated outbound clicks cannot inflate a profile. These bounded weights
// match the D1 adapter; explicit preferences retain per-tag precedence.
func rebuildFeedBehaviorTx(ctx context.Context, tx *sql.Tx, id int64) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM feed.user_tag_preferences WHERE github_id=$1 AND source='behavior'`, id); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `WITH tags AS (
 SELECT pt.repo_key,pt.tag_id,MAX(pt.weight) AS weight,MAX(pt.taxonomy_version) AS taxonomy_version
 FROM feed.project_tags pt JOIN feed.tag_definitions d ON d.id=pt.tag_id AND d.status='canonical' AND d.taxonomy_version<=(SELECT version FROM feed.taxonomy_versions WHERE state='active')
 JOIN feed.projects p ON p.repo_key=pt.repo_key AND p.analysis_id=pt.analysis_id
 WHERE pt.repo_key IN(SELECT repo_key FROM feed.behavior_signals WHERE github_id=$1) GROUP BY pt.repo_key,pt.tag_id
 ) INSERT INTO feed.user_tag_preferences(github_id,tag_id,value,source,strength,taxonomy_version)
 SELECT $1,t.tag_id,1,'behavior',LEAST(0.6,SUM(CASE s.signal WHEN 'saved' THEN 0.3 WHEN 'outbound' THEN 0.1 ELSE 0.05 END*t.weight)),MAX(t.taxonomy_version)
 FROM feed.behavior_signals s JOIN tags t ON t.repo_key=s.repo_key WHERE s.github_id=$1 GROUP BY t.tag_id`, id)
	return err
}
func setFeedSavedSignalTx(ctx context.Context, tx *sql.Tx, id int64, repo string, saved bool, now time.Time) error {
	if saved {
		_, err := tx.ExecContext(ctx, `INSERT INTO feed.behavior_signals(github_id,repo_key,signal,occurred_at) VALUES($1,$2,'saved',$3) ON CONFLICT(github_id,repo_key,signal) DO NOTHING`, id, repo, now)
		if err != nil {
			return err
		}
	} else {
		if _, err := tx.ExecContext(ctx, `DELETE FROM feed.behavior_signals WHERE github_id=$1 AND repo_key=$2 AND signal='saved'`, id, repo); err != nil {
			return err
		}
	}
	return rebuildFeedBehaviorTx(ctx, tx, id)
}
func insertFeedBehaviorSignalsTx(ctx context.Context, tx *sql.Tx, id int64, eventIDs []string) (bool, error) {
	if len(eventIDs) == 0 {
		return false, nil
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO feed.behavior_signals(github_id,repo_key,signal,occurred_at)
 SELECT github_id,repo_key,CASE event_type WHEN 'github_outbound' THEN 'outbound' ELSE 'qualified_dwell' END,MIN(occurred_at)
 FROM feed.events WHERE github_id=$1 AND id=ANY($2) AND (event_type='github_outbound' OR (event_type='dwell' AND COALESCE((metadata->>'qualified')::boolean,false)))
 GROUP BY github_id,repo_key,CASE event_type WHEN 'github_outbound' THEN 'outbound' ELSE 'qualified_dwell' END
 ON CONFLICT(github_id,repo_key,signal) DO NOTHING`, id, eventIDs)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	if err != nil || count == 0 {
		return false, err
	}
	if err := rebuildFeedBehaviorTx(ctx, tx, id); err != nil {
		return false, err
	}
	return true, nil
}
