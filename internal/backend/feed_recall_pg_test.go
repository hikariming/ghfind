package backend

import (
	"context"
	"fmt"
	"github.com/hikariming/ghfind/internal/feedmigration"
	"os"
	"testing"
	"time"
)

func TestPortablePostgresRecallFiltersBeforeLimit(t *testing.T) {
	dsn := os.Getenv("FEED_TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv("FEED_REQUIRE_POSTGRES_TESTS") == "1" {
			t.Fatal("real PostgreSQL required")
		}
		t.Skip("disposable PostgreSQL required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	resetFeedIntegrationSchema(t, ctx, dsn)
	if err := feedmigration.Run(ctx, dsn); err != nil {
		t.Fatal(err)
	}
	s, err := OpenPostgresFeedStore(Config{FeedDatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.EnablePortableRuntime(1); err != nil {
		t.Fatal(err)
	}
	u, err := s.EnsureFeedUser(ctx, OAuthSession{GitHubID: 4242, Login: "synthetic-recall"})
	if err != nil {
		t.Fatal(err)
	}
	p, err := BuildFeedProjectProjection(validFeedAssessment(), nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for i := 0; i < 130; i++ {
		p.RepoKey = fmt.Sprintf("synthetic-recall/project-%03d", i)
		p.ItemID = fmt.Sprintf("synthetic-recall-%03d", i)
		p.AnalyzedAt = now.Add(-time.Duration(i) * time.Hour)
		p.ProductScore = 100 - float64(i)/2
		p.ExposureBand = "low"
		p.Publishable = i < 80 || i >= 90
		if err := s.UpsertFeedProject(ctx, p); err != nil {
			t.Fatal(err)
		}
		// The first 60 sorted rows have no receipt; the next 10 have stale
		// analysis evidence. Ten further rows are blocked by user state and ten
		// are unpublished. Exactly 40 valid rows remain beyond the invalid prefix.
		if i >= 60 {
			analysis := p.AnalysisID
			if i < 70 {
				analysis = "stale-analysis"
			}
			if _, err := s.db.ExecContext(ctx, `INSERT INTO feed.project_submission_evidence(repo_key,source_kind,source_id,submitted_at,analysis_id) VALUES($1,'app_submission',$2,now(),$3)`, p.RepoKey, fmt.Sprintf("synthetic-receipt-%d", i), analysis); err != nil {
				t.Fatal(err)
			}
		}
		if i >= 70 && i < 80 {
			if _, err := s.db.ExecContext(ctx, `INSERT INTO feed.user_project_state(github_id,repo_key,not_interested) VALUES($1,$2,true)`, u.GitHubID, p.RepoKey); err != nil {
				t.Fatal(err)
			}
		}
	}
	candidates, counts, err := s.LoadFeedCandidates(ctx, *u, 240)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 40 || counts["latest"] != 40 || counts["quality"] != 20 || counts["discovery"] != 20 {
		t.Fatalf("recall starved after invalid prefix: %d %+v", len(candidates), counts)
	}
	for _, c := range candidates {
		if c.Project.RepoKey < "synthetic-recall/project-090" || !c.Project.SubmissionEvidence {
			t.Fatalf("ineligible candidate: %+v", c.Project)
		}
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE feed.project_submission_evidence SET analysis_id='withdrawn' WHERE repo_key>='synthetic-recall/project-095'`); err != nil {
		t.Fatal(err)
	}
	candidates, counts, err = s.LoadFeedCandidates(ctx, *u, 240)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 5 || counts["latest"] != 5 || counts["quality"] != 5 || counts["discovery"] != 5 {
		t.Fatalf("short recall relaxed filters: %d %+v", len(candidates), counts)
	}
}
