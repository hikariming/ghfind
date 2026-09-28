import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateEvidence, artifactName, contextFromEnvironment, eligibleBranch, localMilestones, makeJobReceipt, requiredJobs, validateLocalE2E, validateRemoteEvidence, verifyRemote } from './feed-ci-evidence.mjs';

const sha = 'a'.repeat(40), tree = 'b'.repeat(40);
const context = { repository: 'hikariming/ghfind', event: 'push', branch: 'codex/feed-test', sourceSha: sha, checkoutSha: sha, treeSha: tree, runId: '123', runAttempt: '2' };
const createdAt = '2026-09-09T03:00:00Z';
function local(c = context) {
  return { format: 'ghfind-complete-local-e2e-v1', sourceSha: c.checkoutSha, sourceTree: c.treeSha, status: 'passed', cleanupSuccessful: true, externalProviders: 'local-fixture-transports', realOAuth: false, profiles: Object.fromEntries(['cf_d1_r2', 'postgres'].map(profile => [profile, { status: 'passed', milestones: Object.fromEntries(localMilestones.map(name => [name, true])), report: `${profile}/journey.json` }])) };
}
function fixture(c = context) {
  const results = Object.fromEntries(Object.keys(requiredJobs).map(id => [id, { result: 'success' }]));
  const receipts = Object.fromEntries(Object.keys(requiredJobs).map(id => [id, makeJobReceipt(id, c, id === 'feed-e2e' ? local(c) : null)]));
  const evidence = aggregateEvidence(c, results, receipts, createdAt);
  const run = { id: 123, run_attempt: 2, repository: { full_name: c.repository }, head_repository: { full_name: c.repository }, path: '.github/workflows/ci.yml', name: 'CI', event: c.event, head_sha: c.sourceSha, head_branch: c.branch, status: 'completed', conclusion: 'success', run_started_at: '2026-09-09T02:50:00Z', updated_at: '2026-09-09T03:01:00Z' };
  const jobs = [...Object.values(requiredJobs), 'Verify release'].map(name => ({ name, head_sha: c.sourceSha, run_id: 123, status: 'completed', conclusion: 'success' }));
  const artifact = { name: artifactName(c.checkoutSha, '123', '2'), expired: false, workflow_run: { id: 123, head_sha: c.checkoutSha } };
  return { evidence, results, receipts, options: { sha: c.checkoutSha, treeSha: c.treeSha, run, jobs, artifact, now: Date.parse('2026-09-09T03:02:00Z') } };
}

test('every required job actual checkout and both complete profiles authorize one push attempt', () => {
  const { evidence, options } = fixture();
  assert.equal(validateRemoteEvidence(evidence, options), evidence);
});

test('pull request synthetic merge succeeds as compatibility evidence but cannot authorize a release', () => {
  const { evidence, options } = fixture({ ...context, event: 'pull_request', branch: '264/merge' });
  assert.equal(evidence.eligible, false);
  assert.throws(() => validateRemoteEvidence(evidence, options), /ineligible/);
});

test('a job that actually tested the merge SHA cannot claim the requested head SHA', () => {
  const env = { GITHUB_REPOSITORY: context.repository, GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: context.branch, GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
  assert.throws(() => contextFromEnvironment(env, 'c'.repeat(40), tree), /actual checkout differs/);
  const f = fixture();
  f.receipts.verify.context = { ...context, sourceSha: 'c'.repeat(40), checkoutSha: 'c'.repeat(40) };
  assert.throws(() => aggregateEvidence(context, f.results, f.receipts), /differs/);
});

test('missing, skipped, cancelled and failed mandatory jobs never yield a release receipt', () => {
  for (const result of ['skipped', 'cancelled', 'failure', undefined]) {
    const f = fixture(); f.results['feed-e2e'].result = result;
    assert.throws(() => aggregateEvidence(context, f.results, f.receipts), /did not pass/);
  }
  const f = fixture(); delete f.receipts['feed-runtime'];
  assert.throws(() => aggregateEvidence(context, f.results, f.receipts), /keys mismatch/);
});

test('local E2E cannot pass with a skipped profile, synthetic production provenance, incomplete deletion or failed cleanup', () => {
  for (const mutate of [e => { delete e.profiles.cf_d1_r2; }, e => { e.profiles.postgres.status = 'skipped'; }, e => { e.profiles.cf_d1_r2.milestones.deletionCompleted = false; }, e => { e.cleanupSuccessful = false; }, e => { e.realOAuth = true; }, e => { e.sourceSha = 'c'.repeat(40); }]) {
    const receipt = local(); mutate(receipt);
    assert.throws(() => validateLocalE2E(receipt, context));
  }
});

test('new attempts reject previous attempt receipts even for the same unchanged SHA', () => {
  const f = fixture(); f.options.run.run_attempt = 3;
  assert.throws(() => validateRemoteEvidence(f.evidence, f.options), /stale or replayed/);
  f.options.run.run_attempt = 2; f.receipts['feed-runtime'].context = { ...context, runAttempt: '1' };
  assert.throws(() => aggregateEvidence(context, f.results, f.receipts), /runAttempt differs/);
});

test('copied artifacts cannot authorize another run, repository, branch or workflow', () => {
  for (const mutate of [f => { f.options.artifact.workflow_run.id = 124; }, f => { f.options.run.head_repository.full_name = 'attacker/ghfind'; }, f => { f.options.run.head_branch = 'main'; }, f => { f.options.run.path = '.github/workflows/other.yml'; }, f => { f.options.run.event = 'pull_request'; }]) {
    const f = fixture(); mutate(f);
    assert.throws(() => validateRemoteEvidence(f.evidence, f.options));
  }
});

test('green head_sha metadata cannot conceal failed or absent actual required jobs', () => {
  for (const mutate of [f => { f.options.jobs[0].conclusion = 'failure'; }, f => { f.options.jobs.pop(); }, f => { f.options.jobs.shift(); }, f => { f.options.jobs.push({ ...f.options.jobs[0] }); }, f => { f.options.jobs[1].head_sha = 'c'.repeat(40); }]) {
    const f = fixture(); mutate(f);
    assert.throws(() => validateRemoteEvidence(f.evidence, f.options));
  }
});

test('expired artifacts, stale evidence and impossible creation times fail closed', () => {
  for (const mutate of [f => { f.options.artifact.expired = true; }, f => { f.options.now += 25 * 60 * 60 * 1000; }, f => { f.evidence.createdAt = '2026-09-09T02:49:00Z'; }, f => { f.evidence.createdAt = '2026-09-09T03:02:00Z'; }]) {
    const f = fixture(); mutate(f);
    assert.throws(() => validateRemoteEvidence(f.evidence, f.options));
  }
});

test('tree and all exact job evidence are checked, not just the reported revision', () => {
  const f = fixture(); f.evidence.jobs.verify.treeSha = 'd'.repeat(40);
  assert.throws(() => validateRemoteEvidence(f.evidence, f.options), /evidence failed/);
  const g = fixture(); g.options.treeSha = 'd'.repeat(40);
  assert.throws(() => validateRemoteEvidence(g.evidence, g.options), /source\/tree mismatch/);
});

test('eligible source branches are bounded while dev and arbitrary feature branches remain compatibility-only', () => {
  for (const branch of ['main', 'codex/feed-evidence', 'codex/feed-e2e/repair']) assert.equal(eligibleBranch(branch), true);
  for (const branch of ['dev', 'feature/evidence', 'codex/feed-', 'codex/feed-$TOKEN', undefined]) assert.equal(eligibleBranch(branch), false);
});


test('remote verifier downloads the exact attempt artifact and validates its archive digest and live branch HEAD', async () => {
  const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const treeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const f = fixture({ ...context, sourceSha: checkoutSha, checkoutSha, treeSha });
  const current = Date.now();
  f.evidence.createdAt = new Date(current - 10_000).toISOString();
  f.options.run.run_started_at = new Date(current - 60_000).toISOString();
  f.options.run.updated_at = new Date(current - 5_000).toISOString();
  const directory = mkdtempSync(join(tmpdir(), 'feed-ci-remote-test-'));
  try {
    const receipt = join(directory, 'feed-ci-evidence.json'), archiveFile = join(directory, 'receipt.zip'), output = join(directory, 'verified.json');
    writeFileSync(receipt, JSON.stringify(f.evidence));
    execFileSync('zip', ['-j', archiveFile, receipt], { stdio: 'pipe' });
    const archive = readFileSync(archiveFile);
    const artifact = { ...f.options.artifact, id: 456, digest: `sha256:${createHash('sha256').update(archive).digest('hex')}` };
    let mode = 'pass';
    const request = async path => {
      if (path.includes('/workflows/ci.yml/runs?')) return { workflow_runs: [f.options.run] };
      if (path.endsWith('/runs/123')) return { ...f.options.run, conclusion: mode === 'newest-failed' ? 'failure' : 'success' };
      if (path.includes('/git/ref/heads/')) return { object: { type: 'commit', sha: mode === 'branch-advanced' ? 'e'.repeat(40) : checkoutSha } };
      if (path.includes('/runs/123/artifacts?')) return { total_count: 1, artifacts: [{ ...artifact, digest: mode === 'wrong-digest' ? `sha256:${'0'.repeat(64)}` : artifact.digest }] };
      if (path.includes('/attempts/2/jobs?')) return { total_count: f.options.jobs.length, jobs: f.options.jobs };
      if (path.endsWith('/artifacts/456/zip')) return archive;
      throw new Error(`Unexpected API read ${path}`);
    };
    await verifyRemote(checkoutSha, output, { request });
    assert.equal(JSON.parse(readFileSync(output)).context.checkoutSha, checkoutSha);
    for (mode of ['newest-failed', 'branch-advanced', 'wrong-digest']) {
      rmSync(output, { force: true });
      await assert.rejects(verifyRemote(checkoutSha, output, { request }));
      assert.equal(existsSync(output), false, `${mode} must not leave a usable acceptance file`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
