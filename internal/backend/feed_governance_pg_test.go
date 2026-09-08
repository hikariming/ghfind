package backend

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/hikariming/ghfind/internal/feedmigration"
)

func governancePG(t *testing.T) (context.Context, *PostgresFeedStore) {
	t.Helper()
	dsn := os.Getenv("FEED_TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv("FEED_REQUIRE_POSTGRES_TESTS") == "1" {
			t.Fatal("real PostgreSQL required")
		}
		t.Skip("disposable PostgreSQL required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	resetFeedIntegrationSchema(t, ctx, dsn)
	if err := feedmigration.Run(ctx, dsn); err != nil {
		t.Fatal(err)
	}
	if err := feedmigration.Run(ctx, dsn); err != nil {
		t.Fatal("repeated migration", err)
	}
	s, err := OpenPostgresFeedStore(Config{FeedDatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if err = s.EnablePortableRuntime(1); err != nil {
		t.Fatal(err)
	}
	p, err := BuildFeedProjectProjection(validFeedAssessment(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		p.RepoKey = fmt.Sprintf("synthetic-gov-%d/repo", i)
		p.OwnerLogin = fmt.Sprintf("synthetic-gov-%d", i)
		p.ItemID = fmt.Sprintf("synthetic-gov-%d", i)
		if err = s.UpsertFeedProject(ctx, p); err != nil {
			t.Fatal(err)
		}
		govSQL(t, ctx, s, `INSERT INTO feed.project_submission_evidence(repo_key,source_kind,source_id,submitted_at,analysis_id) VALUES($1,'app_submission',$2,now(),$3)`, p.RepoKey, fmt.Sprintf("synthetic-receipt-%d", i), p.AnalysisID)
		govSQL(t, ctx, s, `INSERT INTO feed.tag_proposals(id,namespace,slug,label_zh,label_en,source,source_ref,evidence_ids,status,taxonomy_version,analysis_id) VALUES($1,'domain','synthetic-reviewed','合成','Synthetic','agent',$2,'["original-evidence"]','proposed',1,$3)`, fmt.Sprintf("governance-proposal-%d", i), p.RepoKey, p.AnalysisID)
	}
	return ctx, s
}
func govSQL(t *testing.T, ctx context.Context, s *PostgresFeedStore, q string, args ...any) {
	t.Helper()
	if _, err := s.db.ExecContext(ctx, q, args...); err != nil {
		t.Fatal(err)
	}
}
func govBase(n, version int) FeedGovernanceCommand {
	return FeedGovernanceCommand{CommandID: fmt.Sprintf("00000000-0000-4000-8000-%012d", n), WriterEpoch: 1, ExpectedTaxonomyVersion: int64(version), Operator: "fixture-operator", Reason: "Individually reviewed synthetic evidence"}
}
func TestPostgresGovernanceIndividualCommands(t *testing.T) {
	ctx, s := governancePG(t)
	h, err := NewFeedGovernanceHandler(s, govTestSecret)
	if err != nil {
		t.Fatal(err)
	}
	target := FeedGovernanceTarget{ProposalKind: "assessment", ProposalID: "governance-proposal-0"}
	status, b := govHTTP(t, h, "proposal", target)
	if status != 200 {
		t.Fatalf("inspect %d %s", status, b)
	}
	var viewed struct {
		Proposal FeedGovernanceProposal `json:"proposal"`
	}
	if err = json.Unmarshal(b, &viewed); err != nil {
		t.Fatal(err)
	}
	if !viewed.Proposal.CurrentEvidence || viewed.Proposal.Status != "proposed" {
		t.Fatalf("inspection %+v", viewed)
	}
	create := FeedGovernanceReview{FeedGovernanceCommand: govBase(1, 1), FeedGovernanceTarget: target, ExpectedAnalysisID: viewed.Proposal.AnalysisID, Action: "create", Labels: &FeedGovernanceLabels{LabelEN: "Synthetic reviewed", Description: "Individual approval"}, Assignment: &FeedGovernanceAssignment{Weight: 0, Confidence: .75}}
	status, b = govHTTP(t, h, "review", create)
	if status != 200 {
		t.Fatalf("create %d %s", status, b)
	}
	var result FeedGovernanceResult
	json.Unmarshal(b, &result)
	if result.Status != "mapped" || result.TaxonomyVersion != 2 || result.CanonicalTagID == nil || *result.CanonicalTagID != "domain:synthetic-reviewed" {
		t.Fatalf("result %+v", result)
	}
	replay, b2 := govHTTP(t, h, "review", create)
	if replay != 200 || !reflect.DeepEqual(b, b2) {
		t.Fatalf("exact retry changed %d %s %s", replay, b, b2)
	}
	changed := create
	changed.Reason = "Changed individual review reason"
	if status, _ := govHTTP(t, h, "review", changed); status != 409 {
		t.Fatal("different payload accepted", status)
	}
	var pending int
	var assignments int
	var weight, confidence float64
	var source string
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.tag_proposals WHERE id='governance-proposal-1' AND status='proposed'`).Scan(&pending)
	s.db.QueryRowContext(ctx, `SELECT COUNT(*),MAX(weight),MAX(confidence),MIN(source) FROM feed.project_tags WHERE repo_key='synthetic-gov-0/repo' AND tag_id='domain:synthetic-reviewed'`).Scan(&assignments, &weight, &confidence, &source)
	if pending != 1 || assignments != 1 || weight != 0 || confidence != .75 || source != "editor" {
		t.Fatalf("approval broadened or inferred assignment %d %d %f %f %s", pending, assignments, weight, confidence, source)
	}
	// Invalid target is atomic: no new taxonomy and no partial audit/alias write.
	bad := FeedGovernanceReview{FeedGovernanceCommand: govBase(2, 2), FeedGovernanceTarget: FeedGovernanceTarget{"assessment", "governance-proposal-1"}, ExpectedAnalysisID: create.ExpectedAnalysisID, Action: "map", CanonicalTagID: "artifact:micro-tool", Assignment: &FeedGovernanceAssignment{Weight: .25, Confidence: .5}}
	if status, _ := govHTTP(t, h, "review", bad); status != 409 {
		t.Fatal("cross namespace map accepted")
	}
	if v, _ := s.ActiveTaxonomyVersion(ctx); v != 2 {
		t.Fatal("failed mutation advanced taxonomy", v)
	}
	// Distinct slug creates a non-conflicting global alias but approves one row.
	govSQL(t, ctx, s, `UPDATE feed.tag_proposals SET slug='synthetic-alias' WHERE id='governance-proposal-1'`)
	mapped := bad
	mapped.CanonicalTagID = *result.CanonicalTagID
	if status, b = govHTTP(t, h, "review", mapped); status != 200 {
		t.Fatalf("map %d %s", status, b)
	}
	var alias string
	if err = s.db.QueryRowContext(ctx, `SELECT canonical_tag_id FROM feed.tag_aliases WHERE namespace='domain' AND alias_slug='synthetic-alias'`).Scan(&alias); err != nil || alias != *result.CanonicalTagID {
		t.Fatal("alias", alias, err)
	}
	// Same target's legacy source rows are collapsed to one effective editor row.
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.project_tags WHERE repo_key='synthetic-gov-1/repo' AND tag_id=$1`, alias).Scan(&assignments)
	if assignments != 1 {
		t.Fatal("parallel assignments", assignments)
	}
	govSQL(t, ctx, s, `INSERT INTO feed.tag_proposals(id,namespace,slug,source,source_ref,evidence_ids,status,taxonomy_version,analysis_id) VALUES('stale-proposal','domain','stale-only','user','missing/repo','[]','proposed',1,'stale-analysis')`)
	reject := FeedGovernanceReview{FeedGovernanceCommand: govBase(3, 3), FeedGovernanceTarget: FeedGovernanceTarget{"user", "stale-proposal"}, ExpectedAnalysisID: "stale-analysis", Action: "reject"}
	if status, b = govHTTP(t, h, "review", reject); status != 200 {
		t.Fatalf("reject stale %d %s", status, b)
	}
	var rejected FeedGovernanceResult
	json.Unmarshal(b, &rejected)
	if rejected.CanonicalTagID != nil || rejected.TaxonomyVersion != 3 || rejected.Status != "rejected" {
		t.Fatalf("reject %+v", rejected)
	}
	dep := FeedGovernanceDeprecate{FeedGovernanceCommand: govBase(4, 3), CanonicalTagID: alias}
	if status, b = govHTTP(t, h, "deprecate", dep); status != 200 {
		t.Fatalf("deprecate %d %s", status, b)
	}
	// Exact immutable receipts survive a new writer epoch and erased proposal.
	govSQL(t, ctx, s, `UPDATE feed.runtime_control SET writer_epoch=2;DELETE FROM feed.tag_proposals WHERE id='governance-proposal-0'`)
	if got, err := s.ReviewFeedGovernanceProposal(ctx, create); err != nil || !reflect.DeepEqual(got, result) {
		t.Fatalf("replay after erasure %+v %v", got, err)
	}
	dep.CommandID = govBase(5, 4).CommandID
	dep.ExpectedTaxonomyVersion = 4
	if _, err = s.DeprecateFeedGovernanceTag(ctx, dep); !errors.Is(err, ErrFeedWriterEpoch) {
		t.Fatal("old writer accepted", err)
	}
	if status, b = govHTTP(t, h, "command", map[string]string{"commandId": create.CommandID}); status != 200 {
		t.Fatalf("command lookup %d %s", status, b)
	}
	if p, err := s.InspectFeedGovernanceProposal(ctx, FeedGovernanceTarget{"user", "governance-proposal-1"}); err != nil || p != nil {
		t.Fatal("assessment proposal exposed as user")
	}
}

func TestPostgresGovernanceInvalidatesTaxonomyLazily(t *testing.T) {
	ctx, s := governancePG(t)
	u, err := s.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "synthetic-user"})
	if err != nil {
		t.Fatal(err)
	}
	govSQL(t, ctx, s, `DELETE FROM feed.project_tags;INSERT INTO feed.project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version) SELECT repo_key,'artifact:micro-tool','system',1,1,analysis_id,1 FROM feed.projects WHERE repo_key='synthetic-gov-0/repo'`)
	u, err = s.ReplaceExplicitFeedPreferences(withFeedProfileVersion(ctx, u.ProfileVersion), 42, 1, []FeedPreference{{TagID: "artifact:micro-tool", Value: -1, Source: "explicit", Strength: 1, TaxonomyVersion: 1}})
	if err != nil {
		t.Fatal(err)
	}
	candidates, counts, err := s.LoadFeedCandidates(ctx, *u, 240)
	if err != nil || len(candidates) != 1 || candidates[0].Project.RepoKey != "synthetic-gov-1/repo" {
		t.Fatalf("negative tag did not block %+v %v", candidates, err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	ranked := RankFeedCandidates(candidates, FeedRankOptions{Now: now, Limit: 20, Seed: "gov", OwnerCap: 2})
	snapshot := FeedSession{ID: "taxonomy-session", GitHubID: 42, ProfileVersion: u.ProfileVersion, TaxonomyVersion: 1, AlgorithmVersion: FeedPortableAlgorithmVersion, Items: ranked, CreatedAt: now, ExpiresAt: now.Add(FeedSessionTTL)}
	if err = s.PutFeedSession(ctx, snapshot, FeedSessionTTL); err != nil {
		t.Fatal(err)
	}
	record := FeedRequestRecord{ID: "taxonomy-request", User: *u, AlgorithmVersion: FeedPortableAlgorithmVersion, Seed: "gov", CandidateCounts: counts, Items: ranked}
	if err = s.SaveFeedRequest(ctx, record); err != nil {
		t.Fatal(err)
	}
	// Also isolate the Go empty-tail branch with a cache that deliberately keeps
	// the old snapshot; the PostgreSQL session query has its own independent guard.
	memory := NewMemoryFeedSessionStore()
	memory.PutFeedSession(ctx, snapshot, FeedSessionTTL)
	secret := "fixture-feed-token-secret-0123456789abcdef"
	signer, _ := NewFeedSigner(secret)
	cursor, err := signer.SignCursor(FeedCursorClaims{GitHubID: 42, SessionID: snapshot.ID, Offset: len(ranked), ExpiresAt: snapshot.ExpiresAt.UnixMilli(), ServiceVersion: 1, ServedTail: []int{0}})
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewStandaloneFeedHandler(FeedModeBaseline, secret, s, memory, func(*http.Request, time.Time) *OAuthSession {
		return &OAuthSession{GitHubID: 42, Login: "synthetic-user"}
	})
	if err != nil {
		t.Fatal(err)
	}
	beforeVersion := u.ProfileVersion
	dep := FeedGovernanceDeprecate{FeedGovernanceCommand: govBase(10, 1), CanonicalTagID: "artifact:micro-tool"}
	if _, err = s.DeprecateFeedGovernanceTag(ctx, dep); err != nil {
		t.Fatal(err)
	}
	u, err = s.GetFeedUser(ctx, 42)
	if err != nil || u.TaxonomyVersion != 2 || u.ProfileVersion != beforeVersion || len(u.Preferences) != 0 {
		t.Fatalf("lazy user %+v %v", u, err)
	}
	s.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "synthetic-user"})
	var stored int64
	s.db.QueryRowContext(ctx, `SELECT taxonomy_version FROM feed.users WHERE github_id=42`).Scan(&stored)
	if stored != 1 {
		t.Fatal("governance/ensure rewrote explicit preference version", stored)
	}
	if _, err = s.GetFeedSessionForUser(ctx, 42, snapshot.ID); !errors.Is(err, ErrFeedSessionNotFound) {
		t.Fatal("stale snapshot returned", err)
	}
	snapshot.ID = "stale-taxonomy-write"
	if err = s.PutFeedSession(ctx, snapshot, FeedSessionTTL); !errors.Is(err, ErrFeedTaxonomyChanged) {
		t.Fatal("stale snapshot stored", err)
	}
	if err = s.SaveFeedRequest(ctx, record); !errors.Is(err, ErrFeedTaxonomyChanged) {
		t.Fatal("old request retry survived taxonomy", err)
	}
	truth := true
	if _, err = s.SetFeedProjectState(withFeedProfileVersion(ctx, u.ProfileVersion), 42, ranked[0].Project.RepoKey, FeedStatePatch{Saved: &truth, RequestID: record.ID}, now); !errors.Is(err, ErrFeedTaxonomyChanged) {
		t.Fatal("old state attribution survived", err)
	}
	event := AcceptedFeedEvent{RequestID: record.ID, Input: FeedEventInput{ID: "00000000-0000-4000-8000-000000000099", RepoKey: ranked[0].Project.RepoKey, Type: FeedEventImpression, OccurredAt: now}, Metadata: map[string]any{}}
	if _, err = s.AppendFeedEvents(withFeedProfileVersion(ctx, u.ProfileVersion), 42, []AcceptedFeedEvent{event}); !errors.Is(err, ErrFeedTaxonomyChanged) {
		t.Fatal("old event attribution survived", err)
	}
	req := httptest.NewRequest("GET", "/api/feed/projects?cursor="+url.QueryEscape(cursor), nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 410 {
		t.Fatalf("empty tail bypassed taxonomy %d %s", w.Code, w.Body.String())
	}
	candidates, _, err = s.LoadFeedCandidates(ctx, *u, 240)
	if err != nil || len(candidates) != 2 {
		t.Fatal("deprecated negative tag still blocking", len(candidates), err)
	}
	available, err := s.AvailableFeedRepoKeys(ctx, 42, []string{"synthetic-gov-0/repo"})
	if err != nil || !available["synthetic-gov-0/repo"] {
		t.Fatal("availability retained deprecated negative", err)
	}
	// Revoked submission evidence remains an independent hard boundary.
	govSQL(t, ctx, s, `UPDATE feed.project_submission_evidence SET revoked_at=now() WHERE repo_key='synthetic-gov-0/repo'`)
	candidates, _, err = s.LoadFeedCandidates(ctx, *u, 240)
	if err != nil || len(candidates) != 1 {
		t.Fatal("revoked candidate eligible", err)
	}
	review := FeedGovernanceReview{FeedGovernanceCommand: govBase(11, 2), FeedGovernanceTarget: FeedGovernanceTarget{"assessment", "governance-proposal-0"}, ExpectedAnalysisID: validFeedAssessment().LatestAnalysisID, Action: "create", Labels: &FeedGovernanceLabels{LabelEN: "Revoked"}, Assignment: &FeedGovernanceAssignment{Weight: 1, Confidence: 1}}
	if _, err = s.ReviewFeedGovernanceProposal(ctx, review); err == nil {
		t.Fatal("revoked evidence accepted for governance")
	}
}

func TestPostgresGovernanceTagCapacityAndCurrentAnalysis(t *testing.T) {
	ctx, s := governancePG(t)
	govSQL(t, ctx, s, `DELETE FROM feed.project_tags;
 INSERT INTO feed.tag_definitions(id,namespace,slug,label_zh,label_en,status,taxonomy_version)
 SELECT 'domain:capacity-'||i,'domain','capacity-'||i,'','Synthetic capacity','canonical',1 FROM generate_series(0,100)i;
 INSERT INTO feed.project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version)
 SELECT 'synthetic-gov-0/repo','domain:capacity-'||i,'system',1,1,p.analysis_id,1 FROM generate_series(0,99)i CROSS JOIN feed.projects p WHERE p.repo_key='synthetic-gov-0/repo';
 INSERT INTO feed.project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version)
 VALUES('synthetic-gov-0/repo','domain:capacity-100','agent',1,1,'old-analysis',1)`)
	proposal, err := s.InspectFeedGovernanceProposal(ctx, FeedGovernanceTarget{"assessment", "governance-proposal-0"})
	if err != nil {
		t.Fatal(err)
	}
	cmd := FeedGovernanceReview{FeedGovernanceCommand: govBase(20, 1), FeedGovernanceTarget: proposal.FeedGovernanceTarget, ExpectedAnalysisID: proposal.AnalysisID, Action: "map", CanonicalTagID: "domain:capacity-100", Assignment: &FeedGovernanceAssignment{Weight: .5, Confidence: .5}}
	if _, err = s.ReviewFeedGovernanceProposal(ctx, cmd); err == nil {
		t.Fatal("stale row bypassed 100 current-tag cap")
	}
	if v, _ := s.ActiveTaxonomyVersion(ctx); v != 1 {
		t.Fatal("capacity failure advanced taxonomy")
	}
	// A stale negative tag cannot filter, match positive recall, hydrate or form
	// a new behavior signal, even though its canonical definition remains live.
	u, err := s.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "synthetic-tag-capacity"})
	if err != nil {
		t.Fatal(err)
	}
	u, err = s.ReplaceExplicitFeedPreferences(withFeedProfileVersion(ctx, u.ProfileVersion), 42, 1, []FeedPreference{{TagID: "domain:capacity-100", Value: -1, Source: "explicit", Strength: 1, TaxonomyVersion: 1}})
	if err != nil {
		t.Fatal(err)
	}
	candidates, counts, err := s.LoadFeedCandidates(ctx, *u, 240)
	if err != nil {
		t.Fatal(err)
	}
	var current *FeedCandidate
	for i := range candidates {
		if candidates[i].Project.RepoKey == "synthetic-gov-0/repo" {
			current = &candidates[i]
		}
	}
	if current == nil || len(current.Project.Tags) != 100 || counts["tag"] != 0 {
		t.Fatalf("stale analysis leaked through candidate boundary current=%v counts=%v", current != nil, counts)
	}
	for _, tag := range current.Project.Tags {
		if tag.ID == "domain:capacity-100" {
			t.Fatal("stale tag hydrated")
		}
	}
	available, err := s.AvailableFeedRepoKeys(ctx, 42, []string{current.Project.RepoKey})
	if err != nil || !available[current.Project.RepoKey] {
		t.Fatal("stale negative blocked availability", err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.guardFeedWrite(ctx, tx, 42, u.ProfileVersion); err != nil {
		t.Fatal(err)
	}
	if err = setFeedSavedSignalTx(ctx, tx, 42, current.Project.RepoKey, true, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var staleBehavior int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.user_tag_preferences WHERE github_id=42 AND source='behavior' AND tag_id='domain:capacity-100'`).Scan(&staleBehavior)
	if staleBehavior != 0 {
		t.Fatal("stale tag formed behavior preference")
	}
	cmd.CanonicalTagID = "domain:capacity-0"
	if _, err = s.ReviewFeedGovernanceProposal(ctx, cmd); err != nil {
		t.Fatal("valid current tag replacement blocked at cap", err)
	}
	var count int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.project_tags WHERE repo_key='synthetic-gov-0/repo' AND tag_id='domain:capacity-0'`).Scan(&count)
	if count != 1 {
		t.Fatal("review left duplicate source assignments", count)
	}
}

func TestPostgresGovernanceAtomicAuditAndControlLock(t *testing.T) {
	ctx, s := governancePG(t)
	p, err := s.InspectFeedGovernanceProposal(ctx, FeedGovernanceTarget{"assessment", "governance-proposal-0"})
	if err != nil {
		t.Fatal(err)
	}
	input := FeedGovernanceReview{FeedGovernanceCommand: govBase(30, 1), FeedGovernanceTarget: p.FeedGovernanceTarget, ExpectedAnalysisID: p.AnalysisID, Action: "create", Labels: &FeedGovernanceLabels{LabelEN: "Atomic"}, Assignment: &FeedGovernanceAssignment{Weight: 1, Confidence: 1}}
	govSQL(t, ctx, s, `INSERT INTO feed.taxonomy_versions(version,state) VALUES(10,'draft');INSERT INTO feed.tag_definitions(id,namespace,slug,label_zh,label_en,status,taxonomy_version) VALUES('domain:future-only','domain','future-only','','Future','canonical',10)`)
	future := input
	future.Action = "map"
	future.Labels = nil
	future.CanonicalTagID = "domain:future-only"
	if _, err = s.ReviewFeedGovernanceProposal(ctx, future); err == nil {
		t.Fatal("future canonical target accepted")
	}
	if _, err = s.DeprecateFeedGovernanceTag(ctx, FeedGovernanceDeprecate{FeedGovernanceCommand: govBase(31, 1), CanonicalTagID: "domain:future-only"}); err == nil {
		t.Fatal("future canonical deprecation accepted")
	}
	govSQL(t, ctx, s, `CREATE FUNCTION feed.reject_governance_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
 CREATE TRIGGER synthetic_governance_failure BEFORE INSERT ON feed.governance_commands FOR EACH ROW EXECUTE FUNCTION feed.reject_governance_audit()`)
	if _, err = s.ReviewFeedGovernanceProposal(ctx, input); err == nil {
		t.Fatal("audit failure did not abort")
	}
	var tags, commands int
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.tag_definitions WHERE id='domain:synthetic-reviewed'`).Scan(&tags)
	s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.governance_commands`).Scan(&commands)
	p, err = s.InspectFeedGovernanceProposal(ctx, input.FeedGovernanceTarget)
	if err != nil || p.Status != "proposed" || p.TaxonomyVersion != 1 || tags != 0 || commands != 0 {
		t.Fatalf("partial transaction escaped %+v tags=%d commands=%d err=%v", p, tags, commands, err)
	}
	govSQL(t, ctx, s, `DROP TRIGGER synthetic_governance_failure ON feed.governance_commands;DROP FUNCTION feed.reject_governance_audit()`)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.guardFeedWrite(ctx, tx, 0, 0); err != nil {
		t.Fatal(err)
	}
	blocked, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if _, err = s.ReviewFeedGovernanceProposal(blocked, input); err == nil {
		t.Fatal("governance bypassed in-flight portable writer")
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReviewFeedGovernanceProposal(ctx, input); err != nil {
		t.Fatal("governance did not resume after writer committed", err)
	}
	u, err := s.EnsureFeedUser(ctx, OAuthSession{GitHubID: 42, Login: "synthetic-lock"})
	if err != nil {
		t.Fatal(err)
	}
	tx, err = s.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT writer_epoch FROM feed.runtime_control WHERE singleton FOR UPDATE`); err != nil {
		t.Fatal(err)
	}
	blocked, cancel = context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if _, err = s.ReplaceExplicitFeedPreferences(withFeedProfileVersion(blocked, u.ProfileVersion), 42, 2, nil); err == nil {
		t.Fatal("portable writer bypassed governance activation lock")
	}
}

func TestPostgresGovernanceRejectsMalformedEvidenceWithoutAssigning(t *testing.T) {
	ctx, s := governancePG(t)
	h, _ := NewFeedGovernanceHandler(s, govTestSecret)
	target := FeedGovernanceTarget{"assessment", "governance-proposal-0"}
	for i, raw := range []string{`null`, `{}`, `[null]`, `[1]`, `["bad\n"]`, `["bad\u007f"]`} {
		govSQL(t, ctx, s, `UPDATE feed.tag_proposals SET evidence_ids=$1::jsonb,status='proposed' WHERE id=$2`, raw, target.ProposalID)
		if code, body := govHTTP(t, h, "proposal", target); code != 409 || !strings.Contains(string(body), "governance_evidence_invalid") {
			t.Fatalf("inspect %d %s", code, body)
		}
		input := FeedGovernanceReview{FeedGovernanceCommand: govBase(900+i*3, 1), FeedGovernanceTarget: target, ExpectedAnalysisID: "analysis-1", Action: "create", Labels: &FeedGovernanceLabels{LabelEN: "Bad evidence"}, Assignment: &FeedGovernanceAssignment{Weight: .5, Confidence: .5}}
		// Read only the fixture's immutable analysis ID, not a bypass API.
		if err := s.db.QueryRowContext(ctx, `SELECT analysis_id FROM feed.tag_proposals WHERE id=$1`, target.ProposalID).Scan(&input.ExpectedAnalysisID); err != nil {
			t.Fatal(err)
		}
		if code, body := govHTTP(t, h, "review", input); code != 409 || !strings.Contains(string(body), "governance_evidence_invalid") {
			t.Fatalf("create %d %s", code, body)
		}
		input.Action = "map"
		input.Labels = nil
		input.CanonicalTagID = "domain:synthetic-reviewed"
		input.CommandID = govBase(901+i*3, 1).CommandID
		if code, body := govHTTP(t, h, "review", input); code != 409 || !strings.Contains(string(body), "governance_evidence_invalid") {
			t.Fatalf("map %d %s", code, body)
		}
		input.Action = "reject"
		input.Assignment = nil
		input.CanonicalTagID = ""
		input.CommandID = govBase(902+i*3, 1).CommandID
		if code, body := govHTTP(t, h, "review", input); code != 200 {
			t.Fatalf("reject malformed %d %s", code, body)
		}
		var stored []byte
		var digest string
		var assignments int
		s.db.QueryRowContext(ctx, `SELECT evidence_ids FROM feed.tag_proposals WHERE id=$1`, target.ProposalID).Scan(&stored)
		s.db.QueryRowContext(ctx, `SELECT evidence_hash FROM feed.governance_commands WHERE command_id=$1`, input.CommandID).Scan(&digest)
		s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM feed.project_tags WHERE tag_id='domain:synthetic-reviewed'`).Scan(&assignments)
		if digest != fmt.Sprintf("%x", sha256.Sum256(stored)) || assignments != 0 {
			t.Fatal("rejection lost raw audit evidence or assigned a tag")
		}
	}
}
