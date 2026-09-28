package backend

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestPostgresTagRecallCurrentAnalysisBeforeFanout(t *testing.T) {
	ctx, s := governancePG(t)
	// This deliberately tiny independent fixture has enough stale high-weight
	// sources to fill the 160-row fanout incorrectly if filtering moves after it.
	p, err := BuildFeedProjectProjection(validFeedAssessment(), nil)
	if err != nil {
		t.Fatal(err)
	}
	p.ProductTags = nil
	for i := 0; i < 180; i++ {
		p.RepoKey = fmt.Sprintf("synthetic-recall-%03d/repo", i)
		p.ItemID = fmt.Sprintf("synthetic-recall-%03d", i)
		p.OwnerLogin = fmt.Sprintf("synthetic-recall-%03d", i)
		if err = s.UpsertFeedProject(ctx, p); err != nil {
			t.Fatal(err)
		}
		govSQL(t, ctx, s, `INSERT INTO feed.project_submission_evidence(repo_key,source_kind,source_id,submitted_at,analysis_id) VALUES($1,'app_submission',$2,now(),$3)`, p.RepoKey, "synthetic-receipt-"+p.ItemID, p.AnalysisID)
	}
	user, err := s.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "synthetic-recall-user"})
	if err != nil {
		t.Fatal(err)
	}
	govSQL(t, ctx, s, `DELETE FROM feed.project_tags;
 INSERT INTO feed.tag_definitions(id,namespace,slug,label_zh,label_en,status,taxonomy_version) VALUES('domain:synthetic-negative','domain','synthetic-negative','','Synthetic','canonical',1);
 INSERT INTO feed.user_tag_preferences(github_id,tag_id,value,source,strength,taxonomy_version) VALUES
 (42,'artifact:micro-tool',1,'explicit',1,1),(42,'stage:active-evolution',-1,'graph',0.5,1),(42,'domain:synthetic-negative',-1,'explicit',1,1);
 INSERT INTO feed.project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version)
 SELECT repo_key,'artifact:micro-tool','system',0.4,1,analysis_id,1 FROM feed.projects WHERE repo_key LIKE 'synthetic-recall-%';
 INSERT INTO feed.project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version)
 SELECT repo_key,'artifact:micro-tool','owner',1,1,'obsolete-analysis',1 FROM feed.projects WHERE repo_key LIKE 'synthetic-recall-%';
 INSERT INTO feed.project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version)
 SELECT repo_key,'artifact:micro-tool','editor',0.4,1,analysis_id,1 FROM feed.projects WHERE repo_key IN('synthetic-recall-000/repo','synthetic-recall-001/repo','synthetic-recall-157/repo');
 INSERT INTO feed.project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version)
 SELECT repo_key,'stage:active-evolution','system',0.2,1,analysis_id,1 FROM feed.projects WHERE repo_key>='synthetic-recall-000/repo' AND repo_key<='synthetic-recall-079/repo';
 INSERT INTO feed.project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version)
 SELECT repo_key,'domain:synthetic-negative','editor',1,1,analysis_id,1 FROM feed.projects WHERE repo_key='synthetic-recall-090/repo';
 UPDATE feed.project_submission_evidence SET revoked_at=now() WHERE repo_key='synthetic-recall-091/repo';
 INSERT INTO feed.user_project_state(github_id,repo_key,not_interested) VALUES(42,'synthetic-recall-092/repo',true);
 UPDATE feed.projects SET publishable=false WHERE repo_key='synthetic-recall-093/repo'`)
	user, err = s.GetFeedUser(ctx, 42)
	if err != nil {
		t.Fatal(err)
	}
	provenance, prefs := feedRecallPredicates(true)
	optimized := feedTagRecallSQL(provenance, prefs)
	original := strings.Replace(optimized, "WHERE pt.tag_id=pref.tag_id\n            AND EXISTS(SELECT 1 FROM feed.projects current WHERE current.repo_key=pt.repo_key AND current.analysis_id=pt.analysis_id OFFSET 0)", "JOIN feed.projects current ON current.repo_key=pt.repo_key AND current.analysis_id=pt.analysis_id\n            WHERE pt.tag_id=pref.tag_id", 1)
	if original == optimized {
		t.Fatal("comparison did not reconstruct baseline predicate")
	}
	type result struct {
		Key      string
		Affinity float64
	}
	read := func(ctx context.Context, query string) []result {
		rows, err := s.db.QueryContext(ctx, query, int64(42))
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		out := []result{}
		for rows.Next() {
			var r result
			if err = rows.Scan(&r.Key, &r.Affinity); err != nil {
				t.Fatal(err)
			}
			out = append(out, r)
		}
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
		return out
	}
	before, after := read(ctx, original), read(ctx, optimized)
	if len(after) != 80 || !reflect.DeepEqual(before, after) {
		t.Fatalf("ordered keys/affinities changed: old=%v new=%v", before, after)
	}
	varied := false
	for _, r := range after {
		if r.Affinity != 1 {
			varied = true
		}
		for _, key := range []string{"synthetic-recall-090/repo", "synthetic-recall-091/repo", "synthetic-recall-092/repo", "synthetic-recall-093/repo"} {
			if r.Key == key {
				t.Fatalf("hard filtered %s recalled", key)
			}
		}
	}
	if !varied {
		t.Fatal("fixture failed to exercise mixed affinity with multiple sources")
	}
	candidates, counts, err := s.LoadFeedCandidates(ctx, *user, 240)
	if err != nil || counts["tag"] != 80 {
		t.Fatalf("runtime candidate recall %v %v", counts, err)
	}
	for _, c := range candidates {
		for _, tag := range c.Project.Tags {
			if tag.Weight == 1 && tag.ID == "artifact:micro-tool" {
				t.Fatal("stale high-weight source hydrated")
			}
		}
	}
	// Deprecation makes the negative definition ineffective while preserving its
	// raw rows; the positive canonical input is still filtered before sampling.
	govSQL(t, ctx, s, `UPDATE feed.tag_definitions SET status='deprecated' WHERE id='domain:synthetic-negative'`)
	before, after = read(ctx, original), read(ctx, optimized)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("deprecated negative changed old/new equivalence")
	}
	found := false
	for _, r := range after {
		if r.Key == "synthetic-recall-090/repo" {
			found = true
		}
	}
	if !found {
		t.Fatal("deprecated negative still filters candidate")
	}
	govSQL(t, ctx, s, `UPDATE feed.tag_definitions SET status='deprecated' WHERE id='artifact:micro-tool'`)
	before, after = read(ctx, original), read(ctx, optimized)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("deprecated positive preference entered sampling")
	}
	for _, r := range after {
		if r.Affinity != -1 {
			t.Fatal("noncanonical positive preference still affects affinity")
		}
	}
}
