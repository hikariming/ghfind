#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ACCOUNT = "8f19bebe359e4ec1a24c68c5f49c1584";
export const MILESTONES = ["oauthCallback", "assessmentFinalization", "sourceOutbox", "executorProjection", "governance", "preferences", "events", "deletionCompleted"];
const CORE = "69bdae1c-ac36-4883-8fa4-9ffa54ebd033";
const FEED = "7526684c-b57d-412e-89ba-812cd30798e8";
const WEB = "ghfind-feed-web-staging";
const check = (condition, code) => { if (!condition) throw new Error(code); };
const hash = value => createHash("sha256").update(value).digest("hex");

export function validateTarget(m) {
  check(m?.schemaVersion === 2 && m.accountId === ACCOUNT && m.coreDatabase?.id === CORE && m.feedDatabase?.id === FEED, "isolated_target_required");
  check(m.web?.worker === WEB && m.web.origin === `https://${WEB}.beiming1201.workers.dev` && m.web.runtimeOrigin === "https://ghfind-feed-runtime-staging.beiming1201.workers.dev", "isolated_origins_required");
  check(m.web.oauth?.callbackUrl === `${m.web.origin}/api/auth/callback/github`, "oauth_callback_mismatch");
  const identities = m.web.oauth.identities;
  check(Array.isArray(identities) && identities.length === 2 && new Set(identities.map(i => i.role)).size === 2 && identities.every(i => ["ordinary", "governance"].includes(i.role) && typeof i.githubId === "string" && /^[1-9]\d*$/.test(i.githubId) && Number.isSafeInteger(Number(i.githubId)) && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(i.login)) && new Set(identities.map(i => i.githubId)).size === 2, "dedicated_identities_required");
  const repos = m.web.sourceProvider?.repositories;
  check(m.web.sourceProvider?.dedicated === true && typeof m.web.sourceProvider.agentId === "string" && m.web.sourceProvider.agentId.length > 0 && Array.isArray(repos) && repos.length >= 1 && repos.length <= 4 && repos.every(r => /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9_.-]{1,100}$/.test(r)), "approved_repositories_required");
  return m;
}

// Imported browser state is solely the holders' existing GitHub login. An
// application cookie must be issued afresh by the actual callback under test.
export function validateLoginState(state) {
  check(state && Array.isArray(state.cookies) && state.cookies.length > 0 && Array.isArray(state.origins), "github_login_state_required");
  check(state.cookies.every(c => typeof c.domain === "string" && ["github.com", ".github.com"].includes(c.domain) && c.name !== "ghfind_session" && typeof c.value === "string"), "non_github_login_state_rejected");
  check(state.origins.every(o => o.origin === "https://github.com"), "non_github_login_state_rejected");
  return state;
}

export function validateCallbackSession(cookie, identity, now = Date.now()) {
  check(cookie?.name === "ghfind_session" && cookie.httpOnly && cookie.secure && typeof cookie.value === "string", "callback_session_required");
  let value;
  try { value = JSON.parse(Buffer.from(cookie.value.split(".")[0], "base64url").toString()); }
  catch { throw new Error("invalid_callback_session"); }
  check(String(value.github_id) === identity.githubId && value.login?.toLowerCase() === identity.login.toLowerCase() && value.expires_at > now, "oauth_identity_mismatch");
  // This does not replace server signature validation: the next authenticated
  // Feed request must succeed with this callback-issued HttpOnly cookie.
}

export function validatePreviousAssessment(row, agentId) {
  if (!row) return;
  check(row.status === "completed" && row.mosoo_agent_id === agentId && row.active_key === null && typeof row.latest_analysis_id === "string", "unowned_previous_assessment");
}

export function validateProjection(rows, fact, analysisId) {
  check(rows.length === 1 && rows[0].analysis_id === analysisId && rows[0].version_analysis_id === analysisId &&
    rows[0].event_id === fact.event_id && rows[0].source_version === fact.sequence && rows[0].receipt_id === fact.receipt_id &&
    /^[a-f0-9]{64}$/.test(rows[0].source_hash) && rows[0].version_source_hash === rows[0].source_hash &&
    rows[0].event_source_hash === fact.source_hash && fact.source_hash === fact.analysis_sha256 && rows[0].job_status === "completed" &&
    rows[0].published === 1 && rows[0].revoked_at === null && rows[0].blocked_reason === "", "exact_project_projection_missing");
}

export function safeError(error) {
  return error instanceof Error && /^[a-z][a-z0-9_]{2,90}$/.test(error.message) ? error.message : "remote_e2e_failed";
}

async function loadPrivateState(path) {
  check(typeof path === "string" && isAbsolute(path), "private_login_file_required");
  const info = await lstat(path);
  check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.size <= 512 * 1024, "unsafe_login_state_file");
  return validateLoginState(JSON.parse(await readFile(path, "utf8")));
}

async function run(m, sourceSha, sourceTree, report) {
  const { chromium } = await import("playwright");
  const { verifyWebVersion } = await import("./feed-platform-web-verify.mjs");
  const ordinary = m.web.oauth.identities.find(i => i.role === "ordinary");
  const governor = m.web.oauth.identities.find(i => i.role === "governance");
  const secrets = ["CF_FEED_STAGING_API_TOKEN", "FEED_RUNTIME_ADMIN_SECRET", "FEED_OPERATOR_SECRET"];
  for (const name of secrets) check((process.env[name] ?? "").length >= 32, "staging_credentials_required");
  check(process.env.FEED_RUNTIME_ADMIN_SECRET !== process.env.FEED_OPERATOR_SECRET, "distinct_operator_credentials_required");
  const started = Date.now(), deadline = started + 25 * 60_000;
  let requests = 0, management = 0;
  const reserve = () => check(Date.now() < deadline && ++requests <= 450, "remote_e2e_budget_exhausted");
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const api = async (path, body) => {
    reserve(); check(++management <= 16, "management_query_budget_exhausted");
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
      method: body ? "POST" : "GET", headers: { authorization: `Bearer ${process.env.CF_FEED_STAGING_API_TOKEN}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000), redirect: "error",
    });
    check(r.ok, "cloudflare_readback_failed");
    const value = await r.json(); check(value.success === true, "cloudflare_readback_failed"); return value.result;
  };
  const query = async (db, sql, params) => {
    check([CORE, FEED].includes(db), "isolated_target_required");
    const value = await api(`/d1/database/${db}/query`, { sql, params });
    check(value.length === 1 && value[0].success === true, "staging_query_failed"); return value[0];
  };
  const deployment = async () => {
    const result = await api(`/workers/scripts/${WEB}/deployments`);
    const latest = result.deployments[0];
    check(latest?.versions?.length === 1 && latest.versions[0].percentage === 100, "ambiguous_web_deployment");
    const versionId = latest.versions[0].version_id;
    check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(versionId), "invalid_web_version");
    const version = await api(`/workers/scripts/${WEB}/versions/${versionId}`);
    // Inspect the active immutable version's entire binding inventory before
    // the browser can write: the manifest alone cannot protect a misbound Web.
    verifyWebVersion(m, sourceSha, result, version);
    return { worker: WEB, sourceSha, workerVersionId: latest.versions[0].version_id };
  };
  report.deployment = await deployment();
  const browser = await chromium.launch({ headless: true });
  const pages = [];
  const call = async (page, method, path, body, expected = 200, extra = {}) => {
    reserve(); check(path.startsWith("/api/") && !path.startsWith("//") && !path.includes("#"), "invalid_business_path");
    const result = await page.evaluate(async ({ method, path, body, extra }) => {
      const r = await fetch(path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(20_000) });
      return { status: r.status, cache: r.headers.get("cache-control"), value: await r.json() };
    }, { method, path, body, extra });
    check(result.status === expected, "business_response_mismatch");
    if (path.startsWith("/api/feed/")) check(result.cache === "no-store", "feed_cache_policy_failed");
    return result.value;
  };
  const admin = async (kind, body, authorized = true, expected = 200) => {
    reserve();
    const r = await fetch(`${m.web.runtimeOrigin}/internal/runtime/${kind}`, { method: "POST", headers: {
      authorization: `Bearer ${authorized ? process.env.FEED_RUNTIME_ADMIN_SECRET : "invalid-test-credential"}`,
      "x-feed-operator": process.env.FEED_OPERATOR_SECRET, "x-feed-contract": "1", "x-feed-target": "staging", "x-feed-release": sourceSha, "x-feed-writer-epoch": "1", "content-type": "application/json",
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: "error" });
    check(r.status === expected, "operator_response_mismatch"); return r.json();
  };
  const erase = async page => {
    const erased = await call(page, "DELETE", "/api/feed/profile", undefined, 202);
    check(typeof erased.deletionId === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(erased.deletionId), "deletion_identity_required");
    for (let i = 0; i < 36; i++) {
      const status = await call(page, "GET", `/api/feed/profile/deletions/${erased.deletionId}`);
      if (status.status === "completed") return erased.deletionId;
      check(!["failed", "blocked"].includes(status.status), "deletion_cleanup_failed");
      await wait(5_000);
    }
    throw new Error("deletion_cleanup_timeout");
  };
  try {
    const login = async identity => {
      const state = await loadPrivateState(process.env[`FEED_E2E_${identity.role.toUpperCase()}_STORAGE_STATE_FILE`]);
      const context = await browser.newContext({ storageState: state });
      const page = await context.newPage(); pages.push(page);
      let begin = false, callback = false;
      page.on("response", response => {
        const url = new URL(response.url());
        if (url.origin === m.web.origin && url.pathname === "/api/auth/github" && response.status() === 302) begin = true;
        if (url.origin === m.web.origin && url.pathname === "/api/auth/callback/github" && response.status() === 302) callback = true;
      });
      await page.goto(`${m.web.origin}/api/feed/projects`, { timeout: 30_000 });
      await call(page, "GET", "/api/feed/projects", undefined, 401);
      await page.goto(`${m.web.origin}/api/auth/github?callbackUrl=/api/feed/preferences`, { timeout: 30_000 });
      // An expired login, consent prompt, MFA or challenge is a failed gate.
      // The account holder completes it; the runner never fabricates a session.
      await page.waitForURL(`${m.web.origin}/api/feed/preferences`, { timeout: 45_000 });
      check(begin && callback, "real_oauth_callback_required");
      const cookies = await context.cookies(m.web.origin);
      validateCallbackSession(cookies.find(c => c.name === "ghfind_session"), identity);
      check(!cookies.some(c => c.name === "ghfind_oauth_state"), "oauth_state_not_consumed");
      await call(page, "GET", "/api/feed/preferences");
      report.identities.push({ ...identity, oauthBegin: begin, oauthCallback: callback });
      await erase(page); // Remove only this dedicated identity's prior fixture state.
      return page;
    };
    const page = await login(ordinary), other = await login(governor);
    const milestones = report.profiles.cf_d1_r2.milestones;
    milestones.oauthCallback = true; report.realOAuth = true;
    const repo = m.web.sourceProvider.repositories[0];

    // A repeatable real evaluation must not reuse yesterday's completed result.
    // Only remove the approved disposable staging repo's current summary pointer;
    // preserve immutable runs, receipts, outbox sequences and deletion fences.
    const previous = (await query(CORE, `SELECT pa.latest_analysis_id,pr.status,pr.mosoo_agent_id,pr.active_key FROM project_assessments pa JOIN project_analysis_runs pr ON pr.id=pa.latest_analysis_id WHERE pa.repo_key=?`, [repo])).results[0];
    validatePreviousAssessment(previous, m.web.sourceProvider.agentId);
    if (previous) {
      const events = (await query(CORE, "SELECT event_id,status FROM feed_source_outbox WHERE analysis_id=?", [previous.latest_analysis_id])).results;
      check(events.length === 1 && events[0].status === "delivered", "previous_source_not_drained");
      const job = await admin("feed-admin/v1/status", { kind: "sourceEvent", id: events[0].event_id });
      check(job.job?.status === "completed", "previous_executor_not_drained");
      const removed = await query(CORE, `DELETE FROM project_assessments WHERE repo_key=? AND latest_analysis_id=? AND NOT EXISTS(SELECT 1 FROM project_analysis_runs WHERE repo_key=? AND status IN ('queued','creating_thread','running','finalizing')) AND EXISTS(SELECT 1 FROM project_analysis_runs WHERE id=? AND status='completed' AND mosoo_agent_id=? AND active_key IS NULL)`, [repo, previous.latest_analysis_id, repo, previous.latest_analysis_id, m.web.sourceProvider.agentId]);
      check(removed.meta?.changes === 1, "fixture_reset_raced");
    }
    report.fixture = { repository: repo, previousPointerRemoved: Boolean(previous), preservedHistory: true };
    const created = await call(page, "POST", "/api/project-analyses", { repositoryUrl: `https://github.com/${repo}` }, 202);
    check(typeof created.analysisId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(created.analysisId) && created.statusUrl === `/api/project-analyses/${created.analysisId}` && created.reused !== true, "fresh_assessment_required");
    let completed = false;
    for (let i = 0; i < 180; i++) {
      const view = await call(page, "GET", created.statusUrl);
      if (view.status === "completed") { completed = true; break; }
      check(!["failed", "cancelled", "expired"].includes(view.status), "real_assessment_failed");
      await wait(5_000);
    }
    check(completed, "real_assessment_timeout");
    const source = (await query(CORE, `SELECT pr.created_at,pr.completed_at,pr.mosoo_agent_id,pr.mosoo_thread_id,pr.mosoo_run_id,pr.analysis_sha256,pr.report_sha256,pr.evidence_sha256,o.sequence,o.event_id,o.receipt_id,o.source_hash FROM project_analysis_runs pr JOIN project_assessments pa ON pa.latest_analysis_id=pr.id JOIN feed_submission_receipts sr ON sr.analysis_id=pr.id JOIN feed_source_outbox o ON o.analysis_id=pr.id AND o.receipt_id=sr.id WHERE pr.id=? AND pa.repo_key=? AND pr.status='completed' AND sr.source_kind='app_submission'`, [created.analysisId, repo])).results;
    check(source.length === 1, "source_transaction_evidence_missing");
    const fact = source[0];
    check(fact.created_at >= started && fact.completed_at >= fact.created_at && fact.mosoo_agent_id === m.web.sourceProvider.agentId && fact.mosoo_thread_id && fact.mosoo_run_id && [fact.analysis_sha256, fact.report_sha256, fact.evidence_sha256, fact.source_hash].every(h => typeof h === "string" && /^[a-f0-9]{64}$/.test(h)), "real_provider_evidence_missing");
    milestones.assessmentFinalization = true;
    let projected = false;
    for (let i = 0; i < 36; i++) {
      const [origin, target] = await Promise.all([
        admin("feed-admin/v1/status", { kind: "coreSource", id: String(fact.sequence) }),
        admin("feed-admin/v1/status", { kind: "sourceEvent", id: fact.event_id }),
      ]);
      if (origin.job?.status === "delivered" && target.job?.status === "completed") { projected = true; break; }
      check(!["failed", "dead_letter"].includes(origin.job?.status) && !["failed", "dead_letter"].includes(target.job?.status), "source_projection_failed");
      await wait(5_000);
    }
    check(projected, "source_projection_timeout");
    milestones.sourceOutbox = true;
    const projection = (await query(FEED, `SELECT p.analysis_id,p.source_hash,p.published,v.analysis_id AS version_analysis_id,v.event_id,v.source_version,v.receipt_id,v.source_hash AS version_source_hash,v.revoked_at,v.blocked_reason,j.status AS job_status,json_extract(j.envelope_json,'$.sourceHash') AS event_source_hash FROM feed_projects p JOIN feed_project_source_versions v ON v.repo_key=p.repo_key JOIN feed_execution_jobs j ON j.event_id=v.event_id WHERE p.repo_key=?`, [repo])).results;
    validateProjection(projection, fact, created.analysisId);
    report.source = { analysisIdHash: hash(created.analysisId), sourceEventIdHash: hash(fact.event_id), sequence: fact.sequence, committedTogether: true, executorCompleted: true };
    let feed = await call(page, "GET", "/api/feed/projects?limit=50");
    let item = feed.items.find(i => i.project.repoKey === repo);
    check(item, "project_not_eligible_for_feed");
    for (const key of ["score", "analysisId", "sourceHash", "features", "totalScore", "propensity", "embedding", "candidateSources"]) check(!JSON.stringify(feed).includes(`"${key}":`), "private_ranking_field_exposed");
    milestones.executorProjection = true;
    const tags = await call(page, "GET", "/api/feed/tags");
    const canonical = tags.tags[0]; check(canonical?.id, "canonical_taxonomy_required");
    const proposal = await call(page, "POST", "/api/feed/tags/proposals", { id: randomUUID(), repoKey: repo, namespace: canonical.namespace, slug: `e2e-${randomUUID().slice(0, 8)}`, labelZh: "隔离验收提议", labelEn: "Isolated acceptance proposal", evidence: ["approved-staging-assessment"] }, 202);
    check(proposal.status === "proposed", "proposal_autoapproved");
    const command = { commandId: randomUUID(), writerEpoch: 1, expectedTaxonomyVersion: tags.taxonomyVersion, operator: `github:${governor.githubId}`, reason: "Map the dedicated staging acceptance proposal to the approved taxonomy", proposalKind: "user", proposalId: proposal.proposalId, expectedAnalysisId: created.analysisId, action: "map", canonicalTagId: canonical.id, assignment: { weight: 1, confidence: 1 } };
    await admin("feed-governance/v1/review", command, false, 401);
    const review = await admin("feed-governance/v1/review", command);
    check(review.status === "mapped", "governance_review_failed");
    assert.deepEqual(await admin("feed-governance/v1/review", command), review);
    milestones.governance = true;
    feed = await call(page, "GET", "/api/feed/projects?limit=50");
    item = feed.items.find(i => i.project.repoKey === repo); check(item, "reviewed_project_missing");
    await call(other, "PUT", `/api/feed/projects/${repo}/state`, { saved: true, impressionToken: item.impressionToken }, 400);
    const before = await call(page, "GET", "/api/feed/preferences");
    await call(page, "PUT", `/api/feed/projects/${repo}/state`, { saved: true, impressionToken: item.impressionToken }, 200, { "x-github-id": governor.githubId, "x-feed-gateway": "forged", authorization: "Bearer forged" });
    const behavior = await call(page, "GET", "/api/feed/preferences");
    check(behavior.profileVersion > before.profileVersion && behavior.preferences.some(p => p.value > 0 && p.source !== "explicit"), "behavior_did_not_change_profile");
    check((await call(other, "GET", "/api/feed/preferences")).preferences.length === 0, "identity_isolation_failed");
    const event = { id: randomUUID(), type: "github_outbound", repoKey: repo, impressionToken: item.impressionToken, occurredAt: new Date().toISOString() };
    await call(page, "POST", "/api/feed/events", { events: [event] }, 202);
    const outboundProfile = await call(page, "GET", "/api/feed/preferences");
    const strength = profile => profile.preferences.find(p => p.tagId === canonical.id && p.source === "behavior")?.strength ?? 0;
    check(outboundProfile.profileVersion > behavior.profileVersion && strength(outboundProfile) > strength(behavior), "outbound_did_not_change_profile");
    const duplicate = await call(page, "POST", "/api/feed/events", { events: [event] }, 202);
    check(duplicate.accepted === 0 && duplicate.duplicate === 1, "event_deduplication_failed");
    const duplicateProfile = await call(page, "GET", "/api/feed/preferences");
    check(duplicateProfile.profileVersion === outboundProfile.profileVersion && strength(duplicateProfile) === strength(outboundProfile), "duplicate_event_changed_profile");
    milestones.events = true;
    await call(page, "PUT", "/api/feed/preferences", { taxonomyVersion: review.taxonomyVersion, preferences: [{ tagId: canonical.id, value: -1 }] });
    check((await call(page, "GET", "/api/feed/projects?limit=50")).items.every(i => i.project.repoKey !== repo), "negative_preference_not_applied");
    await call(page, "PUT", "/api/feed/preferences", { taxonomyVersion: review.taxonomyVersion, preferences: [] });
    const restored = (await call(page, "GET", "/api/feed/projects?limit=50")).items.find(i => i.project.repoKey === repo);
    check(restored, "preference_clear_not_applied"); milestones.preferences = true;
    const deletionId = await erase(page);
    await call(other, "GET", `/api/feed/profile/deletions/${deletionId}`, undefined, 404);
    await call(page, "PUT", `/api/feed/projects/${repo}/state`, { saved: true, impressionToken: restored.impressionToken }, 400);
    await erase(page); // Remove any empty new incarnation created by the stale-token probe.
    await erase(other);
    milestones.deletionCompleted = true;
    assert.deepEqual(await deployment(), report.deployment);
    report.profiles.cf_d1_r2.status = "passed";
    report.cleanupSuccessful = true;
    report.measurements = { requests, managementQueries: management, elapsedMs: Date.now() - started, assessmentsCreated: 1, archiveObjectRecoveryProven: false };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = process.argv.slice(2), values = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--execute") values.execute = true;
    else { check(["--manifest", "--release-sha", "--directory"].includes(args[i]) && args[i + 1], "invalid_arguments"); values[args[i].slice(2)] = args[++i]; }
  }
  const sourceSha = values["release-sha"];
  check(/^[a-f0-9]{40}$/.test(sourceSha ?? "") && isAbsolute(values.directory ?? ""), "exact_release_and_fresh_directory_required");
  const { validateWebManifest } = await import("./feed-platform-web.mjs");
  const m = validateTarget(validateWebManifest(JSON.parse(await readFile(values.manifest, "utf8"))));
  if (!values.execute) { console.log(JSON.stringify({ mode: "dry-run", sourceSha, worker: WEB, profiles: ["cf_d1_r2"], maxAssessments: 1, maxRequests: 450, realOAuthRequired: true })); return; }
  check(process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REPOSITORY === "hikariming/ghfind", "github_actions_required");
  check(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() === sourceSha, "checkout_mismatch");
  const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  await mkdir(values.directory, { mode: 0o700 });
  const report = { format: "ghfind-feed-e2e-remote-v1", sourceSha, sourceTree, startedAt: new Date().toISOString(), status: "failed", realOAuth: false, externalProviders: "real", cleanupSuccessful: false, identities: [], profiles: { cf_d1_r2: { status: "failed", milestones: Object.fromEntries(MILESTONES.map(k => [k, false])) } } };
  try { await run(m, sourceSha, sourceTree, report); report.status = "passed"; }
  catch (error) { report.error = safeError(error); process.exitCode = 1; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile(resolve(values.directory, "feed-e2e-remote.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); }
  console.log(JSON.stringify({ status: report.status, error: report.error, sourceSha }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
