#!/usr/bin/env node
// One logical assessment for one pinned release. SQL below is read-only and
// fixed; the sole public POST is journaled before transmission. An uncertain
// journal must survive Actions reruns: the public API has no permanent client
// idempotency-key input, so losing that journal is NOT permission to POST again.
import { readFile, open, rename, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { boundedJSON } from "./feed-platform-web-verify.mjs";
export const ACCOUNT = "8f19bebe359e4ec1a24c68c5f49c1584";
export const ORIGIN = "https://ghfind.beiming1201.workers.dev";
export const REPO = "hikariming/ghfind";
export const CORE = "60d45096-bfe7-4de1-8b85-c1b66a466b0d";
export const FEED = "9c4ac13a-4c90-40a8-9d56-d7141f864bbf";
export const LIMITS = Object.freeze({
  publicPolls: 60,
  pollIntervalMs: 15000,
  publicWaitMs: 900000,
  projectionPolls: 5,
  projectionIntervalMs: 35000,
  projectionWaitMs: 180000,
  terminalRevalidations: 2,
  terminalWaitMs: 60000,
  management: 22,
});
const check = (v, code) => {
  if (!v) throw new Error(code);
};
const id = (v) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-)[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    v,
  );
const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const active = new Set([
  "queued",
  "creating_thread",
  "running",
  "finalizing",
  "completed",
]);
const versions = {
  schema_version: "ghfind.project-analysis.v3",
  rubric_version: "project-value-v1",
  agent_version: "project-evaluator-v3",
  skill_version: "ghfind-project-evaluator-v4",
};
export const SQL = Object.freeze({
  candidate: `SELECT p.repo_key,p.analysis_id,p.source_hash FROM feed_projects p WHERE p.published=1 AND (? IS NULL OR p.repo_key=?) AND (EXISTS(SELECT 1 FROM feed_submission_provenance v WHERE v.repo_key=p.repo_key AND v.analysis_id=p.analysis_id AND v.revoked_at IS NULL) OR EXISTS(SELECT 1 FROM feed_project_source_versions v WHERE v.repo_key=p.repo_key AND v.analysis_id=p.analysis_id AND v.revoked_at IS NULL AND v.blocked_reason='')) AND NOT EXISTS(SELECT 1 FROM feed_project_moderation m WHERE m.repo_key=p.repo_key AND m.removed=1) ORDER BY p.repo_key LIMIT 1`,
  runs: `SELECT id,repo_key,requested_ref,status,idempotency_key,schema_version,rubric_version,agent_version,skill_version,created_at,create_attempts FROM project_analysis_runs WHERE repo_key=? AND requested_ref=? ORDER BY created_at LIMIT 2`,
  source: `SELECT pr.id,pr.repo_key,pr.requested_ref,pr.resolved_commit_sha,pr.status,pr.schema_version,pr.rubric_version,pr.agent_version,pr.skill_version,pr.idempotency_key,pr.create_attempts,pr.created_at,pr.completed_at,pr.mosoo_agent_id,pr.mosoo_thread_id,pr.mosoo_run_id,pr.analysis_sha256,pr.report_sha256,pr.evidence_sha256,pa.latest_analysis_id,pa.resolved_commit_sha AS current_commit_sha,sr.id AS receipt_id,sr.requested_repo_key,sr.source_kind,o.sequence,o.event_id,o.aggregate_key,o.source_hash,o.contract_version,o.status AS outbox_status FROM project_analysis_runs pr JOIN project_assessments pa ON pa.latest_analysis_id=pr.id JOIN feed_submission_receipts sr ON sr.analysis_id=pr.id JOIN feed_source_outbox o ON o.analysis_id=pr.id AND o.receipt_id=sr.id WHERE pr.id=? AND pr.repo_key=? LIMIT 2`,
  projection: `SELECT p.analysis_id,p.source_hash,p.published,v.analysis_id AS version_analysis_id,v.event_id,v.source_version,v.receipt_id,v.source_hash AS version_source_hash,v.resolved_commit_sha,v.source_kind,v.revoked_at,v.blocked_reason,j.status AS job_status,j.aggregate_key AS job_repo,j.source_version AS job_source_version,json_extract(j.envelope_json,'$.analysisId') AS event_analysis_id,json_extract(j.envelope_json,'$.receiptId') AS event_receipt_id,json_extract(j.envelope_json,'$.sourceHash') AS event_source_hash,json_extract(j.envelope_json,'$.sourceVersion') AS event_source_version,json_extract(j.envelope_json,'$.eventId') AS job_event_id,json_extract(j.envelope_json,'$.contractVersion') AS event_contract_version,COALESCE(m.removed,0) AS removed FROM feed_projects p JOIN feed_project_source_versions v ON v.repo_key=p.repo_key JOIN feed_execution_jobs j ON j.event_id=v.event_id LEFT JOIN feed_project_moderation m ON m.repo_key=p.repo_key WHERE p.repo_key=? LIMIT 2`,
});
export function safeError(e) {
  return e instanceof Error && /^[a-z][a-z0-9_]{2,90}$/.test(e.message)
    ? e.message
    : "production_assessment_failed";
}
export function authorize(env = process.env) {
  check(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_REPOSITORY === REPO &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_WORKFLOW_REF ===
        `${REPO}/.github/workflows/deploy-cf-production.yml@refs/heads/main`,
    "production_actions_required",
  );
}
function validateSHA(sha) {
  check(
    typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
    "exact_release_sha_required",
  );
}
function validateReceipt(r, sha = r?.sourceSha) {
  validateSHA(sha);
  check(
    r?.format === "ghfind-production-assessment-intent-v1" &&
      uuid(r.intentId) &&
      r.sourceSha === sha &&
      r.origin === ORIGIN &&
      r.repository === REPO &&
      [
        "intent",
        "uncertain",
        "selected",
        "skipped",
        "waiting",
        "completed",
      ].includes(r.phase) &&
      typeof r.postIssued === "boolean" &&
      Number.isSafeInteger(r.polls) &&
      r.polls >= 0 &&
      r.polls <= LIMITS.publicPolls &&
      Number.isSafeInteger(r.projectionPolls) &&
      r.projectionPolls >= 0 &&
      r.projectionPolls <= LIMITS.projectionPolls,
    "invalid_assessment_receipt",
  );
  if (r.analysisId !== null) check(id(r.analysisId), "invalid_analysis_id");
  check(
    r.terminalRevalidations === undefined ||
      (Number.isSafeInteger(r.terminalRevalidations) &&
        r.terminalRevalidations >= 0 &&
        r.terminalRevalidations <= LIMITS.terminalRevalidations),
    "invalid_assessment_receipt",
  );
  check(
    r.completionObservedAt === undefined ||
      (Number.isSafeInteger(r.completionObservedAt) &&
        r.completionObservedAt > 0 &&
        r.analysisId !== null),
    "invalid_assessment_receipt",
  );
  return r;
}
async function load(path) {
  check(isAbsolute(path), "absolute_receipt_path_required");
  try {
    const st = await lstat(path);
    check(
      st.isFile() && !st.isSymbolicLink() && st.size <= 65536,
      "unsafe_receipt_file",
    );
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error("invalid_receipt_json");
    }
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function save(path, r, create = false) {
  const target = create ? path : `${path}.${randomUUID()}.tmp`;
  const f = await open(target, "wx", 0o600);
  try {
    await f.writeFile(JSON.stringify(r, null, 2) + "\n");
    await f.sync();
  } finally {
    await f.close();
  }
  if (!create) await rename(target, path);
}
function context(
  {
    token = process.env.CLOUDFLARE_API_TOKEN,
    fetcher = fetch,
    now = Date.now,
    sleep = pause,
  } = {},
  durationMs,
) {
  check(
    typeof token === "string" &&
      token.length > 0 &&
      !/[\x00-\x20\x7f]/.test(token),
    "cloudflare_read_token_required",
  );
  const controller = new AbortController(),
    deadline = now() + durationMs;
  const timer = setTimeout(
    () => controller.abort(new Error("assessment_deadline_exceeded")),
    durationMs,
  );
  let management = 0;
  const budget = () => {
    controller.signal.throwIfAborted();
    check(now() < deadline, "assessment_deadline_exceeded");
  };
  async function request(
    url,
    init,
    maximum = 1048576,
    requestDeadline = deadline,
  ) {
    budget();
    const target = new URL(url);
    // Reconciliation includes sequential snapshot, file-list and artifact phases.
    // The caller's remaining overall budget still bounds this longer request.
    const publicAssessment =
      target.origin === ORIGIN &&
      target.search === "" &&
      target.hash === "" &&
      ((init.method === "POST" &&
        target.pathname === "/api/project-analyses") ||
        (init.method === "GET" &&
          /^\/api\/project-analyses\/[A-Za-z0-9_.:-]{1,160}$/.test(
            target.pathname,
          )));
    const remaining = Math.min(deadline, requestDeadline) - now();
    check(remaining > 0, "assessment_deadline_exceeded");
    const r = await fetcher(url, {
      ...init,
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(
          Math.min(publicAssessment ? 60000 : 15000, remaining),
        ),
      ]),
    });
    const data = await boundedJSON(r, maximum);
    budget();
    check(now() < requestDeadline, "assessment_deadline_exceeded");
    return { response: r, data };
  }
  async function cf(path, body, requestDeadline = deadline) {
    check(++management <= LIMITS.management, "management_budget_exhausted");
    const { response, data } = await request(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      1048576,
      requestDeadline,
    );
    check(response.ok && data.success === true, "cloudflare_read_failed");
    return data.result;
  }
  async function query(kind, params, requestDeadline = deadline) {
    const db = ["candidate", "projection"].includes(kind) ? FEED : CORE;
    check(Object.hasOwn(SQL, kind), "unknown_read_query");
    const rows = await cf(
      `/d1/database/${db}/query`,
      {
        sql: SQL[kind],
        params,
      },
      requestDeadline,
    );
    check(
      Array.isArray(rows) &&
        rows.length === 1 &&
        rows[0].success === true &&
        Array.isArray(rows[0].results) &&
        rows[0].results.length <= 2,
      "invalid_read_result",
    );
    return rows[0].results;
  }
  async function web(sha) {
    const d = await cf("/workers/scripts/ghfind/deployments"),
      v = d?.deployments?.[0]?.versions;
    check(
      v?.length === 1 &&
        v[0].percentage === 100 &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v[0].version_id),
      "web_version_missing",
    );
    const version = await cf(
        `/workers/scripts/ghfind/versions/${v[0].version_id}`,
      ),
      bindings = version.resources?.bindings;
    check(
      version.id === v[0].version_id &&
        version.annotations?.["workers/tag"] === `production-${sha}` &&
        Array.isArray(bindings) &&
        new Set(bindings.map((b) => b.name)).size === bindings.length,
      "web_source_identity_mismatch",
    );
    const value = (name) =>
      bindings.find((b) => b.name === name && b.type === "plain_text")?.text;
    check(
      value("FEED_RELEASE_SHA") === sha &&
        value("FEED_SOURCE_OUTBOX_ENABLED") === "true" &&
        value("FEED_ROLLOUT_MODE") === "paused" &&
        value("MOSOO_API_BASE") === "https://cloud.mosoo.ai/api/v1" &&
        /^[A-Z0-9]{26}$/.test(value("MOSOO_PROJECT_AGENT_ID")) &&
        bindings.some(
          (b) => b.name === "GHFIND_D1" && b.type === "d1" && b.id === CORE,
        ) &&
        bindings.some(
          (b) =>
            b.name === "GHFIND_FEED_D1" && b.type === "d1" && b.id === FEED,
        ) &&
        bindings.some(
          (b) => b.name === "MOSOO_API_TOKEN" && b.type === "secret_text",
        ),
      "real_provider_or_source_binding_missing",
    );
    return {
      workerVersionId: version.id,
      agentId: value("MOSOO_PROJECT_AGENT_ID"),
    };
  }
  return {
    now,
    sleep: async (ms) => {
      budget();
      await sleep(ms, undefined, { signal: controller.signal });
      budget();
    },
    query,
    web,
    request,
    budget,
    counts: () => ({ management }),
    close: () => {
      clearTimeout(timer);
      controller.abort();
    },
  };
}
function candidate(row) {
  check(
    typeof row?.repo_key === "string" &&
      /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(row.repo_key) &&
      id(row.analysis_id) &&
      hash(row.source_hash),
    "invalid_candidate_identity",
  );
  return {
    repoKey: row.repo_key,
    analysisId: row.analysis_id,
    sourceHash: row.source_hash,
  };
}
function runIdentity(row, sha, wantedId) {
  check(
    row &&
      id(row.id) &&
      (!wantedId || row.id === wantedId) &&
      row.repo_key === REPO &&
      row.requested_ref === sha &&
      Object.entries(versions).every(([k, v]) => row[k] === v),
    "logical_assessment_identity_mismatch",
  );
  check(active.has(row.status), "logical_assessment_terminal_failure");
  const base = `ghfind-project-${row.id}`;
  check(
    row.idempotency_key === base ||
      row.idempotency_key === `${base}-retry-1` ||
      row.idempotency_key === `${base}-retry-2`,
    "assessment_retry_identity_mismatch",
  );
  check(
    Number.isSafeInteger(row.create_attempts) &&
      row.create_attempts >= 0 &&
      row.create_attempts <= 3,
    "assessment_create_attempts_exceeded",
  );
  return {
    analysisId: row.id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    currentThreadCreateAttempts: row.create_attempts,
    providerRunRetries:
      row.idempotency_key === base ? 0 : Number(row.idempotency_key.at(-1)),
  };
}
async function oneRun(c, sha, wantedId) {
  const rows = await c.query("runs", [REPO, sha]);
  check(rows.length <= 1, "multiple_logical_assessments_refused");
  return rows.length ? runIdentity(rows[0], sha, wantedId) : null;
}
export async function startAssessment(sha, path, options = {}) {
  validateSHA(sha);
  const c = context(options, 90000);
  try {
    let r = await load(path);
    if (r) validateReceipt(r, sha);
    const eligible = await c.query("candidate", [null, null]);
    if (r?.phase === "skipped") {
      check(eligible.length === 1, "existing_candidate_no_longer_eligible");
      return r;
    }
    if (r) {
      const existing = await oneRun(c, sha, r.analysisId);
      check(existing, "uncertain_post_outcome_no_retry");
      r = { ...r, ...existing, phase: "selected", resume: true };
      await save(path, r);
      return r;
    }
    r = {
      format: "ghfind-production-assessment-intent-v1",
      intentId: randomUUID(),
      sourceSha: sha,
      origin: ORIGIN,
      repository: REPO,
      phase: "intent",
      postIssued: false,
      analysisId: null,
      createdAt: c.now(),
      polls: 0,
      projectionPolls: 0,
      apiReused: null,
      providerExecution: "not_yet_verified",
    };
    if (eligible.length) {
      r.phase = "skipped";
      r.candidate = candidate(eligible[0]);
      r.providerExecution = "not_requested";
      await save(path, r, true);
      return r;
    }
    const existing = await oneRun(c, sha);
    if (existing) {
      r = { ...r, ...existing, phase: "selected", reusedLogicalRun: true };
      await save(path, r, true);
      return r;
    }
    const { response, data } = await c.request(
      "https://api.github.com/repos/hikariming/ghfind/git/ref/heads/main",
      { method: "GET", headers: { accept: "application/vnd.github+json" } },
    );
    check(
      response.ok && data.object?.sha === sha,
      "release_is_not_current_main",
    );
    r.web = await c.web(sha);
    r.postIssued = true;
    await save(path, r, true); // uncertainty is durable BEFORE the only public POST
    try {
      const posted = await c.request(`${ORIGIN}/api/project-analyses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryUrl: `https://github.com/${REPO}`,
          ref: sha,
        }),
      });
      check(
        [200, 202].includes(posted.response.status) &&
          id(posted.data.analysisId) &&
          posted.data.repoKey === REPO &&
          posted.data.statusUrl ===
            `/api/project-analyses/${posted.data.analysisId}`,
        "assessment_post_unconfirmed",
      );
      const selected = await oneRun(c, sha, posted.data.analysisId);
      check(selected, "assessment_post_unconfirmed");
      r = {
        ...r,
        ...selected,
        phase: "selected",
        apiReused:
          posted.data.reused === true ||
          posted.response.headers.get("x-project-analysis-reused") === "true"
            ? true
            : null,
      };
      await save(path, r);
      return r;
    } catch (error) {
      r = { ...r, phase: "uncertain", error: safeError(error) };
      await save(path, r);
      // Recovery is a read. A missing/failed/ambiguous row never causes a POST.
      const selected = await oneRun(c, sha);
      if (selected) {
        r = {
          ...r,
          ...selected,
          phase: "selected",
          resumedAfterUncertainPost: true,
        };
        await save(path, r);
        return r;
      }
      throw new Error("uncertain_post_outcome_no_retry");
    }
  } finally {
    c.close();
  }
}
export function sourceIdentity(row, sha, analysisId, agentId) {
  const run = runIdentity(row, sha, analysisId);
  check(
    row.status === "completed" &&
      row.create_attempts >= 1 &&
      row.resolved_commit_sha === sha &&
      row.current_commit_sha === sha &&
      row.latest_analysis_id === analysisId &&
      row.mosoo_agent_id === agentId &&
      id(row.mosoo_thread_id) &&
      id(row.mosoo_run_id) &&
      Number.isSafeInteger(row.created_at) &&
      Number.isSafeInteger(row.completed_at) &&
      row.completed_at >= row.created_at &&
      [
        row.analysis_sha256,
        row.report_sha256,
        row.evidence_sha256,
        row.source_hash,
      ].every(hash) &&
      row.source_hash === row.analysis_sha256 &&
      id(row.receipt_id) &&
      row.requested_repo_key === REPO &&
      row.source_kind === "app_submission" &&
      row.aggregate_key === REPO &&
      row.contract_version === 1 &&
      Number.isSafeInteger(row.sequence) &&
      row.sequence > 0 &&
      id(row.event_id),
    "source_finalization_identity_mismatch",
  );
  check(
    ["pending", "leased", "delivered"].includes(row.outbox_status),
    "source_delivery_terminal_failure",
  );
  return {
    ...run,
    receiptId: row.receipt_id,
    eventId: row.event_id,
    sourceVersion: row.sequence,
    sourceHash: row.source_hash,
    analysisSHA256: row.analysis_sha256,
    reportSHA256: row.report_sha256,
    evidenceSHA256: row.evidence_sha256,
    providerAgentId: row.mosoo_agent_id,
    providerThreadId: row.mosoo_thread_id,
    providerRunId: row.mosoo_run_id,
    outboxStatus: row.outbox_status,
    providerThreadsLowerBound: run.providerRunRetries + 1,
    priorThreadIdentitiesAvailable: run.providerRunRetries === 0,
  };
}
export function projectionIdentity(row, source, sha) {
  if (!row) return null;
  check(
    row.analysis_id === source.analysisId &&
      row.version_analysis_id === source.analysisId &&
      row.event_analysis_id === source.analysisId &&
      row.event_id === source.eventId &&
      row.job_event_id === source.eventId &&
      row.source_version === source.sourceVersion &&
      row.job_source_version === source.sourceVersion &&
      row.event_source_version === source.sourceVersion &&
      row.receipt_id === source.receiptId &&
      row.event_receipt_id === source.receiptId &&
      row.event_source_hash === source.sourceHash &&
      row.event_contract_version === 1 &&
      row.job_repo === REPO &&
      row.resolved_commit_sha === sha &&
      row.source_kind === "app_submission" &&
      hash(row.source_hash) &&
      row.source_hash === row.version_source_hash,
    "projection_identity_mismatch",
  );
  check(
    ["pending", "leased", "completed"].includes(row.job_status),
    "projection_terminal_failure",
  );
  check(
    row.revoked_at === null &&
      row.blocked_reason === "" &&
      row.removed === 0 &&
      row.published === 1,
    "project_not_eligible_after_assessment",
  );
  if (row.job_status !== "completed" || source.outboxStatus !== "delivered")
    return null;
  return {
    analysisId: source.analysisId,
    eventId: source.eventId,
    receiptId: source.receiptId,
    sourceVersion: source.sourceVersion,
    sourceHash: row.source_hash,
    eventSourceHash: row.event_source_hash,
    resolvedCommitSha: sha,
    published: true,
    executorStatus: "completed",
  };
}
export async function waitAssessment(path, output, options = {}) {
  check(isAbsolute(output), "absolute_result_path_required");
  const initial = await load(path);
  check(initial, "assessment_receipt_required");
  let r = validateReceipt(initial);
  const c = context(options, LIMITS.publicWaitMs + LIMITS.projectionWaitMs);
  try {
    if (r.phase === "skipped") {
      const rows = await c.query("candidate", [
        r.candidate?.repoKey,
        r.candidate?.repoKey,
      ]);
      check(rows.length === 1, "existing_candidate_no_longer_eligible");
      const result = {
        format: "ghfind-production-assessment-result-v1",
        status: "passed",
        sourceSha: r.sourceSha,
        intentId: r.intentId,
        assessment: "skipped_existing_eligible",
        providerExecution: "not_requested",
        publicPostReserved: false,
        candidate: candidate(rows[0]),
        observedAt: c.now(),
      };
      await save(output, result, true);
      return result;
    }
    check(r.analysisId && id(r.analysisId), "uncertain_post_outcome_no_retry");
    // This route never drives provider reconciliation. The full source proof is
    // still required on every invocation, even after an earlier passed receipt.
    const terminalRead =
      r.completionObservedAt !== undefined ||
      r.status === "completed" ||
      r.phase === "completed";
    if (terminalRead)
      check(
        (r.terminalRevalidations ?? 0) < LIMITS.terminalRevalidations,
        "terminal_revalidation_exhausted",
      );
    const terminalDeadline = c.now() + LIMITS.terminalWaitMs;
    const web = await c.web(r.sourceSha);
    if (r.web)
      check(
        web.agentId === r.web.agentId,
        "provider_changed_during_assessment",
      );
    async function finish(source, projection) {
      const result = {
        format: "ghfind-production-assessment-result-v1",
        status: "passed",
        sourceSha: r.sourceSha,
        intentId: r.intentId,
        repository: REPO,
        origin: ORIGIN,
        assessment:
          r.reusedLogicalRun || r.apiReused === true
            ? "reused_logical_assessment"
            : "public_post_logical_assessment",
        apiReused: r.apiReused,
        providerExecution: "real_artifacts_and_provider_identity_observed",
        newProviderExecutionClaimed: false,
        publicPostReserved: r.postIssued,
        source,
        projection,
        polls: r.polls,
        projectionPolls: r.projectionPolls,
        terminalRevalidations: r.terminalRevalidations ?? 0,
        verification: terminalRead
          ? "readonly_terminal_revalidation"
          : "normal_projection_window",
        observedAt: c.now(),
        notProven: [
          "real OAuth",
          "personalized Feed journey",
          "single provider thread when retry suffix is present",
          "permanent client idempotency after losing intent receipt",
        ],
      };
      await save(output, result, true);
      r.phase = "completed";
      await save(path, r);
      return result;
    }
    async function observeProjection(deadline) {
      const sources = await c.query("source", [r.analysisId, REPO], deadline);
      check(sources.length === 1, "source_finalization_missing");
      const source = sourceIdentity(
        sources[0],
        r.sourceSha,
        r.analysisId,
        web.agentId,
      );
      const rows = await c.query("projection", [REPO], deadline);
      check(rows.length <= 1, "ambiguous_projection");
      return {
        source,
        projection: projectionIdentity(rows[0], source, r.sourceSha),
      };
    }
    if (terminalRead) {
      r.terminalRevalidations = (r.terminalRevalidations ?? 0) + 1;
      // Reserve the finite read before transmission. Crash/ack loss consumes it.
      await save(path, r);
      const { source, projection } = await observeProjection(terminalDeadline);
      check(projection, "terminal_projection_not_ready");
      return finish(source, projection);
    }
    r = { ...r, phase: "waiting", waitStartedAt: r.waitStartedAt ?? c.now() };
    await save(path, r);
    let completed = false;
    while (
      r.polls < LIMITS.publicPolls &&
      c.now() < r.waitStartedAt + LIMITS.publicWaitMs
    ) {
      r.polls++;
      await save(path, r);
      const { response, data } = await c.request(
        `${ORIGIN}/api/project-analyses/${encodeURIComponent(r.analysisId)}`,
        { method: "GET", headers: { accept: "application/json" } },
        4 * 1024 * 1024,
        r.waitStartedAt + LIMITS.publicWaitMs,
      );
      check(
        response.ok &&
          data.analysisId === r.analysisId &&
          data.repoKey === REPO &&
          data.requestedRef === r.sourceSha &&
          active.has(data.status),
        "assessment_status_failed_or_invalid",
      );
      if (data.status === "completed") {
        completed = true;
        r.status = "completed";
        r.completionObservedAt = c.now();
        await save(path, r);
        break;
      }
      if (
        r.polls < LIMITS.publicPolls &&
        c.now() + LIMITS.pollIntervalMs < r.waitStartedAt + LIMITS.publicWaitMs
      )
        await c.sleep(LIMITS.pollIntervalMs);
      else break;
    }
    check(completed, "assessment_wait_exhausted");
    r.projectionStartedAt ??= c.now();
    await save(path, r);
    while (
      r.projectionPolls < LIMITS.projectionPolls &&
      c.now() < r.projectionStartedAt + LIMITS.projectionWaitMs
    ) {
      r.projectionPolls++;
      await save(path, r);
      const { source, projection } = await observeProjection(
        r.projectionStartedAt + LIMITS.projectionWaitMs,
      );
      if (projection) {
        return finish(source, projection);
      }
      if (
        r.projectionPolls < LIMITS.projectionPolls &&
        c.now() + LIMITS.projectionIntervalMs <
          r.projectionStartedAt + LIMITS.projectionWaitMs
      )
        await c.sleep(LIMITS.projectionIntervalMs);
    }
    throw new Error("projection_wait_exhausted");
  } finally {
    c.close();
  }
}
async function main(args) {
  authorize();
  if (args[0] === "start" && args.length === 3) {
    await startAssessment(args[1], args[2]);
    console.log("assessment_start_journal_saved");
    return;
  }
  if (args[0] === "wait" && args.length === 3) {
    await waitAssessment(args[1], args[2]);
    console.log("assessment_source_projection_verified");
    return;
  }
  throw new Error("invalid_assessment_command");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((e) => {
    console.error(safeError(e));
    process.exitCode = 1;
  });
