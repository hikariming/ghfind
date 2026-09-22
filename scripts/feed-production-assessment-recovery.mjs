#!/usr/bin/env node
// Read GitHub Actions history before the one paid assessment is started. An
// uncertain previous POST is a stop condition, never permission to POST again.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = 'hikariming/ghfind';
export const workflowPath = '.github/workflows/deploy-cf-production.yml';
export const startStep = 'Start or resume the single real production assessment';
export const receiptFile = 'assessment-intent.json';
// The pinned carryover window contained 22 production workflow_run events on
// 2026-09-22. Twenty rejected that complete one-page history before any deploy.
export const limits = Object.freeze({ runs: 40, attempts: 10, requests: 180, artifactBytes: 8 * 1024 * 1024, receiptBytes: 32 * 1024 });
const historyEvidencePath = new URL('../ops/feed-production-assessment-history-evidence.json', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonicalHash = value => sha256(JSON.stringify(value));
const base = `/repos/${repository}`;
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const id = value => /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };

export function validateContext(sourceSha, env = process.env) {
  requireThat(validSha(sourceSha), 'exact lowercase source SHA required');
  requireThat(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === repository && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_WORKFLOW_REF === `${repository}/${workflowPath}@refs/heads/main` &&
    id(env.GITHUB_RUN_ID) && id(env.GITHUB_RUN_ATTEMPT), 'assessment recovery requires the pinned main production Actions context');
  return { sourceSha, currentRunId: Number(env.GITHUB_RUN_ID), currentAttempt: Number(env.GITHUB_RUN_ATTEMPT) };
}
export function loadCarryover(env = process.env) {
  if (env.FEED_ASSESSMENT_CARRYOVER === undefined) return null;
  requireThat(typeof env.FEED_ASSESSMENT_CARRYOVER === 'string' && env.FEED_ASSESSMENT_CARRYOVER.length > 0,
    'assessment carryover manifest path is required');
  const bytes = readFileSync(env.FEED_ASSESSMENT_CARRYOVER);
  requireThat(bytes.length <= limits.receiptBytes, 'assessment carryover manifest exceeds bound');
  let manifest; try { manifest = JSON.parse(bytes); } catch { throw new Error('invalid assessment carryover manifest JSON'); }
  return validateCarryover(manifest);
}
export function validateCarryover(manifest) {
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  requireThat(manifest?.format === 'ghfind-production-assessment-carryover-v1' &&
    id(manifest.runId) && Number.isInteger(manifest.attempt) && manifest.attempt > 0 && manifest.attempt <= limits.attempts &&
    validSha(manifest.sourceSha) && uuid(manifest.intentId) && uuid(manifest.analysisId),
    'invalid pinned assessment carryover identity');
  return manifest;
}
export function validateCarryoverReceipt(receipt, manifest) {
  validateCarryover(manifest);
  requireThat(receipt?.sourceSha === manifest.sourceSha && receipt.intentId === manifest.intentId &&
    receipt.analysisId === manifest.analysisId && receipt.postIssued === true &&
    ['selected', 'waiting', 'completed'].includes(receipt.phase) && receipt.repository === repository &&
    receipt.origin === 'https://ghfind.beiming1201.workers.dev',
    'carryover requires the same selected paid assessment; uncertain or conflicting receipt refused');
  return receipt;
}
export function validateRun(run, sourceSha) {
  requireThat(id(run?.id) && run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.path === workflowPath && run.head_sha === sourceSha && run.head_branch === 'main' && run.event === 'workflow_run' &&
    Number.isInteger(run.run_attempt) && run.run_attempt > 0 && run.run_attempt <= limits.attempts,
  'historical production run identity or attempt bound differs');
  return run;
}
export function mayHaveStarted(jobs) {
  requireThat(Number.isInteger(jobs?.total_count) && jobs.total_count === jobs.jobs?.length && jobs.total_count <= 100,
    'complete historical job inventory required');
  const steps = [];
  for (const job of jobs.jobs) {
    requireThat(job && Array.isArray(job.steps), 'historical job steps are unreadable');
    steps.push(...job.steps.filter(step => step.name === startStep));
  }
  requireThat(steps.length <= 1, 'ambiguous historical assessment start steps');
  // An older workflow without this step could not invoke this start command.
  if (steps.length === 0) return false;
  const step = steps[0];
  if (step.status === 'completed' && step.conclusion === 'skipped') return false;
  // Failed/cancelled/in-progress steps can have crossed the POST boundary.
  return true;
}
export async function readBounded(response, maximum) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength; requireThat(size <= maximum, 'GitHub recovery response exceeds bound'); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function githubReader(token, fetcher = fetch) {
  requireThat(typeof token === 'string' && token.length > 0 && !/[\x00-\x20\x7f]/.test(token), 'read-only GH_TOKEN required');
  return async (path, binary = false) => {
    requireThat(path.startsWith(`${base}/actions/`), 'unexpected GitHub recovery route');
    const response = await fetcher(`https://api.github.com${path}`, { method: 'GET', redirect: 'manual',
      signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
    let download = response;
    if (binary && response.status === 302) {
      let target; try { target = new URL(response.headers.get('location')); } catch { /* rejected below */ }
      requireThat(target?.protocol === 'https:' && !target.username && !target.password && !target.hash &&
        ['.blob.core.windows.net', '.actions.githubusercontent.com', '.githubusercontent.com'].some(suffix => target.hostname.endsWith(suffix)),
      'unexpected artifact download origin');
      // A signed artifact URL is used only in memory, without GitHub credentials.
      download = await fetcher(target, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000) });
    }
    requireThat(download.ok, `GitHub assessment recovery read failed (${download.status})`);
    const bytes = await readBounded(download, binary ? limits.artifactBytes : 2 * 1024 * 1024);
    if (binary) return bytes;
    try { return JSON.parse(bytes); } catch { throw new Error('invalid GitHub recovery JSON'); }
  };
}
export function extractReceipt(archive, { allowMissing = false } = {}) {
  requireThat(Buffer.isBuffer(archive) && archive.length > 0 && archive.length <= limits.artifactBytes, 'invalid assessment artifact bytes');
  const directory = mkdtempSync(resolve(tmpdir(), 'feed-assessment-recovery-'));
  const zip = resolve(directory, 'evidence.zip');
  try {
    writeFileSync(zip, archive, { mode: 0o600 });
    let entries;
    try { entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 128 * 1024, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n'); }
    catch { throw new Error('cannot safely list assessment evidence archive'); }
    requireThat(entries.length <= 2000 && entries.every(name => name.length > 0 && !name.startsWith('/') && !/[\\\x00-\x1f:]/.test(name) &&
      !name.split('/').includes('..') && !name.split('/').includes('.')), 'unsafe assessment artifact entry');
    if (allowMissing && !entries.includes(receiptFile)) return null;
    requireThat(entries.filter(name => name === receiptFile).length === 1, 'possible previous assessment POST lacks a unique intent receipt');
    // Stream one exact file to memory. Never extract any archive path to disk.
    try { return execFileSync('unzip', ['-p', zip, receiptFile], { maxBuffer: limits.receiptBytes, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new Error('assessment intent receipt is unreadable or exceeds bound'); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
export function validateReceipt(bytes, sourceSha) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= limits.receiptBytes, 'invalid assessment receipt length');
  let receipt; try { receipt = JSON.parse(bytes); } catch { throw new Error('invalid assessment receipt JSON'); }
  requireThat(receipt && typeof receipt === 'object' && !Array.isArray(receipt) && receipt.sourceSha === sourceSha && receipt.format === 'ghfind-production-assessment-intent-v1' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(receipt.intentId ?? ''),
    'historical assessment receipt source SHA or stable intent identity differs');
  return receipt;
}
// These exceptions are reviewed historical evidence, not a general rule that a
// failed step or a missing artifact means no POST. Logs remain fetched live.
export function validateHistoryEvidence(value) {
  const hash = text => typeof text === 'string' && /^[a-f0-9]{64}$/.test(text);
  requireThat(value?.format === 'ghfind-assessment-readonly-history-v1' && Array.isArray(value.entries) &&
    value.entries.length <= limits.runs && Array.isArray(value.archivedReceipts) && value.archivedReceipts.length <= 1,
    'invalid reviewed assessment history evidence');
  const keys = new Set();
  for (const item of [...value.entries, ...value.archivedReceipts]) {
    requireThat(id(item.runId) && Number.isInteger(item.attempt) && item.attempt > 0 && item.attempt <= limits.attempts &&
      validSha(item.sourceSha) && id(item.jobId) && hash(item.logsSHA256) && id(item.artifactId) && hash(item.artifactSHA256),
      'invalid exact historical assessment evidence identity');
    const key = `${item.runId}:${item.attempt}`;
    requireThat(!keys.has(key), 'duplicate reviewed assessment history identity'); keys.add(key);
  }
  for (const item of value.entries) requireThat(hash(item.workflowSHA256) && [
    'possible previous assessment POST lacks a unique intent receipt',
    'possible previous assessment POST has missing, expired or mismatched evidence artifact',
  ].includes(item.failureReason), 'invalid reviewed readonly failure evidence');
  return value;
}
async function verifyHistoricalLog(item, jobs, get, conclusion) {
  const matching = jobs.jobs.filter(job => job.id === item.jobId && job.steps.some(step =>
    step.name === startStep && step.status === 'completed' && step.conclusion === conclusion));
  requireThat(matching.length === 1, 'reviewed assessment job or step outcome differs');
  const logs = await get(`${base}/actions/jobs/${item.jobId}/logs`, true);
  requireThat(Buffer.isBuffer(logs) && sha256(logs) === item.logsSHA256,
    'reviewed assessment historical log digest mismatch');
  if (item.failureReason) requireThat(logs.toString().includes(item.failureReason) &&
    logs.toString().includes('Process completed with exit code 1.'), 'reviewed readonly failure reason differs');
}
export function archivedReceiptBytes(item, carryover, env) {
  requireThat(carryover && canonicalHash(item.receipt) === item.receiptSHA256 &&
    canonicalHash(item.operator) === item.operatorSHA256, 'reviewed archive receipt or operator digest mismatch');
  const receipt = validateCarryoverReceipt(item.receipt, carryover), operator = item.operator;
  const recovery = receipt.operatorRecovery, result = operator?.result;
  requireThat(recovery && operator.format === 'ghfind-production-assessment-operator-result-v1' && operator.status === 'accepted' &&
    operator.releaseSha === item.sourceSha && operator.request?.operatorRef === `github-actions:${item.runId}:${item.attempt}` &&
    operator.request.analysisId === receipt.analysisId && operator.request.requestedRef === receipt.sourceSha &&
    operator.request.requestId === recovery.requestId && operator.request.action === 'retry_interrupted' &&
    operator.request.expectedThreadId === recovery.priorThreadId && operator.request.expectedRunId === recovery.priorRunId &&
    recovery.action === 'retry_interrupted' && result?.analysisId === receipt.analysisId && result.requestedRef === receipt.sourceSha &&
    result.idempotencyKey === `ghfind-project-${receipt.analysisId}-retry-1` && receipt.idempotencyKey === result.idempotencyKey &&
    recovery.nextIdempotencyKey === result.idempotencyKey && receipt.providerRunRetries === 1 &&
    recovery.priorReceiptSHA256 === operator.originalReceiptSHA256 &&
    canonicalHash(recovery.previousAttempt) === recovery.priorReceiptSHA256 &&
    Object.entries(result.recovery ?? {}).length === 7 && Object.entries(result.recovery).every(([key, value]) => recovery[key] === value),
    'reviewed archive operator lineage differs');
  validateCarryoverReceipt(recovery.previousAttempt, carryover);
  requireThat(typeof env.FEED_ASSESSMENT_RECOVERY_AUDIT === 'string' && env.FEED_ASSESSMENT_RECOVERY_AUDIT.startsWith('/'),
    'reviewed archive requires a fresh read-only D1 audit file');
  const bytes = readFileSync(env.FEED_ASSESSMENT_RECOVERY_AUDIT);
  requireThat(bytes.length <= limits.receiptBytes, 'recovery audit exceeds bound');
  let rows; try { rows = JSON.parse(bytes); } catch { throw new Error('invalid recovery audit JSON'); }
  if (Array.isArray(rows) && rows.length === 1 && rows[0]?.success === true && Array.isArray(rows[0].results)) rows = rows[0].results;
  const expected = item.databaseAudit;
  requireThat(Array.isArray(rows) && rows.length === 1 && expected &&
    Object.keys(rows[0] ?? {}).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => rows[0][key] === value) &&
    expected.analysis_id === receipt.analysisId && expected.request_id === recovery.requestId &&
    expected.requested_at === recovery.createdAt && expected.execution_deadline_at === recovery.executionDeadlineAt &&
    expected.next_idempotency_key === recovery.nextIdempotencyKey && expected.operator_ref === operator.request.operatorRef &&
    expected.original_thread_id === recovery.priorThreadId && expected.original_run_id === recovery.priorRunId,
    'fresh D1 audit differs from reviewed archive recovery');
  return Buffer.from(JSON.stringify(receipt));
}
export async function recover(sourceSha, destination, { env = process.env, request, extract = extractReceipt, historyEvidence } = {}) {
  const context = validateContext(sourceSha, env), read = request ?? githubReader(env.GH_TOKEN);
  const carryover = loadCarryover(env);
  const evidence = validateHistoryEvidence(historyEvidence ?? JSON.parse(readFileSync(historyEvidencePath)));
  let readonlyFailures = 0, archivedRecoveries = 0;
  if (carryover) requireThat(carryover.sourceSha !== sourceSha && carryover.runId !== context.currentRunId,
    'carryover must identify a distinct predecessor production release');
  const target = resolve(destination ?? '');
  requireThat(destination && target === destination && !existsSync(target) && existsSync(dirname(target)),
    'assessment recovery destination must be a new absolute file in an existing directory');
  let reads = 0;
  const get = (...args) => { requireThat(++reads <= limits.requests, 'assessment history request bound exceeded'); return read(...args); };
  const listing = await get(`${base}/actions/workflows/deploy-cf-production.yml/runs?head_sha=${sourceSha}&per_page=100`);
  requireThat(Number.isInteger(listing?.total_count) && listing.total_count === listing.workflow_runs?.length && listing.total_count <= limits.runs,
    'complete bounded same-SHA production run history required');
  let runs = listing.workflow_runs.map(run => validateRun(run, sourceSha));
  const current = runs.filter(run => run.id === context.currentRunId);
  requireThat(current.length === 1 && current[0].run_attempt === context.currentAttempt, 'current production run/attempt missing from history');
  if (carryover) {
    const predecessor = validateRun(await get(`${base}/actions/runs/${carryover.runId}`), carryover.sourceSha);
    requireThat(predecessor.status === 'completed' && predecessor.run_attempt >= carryover.attempt,
      'pinned predecessor assessment run is unresolved or attempt missing');
    const beginning = Date.parse(predecessor.created_at), ending = Date.parse(current[0].created_at);
    requireThat(Number.isFinite(beginning) && Number.isFinite(ending) && beginning <= ending,
      'bounded carryover history timestamps are missing or reversed');
    const interval = `${predecessor.created_at}..${current[0].created_at}`;
    const history = await get(`${base}/actions/workflows/deploy-cf-production.yml/runs?branch=main&event=workflow_run&created=${encodeURIComponent(interval)}&per_page=100`);
    requireThat(Number.isInteger(history?.total_count) && history.total_count === history.workflow_runs?.length &&
      history.total_count <= limits.runs, 'complete bounded carryover release history required');
    const intervalRuns = history.workflow_runs.map(run => {
      requireThat(validSha(run.head_sha) && Date.parse(run.created_at) >= beginning && Date.parse(run.created_at) <= ending,
        'carryover history contains an out-of-range run');
      return validateRun(run, run.head_sha);
    });
    const byId = new Map(intervalRuns.map(run => [run.id, run]));
    requireThat(byId.size === intervalRuns.length && runs.every(run => byId.get(run.id)?.head_sha === run.head_sha &&
      byId.get(run.id)?.run_attempt === run.run_attempt) && byId.get(predecessor.id)?.head_sha === predecessor.head_sha &&
      byId.get(predecessor.id)?.run_attempt === predecessor.run_attempt,
      'carryover interval omits or conflicts with current or pinned predecessor history');
    // Every intervening release can have consumed durable quotas. Inspect it,
    // but only the explicitly pinned intent/analysis may ever be restored.
    runs = intervalRuns;
  }
  let restored, inspected = 0, possibleStarts = 0, predecessorReceiptObserved = false;
  for (const run of runs) {
    const finalAttempt = run.id === context.currentRunId ? context.currentAttempt - 1 : run.run_attempt;
    let artifacts;
    for (let attempt = 1; attempt <= finalAttempt; attempt++) {
      const historical = validateRun(await get(`${base}/actions/runs/${run.id}/attempts/${attempt}`), run.head_sha);
      requireThat(historical.id === run.id && historical.run_attempt === attempt && historical.status === 'completed',
        'historical assessment attempt is unresolved or still running');
      const jobs = await get(`${base}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`);
      for (const job of jobs.jobs ?? []) requireThat(job.run_id === run.id && job.head_sha === run.head_sha, 'historical job source/run differs');
      inspected++;
      if (!mayHaveStarted(jobs)) continue;
      possibleStarts++;
      artifacts ??= await get(`${base}/actions/runs/${run.id}/artifacts?per_page=100`);
      requireThat(Number.isInteger(artifacts?.total_count) && artifacts.total_count === artifacts.artifacts?.length && artifacts.total_count <= 100,
        'complete historical artifact inventory required');
      const matches = artifacts.artifacts.filter(artifact => artifact.name === `feed-production-${run.id}-${attempt}`);
      const reviewed = evidence.entries.find(item => item.runId === run.id && item.attempt === attempt && item.sourceSha === run.head_sha);
      const archived = evidence.archivedReceipts.find(item => item.runId === run.id && item.attempt === attempt && item.sourceSha === run.head_sha);
      let bytes, artifact;
      if (matches.length === 0 && archived) {
        // The original GitHub ZIP is unavailable. This narrowly pinned,
        // explicitly reviewed local archive is corroborated by live job logs
        // and a fresh D1 audit, never represented as a verified remote ZIP.
        await verifyHistoricalLog(archived, jobs, get, 'success');
        bytes = archivedReceiptBytes(archived, carryover, env);
        artifact = { created_at: archived.createdAt }; archivedRecoveries++;
      } else {
        requireThat(matches.length === 1 && matches[0].expired === false && id(matches[0].id) &&
          matches[0].workflow_run?.id === run.id && matches[0].workflow_run?.head_sha === run.head_sha,
        'possible previous assessment POST has missing, expired or mismatched evidence artifact');
        artifact = matches[0];
        const archive = await get(`${base}/actions/artifacts/${artifact.id}/zip`, true);
        requireThat(/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') &&
          artifact.digest === `sha256:${sha256(archive)}`, 'historical artifact digest mismatch');
        if (reviewed) {
          requireThat(artifact.id === reviewed.artifactId && sha256(archive) === reviewed.artifactSHA256,
            'reviewed readonly artifact identity or digest differs');
          await verifyHistoricalLog(reviewed, jobs, get, 'failure');
        }
        bytes = extract(archive, { allowMissing: Boolean(reviewed) });
        if (bytes === null && reviewed) { readonlyFailures++; continue; }
      }
      const receipt = validateReceipt(bytes, carryover?.sourceSha ?? sourceSha);
      if (carryover) {
        validateCarryoverReceipt(receipt, carryover);
        if (run.id === carryover.runId && attempt === carryover.attempt) predecessorReceiptObserved = true;
      }
      const createdAt = Date.parse(artifact.created_at);
      requireThat(Number.isFinite(createdAt), 'historical artifact creation time is missing');
      if (restored) {
        requireThat(receipt.intentId === restored.intentId, 'historical assessment intent identities conflict; manual reconciliation required');
        requireThat(createdAt !== restored.createdAt || bytes.equals(restored.bytes), 'ambiguous assessment receipt ordering');
      }
      // Preserve the latest whole receipt. In particular, an uncertain/null-ID
      // reservation is not replaced with an earlier selected assessment.
      if (!restored || createdAt > restored.createdAt)
        restored = { bytes, intentId: receipt.intentId, createdAt, runId: run.id, attempt };
    }
  }
  if (carryover) requireThat(predecessorReceiptObserved && restored,
    'pinned predecessor has no verified selected assessment receipt; fresh POST prohibited');
  if (restored) writeFileSync(target, restored.bytes, { mode: 0o600, flag: 'wx' });
  return { status: restored ? 'recovered' : 'no_prior_start', sourceSha, ...(carryover ? { releaseSha: sourceSha, assessmentSourceSha: carryover.sourceSha } : {}), inspectedAttempts: inspected,
    possibleStarts, readonlyFailures, archivedRecoveries, ...(restored ? { recoveredRunId: restored.runId, recoveredAttempt: restored.attempt } : {}) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  Promise.resolve().then(() => {
    requireThat(process.argv.length === 4, 'usage: feed-production-assessment-recovery.mjs SHA DEST');
    return recover(process.argv[2], process.argv[3]);
  }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
