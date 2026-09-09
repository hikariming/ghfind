#!/usr/bin/env node
// A successful pull_request run tests a synthetic merge, not the pushed HEAD.
// These receipts bind every required job's observed checkout to one push run.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const repository = 'hikariming/ghfind';
export const requiredJobs = Object.freeze({ verify: 'Application checks', 'feed-contracts': 'Feed storage contracts', 'feed-runtime': 'Feed runtime builds', 'feed-e2e': 'Complete local Feed E2E' });
export const evidenceVersion = 'ghfind.feed-ci.v1';
const shaPattern = /^[a-f0-9]{40}$/;
const numericPattern = /^[1-9][0-9]*$/;
const assert = (value, message) => { if (!value) throw new Error(message); };
const exactKeys = (value, keys, label) => { assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`); assert(Object.keys(value).sort().join(',') === [...keys].sort().join(','), `${label} keys mismatch`); };
export const eligibleBranch = branch => branch === 'main' || /^codex\/feed-[a-z0-9][a-z0-9/_-]*$/.test(branch ?? '');
export const artifactName = (sha, runId, attempt) => `feed-ci-${sha}-${runId}-${attempt}`;
const git = argument => execFileSync('git', ['rev-parse', argument], { encoding: 'utf8' }).trim();
const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJSON = (file, data) => { mkdirSync(dirname(resolve(file)), { recursive: true }); writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }); };

export function contextFromEnvironment(env = process.env, checkout = git('HEAD'), tree = git('HEAD^{tree}')) {
  const context = { repository: env.GITHUB_REPOSITORY, event: env.GITHUB_EVENT_NAME, branch: env.GITHUB_REF_NAME, sourceSha: env.GITHUB_SHA, checkoutSha: checkout, treeSha: tree, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT };
  validateContext(context);
  return context;
}

export function validateContext(context) {
  exactKeys(context, ['repository', 'event', 'branch', 'sourceSha', 'checkoutSha', 'treeSha', 'runId', 'runAttempt'], 'context');
  assert(context.repository === repository, 'unexpected repository');
  assert(['push', 'pull_request'].includes(context.event), 'unsupported CI event');
  assert(typeof context.branch === 'string' && context.branch.length > 0, 'branch absent');
  for (const key of ['sourceSha', 'checkoutSha', 'treeSha']) assert(shaPattern.test(context[key] ?? ''), `invalid ${key}`);
  assert(context.checkoutSha === context.sourceSha, 'actual checkout differs from event SHA');
  assert(numericPattern.test(context.runId ?? '') && numericPattern.test(context.runAttempt ?? ''), 'invalid run identity');
}

export const localMilestones = Object.freeze(['oauthCallback', 'assessmentFinalization', 'sourceOutbox', 'executorProjection', 'governance', 'preferences', 'events', 'deletionCompleted']);

export function validateLocalE2E(evidence, context) {
  assert(evidence?.format === 'ghfind-complete-local-e2e-v1', 'complete local E2E receipt required');
  assert(evidence.sourceSha === context.checkoutSha && evidence.sourceTree === context.treeSha, 'local E2E source/tree mismatch');
  assert(evidence.status === 'passed' && evidence.cleanupSuccessful === true, 'local E2E failed or cleanup incomplete');
  assert(evidence.externalProviders === 'local-fixture-transports' && evidence.realOAuth === false, 'local fixture provenance must be explicit');
  exactKeys(evidence.profiles, ['cf_d1_r2', 'postgres'], 'local E2E profiles');
  const profiles = {};
  for (const profile of ['cf_d1_r2', 'postgres']) {
    const result = evidence.profiles[profile];
    assert(result.status === 'passed', `${profile} E2E not passed`);
    exactKeys(result.milestones, localMilestones, `${profile} milestones`);
    for (const milestone of localMilestones) assert(result.milestones[milestone] === true, `${profile} ${milestone} incomplete`);
    assert(result.report === `${profile}/journey.json`, `${profile} report path mismatch`);
    profiles[profile] = { status: result.status, milestones: result.milestones, report: result.report };
  }
  // Only these nonsecret fields may enter the release artifact.
  return { format: evidence.format, sourceSha: evidence.sourceSha, sourceTree: evidence.sourceTree, status: 'passed', cleanupSuccessful: true, externalProviders: evidence.externalProviders, realOAuth: false, profiles };
}

export function makeJobReceipt(job, context, localE2E = null) {
  assert(Object.hasOwn(requiredJobs, job), 'unexpected required job');
  validateContext(context);
  assert(job === 'feed-e2e' || localE2E === null, 'E2E receipt belongs only to feed-e2e job');
  return { version: evidenceVersion, kind: 'job', job, context, localE2E: job === 'feed-e2e' ? validateLocalE2E(localE2E, context) : null };
}

export function aggregateEvidence(context, results, receipts, createdAt = new Date().toISOString()) {
  validateContext(context);
  exactKeys(results, Object.keys(requiredJobs), 'job results');
  exactKeys(receipts, Object.keys(requiredJobs), 'job receipts');
  const jobs = {};
  for (const id of Object.keys(requiredJobs)) {
    assert(results[id]?.result === 'success', `${id} did not pass`);
    const receipt = receipts[id];
    exactKeys(receipt, ['version', 'kind', 'job', 'context', 'localE2E'], `${id} receipt`);
    assert(receipt.version === evidenceVersion && receipt.kind === 'job' && receipt.job === id, `${id} invalid receipt`);
    validateContext(receipt.context);
    for (const key of Object.keys(context)) assert(receipt.context[key] === context[key], `${id} ${key} differs`);
    assert(id === 'feed-e2e' || receipt.localE2E === null, 'unexpected local E2E attachment');
    jobs[id] = { name: requiredJobs[id], result: 'success', checkoutSha: receipt.context.checkoutSha, treeSha: receipt.context.treeSha };
  }
  assert(Number.isFinite(Date.parse(createdAt)), 'invalid creation time');
  return { version: evidenceVersion, kind: 'release', context, createdAt, eligible: context.event === 'push' && eligibleBranch(context.branch), jobs, localE2E: validateLocalE2E(receipts['feed-e2e'].localE2E, context) };
}

export function validateRemoteEvidence(evidence, { sha, treeSha, run, jobs, artifact, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 }) {
  assert(shaPattern.test(sha ?? ''), 'exact release SHA required');
  exactKeys(evidence, ['version', 'kind', 'context', 'createdAt', 'eligible', 'jobs', 'localE2E'], 'release evidence');
  assert(evidence.version === evidenceVersion && evidence.kind === 'release' && evidence.eligible === true, 'release evidence ineligible');
  validateContext(evidence.context);
  const context = evidence.context;
  validateLocalE2E(evidence.localE2E, context);
  assert(context.event === 'push' && eligibleBranch(context.branch), 'only trusted branch push CI can qualify');
  assert(context.checkoutSha === sha && context.sourceSha === sha && context.treeSha === treeSha, 'release source/tree mismatch');
  assert(run.repository?.full_name === repository && run.head_repository?.full_name === repository, 'run repository mismatch');
  assert(run.path === '.github/workflows/ci.yml' && run.name === 'CI' && run.event === 'push', 'unexpected workflow or event');
  assert(run.head_sha === sha && run.head_branch === context.branch, 'run source mismatch');
  assert(String(run.id) === context.runId && String(run.run_attempt) === context.runAttempt, 'stale or replayed run attempt');
  assert(run.status === 'completed' && run.conclusion === 'success', 'CI run not successful');
  const created = Date.parse(evidence.createdAt), started = Date.parse(run.run_started_at), completed = Date.parse(run.updated_at);
  assert(Number.isFinite(created) && Number.isFinite(started) && Number.isFinite(completed), 'invalid evidence timestamps');
  assert(created >= started && created <= completed && created <= now + 60_000 && now - created <= maxAgeMs, 'stale or impossible evidence time');
  assert(artifact.name === artifactName(sha, context.runId, context.runAttempt) && artifact.expired === false, 'artifact identity or expiry mismatch');
  assert(artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === sha, 'artifact belongs to another run');
  exactKeys(evidence.jobs, Object.keys(requiredJobs), 'required job evidence');
  for (const [id, name] of Object.entries(requiredJobs)) {
    const job = evidence.jobs[id];
    exactKeys(job, ['name', 'result', 'checkoutSha', 'treeSha'], `${id} evidence`);
    assert(job.name === name && job.result === 'success' && job.checkoutSha === sha && job.treeSha === treeSha, `${id} evidence failed`);
    const matches = jobs.filter(item => item.name === name);
    assert(matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success' && matches[0].head_sha === sha && matches[0].run_id === run.id, `${id} actual GitHub job failed or missing`);
  }
  const gates = jobs.filter(item => item.name === 'Verify release');
  assert(gates.length === 1 && gates[0].status === 'completed' && gates[0].conclusion === 'success', 'actual release gate did not pass');
  return evidence;
}

export async function verifyRemote(sha, destination, { request = githubRequest } = {}) {
  assert(shaPattern.test(sha ?? ''), 'exact release SHA required');
  assert(git('HEAD') === sha, 'caller checkout differs from release SHA');
  const runs = await request(`/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`);
  const candidates = runs.workflow_runs.filter(run => run.event === 'push' && eligibleBranch(run.head_branch) && run.head_repository?.full_name === repository).sort((a, b) => b.id - a.id);
  assert(candidates.length > 0, 'no eligible push CI run for release SHA');
  // Do not fall back to an older green run while the newest run is pending/failed.
  const run = await request(`/repos/${repository}/actions/runs/${candidates[0].id}`);
  assert(run.status === 'completed' && run.conclusion === 'success', 'latest eligible CI run has not passed');
  const currentRef = await request(`/repos/${repository}/git/ref/heads/${run.head_branch.split('/').map(encodeURIComponent).join('/')}`);
  assert(currentRef.object?.type === 'commit' && currentRef.object.sha === sha, 'release SHA is no longer the current branch HEAD');
  const listing = await request(`/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
  assert(listing.total_count <= 100, 'artifact pagination exceeds bounded verifier');
  const artifacts = listing.artifacts.filter(item => item.name === artifactName(sha, String(run.id), String(run.run_attempt)));
  assert(artifacts.length === 1, 'exact run-attempt release artifact missing or ambiguous');
  const artifact = artifacts[0];
  const jobListing = await request(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  assert(jobListing.total_count <= 100, 'job pagination exceeds bounded verifier');
  const archive = await request(`/repos/${repository}/actions/artifacts/${artifact.id}/zip`, true);
  assert(archive.length <= 128 * 1024, 'evidence archive exceeds bound');
  assert(/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') && artifact.digest === `sha256:${createHash('sha256').update(archive).digest('hex')}`, 'artifact digest missing or mismatched');
  const temporary = mkdtempSync(join(tmpdir(), 'feed-ci-evidence-'));
  try {
    const zip = join(temporary, 'evidence.zip');
    writeFileSync(zip, archive, { mode: 0o600 });
    const files = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 8192 }).trim().split('\n');
    assert(files.length === 1 && files[0] === 'feed-ci-evidence.json', 'unexpected evidence archive files');
    const evidence = JSON.parse(execFileSync('unzip', ['-p', zip, 'feed-ci-evidence.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 }));
    validateRemoteEvidence(evidence, { sha, treeSha: git('HEAD^{tree}'), run, jobs: jobListing.jobs, artifact });
    writeJSON(destination, evidence);
    return evidence;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

async function githubRequest(path, binary = false) {
  assert(process.env.GH_TOKEN, 'GH_TOKEN required for read-only GitHub evidence verification');
  const response = await fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `GitHub evidence read failed (${response.status})`);
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}

async function main(args) {
  const [command, ...parameters] = args;
  if (command === 'record-job' && parameters.length === 2) {
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--']);
    const localE2E = parameters[0] === 'feed-e2e' ? readJSON(process.env.FEED_LOCAL_E2E_RECEIPT || '') : null;
    writeJSON(parameters[1], makeJobReceipt(parameters[0], contextFromEnvironment(), localE2E));
  } else if (command === 'aggregate' && parameters.length === 2) {
    const context = contextFromEnvironment();
    const receipts = Object.fromEntries(Object.keys(requiredJobs).map(id => [id, readJSON(join(parameters[0], `${id}.json`))]));
    writeJSON(parameters[1], aggregateEvidence(context, JSON.parse(process.env.CI_JOB_RESULTS ?? '{}'), receipts));
  } else if (command === 'verify-ci-remote' && parameters.length === 2) {
    const evidence = await verifyRemote(parameters[0], parameters[1]);
    console.log(`Verified actual checkout ${evidence.context.checkoutSha}, CI run ${evidence.context.runId} attempt ${evidence.context.runAttempt}; all required jobs passed.`);
  } else throw new Error('Usage: feed-ci-evidence.mjs record-job <job> <file> | aggregate <receipt-directory> <file> | verify-ci-remote <sha> <file>');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
