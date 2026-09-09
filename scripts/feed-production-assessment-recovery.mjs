#!/usr/bin/env node
// Read GitHub Actions history before the one paid assessment is started. An
// uncertain previous POST is a stop condition, never permission to POST again.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = 'hikariming/ghfind';
export const workflowPath = '.github/workflows/deploy-cf-production.yml';
export const startStep = 'Start or resume the single real production assessment';
export const receiptFile = 'assessment-intent.json';
export const limits = Object.freeze({ runs: 20, attempts: 10, requests: 180, artifactBytes: 8 * 1024 * 1024, receiptBytes: 32 * 1024 });
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
export function extractReceipt(archive) {
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
export async function recover(sourceSha, destination, { env = process.env, request, extract = extractReceipt } = {}) {
  const context = validateContext(sourceSha, env), read = request ?? githubReader(env.GH_TOKEN);
  const target = resolve(destination ?? '');
  requireThat(destination && target === destination && !existsSync(target) && existsSync(dirname(target)),
    'assessment recovery destination must be a new absolute file in an existing directory');
  let reads = 0;
  const get = (...args) => { requireThat(++reads <= limits.requests, 'assessment history request bound exceeded'); return read(...args); };
  const listing = await get(`${base}/actions/workflows/deploy-cf-production.yml/runs?head_sha=${sourceSha}&per_page=100`);
  requireThat(Number.isInteger(listing?.total_count) && listing.total_count === listing.workflow_runs?.length && listing.total_count <= limits.runs,
    'complete bounded same-SHA production run history required');
  const runs = listing.workflow_runs.map(run => validateRun(run, sourceSha));
  const current = runs.filter(run => run.id === context.currentRunId);
  requireThat(current.length === 1 && current[0].run_attempt === context.currentAttempt, 'current production run/attempt missing from history');
  let restored, inspected = 0, possibleStarts = 0;
  for (const run of runs) {
    const finalAttempt = run.id === context.currentRunId ? context.currentAttempt - 1 : run.run_attempt;
    let artifacts;
    for (let attempt = 1; attempt <= finalAttempt; attempt++) {
      const historical = validateRun(await get(`${base}/actions/runs/${run.id}/attempts/${attempt}`), sourceSha);
      requireThat(historical.id === run.id && historical.run_attempt === attempt && historical.status === 'completed',
        'historical assessment attempt is unresolved or still running');
      const jobs = await get(`${base}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`);
      for (const job of jobs.jobs ?? []) requireThat(job.run_id === run.id && job.head_sha === sourceSha, 'historical job source/run differs');
      inspected++;
      if (!mayHaveStarted(jobs)) continue;
      possibleStarts++;
      artifacts ??= await get(`${base}/actions/runs/${run.id}/artifacts?per_page=100`);
      requireThat(Number.isInteger(artifacts?.total_count) && artifacts.total_count === artifacts.artifacts?.length && artifacts.total_count <= 100,
        'complete historical artifact inventory required');
      const matches = artifacts.artifacts.filter(artifact => artifact.name === `feed-production-${run.id}-${attempt}`);
      requireThat(matches.length === 1 && matches[0].expired === false && id(matches[0].id) &&
        matches[0].workflow_run?.id === run.id && matches[0].workflow_run?.head_sha === sourceSha,
      'possible previous assessment POST has missing, expired or mismatched evidence artifact');
      const artifact = matches[0], archive = await get(`${base}/actions/artifacts/${artifact.id}/zip`, true);
      requireThat(/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') &&
        artifact.digest === `sha256:${createHash('sha256').update(archive).digest('hex')}`, 'historical artifact digest mismatch');
      const bytes = extract(archive), receipt = validateReceipt(bytes, sourceSha);
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
  if (restored) writeFileSync(target, restored.bytes, { mode: 0o600, flag: 'wx' });
  return { status: restored ? 'recovered' : 'no_prior_start', sourceSha, inspectedAttempts: inspected,
    possibleStarts, ...(restored ? { recoveredRunId: restored.runId, recoveredAttempt: restored.attempt } : {}) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  Promise.resolve().then(() => {
    requireThat(process.argv.length === 4, 'usage: feed-production-assessment-recovery.mjs SHA DEST');
    return recover(process.argv[2], process.argv[3]);
  }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
