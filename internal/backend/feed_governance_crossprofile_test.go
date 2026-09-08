package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	feedauth "github.com/hikariming/ghfind/internal/feed/auth"
	"github.com/hikariming/ghfind/internal/feedmigration"
)

// This is a synthetic protocol contract against real PostgreSQL and real
// workerd/D1. Test gateway signatures and receipt fixtures are not GitHub OAuth,
// source finalization, model-provider, deployed CF, or production evidence.
func TestPortableGovernanceBothProfiles(t *testing.T) {
	endpoint, bridgeSecret, operatorSecret, dsn := os.Getenv("FEED_TEST_BRIDGE_ENDPOINT"), os.Getenv("FEED_TEST_BRIDGE_SECRET"), os.Getenv("FEED_TEST_OPERATOR_SECRET"), os.Getenv("FEED_TEST_DATABASE_URL")
	if endpoint == "" || bridgeSecret == "" || operatorSecret == "" || dsn == "" {
		if os.Getenv("FEED_REQUIRE_CROSSPROFILE_TESTS") == "1" {
			t.Fatal("governance requires real workerd bridge, independent operator secret and disposable PostgreSQL")
		}
		t.Skip("run scripts/test-feed-crossprofile.mjs; missing dependencies cannot satisfy acceptance")
	}
	for name, raw := range map[string]string{"workerd": endpoint, "postgres": dsn} {
		u, err := url.Parse(raw)
		if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || (name == "workerd" && (u.Scheme != "http" || u.Path != "")) || (name == "postgres" && !strings.HasSuffix(u.Path, "_test")) {
			t.Fatalf("%s must be an isolated loopback fixture (PostgreSQL database suffix _test)", name)
		}
	}
	if len(operatorSecret) < 32 || operatorSecret == bridgeSecret {
		t.Fatal("distinct operator capability secret required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	resetFeedIntegrationSchema(t, ctx, dsn)
	if err := feedmigration.Run(ctx, dsn); err != nil {
		t.Fatal(err)
	}
	pg, err := OpenPostgresFeedStore(Config{FeedDatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	if err = pg.EnablePortableRuntime(1); err != nil {
		t.Fatal(err)
	}
	governanceArchiveFixture(t, ctx, pg)
	pgHandler, err := NewFeedGovernanceHandler(pg, operatorSecret)
	if err != nil {
		t.Fatal(err)
	}
	pgHTTP := httptest.NewServer(pgHandler)
	defer pgHTTP.Close()
	cf, err := NewCFFeedStore(endpoint, bridgeSecret, &http.Client{Timeout: 5 * time.Second, Transport: crossProfileTransport{}})
	if err != nil {
		t.Fatal(err)
	}
	cfCleanup, err := NewHTTPFeedCleanupStore(endpoint, os.Getenv("FEED_TEST_EXECUTOR_SECRET"))
	if err != nil {
		t.Fatal(err)
	}
	for _, profile := range []struct {
		name           string
		store          crossProfileStore
		operatorOrigin string
		cleanup        FeedCleanupStore
	}{{"postgres", pg, pgHTTP.URL, pg}, {"cf_d1_r2", cf, endpoint, cfCleanup}} {
		t.Run(profile.name, func(t *testing.T) {
			runPortableGovernanceContract(t, ctx, profile.store, profile.operatorOrigin, operatorSecret, bridgeSecret, profile.cleanup)
		})
	}
}

func runPortableGovernanceContract(t *testing.T, ctx context.Context, store crossProfileStore, operatorOrigin, operatorSecret, bridgeSecret string, cleanup FeedCleanupStore) {
	t.Helper()
	const actor int64 = 7654321
	const signingSecret = "synthetic-governance-feed-signature-0123456789"
	now := time.Now().UTC().Truncate(time.Millisecond)
	repos := make([]string, 30)
	analyses := make([]string, len(repos))
	// All eligibility is attached to explicit synthetic receipts through the
	// same leased job/projection capability used by the executor. No SQL RPC.
	for i := range repos {
		repos[i] = fmt.Sprintf("synthetic-gov-contract-%d/repo", i)
		analyses[i] = fmt.Sprintf("synthetic-governance-analysis-%d", i)
		assessment := validFeedAssessment()
		assessment.RepoKey, assessment.LatestAnalysisID, assessment.AnalyzedAt = repos[i], analyses[i], now.UnixMilli()
		assessment.Analysis.AnalysisID = analyses[i]
		assessment.Analysis.Repository.RepoKey = repos[i]
		assessment.Analysis.Repository.CanonicalURL = "https://github.com/" + repos[i]
		assessment.Analysis.AnalyzedAt = now.Format(time.RFC3339Nano)
		projection, err := BuildFeedProjectProjection(assessment, nil)
		if err != nil {
			t.Fatal(err)
		}
		event := FeedSourceEvent{ContractVersion: 1, EventID: "assessment.completed:" + analyses[i] + ":" + projection.SourceHash, AggregateKey: repos[i], SourceVersion: int64(10000 + i), Kind: "assessment.completed", AnalysisID: analyses[i], ReceiptID: "app:" + analyses[i], SourceHash: projection.SourceHash, OccurredAt: now.UnixMilli()}
		claim, err := store.ClaimFeedJob(ctx, FeedJobClaimRequest{WriterEpoch: 1, Event: event, LeaseOwner: "governance-contract", LeaseSeconds: 90})
		if err != nil || claim.Status != "leased" {
			t.Fatalf("projection lease %+v %v", claim, err)
		}
		_, err = store.ApplyFeedProjection(ctx, FeedApplyProjectionRequest{WriterEpoch: 1, EventID: event.EventID, LeaseOwner: "governance-contract", SourceVersion: event.SourceVersion, Projection: FeedProjectionDTO{FeedProjectProjection: projection, ProductTags: []FeedProjectionProductTag{}}, Receipt: FeedSubmissionReceipt{ReceiptID: event.ReceiptID, SourceKind: "app_submission", SubmittedAt: now}})
		if err != nil {
			t.Fatal(err)
		}
		if err = store.CompleteFeedJob(ctx, FeedJobFinishRequest{WriterEpoch: 1, EventID: event.EventID, LeaseOwner: "governance-contract"}); err != nil {
			t.Fatal(err)
		}
	}
	verifier, _ := feedauth.New("synthetic-governance-gateway-secret-0123456789", "feed-api")
	handler, err := NewStandaloneFeedHandler(FeedModeBaseline, signingSecret, store, store, func(r *http.Request, now time.Time) *OAuthSession {
		claims, err := verifier.Verify(r, now)
		if err != nil {
			return nil
		}
		return &OAuthSession{GitHubID: claims.GitHubID, Login: claims.Login}
	})
	if err != nil {
		t.Fatal(err)
	}
	apiAs := func(who int64, method, path string, input any, expected int) []byte {
		t.Helper()
		var body []byte
		if input != nil {
			body, err = json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		at := time.Now()
		token, err := verifier.Sign(feedauth.Claims{Version: 1, Audience: "feed-api", GitHubID: who, Login: "synthetic-gov-user", IssuedAt: at.UnixMilli(), ExpiresAt: at.Add(30 * time.Second).UnixMilli(), Method: method, Target: r.URL.RequestURI(), BodySHA256: feedauth.BodyHash(body)})
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set(feedauth.Header, token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != expected {
			t.Fatalf("public %s %s: %d want %d body=%s", method, path, w.Code, expected, w.Body)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("public cache contract")
		}
		return w.Body.Bytes()
	}
	api := func(method, path string, input any, expected int) []byte {
		t.Helper()
		return apiAs(actor, method, path, input, expected)
	}
	client := &http.Client{Timeout: 7 * time.Second}
	operatorRaw := func(operation string, body []byte, headers map[string]string, expected int) []byte {
		t.Helper()
		r, err := http.NewRequestWithContext(ctx, "POST", operatorOrigin+feedGovernancePath+operation, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Authorization", "Bearer "+operatorSecret)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Feed-Contract", "1")
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		out, err := io.ReadAll(io.LimitReader(response.Body, 65537))
		if err != nil || len(out) > 65536 {
			t.Fatal("operator response bound", err)
		}
		if response.StatusCode != expected {
			t.Fatalf("operator %s: %d want %d body=%s", operation, response.StatusCode, expected, out)
		}
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("operator cache contract")
		}
		return out
	}
	operator := func(operation string, input any, expected int) []byte {
		t.Helper()
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		return operatorRaw(operation, body, nil, expected)
	}
	assertError := func(body []byte, code string) {
		t.Helper()
		var got struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &got) != nil || got.Error != code {
			t.Fatalf("error want %s got %s", code, body)
		}
	}
	decode := func(body []byte, out any) {
		t.Helper()
		if err := json.Unmarshal(body, out); err != nil {
			t.Fatal(err)
		}
	}
	unknown := FeedGovernanceTarget{"user", "synthetic-absent-proposal"}
	unknownJSON, _ := json.Marshal(unknown)
	for _, tc := range []struct {
		name    string
		headers map[string]string
		status  int
		code    string
	}{
		{"operator isolation", map[string]string{"Authorization": "Bearer " + bridgeSecret}, 401, "unauthorized"},
		{"contract", map[string]string{"X-Feed-Contract": "2"}, 409, "contract_version_changed"},
		{"media", map[string]string{"Content-Type": "text/plain"}, 415, "unsupported_media_type"},
	} {
		t.Run(tc.name, func(t *testing.T) { assertError(operatorRaw("proposal", unknownJSON, tc.headers, tc.status), tc.code) })
	}
	assertError(operatorRaw("proposal?extra=1", unknownJSON, nil, 404), "operation_not_found")
	assertError(operatorRaw("proposal", bytes.Repeat([]byte(" "), 32769), nil, 413), "request_too_large")
	for _, id := range []string{"00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"} {
		assertError(operator("command", map[string]string{"commandId": id}, 400), "invalid_request")
	}
	for _, body := range []string{`{"proposalKind":"user","proposalId":"\ud800"}`, `{"proposalKind":"user","proposalId":"\ufeff"}`, "{\"proposalKind\":\"user\",\"proposalId\":\"" + string([]byte{0xff}) + "\"}"} {
		assertError(operatorRaw("proposal", []byte(body), nil, 400), "invalid_request")
	}
	for _, body := range [][]byte{[]byte(`{"proposalKind":"user","proposalId":"\ud83d\ude00"}`), []byte(`{"proposalKind":"user","proposalId":"\u0085"}`), append([]byte{0xef, 0xbb, 0xbf}, unknownJSON...)} {
		operatorRaw("proposal", body, nil, 200)
	}
	if string(bytes.TrimSpace(operator("proposal", unknown, 200))) != `{"proposal":null}` {
		t.Fatal("unknown proposal is not nullable")
	}

	var targets [3]FeedGovernanceTarget
	slugs := []string{"synthetic-contract-canonical", "synthetic-contract-alias", "synthetic-contract-rejected"}
	for i, slug := range slugs {
		input := FeedTagProposalInput{ID: fmt.Sprintf("76000000-0000-4000-8000-%012d", i+1), RepoKey: repos[i], Namespace: "domain", Slug: slug, LabelZH: "合成提议", LabelEN: "Synthetic proposal", Evidence: []string{"synthetic-receipt-evidence"}}
		var result FeedTagProposalResult
		decode(api("POST", "/api/feed/tags/proposals", input, 202), &result)
		if result.Status != "proposed" || result.ProposalID == "" {
			t.Fatalf("public proposal promoted %+v", result)
		}
		targets[i] = FeedGovernanceTarget{"user", result.ProposalID}
	}
	inspect := func(target FeedGovernanceTarget) FeedGovernanceProposal {
		t.Helper()
		var out struct {
			Proposal *FeedGovernanceProposal `json:"proposal"`
		}
		decode(operator("proposal", target, 200), &out)
		if out.Proposal == nil {
			t.Fatal("proposal missing")
		}
		return *out.Proposal
	}
	proposal := inspect(targets[0])
	if !proposal.CurrentEvidence || proposal.AnalysisID != analyses[0] || proposal.CurrentAnalysisID == nil || *proposal.CurrentAnalysisID != analyses[0] || proposal.Status != "proposed" || !reflect.DeepEqual(proposal.Evidence, []string{"synthetic-receipt-evidence"}) {
		t.Fatalf("proposal inspection %+v", proposal)
	}
	active := proposal.TaxonomyVersion
	for _, tag := range func() []FeedTag {
		tags, _, err := store.ListFeedTags(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return tags
	}() {
		if tag.ID == "domain:"+slugs[0] {
			t.Fatal("user proposal became canonical")
		}
	}
	page := func(path string) feedProjectsResponse {
		t.Helper()
		var out feedProjectsResponse
		decode(api("GET", path, nil, 200), &out)
		return out
	}
	first := page("/api/feed/projects?limit=20")
	if len(first.Items) != 20 || first.NextCursor == nil || first.TaxonomyVersion != active {
		t.Fatalf("initial page %+v", first)
	}
	item := first.Items[0]
	// Exposure changes neither preference version nor taxonomy and must preserve
	// the next page. Retain the original token for the post-governance checks.
	event := FeedEventInput{ID: "76000000-0000-4000-8000-000000000101", Type: FeedEventImpression, RepoKey: item.Project.RepoKey, ImpressionToken: item.ImpressionToken, OccurredAt: now}
	api("POST", "/api/feed/events", []FeedEventInput{event}, 202)
	page("/api/feed/projects?cursor=" + url.QueryEscape(*first.NextCursor))
	signer, _ := NewFeedSigner(signingSecret)
	claims, err := signer.ParseCursor(*first.NextCursor, actor, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	scoped, ok := store.(ActorFeedSessionStore)
	if !ok {
		t.Fatal("actor scoped persistent sessions required")
	}
	snapshot, err := scoped.GetFeedSessionForUser(ctx, actor, claims.SessionID)
	if err != nil || snapshot == nil {
		t.Fatal("persistent session", err)
	}
	// A terminal cursor is not emitted by normal pagination. Construct the valid
	// signed boundary fixture from the real persistent session, without accepting
	// an unsigned client tail or inventing a session in the adapter.
	claims.Offset = len(snapshot.Items)
	claims.ServedTail = []int{claims.Offset - 1}
	tail, err := signer.SignCursor(claims)
	if err != nil {
		t.Fatal(err)
	}
	if out := page("/api/feed/projects?cursor=" + url.QueryEscape(tail)); len(out.Items) != 0 {
		t.Fatal("terminal cursor not empty before governance")
	}
	before, err := store.GetFeedUser(ctx, actor)
	if err != nil {
		t.Fatal(err)
	}
	command := func(n int, version int64) FeedGovernanceCommand {
		return FeedGovernanceCommand{CommandID: fmt.Sprintf("76000000-0000-4000-8000-%012d", 200+n), WriterEpoch: 1, ExpectedTaxonomyVersion: version, Operator: "synthetic-contract-reviewer", Reason: "Individually reviewed synthetic evidence"}
	}
	create := FeedGovernanceReview{FeedGovernanceCommand: command(1, active), FeedGovernanceTarget: targets[0], ExpectedAnalysisID: analyses[0], Action: "create", Labels: &FeedGovernanceLabels{LabelZH: "已审核合成标签", LabelEN: "Reviewed synthetic", Description: "Synthetic review contract"}, Assignment: &FeedGovernanceAssignment{Weight: .5, Confidence: .75}}
	// Equivalent JSON numeric spellings must produce the same command identity.
	encoded, _ := json.Marshal(create)
	encoded = bytes.Replace(encoded, []byte(`"writerEpoch":1`), []byte(`"writerEpoch":1e0`), 1)
	encoded = bytes.Replace(encoded, []byte(fmt.Sprintf(`"expectedTaxonomyVersion":%d`, active)), []byte(fmt.Sprintf(`"expectedTaxonomyVersion":%d.0`, active)), 1)
	var created FeedGovernanceResult
	decode(operatorRaw("review", encoded, nil, 200), &created)
	if created.Status != "mapped" || created.TaxonomyVersion != active+1 || created.CanonicalTagID == nil || *created.CanonicalTagID != "domain:"+slugs[0] {
		t.Fatalf("create result %+v", created)
	}
	var retried FeedGovernanceResult
	decode(operator("review", create, 200), &retried)
	if !reflect.DeepEqual(created, retried) {
		t.Fatal("exact retry changed result")
	}
	changed := create
	changed.Reason = "A different review payload must conflict"
	assertError(operator("review", changed, 409), "governance_command_conflict")
	assertError(api("GET", "/api/feed/projects?cursor="+url.QueryEscape(*first.NextCursor), nil, 410), "feed_cursor_expired")
	assertError(api("GET", "/api/feed/projects?cursor="+url.QueryEscape(tail), nil, 410), "feed_cursor_expired")
	assertError(api("PUT", "/api/feed/projects/"+item.Project.RepoKey+"/state", map[string]any{"saved": true, "impressionToken": item.ImpressionToken}, 409), "taxonomy_version_changed")
	event.ID = "76000000-0000-4000-8000-000000000102"
	assertError(api("POST", "/api/feed/events", map[string]any{"events": []FeedEventInput{event}}, 409), "taxonomy_version_changed")
	after, err := store.GetFeedUser(ctx, actor)
	if err != nil {
		t.Fatal(err)
	}
	if after.ProfileVersion != before.ProfileVersion || after.TaxonomyVersion != active+1 {
		t.Fatal("taxonomy must invalidate lazily without mutating profile", before, after)
	}
	if fresh := page("/api/feed/projects?limit=20"); fresh.TaxonomyVersion != active+1 || len(fresh.Items) == 0 {
		t.Fatal("fresh session did not recover")
	}
	if pending := inspect(targets[1]); pending.Status != "proposed" {
		t.Fatal("review approved another proposal")
	}
	mapped := FeedGovernanceReview{FeedGovernanceCommand: command(2, active+1), FeedGovernanceTarget: targets[1], ExpectedAnalysisID: analyses[1], Action: "map", CanonicalTagID: *created.CanonicalTagID, Assignment: &FeedGovernanceAssignment{Weight: .25, Confidence: .8}}
	var mapResult FeedGovernanceResult
	decode(operator("review", mapped, 200), &mapResult)
	if mapResult.TaxonomyVersion != active+2 || mapResult.Status != "mapped" || mapResult.CanonicalTagID == nil || *mapResult.CanonicalTagID != *created.CanonicalTagID {
		t.Fatalf("map %+v", mapResult)
	}
	if pending := inspect(targets[2]); pending.Status != "proposed" {
		t.Fatal("map broadened its scope")
	}
	rejected := FeedGovernanceReview{FeedGovernanceCommand: command(3, active+2), FeedGovernanceTarget: targets[2], ExpectedAnalysisID: analyses[2], Action: "reject"}
	var rejectResult FeedGovernanceResult
	decode(operator("review", rejected, 200), &rejectResult)
	if rejectResult.Status != "rejected" || rejectResult.TaxonomyVersion != active+2 || rejectResult.CanonicalTagID != nil {
		t.Fatalf("reject %+v", rejectResult)
	}
	if viewed := inspect(targets[2]); viewed.Status != "rejected" || viewed.ReviewedBy == nil || *viewed.ReviewedBy != rejected.Operator || viewed.ReviewReason == nil || *viewed.ReviewReason != rejected.Reason {
		t.Fatal("review audit missing", viewed)
	}
	// Negative canonical preferences hard-filter both reviewed projects; after
	// deprecation the stored preference remains but may no longer hide projects.
	api("PUT", "/api/feed/preferences", map[string]any{"taxonomyVersion": active + 2, "preferences": []FeedPreference{{TagID: *created.CanonicalTagID, Value: -1}}}, 200)
	available, err := store.AvailableFeedRepoKeys(ctx, actor, repos[:3])
	if err != nil {
		t.Fatal(err)
	}
	if available[repos[0]] || available[repos[1]] || !available[repos[2]] {
		t.Fatalf("canonical negative filter %+v", available)
	}
	deprecate := FeedGovernanceDeprecate{FeedGovernanceCommand: command(4, active+2), CanonicalTagID: *created.CanonicalTagID}
	var deprecated FeedGovernanceResult
	decode(operator("deprecate", deprecate, 200), &deprecated)
	if deprecated.Status != "deprecated" || deprecated.TaxonomyVersion != active+3 {
		t.Fatalf("deprecate %+v", deprecated)
	}
	available, err = store.AvailableFeedRepoKeys(ctx, actor, repos[:3])
	if err != nil {
		t.Fatal(err)
	}
	if !available[repos[0]] || !available[repos[1]] {
		t.Fatal("deprecated negative still filters projects", available)
	}
	tags, version, err := store.ListFeedTags(ctx)
	if err != nil || version != active+3 {
		t.Fatal("active taxonomy", version, err)
	}
	for _, tag := range tags {
		if tag.ID == *created.CanonicalTagID {
			t.Fatal("deprecated tag is still canonical")
		}
	}
	var receipt struct {
		Command *FeedGovernanceResult `json:"command"`
	}
	decode(operator("command", map[string]string{"commandId": create.CommandID}, 200), &receipt)
	if receipt.Command == nil || !reflect.DeepEqual(*receipt.Command, created) {
		t.Fatal("persistent command receipt changed")
	}
	// Exact replay remains stable even after later taxonomy transitions.
	decode(operator("review", create, 200), &retried)
	if !reflect.DeepEqual(retried, created) {
		t.Fatal("old command retry changed after deprecation")
	}
	// Privacy continues through the same public/operator clients on both actual
	// stores. New classification facts are public; the proposal body remains private.
	privateInput := FeedTagProposalInput{ID: "76000000-0000-4000-8000-000000000501", RepoKey: repos[0], Namespace: "domain", Slug: "synthetic-private-contract", LabelEN: "Private proposal label", Evidence: []string{"private-user-synthetic-evidence"}}
	var privateResult FeedTagProposalResult
	decode(api("POST", "/api/feed/tags/proposals", privateInput, 202), &privateResult)
	privateTarget := FeedGovernanceTarget{"user", privateResult.ProposalID}
	privateCreate := FeedGovernanceReview{FeedGovernanceCommand: command(10, active+3), FeedGovernanceTarget: privateTarget, ExpectedAnalysisID: analyses[0], Action: "create", Labels: &FeedGovernanceLabels{LabelEN: "Independent public classification"}, Assignment: &FeedGovernanceAssignment{Weight: .4, Confidence: .7}}
	var privateReceipt FeedGovernanceResult
	decode(operator("review", privateCreate, 200), &privateReceipt)
	privateInput.ID = "76000000-0000-4000-8000-000000000502"
	var pendingPrivate, otherPrivate FeedTagProposalResult
	decode(api("POST", "/api/feed/tags/proposals", privateInput, 202), &pendingPrivate)
	decode(apiAs(actor+1, "POST", "/api/feed/tags/proposals", privateInput, 202), &otherPrivate)
	if pendingPrivate.ProposalID == privateResult.ProposalID || pendingPrivate.ProposalID == otherPrivate.ProposalID {
		t.Fatal("user proposals merged across actor/command identity")
	}
	beforeDelete, err := store.GetFeedUser(ctx, actor)
	if err != nil {
		t.Fatal(err)
	}
	var deletion FeedBridgeDeleteResponse
	decode(api("DELETE", "/api/feed/profile", nil, 202), &deletion)
	if deletion.DeletionID == "" || deletion.Status != "queued" {
		t.Fatalf("deletion must be queued %+v", deletion)
	}
	hidden := func(target FeedGovernanceTarget) {
		t.Helper()
		var out struct {
			Proposal *FeedGovernanceProposal `json:"proposal"`
		}
		decode(operator("proposal", target, 200), &out)
		if out.Proposal != nil {
			t.Fatal("deleted user's proposal visible", out.Proposal)
		}
	}
	for _, target := range append(targets[:], privateTarget, FeedGovernanceTarget{"user", pendingPrivate.ProposalID}) {
		hidden(target)
	}
	for i, action := range []string{"create", "map", "reject"} {
		blocked := FeedGovernanceReview{FeedGovernanceCommand: command(11+i, active+4), FeedGovernanceTarget: FeedGovernanceTarget{"user", pendingPrivate.ProposalID}, ExpectedAnalysisID: analyses[0], Action: action}
		if action == "create" {
			blocked.Labels = privateCreate.Labels
			blocked.Assignment = privateCreate.Assignment
		}
		if action == "map" {
			blocked.CanonicalTagID = *privateReceipt.CanonicalTagID
			blocked.Assignment = privateCreate.Assignment
		}
		assertError(operator("review", blocked, 409), "governance_proposal_deleted")
	}
	decode(operator("review", privateCreate, 200), &retried)
	if !reflect.DeepEqual(retried, privateReceipt) {
		t.Fatal("safe receipt retry changed after deletion")
	}
	api("GET", "/api/feed/preferences", nil, 200)
	returned, err := store.GetFeedUser(ctx, actor)
	if err != nil || returned.ProfileVersion <= beforeDelete.ProfileVersion {
		t.Fatal("recreation failed deletion generation fence", returned, err)
	}
	assertError(api("POST", "/api/feed/tags/proposals", privateInput, 409), "proposal_id_conflict")
	oldPrivateInput := privateInput
	privateInput.ID = "76000000-0000-4000-8000-000000000503"
	var newPrivate FeedTagProposalResult
	decode(api("POST", "/api/feed/tags/proposals", privateInput, 202), &newPrivate)
	if newPrivate.ProposalID == pendingPrivate.ProposalID {
		t.Fatal("new generation revived old proposal")
	}
	hidden(privateTarget)
	executor, err := NewFeedCleanupExecutor(cleanup, 1, "synthetic-governance-cleanup-executor-0123456789")
	if err != nil {
		t.Fatal(err)
	}
	deletionStore, ok := store.(FeedDeletionStore)
	if !ok {
		t.Fatal("queryable deletion status required")
	}
	completed := false
	for i := 0; i < 20; i++ {
		if _, err := executor.Execute(ctx); err != nil {
			t.Fatal("durable governance cleanup", err)
		}
		state, err := deletionStore.GetFeedDeletion(ctx, actor, deletion.DeletionID)
		if err != nil {
			t.Fatal(err)
		}
		if state.Status == "completed" {
			completed = true
			break
		}
	}
	if !completed {
		t.Fatal("bounded cleanup did not complete all erasure sinks")
	}
	hidden(privateTarget)
	hidden(FeedGovernanceTarget{"user", pendingPrivate.ProposalID})
	assertError(api("POST", "/api/feed/tags/proposals", oldPrivateInput, 409), "proposal_id_conflict")
	if p := inspect(FeedGovernanceTarget{"user", newPrivate.ProposalID}); !p.CurrentEvidence || !reflect.DeepEqual(p.Evidence, privateInput.Evidence) {
		t.Fatal("cleanup erased recreated generation", p)
	}
	if p := inspect(FeedGovernanceTarget{"user", otherPrivate.ProposalID}); !p.CurrentEvidence || !reflect.DeepEqual(p.Evidence, privateInput.Evidence) {
		t.Fatal("cleanup erased another author", p)
	}
	decode(operator("review", privateCreate, 200), &retried)
	if !reflect.DeepEqual(retried, privateReceipt) {
		t.Fatal("safe exact receipt changed after cleanup")
	}
	tags, _, err = store.ListFeedTags(ctx)
	if err != nil {
		t.Fatal(err)
	}
	retained := false
	for _, tag := range tags {
		if tag.ID == *privateReceipt.CanonicalTagID {
			retained = true
		}
	}
	if !retained {
		t.Fatal("privacy cleanup deleted an independently approved public classification")
	}

}
