package backend

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/hikariming/ghfind/internal/feedmigration"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func governanceArchiveFixture(t *testing.T, ctx context.Context, pg *PostgresFeedStore) {
	t.Helper()
	endpoint := os.Getenv("FEED_TEST_S3_ENDPOINT")
	if endpoint == "" {
		if os.Getenv("FEED_REQUIRE_S3_TESTS") == "1" || os.Getenv("FEED_REQUIRE_CROSSPROFILE_TESTS") == "1" {
			t.Fatal("governance erasure requires actual S3-compatible service")
		}
		t.Skip("real S3 required for governance cleanup completion")
	}
	config := FeedS3Config{Endpoint: endpoint, Region: "us-east-1", Bucket: fmt.Sprintf("feed-governance-privacy-%d", time.Now().UnixNano()), AccessKeyID: os.Getenv("FEED_TEST_S3_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("FEED_TEST_S3_SECRET_ACCESS_KEY"), UsePathStyle: true}
	objects, err := NewFeedS3Objects(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	client := objects.client.(*s3.Client)
	if _, err = client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(config.Bucket)}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		list, err := client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{Bucket: aws.String(config.Bucket), MaxKeys: aws.Int32(100)})
		if err != nil {
			t.Error(err)
			return
		}
		if aws.ToBool(list.IsTruncated) {
			t.Error("bounded governance bucket teardown exceeded")
			return
		}
		for _, o := range list.Contents {
			if _, err = client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(config.Bucket), Key: o.Key}); err != nil {
				t.Error(err)
			}
		}
		if _, err = client.DeleteBucket(ctx, &s3.DeleteBucketInput{Bucket: aws.String(config.Bucket)}); err != nil {
			t.Error(err)
		}
	})
	if err = pg.UseArchiveObjects(objects); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresGovernanceUserDeletionPrivacy(t *testing.T) {
	ctx, s := governancePG(t)
	governanceArchiveFixture(t, ctx, s)
	h, _ := NewFeedGovernanceHandler(s, govTestSecret)
	for _, id := range []int64{42, 43} {
		if _, err := s.EnsureFeedUser(ctx, OAuthSession{GitHubID: id, Login: "synthetic-owner"}); err != nil {
			t.Fatal(err)
		}
	}
	propose := func(actor int64, n int, repo, slug string) FeedGovernanceTarget {
		t.Helper()
		input := FeedTagProposalInput{ID: fmt.Sprintf("77000000-0000-4000-8000-%012d", n), RepoKey: repo, Namespace: "domain", Slug: slug, LabelEN: "Private original label", Evidence: []string{"private-user-request-evidence"}}
		result, err := s.ProposeFeedTag(ctx, actor, input)
		if err != nil {
			t.Fatal(err)
		}
		again, err := s.ProposeFeedTag(ctx, actor, input)
		if err != nil || result != again {
			t.Fatal("actor command retry", result, again, err)
		}
		return FeedGovernanceTarget{"user", result.ProposalID}
	}
	one := propose(42, 1, "synthetic-gov-0/repo", "private-classification")
	pending := propose(42, 2, "synthetic-gov-0/repo", "private-classification")
	other := propose(43, 1, "synthetic-gov-0/repo", "private-classification")
	if one == pending || one == other || pending == other {
		t.Fatal("user proposals merged across actors or commands")
	}
	var viewed struct {
		Proposal FeedGovernanceProposal `json:"proposal"`
	}
	status, b := govHTTP(t, h, "proposal", one)
	if status != 200 {
		t.Fatal(status, string(b))
	}
	json.Unmarshal(b, &viewed)
	create := FeedGovernanceReview{FeedGovernanceCommand: govBase(7701, 1), FeedGovernanceTarget: one, ExpectedAnalysisID: viewed.Proposal.AnalysisID, Action: "create", Labels: &FeedGovernanceLabels{LabelEN: "Independently reviewed public classification"}, Assignment: &FeedGovernanceAssignment{Weight: .4, Confidence: .7}}
	status, b = govHTTP(t, h, "review", create)
	if status != 200 {
		t.Fatal(status, string(b))
	}
	var receipt FeedGovernanceResult
	json.Unmarshal(b, &receipt)
	var evidence, origin string
	if err := s.db.QueryRowContext(ctx, `SELECT evidence_ids::text,origin_proposal_id FROM feed.project_tags WHERE repo_key=$1 AND tag_id=$2 AND source='editor'`, viewed.Proposal.RepoKey, *receipt.CanonicalTagID).Scan(&evidence, &origin); err != nil {
		t.Fatal(err)
	}
	if origin != one.ProposalID || strings.Contains(evidence, "private-user-request-evidence") || !strings.Contains(evidence, "governance:"+create.CommandID) {
		t.Fatal("assignment copied private evidence", evidence, origin)
	}
	// Model a pre-fix assignment with proven origin. This is local fixture SQL,
	// never a new production capability or a path for submitting raw assignments.
	govSQL(t, ctx, s, `UPDATE feed.project_tags SET evidence_ids='["legacy-private-copy"]'::jsonb WHERE origin_proposal_id=$1`, one.ProposalID)
	second := propose(42, 3, "synthetic-gov-1/repo", "other-private-alias")
	mapCommand := FeedGovernanceReview{FeedGovernanceCommand: govBase(7702, 2), FeedGovernanceTarget: second, ExpectedAnalysisID: create.ExpectedAnalysisID, Action: "map", CanonicalTagID: *receipt.CanonicalTagID, Assignment: &FeedGovernanceAssignment{Weight: .6, Confidence: .8}}
	if code, b := govHTTP(t, h, "review", mapCommand); code != 200 {
		t.Fatal(code, string(b))
	}
	newer := propose(43, 3, "synthetic-gov-1/repo", "other-private-alias")
	overwrite := mapCommand
	overwrite.FeedGovernanceCommand = govBase(7703, 3)
	overwrite.FeedGovernanceTarget = newer
	if code, b := govHTTP(t, h, "review", overwrite); code != 200 {
		t.Fatal(code, string(b))
	}
	if _, err := s.PutFeedArchive(ctx, FeedArchiveIdentity{42, 1, "private-events"}, []byte(`{"evidence":"private-archive"}`)); err != nil {
		t.Fatal(err)
	}
	deletion, err := s.DeleteFeedProfile(ctx, 42, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var authors int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.user_proposal_authors WHERE github_id=42`).Scan(&authors)
	if authors != 3 {
		t.Fatal("deletion lost durable author links", authors)
	}
	for _, target := range []FeedGovernanceTarget{one, pending, second} {
		if code, b := govHTTP(t, h, "proposal", target); code != 200 || string(b) != "{\"proposal\":null}\n" {
			t.Fatalf("deleted proposal visible %d %s", code, b)
		}
	}
	for i, action := range []string{"create", "map", "reject"} {
		attempt := FeedGovernanceReview{FeedGovernanceCommand: govBase(7710+i, 4), FeedGovernanceTarget: pending, ExpectedAnalysisID: create.ExpectedAnalysisID, Action: action}
		if action == "create" {
			attempt.Labels = create.Labels
			attempt.Assignment = create.Assignment
		}
		if action == "map" {
			attempt.CanonicalTagID = *receipt.CanonicalTagID
			attempt.Assignment = create.Assignment
		}
		if code, b := govHTTP(t, h, "review", attempt); code != 409 || !strings.Contains(string(b), "governance_proposal_deleted") {
			t.Fatalf("deleted review %s %d %s", action, code, b)
		}
	}
	// Same actor and command after erasure belong to a new generation.
	recreated, err := s.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "synthetic-returned"})
	if err != nil || recreated.ProfileVersion <= 1 {
		t.Fatal("recreation floor", recreated, err)
	}
	oldInput := FeedTagProposalInput{ID: "77000000-0000-4000-8000-000000000001", RepoKey: "synthetic-gov-0/repo", Namespace: "domain", Slug: "private-classification", LabelEN: "Private original label", Evidence: []string{"private-user-request-evidence"}}
	if _, err = s.ProposeFeedTag(ctx, 42, oldInput); !errors.Is(err, ErrFeedProposalConflict) {
		t.Fatal("old-generation command replay accepted", err)
	}
	replacement := propose(42, 4, "synthetic-gov-0/repo", "private-classification")
	if replacement == one {
		t.Fatal("old proposal revived by command replay after recreation")
	}
	lease, err := s.ClaimFeedCleanup(ctx, FeedCleanupClaim{1, "privacy-cleanup", 90})
	if err != nil || lease.DeletionID != deletion {
		t.Fatal(lease, err)
	}
	command := FeedCleanupCommand{WriterEpoch: 1, DeletionID: deletion, LeaseOwner: "privacy-cleanup"}
	first, err := s.StepFeedCleanup(ctx, command)
	if err != nil || first.Status == "completed" {
		t.Fatal("premature cleanup completion", first, err)
	}
	if err = s.ReleaseFeedCleanup(ctx, command); err != nil {
		t.Fatal(err)
	}
	lease, err = s.ClaimFeedCleanup(ctx, FeedCleanupClaim{1, "privacy-cleanup-resume", 90})
	if err != nil || lease.DeletionID != deletion || lease.Failures != 0 {
		t.Fatal("normal checkpoint recovery", lease, err)
	}
	command.LeaseOwner = "privacy-cleanup-resume"
	complete := false
	for i := 0; i < 20; i++ {
		progress, err := s.StepFeedCleanup(ctx, command)
		if err != nil || progress.Processed > 100 {
			t.Fatal("bounded cleanup", progress, err)
		}
		if progress.Status == "completed" {
			complete = true
			break
		}
	}
	if !complete {
		t.Fatal("cleanup did not complete within bounded steps")
	}
	if code, b := govHTTP(t, h, "proposal", replacement); code != 200 || strings.Contains(string(b), "\"proposal\":null") || !strings.Contains(string(b), "private-user-request-evidence") {
		t.Fatal("new generation erased", code, string(b))
	}
	if code, b := govHTTP(t, h, "proposal", one); code != 200 || !strings.Contains(string(b), "\"proposal\":null") {
		t.Fatal("old proposal reappeared", code, string(b))
	}
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.user_proposal_authors WHERE github_id=42 AND profile_version<=1`).Scan(&authors)
	if authors != 0 {
		t.Fatal("completed cleanup retained author links")
	}
	s.db.QueryRowContext(ctx, `SELECT evidence_ids::text,COALESCE(origin_proposal_id,'') FROM feed.project_tags WHERE repo_key='synthetic-gov-0/repo' AND tag_id=$1 AND source='editor'`, *receipt.CanonicalTagID).Scan(&evidence, &origin)
	if evidence != "[]" || origin != "" {
		t.Fatal("legacy copied evidence retained", evidence, origin)
	}
	s.db.QueryRowContext(ctx, `SELECT evidence_ids::text,origin_proposal_id FROM feed.project_tags WHERE repo_key='synthetic-gov-1/repo' AND tag_id=$1 AND source='editor'`, *receipt.CanonicalTagID).Scan(&evidence, &origin)
	if origin != newer.ProposalID || !strings.Contains(evidence, "governance:"+overwrite.CommandID) {
		t.Fatal("cleanup erased a later author's assignment", evidence, origin)
	}
	code, retry := govHTTP(t, h, "review", create)
	var retried FeedGovernanceResult
	json.Unmarshal(retry, &retried)
	if code != 200 || !reflect.DeepEqual(receipt, retried) {
		t.Fatal("safe exact governance receipt lost", code, string(retry))
	}
	s.db.QueryRowContext(ctx, `SELECT evidence_ids::text FROM feed.project_tags WHERE repo_key='synthetic-gov-0/repo' AND tag_id=$1 AND source='editor'`, *receipt.CanonicalTagID).Scan(&evidence)
	if evidence != "[]" {
		t.Fatal("receipt retry rewrote erased evidence")
	}
	var associations, rawReceipts, rawSlugs int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FILTER(WHERE proposal_id IS NOT NULL),COUNT(*) FILTER(WHERE payload_hash<>'deleted' OR created_at<>'epoch'::timestamptz) FROM feed.tag_proposal_commands WHERE github_id=42 AND profile_version<=1`).Scan(&associations, &rawReceipts)
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.tag_proposals WHERE id=$1 AND slug<>'deleted-proposal'`, one.ProposalID).Scan(&rawSlugs)
	if associations != 0 || rawReceipts != 0 || rawSlugs != 0 {
		t.Fatal("cleanup retained raw slug or submission command association", associations, rawReceipts, rawSlugs)
	}
	if _, err = s.ProposeFeedTag(ctx, 42, oldInput); !errors.Is(err, ErrFeedProposalConflict) {
		t.Fatal("cleaned command replay accepted", err)
	}
}

func TestPostgresUserProposalPrivacyMigration(t *testing.T) {
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
	s, err := OpenPostgresFeedStore(Config{FeedDatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	govSQL(t, ctx, s, `CREATE SCHEMA feed;CREATE TABLE feed.schema_migrations(version BIGINT PRIMARY KEY,name TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
	required, err := feedmigration.RequiredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range required {
		if m.Version >= 22 {
			break
		}
		body, err := os.ReadFile(filepath.Join("..", "feedmigration", "migrations", m.Name))
		if err != nil {
			t.Fatal(err)
		}
		govSQL(t, ctx, s, string(body))
		govSQL(t, ctx, s, `INSERT INTO feed.schema_migrations(version,name) VALUES($1,$2)`, m.Version, m.Name)
	}
	if err = s.EnablePortableRuntime(1); err != nil {
		t.Fatal(err)
	}
	p, err := BuildFeedProjectProjection(validFeedAssessment(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		repo := fmt.Sprintf("synthetic-old-privacy-%d/repo", i)
		govSQL(t, ctx, s, `INSERT INTO feed.projects(repo_key,item_id,owner_login,name,canonical_url,summary,project_type,lifecycle,product_score,confidence,verification_level,exposure_band,analysis_id,resolved_commit_sha,analyzed_at,descriptor,descriptor_hash,source_hash,publishable)
   VALUES($1,$2,$2,'repo',$3,'Synthetic legacy migration fixture','tool','active',80,85,'partial','long_tail',$4,repeat('a',40),now(),'synthetic','h','h',true)`, repo, fmt.Sprintf("synthetic-old-privacy-%d", i), "https://github.com/"+repo, p.AnalysisID)
	}

	govSQL(t, ctx, s, `INSERT INTO feed.users(github_id,login,taxonomy_version) VALUES(101,'synthetic-author',1),(102,'synthetic-other',1),(103,'synthetic-deleted',1)`)
	for _, id := range []string{"proof", "shared", "later", "deleted", "orphan"} {
		govSQL(t, ctx, s, `INSERT INTO feed.tag_proposals(id,namespace,slug,source,source_ref,evidence_ids,analysis_id,taxonomy_version,created_at,label_en) VALUES($1,'artifact',$1,'user','synthetic-old-privacy-0/repo','["legacy-sensitive"]',$2,1,'2026-01-01T00:00:00Z','Private historical label')`, id, p.AnalysisID)
	}
	govSQL(t, ctx, s, `INSERT INTO feed.tag_proposal_commands(github_id,command_id,proposal_id,payload_hash,created_at) VALUES
 (101,'proof','proof','h','2026-01-01T00:00:00Z'),
 (101,'shared-one','shared','h','2026-01-01T00:00:00Z'),(102,'shared-two','shared','h','2026-01-01T00:00:01Z'),
 (102,'later','later','h','2026-01-01T00:00:01Z'),(103,'deleted','deleted','h','2026-01-01T00:00:00Z')`)
	govSQL(t, ctx, s, `INSERT INTO feed.user_deletion_tombstones(deletion_id,github_id,gorse_user_id,requested_at,profile_version,cleanup_status) VALUES('legacy-erasure',103,'gh:103',now(),1,'completed')`)
	raw := `["legacy-sensitive"]`
	for i := 0; i < 2; i++ {
		repo := fmt.Sprintf("synthetic-old-privacy-%d/repo", i)
		commandID := fmt.Sprintf("78000000-0000-4000-8000-%012d", i+1)
		govSQL(t, ctx, s, `INSERT INTO feed.governance_commands(command_id,action,writer_epoch,expected_taxonomy_version,proposal_kind,proposal_id,repo_key,analysis_id,evidence_hash,canonical_tag_id,operator,reason,assignment_weight,assignment_confidence,payload_hash,result_json,taxonomy_version,created_at)
   VALUES($1,'map',1,1,'user','proof',$2,$3,$4,'artifact:micro-tool','synthetic-reviewer','Historical synthetic evidence review',.4,.7,'h','{}',1,now())`, commandID, repo, p.AnalysisID, fmt.Sprintf("%x", sha256.Sum256([]byte(raw))))
		evidence := raw
		if i == 1 {
			evidence = `["later-assessment-owned-evidence"]`
		}
		govSQL(t, ctx, s, `INSERT INTO feed.project_tags(repo_key,tag_id,source,weight,confidence,evidence_ids,analysis_id,taxonomy_version) VALUES($1,'artifact:micro-tool','editor',.4,.7,$2::jsonb,$3,1)`, repo, evidence, p.AnalysisID)
	}
	if err = feedmigration.Run(ctx, dsn); err != nil {
		t.Fatal("upgrade 0021 to 0022", err)
	}
	if err = feedmigration.Run(ctx, dsn); err != nil {
		t.Fatal("repeat completed migration", err)
	}
	var linked int
	var owner int64
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.user_proposal_authors`).Scan(&linked)
	s.db.QueryRowContext(ctx, `SELECT github_id FROM feed.user_proposal_authors WHERE proposal_id='proof'`).Scan(&owner)
	if linked != 1 || owner != 101 {
		t.Fatal("migration guessed historical ownership", linked, owner)
	}
	for _, id := range []string{"shared", "later", "deleted", "orphan"} {
		proposal, err := s.InspectFeedGovernanceProposal(ctx, FeedGovernanceTarget{"user", id})
		if err != nil || proposal != nil {
			t.Fatal("quarantined raw body visible", id, proposal, err)
		}
		input := FeedGovernanceReview{FeedGovernanceCommand: govBase(7801, 1), FeedGovernanceTarget: FeedGovernanceTarget{"user", id}, ExpectedAnalysisID: p.AnalysisID, Action: "reject"}
		if _, err = s.ReviewFeedGovernanceProposal(ctx, input); err == nil || err.Error() != "governance_proposal_deleted" {
			t.Fatal("quarantined command accepted", id, err)
		}
	}
	var quarantined, retained int
	if err = s.db.QueryRowContext(ctx, `SELECT quarantined_proposals,retained_body_proposals FROM feed.user_proposal_quarantine_summary`).Scan(&quarantined, &retained); err != nil || quarantined != 4 || retained != 4 {
		t.Fatal("quarantine must remain visible to promotion audit", quarantined, retained, err)
	}
	var evidence, origin string
	s.db.QueryRowContext(ctx, `SELECT evidence_ids::text,COALESCE(origin_proposal_id,'') FROM feed.project_tags WHERE repo_key='synthetic-old-privacy-0/repo' AND tag_id='artifact:micro-tool'`).Scan(&evidence, &origin)
	if origin != "proof" || !strings.Contains(evidence, "governance:78000000-0000-4000-8000-000000000001") {
		t.Fatal("proven legacy copy not sanitized", evidence, origin)
	}
	s.db.QueryRowContext(ctx, `SELECT evidence_ids::text,COALESCE(origin_proposal_id,'') FROM feed.project_tags WHERE repo_key='synthetic-old-privacy-1/repo' AND tag_id='artifact:micro-tool'`).Scan(&evidence, &origin)
	if origin != "" || evidence != `["later-assessment-owned-evidence"]` {
		t.Fatal("migration guessed later overwrite provenance", evidence, origin)
	}
}

func TestPostgresGovernancePrivacyCleanupIsBounded(t *testing.T) {
	ctx, s := governancePG(t)
	governanceArchiveFixture(t, ctx, s)
	if _, err := s.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "synthetic-many-proposals"}); err != nil {
		t.Fatal(err)
	}
	govSQL(t, ctx, s, `INSERT INTO feed.tag_proposals(id,namespace,slug,source,source_ref,evidence_ids,analysis_id,taxonomy_version,label_en)
 SELECT 'private-batch-'||i,'domain','private-batch-'||i,'user','synthetic-gov-0/repo','["private"]','old-analysis',1,'Private original' FROM generate_series(1,201)i;
 INSERT INTO feed.user_proposal_authors(proposal_id,github_id,profile_version) SELECT id,42,1 FROM feed.tag_proposals WHERE id LIKE 'private-batch-%'`)
	deletion, err := s.DeleteFeedProfile(ctx, 42, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	lease, err := s.ClaimFeedCleanup(ctx, FeedCleanupClaim{1, "bounded-privacy", 90})
	if err != nil || lease.DeletionID != deletion {
		t.Fatal(lease, err)
	}
	cmd := FeedCleanupCommand{WriterEpoch: 1, DeletionID: deletion, LeaseOwner: "bounded-privacy"}
	first, err := s.StepFeedCleanup(ctx, cmd)
	if err != nil || first.Processed != 100 || first.Status != "running" || first.Phase != "primary" {
		t.Fatal("first page of cleanup", first, err)
	}
	var remaining int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.tag_proposals WHERE id LIKE 'private-batch-%' AND label_en='Private original'`).Scan(&remaining)
	if remaining != 101 {
		t.Fatal("cleanup exceeded its body erasure bound", remaining)
	}
	complete := false
	for i := 0; i < 20; i++ {
		progress, err := s.StepFeedCleanup(ctx, cmd)
		if err != nil || progress.Processed > 100 {
			t.Fatal(progress, err)
		}
		if progress.Status == "completed" {
			complete = true
			break
		}
	}
	if !complete {
		t.Fatal("bounded cleanup did not finish")
	}
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.user_proposal_authors WHERE github_id=42`).Scan(&remaining)
	if remaining != 0 {
		t.Fatal("completed cleanup retained author associations", remaining)
	}
}

func TestPostgresGovernanceReviewRacesProfileDeletion(t *testing.T) {
	ctx, s := governancePG(t)
	if _, err := s.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "synthetic-delete-race"}); err != nil {
		t.Fatal(err)
	}
	result, err := s.ProposeFeedTag(ctx, 42, FeedTagProposalInput{ID: "79000000-0000-4000-8000-000000000001", RepoKey: "synthetic-gov-0/repo", Namespace: "domain", Slug: "private-race", LabelEN: "Private pending", Evidence: []string{"private-race-evidence"}})
	if err != nil {
		t.Fatal(err)
	}
	target := FeedGovernanceTarget{"user", result.ProposalID}
	proposal, err := s.InspectFeedGovernanceProposal(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	command := FeedGovernanceReview{FeedGovernanceCommand: govBase(7901, 1), FeedGovernanceTarget: target, ExpectedAnalysisID: proposal.AnalysisID, Action: "create", Labels: &FeedGovernanceLabels{LabelEN: "Public classification"}, Assignment: &FeedGovernanceAssignment{Weight: .5, Confidence: .5}}
	blocker, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	if err = s.guardFeedWrite(ctx, blocker, 42, 0); err != nil {
		t.Fatal(err)
	}
	deleted := make(chan error, 1)
	reviewed := make(chan error, 1)
	go func() { _, err := s.DeleteFeedProfile(ctx, 42, time.Now()); deleted <- err }()
	wait := func(query string) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			var waiting bool
			if err := s.db.QueryRowContext(ctx, query).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("expected database lock wait not observed")
	}
	wait(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%')`)
	go func() { _, err := s.ReviewFeedGovernanceProposal(ctx, command); reviewed <- err }()
	wait(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%runtime_control%' AND query LIKE '%FOR UPDATE%')`)
	if err = blocker.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err = <-deleted; err != nil {
		t.Fatal("delete transaction", err)
	}
	if err = <-reviewed; err == nil || err.Error() != "governance_proposal_deleted" {
		t.Fatal("governance raced past deletion floor", err)
	}
	var assigned int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.tag_definitions WHERE id='domain:private-race'`).Scan(&assigned)
	if assigned != 0 {
		t.Fatal("racing review published deleted private evidence")
	}
}
