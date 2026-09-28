#!/usr/bin/env node
// Reviewed source-event replay only. No provider call, direct projection or SQL write.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQL as assessmentSQL } from './feed-production-assessment.mjs';
import { boundedJSON } from './feed-platform-web-verify.mjs';
import { statusEvidence } from './feed-operator.mjs';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifest = JSON.parse(readFileSync(resolve(root, 'ops/feed-production-manifest.json')));
export const events = JSON.parse(readFileSync(resolve(root, 'ops/feed-production-projection-replay.json')));
export const LIMITS = Object.freeze({ polls: 6, intervalMs: 20000, timeoutMs: 10000, observationStartDeadlineMs: 120000 });
const workflow = 'hikariming/ghfind/.github/workflows/feed-production-projection-replay.yml@refs/heads/main';
const check = (value, code) => { if (!value) throw new Error(code); };
const hash = value => createHash('sha256').update(value).digest('hex');
export function authorize(env = process.env) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REPOSITORY === 'hikariming/ghfind' && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_WORKFLOW_REF === workflow && /^[0-9a-f]{40}$/.test(env.RELEASE_SHA ?? '') &&
    env.RELEASE_SHA === env.GITHUB_SHA, 'protected_current_main_required');
}
export function validateManifest(value = events) {
  check(hash(JSON.stringify(value)) === 'f21ab6d615db4a16eaea27cdacbf3806cb754b6a451980784409799dbbf97b4e', 'reviewed_manifest_changed');
}
export function commandId(event) {
  const h = hash('ghfind-reviewed-risk-contract-replay-v1:' + JSON.stringify(event));
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function intent(sha) {
  validateManifest();
  check(/^[0-9a-f]{40}$/.test(sha), 'release_sha_invalid');
  return { schemaVersion: 1, releaseSHA: sha, manifestHash: hash(JSON.stringify(events)),
    events: events.map(e => ({ eventId: e.eventId, commandId: commandId(e) })), limits: LIMITS };
}
const operator = 'github-actions:reviewed-risk-contract-recovery';
const reason = 'Replay four reviewed assessment source events after risk contract compatibility fix; preserve critical risk exclusion.';
export const SQL = Object.freeze({
  source: `SELECT o.sequence,o.event_id,o.aggregate_key,o.source_hash,o.analysis_id,o.receipt_id,o.status AS outbox_status,r.status,r.analysis_sha256,r.resolved_commit_sha,pa.latest_analysis_id FROM feed_source_outbox o JOIN project_analysis_runs r ON r.id=o.analysis_id JOIN project_assessments pa ON pa.repo_key=r.repo_key WHERE o.event_id=? LIMIT 2`,
  job: assessmentSQL.execution,
  projection: assessmentSQL.projection,
  command: `SELECT id,kind,target_id,operator,reason FROM feed_operator_actions WHERE id=? LIMIT 2`,
});
export function validateSource(rows, e) {
  check(rows.length === 1, 'source_identity_missing'); const s = rows[0];
  check(s.sequence === e.sourceVersion && s.event_id === e.eventId && s.aggregate_key === e.repoKey &&
    s.source_hash === e.sourceHash && s.analysis_sha256 === e.sourceHash && s.analysis_id === e.analysisId &&
    s.receipt_id === e.receiptId && s.latest_analysis_id === e.analysisId && s.resolved_commit_sha === e.expectedResolvedCommitSHA && s.status === 'completed' && s.outbox_status === 'delivered', 'source_identity_changed');
}
export function validateJob(rows, e) {
  check(rows.length === 1, 'job_identity_missing'); const j = rows[0];
  check(j.event_id === e.eventId && j.aggregate_key === e.repoKey && j.source_version === e.sourceVersion &&
    j.analysis_id === e.analysisId && j.receipt_id === e.receiptId && j.source_hash === e.sourceHash &&
    j.event_source_version === e.sourceVersion && j.envelope_event_id === e.eventId && j.contract_version === 1 &&
    j.event_kind === 'assessment.completed', 'job_identity_changed');
  return j.status;
}
export function validateProjection(rows, e) {
  check(rows.length === 1, 'projection_missing'); const p = rows[0];
  check(p.analysis_id === e.analysisId && p.version_analysis_id === e.analysisId && /^[0-9a-f]{64}$/.test(p.source_hash) &&
    p.version_source_hash === p.source_hash && p.event_id === e.eventId && p.source_version === e.sourceVersion &&
    p.receipt_id === e.receiptId && p.resolved_commit_sha === e.expectedResolvedCommitSHA && p.job_status === 'completed' && p.job_repo === e.repoKey &&
    p.job_source_version === e.sourceVersion && p.job_event_id === e.eventId && p.event_analysis_id === e.analysisId &&
    p.event_source_hash === e.sourceHash && p.event_receipt_id === e.receiptId && p.event_source_version === e.sourceVersion &&
    p.event_contract_version === 1 && p.revoked_at === null && p.published === e.expectedPublished &&
    p.blocked_reason === e.expectedBlockedReason && p.removed === 0, 'projection_identity_or_eligibility_changed');
}
export async function transport(env, fetcher = fetch) {
  const { CLOUDFLARE_API_TOKEN: cf, FEED_RUNTIME_ADMIN_SECRET: admin, FEED_OPERATOR_SECRET: secret, RELEASE_SHA: sha } = env;
  check([cf, admin, secret].every(s => typeof s === 'string' && s.length >= 32 && !/[\x00-\x20\x7f]/.test(s)) && admin !== secret, 'independent_credentials_required');
  const request = async (url, init) => {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(LIMITS.timeoutMs) });
    if (!response.ok) throw Object.assign(new Error('transport_failed'), { httpStatus: response.status });
    return boundedJSON(response);
  };
  const management = async (path, body) => {
    const result = await request(`https://api.cloudflare.com/client/v4/accounts/${manifest.accountId}${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${cf}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    check(result.success === true, 'platform_read_failed'); return result.result;
  };
  const domain = await management('/workers/subdomain');
  check(manifest.runtimeOrigin === `https://${manifest.runtimeWorker}.${domain.subdomain}.workers.dev`, 'runtime_origin_changed');
  const settings = await management(`/workers/scripts/${manifest.runtimeWorker}/settings`);
  const adapter = await management(`/workers/scripts/${manifest.adapterWorker}/settings`);
  const binding = (settings, name, type) => {
    const values = settings.bindings?.filter(b => b.name === name && b.type === type);
    check(values?.length === 1, 'binding_missing_or_ambiguous'); return values[0];
  };
  for (const [name, value] of Object.entries({ FEED_ENVIRONMENT: 'production', FEED_MODE: 'baseline', FEED_RELEASE_SHA: sha,
    FEED_WRITER_EPOCH: '1', FEED_EXECUTOR_ENABLED: 'true', FEED_SOURCE_RELAY_ENABLED: 'true' }))
    check(binding(settings, name, 'plain_text').text === value, 'runtime_context_changed');
  const service = binding(settings, 'FEED_ADAPTER', 'service');
  check(service.service === manifest.adapterWorker && !service.entrypoint && (!service.environment || service.environment === 'production'), 'adapter_binding_changed');
  for (const [name, id] of [['CORE_DB', manifest.coreDatabase.id], ['FEED_DB', manifest.feedDatabase.id]])
    check(binding(adapter, name, 'd1').id === id, 'database_binding_changed');
  check(binding(adapter, 'FEED_ARCHIVE', 'r2_bucket').bucket_name === manifest.archiveBucket, 'archive_binding_changed');
  const image = binding(settings, 'FEED_IMAGE_REFERENCE', 'plain_text').text;
  const build = binding(settings, 'FEED_IMAGE_BUILD_ID', 'plain_text').text;
  const deployed = await management(`/workers/scripts/${manifest.runtimeWorker}/deployments`);
  const active = deployed.deployments?.[0];
  check(active?.versions?.length === 1 && active.versions[0].percentage === 100, 'runtime_deployment_split');
  const ready = await request(`${manifest.runtimeOrigin}/readyz`, { headers: { authorization: `Bearer ${admin}` } });
  check(ready.workerVersionId === active.versions[0].version_id && ready.ready === true && ready.version === sha && ready.mode === 'baseline' && ready.contractVersion === '1' &&
    ready.configuredImage === image && ready.containers?.length === 3 && new Set(ready.containers.map(c => c.actorId)).size === 3 &&
    new Set(ready.containers.map(c => c.target)).size === 3 &&
    ready.containers.every(c => ['api-0', 'api-1', 'executor-0'].includes(c.target) &&
      c.service === (c.target === 'executor-0' ? 'feed-worker' : 'feed-api') && c.ready === true && c.running === true && c.version === sha && c.imageBuildId === build &&
      c.mode === 'baseline' && c.writerEpoch === 1 && c.storageWriterVersion === 2 && c.storeProfile === 'cf_d1_r2'), 'runtime_readiness_changed');
  return {
    identity: { releaseSHA: sha, workerVersionId: ready.workerVersionId, image, imageBuildId: build },
    query: async (name, params) => {
      check(Object.hasOwn(SQL, name), 'query_not_enrolled');
      const id = name === 'source' ? manifest.coreDatabase.id : manifest.feedDatabase.id;
      const result = await management(`/d1/database/${id}/query`, { sql: SQL[name], params });
      check(result.length === 1 && result[0].success === true && Array.isArray(result[0].results), 'database_read_failed');
      return result[0].results;
    },
    admin: async (action, body) => {
      check(['status', 'replay'].includes(action), 'operation_not_enrolled');
      return request(`${manifest.runtimeOrigin}/internal/runtime/feed-admin/v1/${action}`, { method: 'POST', headers: {
        authorization: `Bearer ${admin}`, 'x-feed-operator': secret, 'x-feed-contract': '1', 'x-feed-target': 'production',
        'x-feed-release': sha, 'x-feed-writer-epoch': '1', 'content-type': 'application/json',
      }, body: JSON.stringify(body) });
    },
  };
}
export async function execute(t, persist, { sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  validateManifest();
  const evidence = { schemaVersion: 1, identity: t.identity, events: [], completed: false };
  for (const e of events) {
    const record = { eventId: e.eventId, sourceVersion: e.sourceVersion, commandId: commandId(e), phase: 'preflight', polls: 0 };
    evidence.events.push(record); persist(evidence);
    try {
      await t.query('source', [e.eventId]).then(r => validateSource(r, e));
      const state = validateJob(await t.query('job', [e.eventId]), e);
      const actions = await t.query('command', [record.commandId]);
      check(actions.length <= 1 && actions.every(a => a.id === record.commandId && a.kind === 'sourceEvent' && a.target_id === e.eventId &&
        a.operator === operator && a.reason === reason), 'replay_command_identity_changed');
      const before = statusEvidence(await t.admin('status', { kind: 'sourceEvent', id: e.eventId }), e.eventId);
      record.before = before;
      check(before.job?.status === state, 'job_state_changed');
      if (state !== 'completed' && actions.length === 0) {
        check(state === 'dead_letter', 'reviewed_dead_letter_required');
        record.phase = 'replay_intent_persisted'; persist(evidence);
        // Exactly one write attempt; unknown outcomes stop. Manual rerun checks
        // durable audit first and reuses the same ID even after a runner crash.
        const accepted = await t.admin('replay', { kind: 'sourceEvent', id: e.eventId, writerEpoch: 1, commandId: record.commandId, operator, reason });
        check(accepted?.ok === true, 'replay_outcome_uncertain');
      }
      // The deadline gates starting another observation; each in-flight request is
      // separately capped at 10s, final identity reads add at most 30s.
      const deadline = now() + LIMITS.observationStartDeadlineMs;
      for (let poll = 0; poll < LIMITS.polls; poll++) {
        check(now() < deadline, 'completion_deadline_exhausted');
        record.polls++; record.phase = 'observing'; persist(evidence);
        const after = statusEvidence(await t.admin('status', { kind: 'sourceEvent', id: e.eventId }), e.eventId);
        record.after = after; persist(evidence);
        if (after.job?.status === 'completed') {
          const finalSource = await t.query('source', [e.eventId]); validateSource(finalSource, e);
          check(validateJob(await t.query('job', [e.eventId]), e) === 'completed', 'job_not_completed');
          const projection = await t.query('projection', [e.repoKey]);
          validateProjection(projection, e);
          check(projection[0].resolved_commit_sha === finalSource[0].resolved_commit_sha, 'projection_commit_changed');
          record.phase = 'completed'; persist(evidence); break;
        }
        check(after.delivery?.deliveryId === record.commandId && ['pending', 'leased'].includes(after.job?.status), 'replay_failed_or_generation_changed');
        if (poll + 1 < LIMITS.polls) await sleep(LIMITS.intervalMs);
      }
      check(record.phase === 'completed', 'completion_budget_exhausted');
    } catch (error) {
      record.phase = 'failed_or_uncertain'; record.error = /^[a-z_]{3,80}$/.test(error.message) ? error.message : 'replay_failed';
      if (Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) record.httpStatus = error.httpStatus;
      persist(evidence); throw new Error(record.error);
    }
  }
  evidence.completed = true; persist(evidence); return evidence;
}
async function main() {
  authorize(); const sha = process.env.RELEASE_SHA, directory = process.env.EVIDENCE_DIRECTORY;
  check(typeof directory === 'string' && directory.startsWith('/'), 'evidence_directory_required');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const expected = intent(sha), intentPath = resolve(directory, 'intent.json');
  if (process.argv[2] === '--prepare') { writeFileSync(intentPath, JSON.stringify(expected, null, 2), { flag: 'wx', mode: 0o600 }); return; }
  const resultPath = resolve(directory, 'result.json');
  try {
  check(process.argv[2] === '--execute' && JSON.stringify(JSON.parse(readFileSync(intentPath))) === JSON.stringify(expected), 'persisted_intent_changed');
  const current = execFileSync('gh', ['api', 'repos/hikariming/ghfind/git/ref/heads/main', '--jq', '.object.sha'], { encoding: 'utf8' }).trim();
  check(current === sha && execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === sha, 'main_advanced');
    const t = await transport(process.env);
    await execute(t, value => writeFileSync(resultPath, JSON.stringify(value, null, 2), { mode: 0o600 }));
  } catch (error) {
    if (!existsSync(resultPath)) writeFileSync(resultPath, JSON.stringify({ schemaVersion: 1, releaseSHA: sha, completed: false,
      phase: 'transport_preflight_failed', error: /^[a-z_]{3,80}$/.test(error.message) ? error.message : 'preflight_failed',
      ...(Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}) }, null, 2), { mode: 0o600 });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('production_projection_replay_failed; inspect sanitized evidence'); process.exitCode = 1; });
