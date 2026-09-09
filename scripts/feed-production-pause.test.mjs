import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accountId, authorizeApply, expectedBindings, minimalEnvironment, parseArguments, platformReader,
  runPause, validateActive, validateCandidate, validateInput, workflow } from './feed-production-pause.mjs';
const sourceSha = 'a'.repeat(40);
const pausedWebVersion = '11111111-1111-4111-8111-111111111111';
const deploymentId = '22222222-2222-4222-8222-222222222222';
const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'hikariming/ghfind',
  GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: workflow, GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
const candidate = () => ({ id: pausedWebVersion, annotations: { 'workers/tag': `production-${sourceSha}` },
  resources: { script: { etag: 'synthetic-script-etag' }, bindings: [...expectedBindings(sourceSha), { name: 'PRIVATE_EXISTING_METADATA', type: 'plain_text', text: 'NEVER_EMIT_THIS_VALUE' }] } });
const exposure = () => ({ enabled: true, previews_enabled: false });
const deployments = () => ({ deployments: [{ id: deploymentId, versions: [{ version_id: pausedWebVersion, percentage: 100 }] }] });
const parsed = () => ({ sourceSha, pausedWebVersion });

function harness(t, options = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'ghfind-pause-unit-')), directory = join(parent, 'evidence');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const calls = [];
  let versionReads = 0, deploymentReads = 0;
  const api = async path => {
    calls.push(`GET ${path}`);
    if (path.endsWith('/subdomain')) return exposure();
    if (path.endsWith('/deployments')) return options.deployment?.(++deploymentReads) ?? deployments();
    if (path.endsWith(`/${pausedWebVersion}`)) return options.version?.(++versionReads) ?? candidate();
    throw new Error('unexpected test route');
  };
  const prove = async () => {
    calls.push('prove exact main-history source and CI');
    if (options.sourceError) throw new Error('exact CI evidence rejected');
    return { mainSha: env.GITHUB_SHA, sourceSha, ciRunId: '1', ciRunAttempt: '1', ciVerified: true };
  };
  const mutate = async version => {
    calls.push(`rollback ${version}`);
    if (options.rollbackError) throw new Error('rollback failed');
  };
  return { directory, calls, dependencies: { env, api, prove, mutate }, receipt: () => JSON.parse(readFileSync(join(directory, 'pause.json'))) };
}

test('explicit source UUID and duplicate-free CLI arguments are required; local mutation is denied', () => {
  assert.deepEqual(validateInput(sourceSha, pausedWebVersion), parsed());
  for (const input of ['main', 'HEAD', sourceSha.toUpperCase(), sourceSha + ';x']) assert.throws(() => validateInput(input, pausedWebVersion));
  for (const input of ['', 'latest', 'previous', sourceSha]) assert.throws(() => validateInput(sourceSha, input));
  assert.deepEqual(parseArguments(['--source-sha', sourceSha, '--paused-web-version', pausedWebVersion, '--directory', '/tmp/example']), { ...parsed(), directory: '/tmp/example', apply: false });
  assert.throws(() => parseArguments(['--source-sha', sourceSha, '--source-sha', sourceSha]));
  assert.throws(() => parseArguments(['--source-sha', sourceSha, '--paused-web-version', pausedWebVersion, '--directory', '/tmp/example', '--apply', '--apply']));
  assert.throws(() => authorizeApply({}));
  authorizeApply(env);
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'false', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'other/ghfind', GITHUB_REF: 'refs/heads/codex/feed-pause', GITHUB_WORKFLOW_REF: workflow.replace('main', 'topic'), GITHUB_SHA: 'main', GITHUB_RUN_ID: '', GITHUB_RUN_ATTEMPT: '' }))
    assert.throws(() => authorizeApply({ ...env, [name]: value }), name);
});

test('immutable paused candidate rejects legacy, changed data target, enabled traffic and foreign service metadata', () => {
  validateCandidate(sourceSha, pausedWebVersion, candidate(), exposure());
  for (const [name, changes] of [
    ['FEED_BACKEND', { text: 'legacy' }], ['FEED_ROLLOUT_MODE', { text: 'all' }],
    ['FEED_ROLLOUT_BASIS_POINTS', { text: '1' }], ['FEED_SOURCE_OUTBOX_ENABLED', { text: 'false' }],
    ['FEED_STORE_PROFILE', { text: 'postgres' }], ['FEED_RELEASE_SHA', { text: 'b'.repeat(40) }],
    ['GHFIND_D1', { id: 'staging' }], ['GHFIND_FEED_D1', { id: 'staging' }],
    ['FEED_RUNTIME', { service: 'ghfind-feed-runtime-staging' }], ['FEED_RUNTIME', { entrypoint: 'Other' }], ['FEED_RUNTIME', { environment: 'dev' }],
  ]) {
    const value = candidate(); Object.assign(value.resources.bindings.find(row => row.name === name), changes);
    assert.throws(() => validateCandidate(sourceSha, pausedWebVersion, value, exposure()), name);
  }
  const wrongVersion = candidate(); wrongVersion.id = deploymentId;
  assert.throws(() => validateCandidate(sourceSha, pausedWebVersion, wrongVersion, exposure()));
  const wrongTag = candidate(); wrongTag.annotations['workers/tag'] = `production-${'b'.repeat(40)}`;
  assert.throws(() => validateCandidate(sourceSha, pausedWebVersion, wrongTag, exposure()));
  const duplicate = candidate(); duplicate.resources.bindings.push(duplicate.resources.bindings[0]);
  assert.throws(() => validateCandidate(sourceSha, pausedWebVersion, duplicate, exposure()));
  assert.throws(() => validateCandidate(sourceSha, pausedWebVersion, candidate(), { enabled: true, previews_enabled: true }));
  assert.throws(() => validateCandidate(sourceSha, pausedWebVersion, candidate(), {}));
});

test('active readback requires the exact captured UUID at 100 percent', () => {
  assert.deepEqual(validateActive(deployments(), pausedWebVersion), { deploymentId, versionId: pausedWebVersion, percentage: 100 });
  for (const versions of [[{ version_id: pausedWebVersion, percentage: 99 }], [{ version_id: deploymentId, percentage: 100 }], [{ version_id: pausedWebVersion, percentage: 100 }, { version_id: deploymentId, percentage: 0 }], []])
    assert.throws(() => validateActive({ deployments: [{ id: deploymentId, versions }] }, pausedWebVersion));
});

test('plan defaults to read-only and emits no raw binding metadata', async t => {
  const h = harness(t);
  const receipt = await runPause({ ...parsed(), directory: h.directory }, h.dependencies);
  assert.equal(receipt.status, 'planned');
  assert.equal(receipt.serviceRestored, false);
  assert.equal(receipt.rollbackAttempted, false);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[0], 'prove exact main-history source and CI');
  assert.equal(JSON.stringify(h.receipt()).includes('NEVER_EMIT_THIS_VALUE'), false);
});

test('apply proves CI and immutable candidate before mutation, then requires stable active remote readback', async t => {
  const h = harness(t);
  const result = await runPause({ ...parsed(), directory: h.directory, apply: true }, h.dependencies);
  assert.deepEqual(h.calls, ['prove exact main-history source and CI', `GET /workers/scripts/ghfind/versions/${pausedWebVersion}`, 'GET /workers/scripts/ghfind/subdomain', `rollback ${pausedWebVersion}`, 'GET /workers/scripts/ghfind/deployments', `GET /workers/scripts/ghfind/versions/${pausedWebVersion}`, 'GET /workers/scripts/ghfind/subdomain', 'GET /workers/scripts/ghfind/deployments']);
  assert.equal(result.status, 'paused');
  assert.equal(result.active.versionId, pausedWebVersion);
  assert.equal(result.serviceRestored, false);
  assert.equal(result.runId, env.GITHUB_RUN_ID);
});

test('failed source verification cannot read a candidate or invoke rollback', async t => {
  const h = harness(t, { sourceError: true });
  await assert.rejects(runPause({ ...parsed(), directory: h.directory, apply: true }, h.dependencies), /CI evidence rejected/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.receipt().rollbackAttempted, false);
  assert.equal(h.receipt().failure.phase, 'source');
});

test('invalid candidate cannot invoke rollback and retains a failed receipt', async t => {
  const h = harness(t, { version: () => { const value = candidate(); value.resources.bindings.find(row => row.name === 'FEED_BACKEND').text = 'legacy'; return value; } });
  await assert.rejects(runPause({ ...parsed(), directory: h.directory, apply: true }, h.dependencies), /FEED_BACKEND/);
  assert.equal(h.calls.some(call => call.startsWith('rollback')), false);
  assert.equal(h.receipt().status, 'failed');
  assert.equal(h.receipt().failure.phase, 'candidate');
});

test('rollback error performs no guessed fallback and preserves its uncertain outcome', async t => {
  const h = harness(t, { rollbackError: true });
  await assert.rejects(runPause({ ...parsed(), directory: h.directory, apply: true }, h.dependencies), /rollback failed/);
  assert.equal(h.calls.filter(call => call.startsWith('rollback')).length, 1);
  assert.equal(h.receipt().rollbackAttempted, true);
  assert.equal(h.receipt().failure.phase, 'rollback');
  assert.equal(h.receipt().status, 'failed');
});

test('changed active version or deployment during readback cannot report containment', async t => {
  for (const change of ['version', 'deployment']) {
    const h = harness(t, { deployment: n => { const value = deployments(); if (change === 'version') value.deployments[0].versions[0].version_id = deploymentId; else if (n === 2) value.deployments[0].id = pausedWebVersion; return value; } });
    await assert.rejects(runPause({ ...parsed(), directory: h.directory, apply: true }, h.dependencies));
    assert.equal(h.receipt().status, 'failed');
    assert.equal(h.receipt().failure.phase, 'readback');
    assert.equal(h.calls.filter(call => call.startsWith('rollback')).length, 1);
  }
});

test('post-rollback bindings are independently checked', async t => {
  const h = harness(t, { version: count => { const value = candidate(); if (count === 2) value.resources.bindings.find(row => row.name === 'FEED_SOURCE_OUTBOX_ENABLED').text = 'false'; return value; } });
  await assert.rejects(runPause({ ...parsed(), directory: h.directory, apply: true }, h.dependencies), /FEED_SOURCE_OUTBOX_ENABLED/);
  assert.equal(h.receipt().failure.phase, 'readback');
});

test('CF reader permits GET-only pinned routes and stops on denied responses without retry', async () => {
  const calls = [], token = 'synthetic-private-token'.repeat(2);
  const reader = platformReader(token, async (url, options) => { calls.push({ url, options }); return Response.json({ success: false }, { status: 403 }); });
  await assert.rejects(reader('/workers/scripts/other/deployments'), /unexpected/);
  assert.equal(calls.length, 0);
  await assert.rejects(reader('/workers/scripts/ghfind/deployments'), /403/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${accountId}/`));
  const credentials = { PATH: '/bin', GH_TOKEN: 'gh', CLOUDFLARE_API_TOKEN: 'cf', AUTH_SECRET: 'session', FEED_OPERATOR_SECRET: 'operator' };
  assert.deepEqual(minimalEnvironment(credentials, ['GH_TOKEN']), { PATH: '/bin', GH_TOKEN: 'gh' });
  assert.deepEqual(minimalEnvironment(credentials, ['CLOUDFLARE_API_TOKEN']), { PATH: '/bin', CLOUDFLARE_API_TOKEN: 'cf' });
});

test('workflow keeps the shared lock, verified main controller, production policy preflight and one CF credential', () => {
  const text = readFileSync(new URL('../.github/workflows/feed-production-pause.yml', import.meta.url), 'utf8');
  assert.match(text, /group: deploy-cf-production-main/);
  assert.match(text, /cancel-in-progress: false/);
  assert.match(text, /needs: \[protection\]/);
  assert.match(text, /environment: Production/);
  assert.match(text, /github.ref == 'refs\/heads\/main'/);
  assert.match(text, /ref: \$\{\{ github.sha \}\}/);
  assert.match(text, /fetch-depth: 0/);
  assert.match(text, /feed-github-protection.mjs --verify-existing/);
  assert.deepEqual([...text.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]), ['CF_API_TOKEN']);
  assert.match(text, /feed-production-pause\.mjs --source-sha "\$SOURCE_SHA" --paused-web-version "\$PAUSED_WEB_VERSION" --directory "\$RUNNER_TEMP\/feed-production-pause" --apply/);
});
