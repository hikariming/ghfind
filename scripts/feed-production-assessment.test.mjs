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
const candidate = () => ({
  repo_key: REPO,
  analysis_id: ID,
  source_hash: COMPOSITE,
});
function webBindings() {
  return Object.entries({
    FEED_RELEASE_SHA: SHA,
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
      h.calls.push({ url, method: init.method, body: init.body });
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
              `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${["candidate", "projection"].includes(kind) ? FEED : CORE}/query`,
            ),
          );
          if (kind === "runs") assert.deepEqual(params, [REPO, SHA]);
          if (kind === "source") assert.deepEqual(params, [ID, REPO]);
          if (kind === "projection") assert.deepEqual(params, [REPO]);
          const rows = {
            candidate: h.candidates,
            runs: h.rows,
            source: h.sources,
            projection:
              settings.projectionReadyAt !== undefined &&
              h.clock < settings.projectionReadyAt
                ? []
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
          const bindings = webBindings();
          settings.mutateBindings?.(bindings);
          return json({
            success: true,
            result: {
              id: WORKER,
              annotations: { "workers/tag": `production-${SHA}` },
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
