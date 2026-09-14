import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT,
  CORE,
  FEED,
  ORIGIN,
  REPO,
  SQL,
  LIMITS,
  authorize,
  startAssessment,
  waitAssessment,
  sourceIdentity,
  projectionIdentity,
  executionIdentity,
} from "./feed-production-assessment.mjs";

const SHA = "a".repeat(40),
  RAW = "b".repeat(64),
  COMPOSITE = "c".repeat(64);
const ID = "ad370caa-0000-4000-8000-000000000001";
const WORKER = "ad370caa-0000-4000-8000-000000000002";
const AGENT = "01ABCDEFGHIJKLMNOPQRSTUVWX";
const TOKEN = "private-cloudflare-token-never-public";
const SECRET = "RAW_MODEL_CONTENT_MUST_NOT_BE_RETAINED";
const versions = {
  schema_version: "ghfind.project-analysis.v3",
  rubric_version: "project-value-v1",
  agent_version: "project-evaluator-v3",
  skill_version: "ghfind-project-evaluator-v4",
};
const run = (extra = {}) => ({
  id: ID,
  repo_key: REPO,
  requested_ref: SHA,
  status: "running",
  idempotency_key: `ghfind-project-${ID}`,
  create_attempts: 1,
  created_at: 1000,
  ...versions,
  ...extra,
});
const source = (extra = {}) => ({
  ...run({ status: "completed" }),
  resolved_commit_sha: SHA,
  current_commit_sha: SHA,
  latest_analysis_id: ID,
  completed_at: 2000,
  mosoo_agent_id: AGENT,
  mosoo_thread_id: "thread-actual",
  mosoo_run_id: "run-actual",
  analysis_sha256: RAW,
  report_sha256: "d".repeat(64),
  evidence_sha256: "e".repeat(64),
  source_hash: RAW,
  receipt_id: "submission-actual",
  requested_repo_key: REPO,
  source_kind: "app_submission",
  aggregate_key: REPO,
  contract_version: 1,
  sequence: 88,
  event_id: "event-actual",
  outbox_status: "delivered",
  ...extra,
});
const projection = (extra = {}) => ({
  analysis_id: ID,
  version_analysis_id: ID,
  event_analysis_id: ID,
  event_id: "event-actual",
  job_event_id: "event-actual",
  source_version: 88,
  job_source_version: 88,
  event_source_version: 88,
  receipt_id: "submission-actual",
  event_receipt_id: "submission-actual",
  event_source_hash: RAW,
  event_contract_version: 1,
  job_repo: REPO,
  resolved_commit_sha: SHA,
  source_kind: "app_submission",
  source_hash: COMPOSITE,
  version_source_hash: COMPOSITE,
  job_status: "completed",
  revoked_at: null,
  blocked_reason: "",
  removed: 0,
  published: 1,
  ...extra,
});
const execution = (extra = {}) => ({
  event_id: "event-actual",
  envelope_event_id: "event-actual",
  aggregate_key: REPO,
  source_version: 88,
  event_source_version: 88,
  analysis_id: ID,
  receipt_id: "submission-actual",
  source_hash: RAW,
  contract_version: 1,
  status: "pending",
  event_kind: "assessment.completed",
  ...extra,
});
const previousProjection = (extra = {}) =>
  projection({
    analysis_id: "previous-analysis",
    version_analysis_id: "previous-analysis",
    event_analysis_id: "previous-analysis",
    event_id: "previous-event",
    job_event_id: "previous-event",
    source_version: 87,
    job_source_version: 87,
    event_source_version: 87,
    receipt_id: "previous-receipt",
    event_receipt_id: "previous-receipt",
    resolved_commit_sha: "f".repeat(40),
    ...extra,
  });
const candidate = () => ({
  repo_key: REPO,
  analysis_id: ID,
  source_hash: COMPOSITE,
});
function webBindings(releaseSha = SHA) {
  return Object.entries({
    FEED_RELEASE_SHA: releaseSha,
    FEED_SOURCE_OUTBOX_ENABLED: "true",
    FEED_ROLLOUT_MODE: "paused",
    MOSOO_API_BASE: "https://cloud.mosoo.ai/api/v1",
    MOSOO_PROJECT_AGENT_ID: AGENT,
  })
    .map(([name, text]) => ({ name, text, type: "plain_text" }))
    .concat([
      { name: "GHFIND_D1", type: "d1", id: CORE },
      { name: "GHFIND_FEED_D1", type: "d1", id: FEED },
      { name: "MOSOO_API_TOKEN", type: "secret_text" },
    ]);
}
const json = (v, status = 200, headers = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
async function harness(t, settings = {}) {
  const directory = await mkdtemp(
    join(tmpdir(), "ghfind-production-assessment-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = join(directory, "assessment-intent.json"),
    result = join(directory, "assessment-result.json");
  const h = {
    receipt,
    result,
    calls: [],
    posts: 0,
    polls: 0,
    clock: 100000,
    rows: settings.rows ?? [],
    candidates: settings.candidates ?? [],
    sources: settings.sources ?? [source()],
    projections: settings.projections ?? [projection()],
    executions: settings.executions ?? [],
  };
  const read = async () => JSON.parse(await readFile(receipt, "utf8"));
  h.options = {
    token: TOKEN,
    now: () => h.clock,
    sleep: async (ms) => {
      h.clock += ms;
    },
    fetcher: async (url, init) => {
      url = String(url);
      h.calls.push({ url, method: init.method, body: init.body, at: h.clock });
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      assert.ok(init.signal);
      if (url.startsWith("https://api.cloudflare.com/")) {
        assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
        if (url.includes("/d1/database/")) {
          const { sql, params } = JSON.parse(init.body);
          const kind = Object.keys(SQL).find((k) => SQL[k] === sql);
          assert.ok(kind, "only fixed queries");
          assert.match(sql, /^SELECT /);
          assert.doesNotMatch(
            sql,
            /\b(?:INSERT|UPDATE|DELETE|REPLACE|PRAGMA|CREATE)\b/i,
          );
          assert.ok(
            url.startsWith(
              `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${["candidate", "projection", "execution"].includes(kind) ? FEED : CORE}/query`,
            ),
          );
          if (kind === "runs") assert.deepEqual(params, [REPO, SHA]);
          if (kind === "source") assert.deepEqual(params, [ID, REPO]);
          if (kind === "projection") assert.deepEqual(params, [REPO]);
          if (kind === "execution") assert.deepEqual(params, ["event-actual"]);
          await settings.beforeQuery?.(kind, h);
          const rows = {
            candidate: h.candidates,
            runs: h.rows,
            source:
              settings.sourceDeliveredAt !== undefined &&
              h.clock < settings.sourceDeliveredAt
                ? [source({ outbox_status: "pending" })]
                : h.sources,
            execution: h.executions,
            projection:
              settings.projectionReadyAt !== undefined &&
              h.clock < settings.projectionReadyAt
                ? (settings.projectionsBeforeReady ?? [])
                : h.projections,
          }[kind];
          return json({
            success: true,
            result: [{ success: true, results: rows }],
          });
        }
        if (url.endsWith("/deployments"))
          return json({
            success: true,
            result: {
              deployments: [
                { versions: [{ percentage: 100, version_id: WORKER }] },
              ],
            },
          });
        if (url.endsWith(`/versions/${WORKER}`)) {
          const bindings = webBindings(settings.releaseSha);
          settings.mutateBindings?.(bindings);
          return json({
            success: true,
            result: {
              id: WORKER,
              annotations: { "workers/tag": `production-${settings.releaseSha ?? SHA}` },
              resources: { bindings },
            },
          });
        }
        assert.fail(`unexpected CF request ${url}`);
      }
      assert.equal(
        init.headers.authorization,
        undefined,
        "private CF token must not reach public endpoints",
      );
      assert.ok(!JSON.stringify(init.headers).includes(TOKEN));
      if (
        url ===
        "https://api.github.com/repos/hikariming/ghfind/git/ref/heads/main"
      )
        return json({ object: { sha: settings.mainSHA ?? SHA } });
      if (url === `${ORIGIN}/api/project-analyses` && init.method === "POST") {
        h.posts++;
        assert.equal(h.posts, 1, "one logical POST at most");
        assert.deepEqual(JSON.parse(init.body), {
          repositoryUrl: `https://github.com/${REPO}`,
          ref: SHA,
        });
        const intent = await read();
        assert.equal(intent.phase, "intent");
        assert.equal(intent.postIssued, true);
        assert.equal(intent.analysisId, null);
        assert.equal((await stat(receipt)).mode & 0o777, 0o600);
        if (settings.postFailure === "missing")
          throw new Error("sensitive_network_failure_with_token");
        h.rows = [run()];
        if (settings.postFailure === "committed")
          throw new Error("connection_reset_after_database_commit");
        return json(
          {
            analysisId: ID,
            repoKey: REPO,
            statusUrl: `/api/project-analyses/${ID}`,
            ...(settings.apiReused ? { reused: true } : {}),
            assessment: SECRET,
          },
          settings.apiReused ? 200 : 202,
          { "Idempotency-Key": `ghfind-project-${ID}` },
        );
      }
      if (
        url === `${ORIGIN}/api/project-analyses/${ID}` &&
        init.method === "GET"
      ) {
        h.polls++;
        h.clock += settings.statusDurationMs ?? 0;
        const status =
          settings.statuses?.[
            Math.min(h.polls - 1, settings.statuses.length - 1)
          ] ?? "completed";
        return json(
          {
            analysisId: ID,
            repoKey: REPO,
            requestedRef: SHA,
            status,
            assessment: { model: SECRET },
          },
          settings.statusHTTP ?? 200,
        );
      }
      assert.fail(`unexpected request ${url}`);
    },
  };
  h.read = read;
  return h;
}

test("CLI requires pinned production Actions identity and exact release SHA", async (t) => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: REPO,
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/deploy-cf-production.yml@refs/heads/main`,
  };
  assert.doesNotThrow(() => authorize(env));
  for (const k of Object.keys(env))
    assert.throws(
      () => authorize({ ...env, [k]: "wrong" }),
      /production_actions_required/,
    );
  const h = await harness(t);
  await assert.rejects(
    startAssessment("main", h.receipt, h.options),
    /exact_release_sha_required/,
  );
  assert.equal(h.calls.length, 0);
});

test("existing eligible provenance skips a new assessment even if a failed same-SHA run exists", async (t) => {
  const h = await harness(t, {
    candidates: [candidate()],
    rows: [run({ status: "failed" })],
  });
  const r = await startAssessment(SHA, h.receipt, h.options);
  assert.equal(r.phase, "skipped");
  assert.equal(r.postIssued, false);
  const output = await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(output.assessment, "skipped_existing_eligible");
  assert.equal(output.providerExecution, "not_requested");
  assert.equal(h.posts, 0);
  assert.ok(h.calls.every((c) => c.url.includes("/d1/database/")));
});

test("journal precedes sole public POST; same receipt and fresh read recovery never create another ID", async (t) => {
  const h = await harness(t);
  const first = await startAssessment(SHA, h.receipt, h.options);
  assert.equal(first.analysisId, ID);
  assert.equal(first.phase, "selected");
  assert.equal(first.apiReused, null);
  assert.match(first.intentId, /^[a-f0-9-]{36}$/);
  const resumed = await startAssessment(SHA, h.receipt, h.options);
  assert.equal(resumed.intentId, first.intentId);
  assert.equal(h.posts, 1);
  const recovered = await startAssessment(
    SHA,
    join(h.receipt, "..", "fresh.json"),
    h.options,
  );
  assert.equal(recovered.analysisId, ID);
  assert.equal(recovered.postIssued, false);
  assert.equal(recovered.reusedLogicalRun, true);
  assert.equal(h.posts, 1);
  assert.ok(!(await readFile(h.receipt, "utf8")).includes(SECRET));
});

test("uncertain public POST uses readonly core recovery and cannot repeat transmission", async (t) => {
  for (const outcome of ["committed", "missing"]) {
    const h = await harness(t, { postFailure: outcome });
    if (outcome === "committed") {
      const r = await startAssessment(SHA, h.receipt, h.options);
      assert.equal(r.analysisId, ID);
      assert.equal(r.resumedAfterUncertainPost, true);
    } else {
      await assert.rejects(
        startAssessment(SHA, h.receipt, h.options),
        /uncertain_post_outcome_no_retry/,
      );
      const r = await h.read();
      assert.equal(r.phase, "uncertain");
      assert.equal(r.postIssued, true);
      assert.equal(r.analysisId, null);
      await assert.rejects(
        startAssessment(SHA, h.receipt, h.options),
        /uncertain_post_outcome_no_retry/,
      );
      await assert.rejects(
        waitAssessment(h.receipt, h.result, h.options),
        /uncertain_post_outcome_no_retry/,
      );
    }
    assert.equal(h.posts, 1);
  }
});

test("failed, expired, ambiguous or foreign-version logical run prevents another POST", async (t) => {
  for (const rows of [
    [run({ status: "failed" })],
    [run({ status: "expired" })],
    [run(), run({ id: "another-run" })],
    [run({ skill_version: "legacy" })],
  ]) {
    const h = await harness(t, { rows });
    await assert.rejects(
      startAssessment(SHA, h.receipt, h.options),
      /logical_assessment_terminal_failure|multiple_logical_assessments_refused|logical_assessment_identity_mismatch/,
    );
    assert.equal(h.posts, 0);
  }
});

test("main, deployed source flag, provider and paused admission must match before paid request", async (t) => {
  const variants = [
    { mainSHA: "f".repeat(40) },
    ...[
      "FEED_RELEASE_SHA",
      "FEED_SOURCE_OUTBOX_ENABLED",
      "FEED_ROLLOUT_MODE",
      "MOSOO_API_BASE",
      "MOSOO_PROJECT_AGENT_ID",
    ].map((name) => ({
      mutateBindings: (b) => {
        b.find((x) => x.name === name).text = "wrong";
      },
    })),
    {
      mutateBindings: (b) => {
        b.find((x) => x.name === "GHFIND_D1").id = FEED;
      },
    },
  ];
  for (const settings of variants) {
    const h = await harness(t, settings);
    await assert.rejects(
      startAssessment(SHA, h.receipt, h.options),
      /release_is_not_current_main|real_provider_or_source_binding_missing/,
    );
    assert.equal(h.posts, 0);
  }
});

test("real completion checks raw source versus distinct projection hash and records authorized retry honestly", async (t) => {
  const retry = {
    idempotency_key: `ghfind-project-${ID}-retry-1`,
    create_attempts: 3,
  };
  const h = await harness(t, {
    rows: [run(retry)],
    sources: [source(retry)],
    statuses: ["running", "completed"],
  });
  await startAssessment(SHA, h.receipt, h.options);
  const output = await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(output.status, "passed");
  assert.equal(output.assessment, "reused_logical_assessment");
  assert.equal(output.source.providerRunRetries, 1);
  assert.equal(output.source.currentThreadCreateAttempts, 3);
  assert.equal(output.source.providerThreadsLowerBound, 2);
  assert.equal(output.source.priorThreadIdentitiesAvailable, false);
  assert.equal(output.newProviderExecutionClaimed, false);
  assert.equal(output.source.sourceHash, RAW);
  assert.equal(output.projection.sourceHash, COMPOSITE);
  assert.equal(h.posts, 0);
  assert.equal(h.polls, 2);
  assert.equal(h.clock, 115000);
  assert.equal((await h.read()).phase, "completed");
  for (const path of [h.result, h.receipt]) {
    const bytes = await readFile(path, "utf8");
    assert.ok(!bytes.includes(SECRET));
    assert.ok(!bytes.includes(TOKEN));
  }
});

test("source proof rejects old commits, missing artifacts, forged source hash and extra execution attempts", () => {
  for (const extra of [
    { resolved_commit_sha: "f".repeat(40) },
    { source_hash: COMPOSITE },
    { mosoo_agent_id: "foreign" },
    { create_attempts: 0 },
    { create_attempts: 4 },
    { idempotency_key: `ghfind-project-${ID}-retry-3` },
    { report_sha256: null },
    { latest_analysis_id: "old" },
    { outbox_status: "failed" },
  ]) {
    assert.throws(() => sourceIdentity(source(extra), SHA, ID, AGENT));
  }
});

test("projection proof rejects wrong envelope/receipt/version, raw-vs-composite substitution and ineligible publication", () => {
  const s = sourceIdentity(source(), SHA, ID, AGENT);
  for (const extra of [
    { event_source_hash: COMPOSITE },
    { version_source_hash: RAW },
    { event_source_version: 87 },
    { event_receipt_id: "other" },
    { job_repo: "other/repo" },
    { source_kind: "verified_backfill" },
    { removed: 1 },
    { published: 0 },
    { revoked_at: 1 },
    { blocked_reason: "unapproved" },
    { job_status: "dead_letter" },
  ]) {
    assert.throws(() => projectionIdentity(projection(extra), s, SHA));
  }
  assert.equal(
    projectionIdentity(projection({ job_status: "leased" }), s, SHA),
    null,
  );
  assert.equal(
    projectionIdentity(projection(), { ...s, outboxStatus: "pending" }, SHA),
    null,
  );
});

test("a coherent older projection is pending, while equal/newer or corrupted identities still fail", () => {
  const s = sourceIdentity(source(), SHA, ID, AGENT);
  assert.equal(projectionIdentity(previousProjection(), s, SHA), null);
  // A previous blocked/revoked projection can be replaced by a new assessment;
  // its outcome is never used to approve the new version.
  assert.equal(
    projectionIdentity(
      previousProjection({
        source_kind: "verified_backfill",
        published: 0,
        blocked_reason: "old-risk",
        revoked_at: 1000,
        job_status: "dead_letter",
      }),
      s,
      SHA,
    ),
    null,
  );
  for (const patch of [
    ...[0, -1, "87", 87.5, 88, 89].map((version) => ({
      source_version: version,
      job_source_version: version,
      event_source_version: version,
    })),
    { source_version: 87, event_source_version: 86 },
    { version_analysis_id: "unrelated" },
    { event_analysis_id: "unrelated" },
    { job_event_id: "unrelated" },
    { event_receipt_id: "unrelated" },
    { job_repo: "other/repo" },
    { event_contract_version: 2 },
    { event_source_hash: null },
    { version_source_hash: RAW },
    { source_kind: "unknown" },
    { job_status: "unknown" },
    { published: true },
    { removed: null },
    { blocked_reason: null },
    { revoked_at: -1 },
    { resolved_commit_sha: "main" },
  ])
    assert.throws(
      () => projectionIdentity(previousProjection(patch), s, SHA),
      /projection_identity_mismatch/,
    );
});

test("old projection then exact new projection uses the existing wait cadence without another public request", async (t) => {
  const h = await harness(t, {
    rows: [run({ status: "completed" })],
    projectionReadyAt: 135000,
    projectionsBeforeReady: [
      previousProjection({ published: 0, blocked_reason: "old-risk" }),
    ],
  });
  await startAssessment(SHA, h.receipt, h.options);
  const result = await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(result.status, "passed");
  assert.equal(result.projection.analysisId, ID);
  assert.equal(result.projection.sourceVersion, 88);
  assert.equal(result.projectionPolls, 2);
  assert.equal(result.terminalRevalidations, 0);
  assert.equal(h.clock, 135000);
  assert.equal(h.posts, 0);
  assert.equal(h.polls, 0);
  assert.deepEqual(
    h.calls
      .filter((c) => c.body && JSON.parse(c.body).sql === SQL.projection)
      .map((c) => c.at),
    [100000, 135000],
  );
});

test("permanent old projection exhausts the unchanged five checks and cannot become a passing receipt", async (t) => {
  const h = await harness(t, {
    rows: [run({ status: "completed" })],
    projections: [previousProjection()],
  });
  await startAssessment(SHA, h.receipt, h.options);
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /projection_wait_exhausted/,
  );
  assert.equal((await h.read()).projectionPolls, 5);
  assert.equal(h.clock, 240000);
  assert.equal(h.posts, 0);
  assert.equal(h.polls, 0);
  await assert.rejects(readFile(h.result), { code: "ENOENT" });
});

test("public status rejects terminal failure and does not initiate replacement assessment", async (t) => {
  for (const status of ["failed", "cancelled", "expired"]) {
    const h = await harness(t, { rows: [run()], statuses: [status] });
    await startAssessment(SHA, h.receipt, h.options);
    await assert.rejects(
      waitAssessment(h.receipt, h.result, h.options),
      /assessment_status_failed_or_invalid/,
    );
    assert.equal(h.posts, 0);
    assert.equal(h.polls, 1);
  }
});

test("60 polls and 15-minute persisted deadline bound repeated waits, without real sleeps", async (t) => {
  const h = await harness(t, { rows: [run()], statuses: ["running"] });
  await startAssessment(SHA, h.receipt, h.options);
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /assessment_wait_exhausted/,
  );
  assert.equal(h.polls, LIMITS.publicPolls);
  assert.equal(h.clock - 100000, 59 * 15000);
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /assessment_wait_exhausted/,
  );
  assert.equal(h.polls, 60);
  assert.equal(h.posts, 0);
});

test("five projection rounds cover cron plus executor and preserve counts for finite terminal reads", async (t) => {
  const h = await harness(t, { rows: [run()], projections: [] });
  await startAssessment(SHA, h.receipt, h.options);
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /projection_wait_exhausted/,
  );
  assert.equal((await h.read()).projectionPolls, 5);
  assert.equal(h.clock - 100000, 140000);
  const count = h.calls.filter((c) => c.body?.includes(SQL.projection)).length;
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /terminal_projection_not_ready/,
  );
  assert.equal(
    h.calls.filter((c) => c.body?.includes(SQL.projection)).length,
    count + 1,
  );
  assert.equal((await h.read()).projectionPolls, 5);
  assert.equal((await h.read()).terminalRevalidations, 1);
  assert.equal(h.polls, 1);
});

test("receipt SHA and stable identity cannot be altered to repurpose a prior intent", async (t) => {
  const h = await harness(t);
  const r = await startAssessment(SHA, h.receipt, h.options);
  await writeFile(
    h.receipt,
    JSON.stringify({ ...r, origin: "https://other.invalid" }),
  );
  await assert.rejects(
    startAssessment(SHA, h.receipt, h.options),
    /invalid_assessment_receipt/,
  );
  await writeFile(h.receipt, JSON.stringify({ ...r, intentId: null }));
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /invalid_assessment_receipt/,
  );
  assert.equal(h.posts, 1);
});

test("public finalization gets 60s while management reads keep 15s", async (t) => {
  const durations = [];
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms) => {
    durations.push(ms);
    return originalTimeout(ms);
  });
  const h = await harness(t, { statusDurationMs: 30000 });
  await startAssessment(SHA, h.receipt, h.options);
  await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(durations.length, h.calls.length);
  for (let i = 0; i < h.calls.length; i++) {
    assert.equal(
      durations[i],
      h.calls[i].url.startsWith(`${ORIGIN}/api/project-analyses`)
        ? 60000
        : 15000,
    );
  }
  assert.equal(h.posts, 1);
  assert.equal(h.polls, 1);
  assert.equal(h.clock - 100000, 30000);
});

test("last public GET cannot extend the persisted 15-minute budget", async (t) => {
  const durations = [];
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms) => {
    durations.push(ms);
    return originalTimeout(ms);
  });
  const h = await harness(t, { rows: [run()], statusDurationMs: 30000 });
  h.clock += LIMITS.publicWaitMs; // Keep the durable epoch positive in this clock fixture.
  const r = await startAssessment(SHA, h.receipt, h.options);
  // Simulate a recovered receipt with only 10s left in its durable wait budget.
  await writeFile(
    h.receipt,
    JSON.stringify({
      ...r,
      waitStartedAt: h.clock - LIMITS.publicWaitMs + 10000,
    }),
  );
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /assessment_deadline_exceeded/,
  );
  assert.equal(durations.at(-1), 10000);
  assert.equal(h.polls, 1);
  assert.equal(h.posts, 0);
});

test("normal projection succeeds after next cron plus a full bounded executor run", async (t) => {
  // Finalization just missed cron: 59s wait + 5s queue batching + 60s executor.
  const h = await harness(t, {
    rows: [run()],
    projectionReadyAt: 100000 + 124000,
  });
  await startAssessment(SHA, h.receipt, h.options);
  const result = await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(result.status, "passed");
  assert.equal(result.projectionPolls, 5);
  assert.equal(result.terminalRevalidations, 0);
  assert.equal(result.verification, "normal_projection_window");
  assert.equal(h.clock - 100000, 140000);
  assert.equal(h.polls, 1);
  assert.equal(h.posts, 0);
  assert.ok(
    h.calls.filter((c) => c.url.startsWith("https://api.cloudflare.com/"))
      .length <= LIMITS.management,
  );
});

test("later same-intent completed revalidation is one read per invocation and two cumulative reads maximum", async (t) => {
  const h = await harness(t, { rows: [run()], projections: [] });
  const initial = await startAssessment(SHA, h.receipt, h.options);
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /projection_wait_exhausted/,
  );
  const original = await h.read();
  assert.equal(original.completionObservedAt, 100000);
  h.clock += 3600000; // An Actions rerun may occur after the old public deadline.
  h.rows = [run({ status: "completed" })];
  h.projections = [projection()];
  const resumed = await startAssessment(SHA, h.receipt, h.options);
  assert.equal(resumed.intentId, initial.intentId);
  const before = h.calls.length;
  const result = await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(result.verification, "readonly_terminal_revalidation");
  assert.equal(result.terminalRevalidations, 1);
  assert.equal(result.polls, original.polls);
  assert.equal(result.projectionPolls, original.projectionPolls);
  assert.equal(h.calls.length - before, 4); // two Web identity reads + source + projection
  assert.ok(
    h.calls
      .slice(before)
      .every((c) => c.url.startsWith("https://api.cloudflare.com/")),
  );
  assert.equal((await h.read()).waitStartedAt, original.waitStartedAt);
  assert.equal(
    (await h.read()).projectionStartedAt,
    original.projectionStartedAt,
  );
  const again = await waitAssessment(
    h.receipt,
    join(h.result, "..", "second.json"),
    h.options,
  );
  assert.equal(again.terminalRevalidations, 2);
  const bound = h.calls.length;
  await assert.rejects(
    waitAssessment(h.receipt, join(h.result, "..", "third.json"), h.options),
    /terminal_revalidation_exhausted/,
  );
  assert.equal(h.calls.length, bound);
  assert.equal(h.polls, 1);
  assert.equal(h.posts, 0);
});

test("terminal revalidation does not trust a past result when current source or publication differs", async (t) => {
  const h = await harness(t, { rows: [run()] });
  await startAssessment(SHA, h.receipt, h.options);
  await waitAssessment(h.receipt, h.result, h.options);
  h.sources = [source({ source_hash: COMPOSITE })];
  await assert.rejects(
    waitAssessment(
      h.receipt,
      join(h.result, "..", "wrong-source.json"),
      h.options,
    ),
    /source_finalization_identity_mismatch/,
  );
  h.sources = [source()];
  h.projections = [projection({ revoked_at: 1000 })];
  await assert.rejects(
    waitAssessment(h.receipt, join(h.result, "..", "revoked.json"), h.options),
    /project_not_eligible_after_assessment/,
  );
  assert.equal((await h.read()).terminalRevalidations, 2);
  assert.equal(h.posts, 0);
  assert.equal(h.polls, 1);
});

test("first selecting completed source gets all five projection slots without public GET or POST", async (t) => {
  const h = await harness(t, {
    rows: [run({ status: "completed" })],
    projectionReadyAt: 100000 + 124000,
  });
  const r = await startAssessment(SHA, h.receipt, h.options);
  assert.equal(r.status, "completed");
  assert.equal(r.projectionPolls, 0);
  assert.equal(r.projectionStartedAt, undefined);
  assert.equal(r.completionObservedAt, undefined);
  const result = await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(result.verification, "normal_projection_window");
  assert.equal(result.projectionPolls, 5);
  assert.equal(result.terminalRevalidations, 0);
  assert.equal(h.clock, 240000);
  assert.equal(h.polls, 0);
  assert.equal(h.posts, 0);
});

test("restart before next projection slot preserves original start, cadence and remaining checks", async (t) => {
  const h = await harness(t, {
    rows: [run({ status: "completed" })],
    projectionReadyAt: 224000,
  });
  const initial = await startAssessment(SHA, h.receipt, h.options);
  const realSleep = h.options.sleep;
  h.options.sleep = async () => {
    throw new Error("simulated_process_stop_before_next_slot");
  };
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /simulated_process_stop/,
  );
  const checkpoint = await h.read();
  assert.equal(checkpoint.projectionStartedAt, 100000);
  assert.equal(checkpoint.projectionPolls, 1);
  h.clock = 110000;
  const sleeps = [];
  h.options.sleep = async (ms) => {
    sleeps.push(ms);
    await realSleep(ms);
  };
  const restored = await startAssessment(SHA, h.receipt, h.options);
  assert.equal(restored.phase, "selected");
  assert.equal(restored.intentId, initial.intentId);
  assert.equal(restored.completionObservedAt, checkpoint.completionObservedAt);
  const result = await waitAssessment(h.receipt, h.result, h.options);
  assert.deepEqual(sleeps, [25000, 35000, 35000, 35000]);
  assert.deepEqual(
    h.calls.filter((c) => c.body?.includes(SQL.projection)).map((c) => c.at),
    [100000, 135000, 170000, 205000, 240000],
  );
  assert.equal(
    (await h.read()).projectionStartedAt,
    checkpoint.projectionStartedAt,
  );
  assert.equal(result.projectionPolls, 5);
  assert.equal(result.terminalRevalidations, 0);
  assert.equal(h.polls, 0);
  assert.equal(h.posts, 0);
});

test("start preserves previously verified projection so a rerun cannot mint a fresh window", async (t) => {
  const h = await harness(t, { rows: [run({ status: "completed" })] });
  await startAssessment(SHA, h.receipt, h.options);
  const first = await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(first.projectionPolls, 1);
  const recovered = await startAssessment(SHA, h.receipt, h.options);
  assert.equal(recovered.phase, "completed");
  const next = await waitAssessment(
    h.receipt,
    join(h.result, "..", "revalidated.json"),
    h.options,
  );
  assert.equal(next.verification, "readonly_terminal_revalidation");
  assert.equal(next.projectionPolls, 1);
  assert.equal(next.terminalRevalidations, 1);
  assert.equal(h.polls, 0);
  assert.equal(h.posts, 0);
});

const reads = (h, kind) =>
  h.calls.filter((c) => c.body && JSON.parse(c.body).sql === SQL[kind]);

test("cron bootstrap has six durable slots and a separate exhausted failure without projection", async (t) => {
  const h = await harness(t, {
    rows: [run({ status: "completed" })],
    sources: [source({ outbox_status: "pending" })],
  });
  await startAssessment(SHA, h.receipt, h.options);
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /relay_bootstrap_exhausted/,
  );
  const r = await h.read();
  assert.equal(r.relayBootstrapStartedAt, 100000);
  assert.equal(r.relayBootstrapPolls, 6);
  assert.equal(r.projectionStartedAt, undefined);
  assert.equal(r.projectionPolls, 0);
  assert.equal(r.polls, 0);
  assert.equal(r.terminalRevalidations, undefined);
  assert.equal(h.clock, 1000000);
  assert.deepEqual(
    reads(h, "execution").map((c) => c.at),
    [100000, 280000, 460000, 640000, 820000, 1000000],
  );
  assert.equal(reads(h, "source").length, 7); // Initial discovery plus six journaled slots.
  assert.equal(reads(h, "projection").length, 0);
  const n = h.calls.length;
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /relay_bootstrap_exhausted/,
  );
  assert.equal(h.calls.length, n + 2); // Only pinned Web identity reads; no uncounted source probe.
  assert.equal((await h.read()).relayBootstrapPolls, 6);
  assert.equal(h.posts, 0);
  assert.equal(h.polls, 0);
  await assert.rejects(readFile(h.result), { code: "ENOENT" });
});

test("delivered source starts fresh bounded projection after six bootstrap slots and old projection", async (t) => {
  const h = await harness(t, {
    rows: [run({ status: "completed" })],
    sourceDeliveredAt: 1000000,
    projectionReadyAt: 1140000,
    projectionsBeforeReady: [previousProjection()],
    executions: [execution()],
  });
  await startAssessment(SHA, h.receipt, h.options);
  const before = h.calls.length;
  const result = await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(result.status, "passed");
  assert.equal(result.relayBootstrapPolls, 6);
  assert.equal(result.relayBootstrapStartedAt, 100000);
  assert.equal(result.relayDeliveredObservedAt, 1000000);
  assert.equal(result.relayBootstrapIsNormalProjectionLatency, false);
  assert.equal(result.projectionPolls, 5);
  assert.equal(result.polls, 0);
  assert.equal(result.terminalRevalidations, 0);
  assert.equal(result.managementRequests, 25);
  assert.equal(h.calls.length - before, LIMITS.management);
  assert.deepEqual(
    reads(h, "projection").map((c) => c.at),
    [1000000, 1035000, 1070000, 1105000, 1140000],
  );
  assert.equal((await h.read()).projectionStartedAt, 1000000);
  assert.equal(h.posts, 0);
  assert.equal(h.polls, 0);
});

test("bootstrap restart after lost read acknowledgement consumes its slot and preserves cadence", async (t) => {
  let lost = true;
  const h = await harness(t, {
    rows: [run({ status: "completed" })],
    sourceDeliveredAt: 280000,
    beforeQuery: async (kind) => {
      if (kind === "execution" && lost) {
        lost = false;
        throw new Error("fixture_ack_lost");
      }
    },
  });
  await startAssessment(SHA, h.receipt, h.options);
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /fixture_ack_lost/,
  );
  const r = await h.read();
  assert.equal(r.relayBootstrapPolls, 1);
  assert.equal(r.relayBootstrapStartedAt, 100000);
  assert.equal(r.projectionPolls, 0);
  assert.equal(r.projectionStartedAt, undefined);
  h.clock += 10000;
  const before = h.calls.length;
  const result = await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(result.relayBootstrapPolls, 2);
  assert.equal(result.relayDeliveredObservedAt, 280000);
  assert.deepEqual(
    reads(h, "execution").map((c) => c.at),
    [100000, 280000],
  );
  assert.deepEqual(
    h.calls
      .slice(before)
      .filter((c) => c.body && JSON.parse(c.body).sql === SQL.source)
      .map((c) => c.at),
    [280000, 280000],
  );
  assert.equal((await h.read()).waitStartedAt, r.waitStartedAt);
  assert.equal(result.polls, 0);
  assert.equal(h.posts, 0);
});

test("bootstrap source failure, DLQ, ambiguous execution and changed envelope fail immediately", async (t) => {
  for (const failure of ["failed", "dlq", "identity", "ambiguous"]) {
    let probes = 0;
    const h = await harness(t, {
      rows: [run({ status: "completed" })],
      sources: [source({ outbox_status: "leased" })],
      executions:
        failure === "dlq"
          ? [execution({ status: "dead_letter" })]
          : failure === "identity"
            ? [execution({ source_hash: "f".repeat(64) })]
            : failure === "ambiguous"
              ? [execution(), execution()]
              : [],
      beforeQuery: async (kind, state) => {
        if (kind === "source" && ++probes === 2 && failure === "failed")
          state.sources = [source({ outbox_status: "failed" })];
      },
    });
    await startAssessment(SHA, h.receipt, h.options);
    await assert.rejects(
      waitAssessment(h.receipt, h.result, h.options),
      /source_delivery_terminal_failure|projection_terminal_failure|execution_identity_mismatch|ambiguous_execution/,
    );
    assert.equal((await h.read()).relayBootstrapPolls, 1);
    assert.equal((await h.read()).projectionStartedAt, undefined);
    assert.equal(h.clock, 100000);
    assert.equal(reads(h, "projection").length, 0);
  }
});

test("bootstrap execution lookup verifies the requested new event independent of old projection", () => {
  const s = sourceIdentity(source(), SHA, ID, AGENT);
  assert.doesNotThrow(() => executionIdentity(undefined, s));
  for (const status of ["pending", "leased", "completed"])
    assert.doesNotThrow(() => executionIdentity(execution({ status }), s));
  for (const [key, value] of Object.entries({
    event_id: "other",
    envelope_event_id: "other",
    aggregate_key: "other/repo",
    source_version: 87,
    event_source_version: 87,
    analysis_id: "other",
    receipt_id: "other",
    source_hash: "f".repeat(64),
    contract_version: 2,
    event_kind: "other.event",
  }))
    assert.throws(
      () => executionIdentity(execution({ [key]: value }), s),
      /execution_identity_mismatch/,
    );
  for (const status of ["dead_letter", "failed", "unknown"])
    assert.throws(
      () => executionIdentity(execution({ status }), s),
      /projection_terminal_failure/,
    );
});

test("last bootstrap slot permits only its 15s read and fails closed on exhausted restart", async (t) => {
  const h = await harness(t, {
    rows: [run({ status: "completed" })],
    sources: [source({ outbox_status: "pending" })],
  });
  const r = await startAssessment(SHA, h.receipt, h.options);
  await writeFile(
    h.receipt,
    JSON.stringify({
      ...r,
      completionObservedAt: 100000,
      waitStartedAt: 100000,
      relayBootstrapStartedAt: 100000,
      relayBootstrapPolls: 5,
      relayBootstrapSource: {
        eventId: "event-actual",
        receiptId: "submission-actual",
        sourceVersion: 88,
        sourceHash: RAW,
      },
    }),
  );
  h.clock = 1000000 + 15000;
  const before = h.calls.length;
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /relay_bootstrap_exhausted/,
  );
  assert.equal(h.calls.length, before + 2);
  assert.equal((await h.read()).relayBootstrapPolls, 5);
  assert.equal(reads(h, "execution").length, 0);
});

test("combined 1980s deadline remains anchored across restart", async (t) => {
  const h = await harness(t, {
    rows: [run({ status: "completed" })],
    sources: [source({ outbox_status: "pending" })],
  });
  const r = await startAssessment(SHA, h.receipt, h.options);
  await writeFile(
    h.receipt,
    JSON.stringify({
      ...r,
      completionObservedAt: 100000,
      waitStartedAt: 100000,
    }),
  );
  h.clock = 100000 + LIMITS.waitMs;
  const before = h.calls.length;
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /assessment_deadline_exceeded/,
  );
  assert.equal(h.calls.length, before);
  assert.equal((await h.read()).waitStartedAt, 100000);
  assert.equal((await h.read()).relayBootstrapStartedAt, undefined);
});

test("delivered sources do not acquire a bootstrap budget and old terminal recovery stays finite", async (t) => {
  const h = await harness(t, { rows: [run({ status: "completed" })] });
  await startAssessment(SHA, h.receipt, h.options);
  const result = await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(result.relayBootstrapPolls, 0);
  assert.equal(result.relayBootstrapStartedAt, null);
  assert.equal(reads(h, "execution").length, 0);
  assert.equal(result.managementRequests, 5);
  const r = await h.read();
  h.clock += LIMITS.waitMs;
  await rm(h.result);
  const again = await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(again.verification, "readonly_terminal_revalidation");
  assert.equal(again.terminalRevalidations, 1);
  assert.equal(again.managementRequests, 4);
  assert.equal((await h.read()).waitStartedAt, r.waitStartedAt);
  assert.equal((await h.read()).projectionStartedAt, r.projectionStartedAt);
});

test("last bootstrap slot shares one 15s response-body deadline across both reads", async (t) => {
  const h = await harness(t, {
    rows: [run({ status: "completed" })],
    sourceDeliveredAt: 1000000,
    beforeQuery: async (kind, state) => {
      if (kind === "source" && state.clock === 1000000) {
        await Promise.resolve(); // Both transports start before the delayed body arrives.
        state.clock += 16000;
      }
    },
  });
  await startAssessment(SHA, h.receipt, h.options);
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /assessment_deadline_exceeded/,
  );
  assert.equal((await h.read()).relayBootstrapPolls, 6);
  assert.equal((await h.read()).relayDeliveredObservedAt, undefined);
  assert.equal((await h.read()).projectionStartedAt, undefined);
  assert.equal(reads(h, "execution").length, 6);
  assert.equal(h.clock, 1016000);
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /relay_bootstrap_exhausted/,
  );
  assert.equal(reads(h, "execution").length, 6);
});

test("remaining combined deadline clips each bootstrap fetch rather than minting another 1980s", async (t) => {
  const durations = [];
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms) => {
    durations.push(ms);
    return originalTimeout(ms);
  });
  const h = await harness(t, {
    rows: [run({ status: "completed" })],
    sources: [source({ outbox_status: "pending" })],
  });
  const r = await startAssessment(SHA, h.receipt, h.options);
  await writeFile(
    h.receipt,
    JSON.stringify({
      ...r,
      completionObservedAt: 100000,
      waitStartedAt: 100000,
      relayBootstrapStartedAt: 1170000,
      relayBootstrapPolls: 5,
      relayBootstrapSource: {
        eventId: "event-actual",
        receiptId: "submission-actual",
        sourceVersion: 88,
        sourceHash: RAW,
      },
    }),
  );
  h.clock = 2070000;
  const before = h.calls.length;
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /relay_bootstrap_exhausted/,
  );
  assert.equal(h.calls.length - before, 4); // Web2 + last reserved source/execution2.
  assert.deepEqual(durations.slice(-4), [10000, 10000, 10000, 10000]);
  assert.equal((await h.read()).relayBootstrapPolls, 6);
  assert.equal((await h.read()).projectionStartedAt, undefined);
});

test("a failed or DLQ event appearing in a later bootstrap slot stops without consuming remaining slots", async (t) => {
  for (const failure of ["source", "execution"]) {
    const h = await harness(t, {
      rows: [run({ status: "completed" })],
      sources: [source({ outbox_status: "pending" })],
      beforeQuery: async (kind, state) => {
        if (state.clock === 280000 && kind === failure) {
          if (kind === "source")
            state.sources = [source({ outbox_status: "failed" })];
          else state.executions = [execution({ status: "dead_letter" })];
        }
      },
    });
    await startAssessment(SHA, h.receipt, h.options);
    await assert.rejects(
      waitAssessment(h.receipt, h.result, h.options),
      /source_delivery_terminal_failure|projection_terminal_failure/,
    );
    assert.equal((await h.read()).relayBootstrapPolls, 2);
    assert.equal((await h.read()).projectionPolls, 0);
    assert.deepEqual(
      reads(h, "execution").map((c) => c.at),
      [100000, 280000],
    );
  }
});

test("malformed durable bootstrap state fails before network and cannot reset slots", async (t) => {
  const h = await harness(t, { rows: [run({ status: "completed" })] });
  const r = await startAssessment(SHA, h.receipt, h.options);
  for (const change of [
    { relayBootstrapPolls: 7 },
    { relayBootstrapPolls: 1 },
    { relayBootstrapPolls: -1 },
    { relayBootstrapStartedAt: 100000 },
    { waitStartedAt: 0 },
    { relayDeliveredObservedAt: 0 },
  ]) {
    await writeFile(h.receipt, JSON.stringify({ ...r, ...change }));
    const before = h.calls.length;
    await assert.rejects(
      waitAssessment(h.receipt, h.result, h.options),
      /invalid_assessment_receipt/,
    );
    assert.equal(h.calls.length, before);
  }
});

for (const elapsed of [10000, 180001, LIMITS.waitMs + 1]) {
  test(`legacy delivery-only checkpoint resumes its original projection window after ${elapsed}ms`, async (t) => {
    const h = await harness(t, { rows: [run({ status: "completed" })] });
    await startAssessment(SHA, h.receipt, h.options);
    const r = await h.read();
    // Simulate interruption between the two saves used by the old release.
    Object.assign(r, {
      phase: "waiting",
      status: "completed",
      waitStartedAt: h.clock,
      completionObservedAt: h.clock,
      relayDeliveredObservedAt: h.clock,
    });
    assert.equal(r.projectionStartedAt, undefined);
    await writeFile(h.receipt, JSON.stringify(r));
    h.clock += elapsed;
    const result = await waitAssessment(h.receipt, h.result, h.options);
    assert.equal(
      (await h.read()).projectionStartedAt,
      r.relayDeliveredObservedAt,
    );
    assert.equal((await h.read()).waitStartedAt, r.waitStartedAt);
    assert.equal(
      result.verification,
      elapsed < LIMITS.projectionWaitMs
        ? "normal_projection_window"
        : "readonly_terminal_revalidation",
    );
    assert.equal(
      result.projectionPolls,
      elapsed < LIMITS.projectionWaitMs ? 1 : 0,
    );
    assert.equal(
      result.terminalRevalidations,
      elapsed < LIMITS.projectionWaitMs ? 0 : 1,
    );
    assert.equal(reads(h, "projection").length, 1);
    assert.equal(reads(h, "execution").length, 0);
    assert.equal(h.polls, 0);
    assert.equal(h.posts, 0);
  });
}

test("delivery and projection anchors are persisted together before a failed first projection read", async (t) => {
  let interrupted = true;
  const h = await harness(t, {
    rows: [run({ status: "completed" })],
    beforeQuery: async (kind, state) => {
      if (kind !== "projection" || !interrupted) return;
      const checkpoint = JSON.parse(await readFile(state.receipt, "utf8"));
      assert.equal(checkpoint.relayDeliveredObservedAt, 100000);
      assert.equal(
        checkpoint.projectionStartedAt,
        checkpoint.relayDeliveredObservedAt,
      );
      interrupted = false;
      throw new Error("fixture_projection_interrupted");
    },
  });
  await startAssessment(SHA, h.receipt, h.options);
  await assert.rejects(
    waitAssessment(h.receipt, h.result, h.options),
    /fixture_projection_interrupted/,
  );
  h.clock += LIMITS.projectionWaitMs + 1;
  const result = await waitAssessment(h.receipt, h.result, h.options);
  assert.equal(result.verification, "readonly_terminal_revalidation");
  assert.equal(result.projectionPolls, 1); // Interrupted read still consumes its slot.
  assert.equal(result.terminalRevalidations, 1);
  assert.equal((await h.read()).projectionStartedAt, 100000);
  assert.equal(h.polls, 0);
  assert.equal(h.posts, 0);
});


const NEXT_RELEASE = "e".repeat(40);
async function carryoverOptions(h, changes = {}) {
  const saved = await h.read();
  saved.postIssued = true;
  saved.web = { workerVersionId: "old-worker-version", agentId: AGENT };
  Object.assign(saved, changes);
  await writeFile(h.receipt, JSON.stringify(saved));
  const manifestPath = join(h.receipt, "..", "carryover.json");
  await writeFile(manifestPath, JSON.stringify({
    format: "ghfind-production-assessment-carryover-v1",
    runId: 10, attempt: 1, sourceSha: SHA,
    intentId: saved.intentId, analysisId: ID,
  }));
  return {
    ...h.options,
    env: {
      GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: REPO,
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/deploy-cf-production.yml@refs/heads/main`,
      GITHUB_RUN_ID: "20", GITHUB_RUN_ATTEMPT: "1",
      RELEASE_SHA: NEXT_RELEASE, FEED_ASSESSMENT_CARRYOVER: manifestPath,
    },
  };
}
test("cross-release resume checks the new Web but retains the original assessed source and never POSTs", async (t) => {
  const h = await harness(t, { rows: [run()], releaseSha: NEXT_RELEASE });
  await startAssessment(SHA, h.receipt, h.options);
  const options = await carryoverOptions(h);
  const original = await h.read();
  const resumed = await startAssessment(NEXT_RELEASE, h.receipt, options);
  assert.equal(resumed.sourceSha, SHA);
  assert.equal(resumed.analysisId, ID);
  assert.equal(resumed.intentId, original.intentId);
  const result = await waitAssessment(h.receipt, h.result, options);
  assert.equal(result.status, "passed");
  assert.equal(result.releaseSha, NEXT_RELEASE);
  assert.equal(result.sourceSha, SHA);
  assert.equal(result.projection.resolvedCommitSha, SHA);
  assert.equal((await h.read()).sourceSha, SHA);
  assert.equal(h.posts, 0);
  assert.equal(h.polls, 1);
  assert.ok(h.calls.every(c => c.url !== `${ORIGIN}/api/project-analyses`));
});
test("cross-release missing or uncertain receipt cannot fall through to a second paid POST", async (t) => {
  for (const change of ["missing", "uncertain", "other-analysis"]) {
    const h = await harness(t, { rows: [run()] });
    await startAssessment(SHA, h.receipt, h.options);
    const options = await carryoverOptions(h, change === "uncertain"
      ? { phase: "uncertain", analysisId: null }
      : change === "other-analysis" ? { analysisId: "other-assessment" } : {});
    if (change === "missing") await rm(h.receipt);
    const before = h.calls.length;
    await assert.rejects(startAssessment(NEXT_RELEASE, h.receipt, options));
    assert.equal(h.calls.length, before);
    assert.equal(h.posts, 0);
  }
});
test("cross-release wait requires current Actions release context and matching new Web", async (t) => {
  for (const change of ["missing-release", "wrong-release", "foreign-context", "old-web"]) {
    const h = await harness(t, { rows: [run({ status: "completed" })],
      releaseSha: change === "old-web" ? SHA : NEXT_RELEASE });
    await startAssessment(SHA, h.receipt, h.options);
    const options = await carryoverOptions(h);
    if (change === "missing-release") delete options.env.RELEASE_SHA;
    if (change === "wrong-release") options.env.RELEASE_SHA = SHA;
    if (change === "foreign-context") options.env.GITHUB_REF = "refs/heads/topic";
    await assert.rejects(waitAssessment(h.receipt, h.result, options));
    assert.equal(reads(h, "projection").length, 0);
    assert.equal(h.posts, 0);
    assert.equal(h.polls, 0);
  }
});
test("cross-release continuation retains exhausted quotas rather than opening a new projection window", async (t) => {
  const h = await harness(t, { rows: [run({ status: "completed" })], releaseSha: NEXT_RELEASE });
  await startAssessment(SHA, h.receipt, h.options);
  const options = await carryoverOptions(h, {
    phase: "waiting", status: "completed", polls: LIMITS.publicPolls,
    waitStartedAt: 1000, completionObservedAt: 1000,
    projectionStartedAt: 1000, projectionPolls: LIMITS.projectionPolls,
    terminalRevalidations: LIMITS.terminalRevalidations,
  });
  await startAssessment(NEXT_RELEASE, h.receipt, options);
  const before = h.calls.length;
  await assert.rejects(waitAssessment(h.receipt, h.result, options), /terminal_revalidation_exhausted/);
  assert.equal(h.calls.length, before);
  assert.equal((await h.read()).projectionStartedAt, 1000);
  assert.equal((await h.read()).projectionPolls, LIMITS.projectionPolls);
  assert.equal(h.posts, 0);
});
