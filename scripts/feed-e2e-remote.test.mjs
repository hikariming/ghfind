import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT, validateTarget, validateLoginState, validateCallbackSession, validatePreviousAssessment, validateProjection, safeError } from "./feed-e2e-remote.mjs";

const target = () => ({ schemaVersion: 2, accountId: ACCOUNT,
  coreDatabase: { id: "69bdae1c-ac36-4883-8fa4-9ffa54ebd033" }, feedDatabase: { id: "7526684c-b57d-412e-89ba-812cd30798e8" },
  web: { worker: "ghfind-feed-web-staging", origin: "https://ghfind-feed-web-staging.beiming1201.workers.dev", runtimeOrigin: "https://ghfind-feed-runtime-staging.beiming1201.workers.dev",
    oauth: { callbackUrl: "https://ghfind-feed-web-staging.beiming1201.workers.dev/api/auth/callback/github", identities: [{ role: "ordinary", githubId: "101", login: "fixture-one" }, { role: "governance", githubId: "102", login: "fixture-two" }] },
    sourceProvider: { dedicated: true, agentId: "dedicated-fixture-agent", repositories: ["example/tool"] } } });

test("remote runner refuses every production/dev database and unpinned origin before side effects", () => {
  validateTarget(target());
  for (const id of ["60d45096-bfe7-4de1-8b85-c1b66a466b0d", "9c4ac13a-4c90-40a8-9d56-d7141f864bbf", "bd305af9-2cab-4fe8-8c2f-324391cf105e"]) {
    const m = target(); m.coreDatabase.id = id; assert.throws(() => validateTarget(m), /isolated_target_required/);
  }
  for (const origin of ["https://ghfind.com", "http://127.0.0.1:8787", "https://ghfind-feed-web-staging.other.workers.dev"]) {
    const m = target(); m.web.origin = origin; assert.throws(() => validateTarget(m), /isolated_origins_required/);
  }
});

test("ordinary and governance must be distinct unambiguous GitHub identities", () => {
  for (const value of ["101", 101, "9007199254740992", "01"]) {
    const m = target(); m.web.oauth.identities[1].githubId = value;
    assert.throws(() => validateTarget(m), /dedicated_identities_required/);
  }
});

test("holders' login state cannot smuggle a preissued application cookie or another site's secrets", () => {
  const state = { cookies: [{ domain: ".github.com", name: "user_session", value: "unit-fixture" }], origins: [] };
  validateLoginState(state);
  for (const domain of ["ghfind-feed-web-staging.beiming1201.workers.dev", ".github.com.attacker.test", "accounts.google.com"]) {
    assert.throws(() => validateLoginState({ ...state, cookies: [{ ...state.cookies[0], domain }] }), /non_github_login_state_rejected/);
  }
  assert.throws(() => validateLoginState({ ...state, cookies: [{ ...state.cookies[0], name: "ghfind_session" }] }), /non_github_login_state_rejected/);
  assert.throws(() => validateLoginState({ ...state, origins: [{ origin: "https://unrelated.test" }] }), /non_github_login_state_rejected/);
});

test("actual callback identity must match the selected role and be secure and unexpired", () => {
  const identity = target().web.oauth.identities[0];
  const cookie = subject => ({ name: "ghfind_session", httpOnly: true, secure: true, value: Buffer.from(JSON.stringify({ github_id: subject, login: "fixture-one", expires_at: 2000 })).toString("base64url") + ".unit-only-signature" });
  validateCallbackSession(cookie(101), identity, 1000);
  assert.throws(() => validateCallbackSession(cookie(102), identity, 1000), /oauth_identity_mismatch/);
  assert.throws(() => validateCallbackSession(cookie(101), identity, 3000), /oauth_identity_mismatch/);
  assert.throws(() => validateCallbackSession({ ...cookie(101), secure: false }, identity, 1000), /callback_session_required/);
});

test("repeat fixture preparation cannot clear an unowned or running assessment", () => {
  validatePreviousAssessment(undefined, "dedicated-fixture-agent");
  const row = { status: "completed", mosoo_agent_id: "dedicated-fixture-agent", active_key: null, latest_analysis_id: "old-fixture" };
  validatePreviousAssessment(row, "dedicated-fixture-agent");
  for (const patch of [{ status: "running" }, { mosoo_agent_id: "production-agent" }, { active_key: "in-flight" }]) {
    assert.throws(() => validatePreviousAssessment({ ...row, ...patch }, "dedicated-fixture-agent"), /unowned_previous_assessment/);
  }
});

test("browser failures cannot place OAuth URLs, codes or response bodies into public evidence", () => {
  assert.equal(safeError(new Error("https://github.com/callback?code=private&state=private")), "remote_e2e_failed");
  assert.equal(safeError(new Error('{"cookie":"private"}')), "remote_e2e_failed");
  assert.equal(safeError(new Error("oauth_identity_mismatch")), "oauth_identity_mismatch");
});

test("a completed superseded job or old visible project cannot prove the new projection", () => {
  const fact = { event_id: "new-event", sequence: 12, receipt_id: "new-receipt", analysis_sha256: "a".repeat(64), source_hash: "a".repeat(64) };
  // The Go projection hashes normalized metadata as well as analysis content;
  // its composite hash is intentionally distinct from the raw analysis hash.
  const row = { analysis_id: "new-analysis", version_analysis_id: "new-analysis", event_id: fact.event_id, source_version: 12, receipt_id: fact.receipt_id, source_hash: "c".repeat(64), version_source_hash: "c".repeat(64), event_source_hash: fact.source_hash, job_status: "completed", published: 1, revoked_at: null, blocked_reason: "" };
  validateProjection([row], fact, "new-analysis");
  for (const patch of [{ analysis_id: "old" }, { version_analysis_id: "old" }, { source_version: 11 }, { event_id: "old" }, { receipt_id: "old" }, { source_hash: "b".repeat(64) }, { version_source_hash: "b".repeat(64) }, { event_source_hash: "b".repeat(64) }, { job_status: "pending" }, { published: 0 }, { revoked_at: 123 }, { blocked_reason: "unverified_source" }]) {
    assert.throws(() => validateProjection([{ ...row, ...patch }], fact, "new-analysis"), /exact_project_projection_missing/);
  }
  assert.throws(() => validateProjection([], fact, "new-analysis"), /exact_project_projection_missing/);
});
