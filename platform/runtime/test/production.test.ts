import { nativeDispatch } from './helpers/native-proof';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { handleRequest, type RuntimeSettings, type Dispatch } from '../src/router';
import { handleAdminRequest } from '../src/admin';
import { handleGovernanceRequest } from '../src/governance';
const env: RuntimeSettings = {
  FEED_ENVIRONMENT: 'production', FEED_IMAGE_BUILD_ID: 'd'.repeat(64), FEED_RELEASE_SHA: 'a'.repeat(40),
  FEED_IMAGE_REFERENCE: `registry.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/ghfind-feed@sha256:${'b'.repeat(64)}`,
  FEED_MODE: 'off', FEED_WRITER_EPOCH: '1', FEED_EXECUTOR_ENABLED: 'true', FEED_SOURCE_RELAY_ENABLED: 'false',
  FEED_QUEUE_NAME: 'ghfind-feed-production-jobs', FEED_DLQ_NAME: 'ghfind-feed-production-dlq',
  FEED_GATEWAY_SECRET: 'g'.repeat(32), FEED_SIGNING_SECRET: 's'.repeat(32), FEED_BRIDGE_SECRET: 'b'.repeat(32),
  FEED_RUNTIME_ADMIN_SECRET: 'r'.repeat(32), FEED_EXECUTOR_SECRET: 'e'.repeat(32), FEED_SOURCE_SECRET: 'q'.repeat(32), FEED_DELIVERY_SECRET: 'd'.repeat(32),
  WORKER_VERSION: { id: '12345678-1234-4234-8234-123456789012', tag: 'test', timestamp: '2026-09-09T00:00:00Z' },
};
function dispatch(mode = 'off', patch: Record<string, unknown> = {}): Dispatch {
  return nativeDispatch(async target => Response.json({ ready: true, imageBuildId: env.FEED_IMAGE_BUILD_ID, version: env.FEED_RELEASE_SHA, contractVersion: '1', storageWriterVersion: 2,
    service: target === 'executor-0' ? 'feed-worker' : 'feed-api', storeProfile: 'cf_d1_r2', writerEpoch: 1, mode,
    credentials: 'never-upload', ...patch }));
}
function admin(path: string, method = 'GET') {
  return new Request(`https://runtime${path}`, { method, headers: { authorization: `Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}` } });
}
function signed() {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ version: 1, audience: 'feed-api', githubId: 12, login: 'test', issuedAt: now,
    expiresAt: now + 30000, method: 'GET', target: '/api/feed/projects', bodySha256: createHash('sha256').update('').digest('hex') })).toString('base64url');
  const sig = createHmac('sha256', env.FEED_GATEWAY_SECRET).update(`feed-gateway-v1\n${payload}`).digest('base64url');
  return new Request('https://runtime/api/feed/projects', { headers: { 'x-feed-gateway': `${payload}.${sig}` } });
}
test('production public health hides identity; authenticated readiness validates actual mode/writer and whitelists fields', async () => {
  assert.deepEqual(await (await handleRequest(new Request('https://runtime/healthz'), env, dispatch())).json(), { healthy: true, service: 'feed-runtime' });
  const ready = await handleRequest(admin('/readyz'), env, dispatch());
  assert.equal(ready.status, 200); const json = await ready.json() as { mode: string; containers: { mode: string }[] };
  assert.equal(json.mode, 'off'); assert.equal(json.containers.length, 3); assert.equal(json.containers[0]!.mode, 'off');
  assert.equal(JSON.stringify(json).includes('never-upload'), false);
  for (const patch of [{ storageWriterVersion: 1 }, { mode: 'baseline' }, { mode: undefined }, { writerEpoch: 2 }, { storeProfile: 'postgres' }])
    assert.equal((await handleRequest(admin('/readyz'), env, dispatch('off', patch))).status, 503);
  assert.equal((await handleRequest(admin('/readyz'), { ...env, FEED_MODE: 'baseline' }, dispatch('off'))).status, 503);
  assert.equal((await handleRequest(admin('/readyz'), { ...env, FEED_MODE: 'baseline' }, dispatch('baseline'))).status, 200);
  assert.equal((await handleRequest(admin('/internal/runtime/api-0/stop', 'POST'), env, dispatch())).status, 405);
});
test('production off gates valid gateway before dispatch even when an old baseline Container remains', async () => {
  const d = dispatch('baseline'); d.fetch = async () => assert.fail('off must not dispatch business requests');
  const response = await handleRequest(signed(), env, d);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'feed_disabled' });
  assert.equal((await handleRequest(new Request('https://runtime/api/feed/projects'), env, d)).status, 401);
});
function operation(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://runtime/internal/runtime/${path}`, { method: 'POST', headers: {
    authorization: `Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}`, 'x-feed-operator': 'o'.repeat(32), 'x-feed-contract': '1',
    'x-feed-target': 'production', 'x-feed-release': env.FEED_RELEASE_SHA, 'x-feed-writer-epoch': '1', 'content-type': 'application/json', ...headers,
  }, body: JSON.stringify(body) });
}
test('production operator reads require independent roles and exact context; mutations require baseline', async () => {
  let calls = 0;
  const binding = { ...env, FEED_ADAPTER: { fetch: async (req: Request) => {
    calls++; assert.equal(req.headers.get('authorization'), `Bearer ${'o'.repeat(32)}`); return Response.json({ ok: true });
  } } };
  const status = { kind: 'coreSource', id: '1' };
  assert.equal((await handleAdminRequest(operation('feed-admin/v1/status', status), binding)).status, 200);
  assert.equal((await handleGovernanceRequest(operation('feed-governance/v1/proposal', { proposalKind: 'assessment', proposalId: 'p' }), binding)).status, 200);
  for (const headers of [{ 'x-feed-target': 'staging' }, { 'x-feed-release': 'b'.repeat(40) }, { 'x-feed-writer-epoch': '2' }])
    assert.equal((await handleAdminRequest(operation('feed-admin/v1/status', status, headers), binding)).status, 409);
  assert.equal((await handleAdminRequest(operation('feed-admin/v1/status', status, { authorization: `Bearer ${env.FEED_GATEWAY_SECRET}` }), binding)).status, 401);
  const replay = { ...status, commandId: '12345678-1234-4234-8234-123456789012', operator: 'release-owner', reason: 'Recover the approved source event' };
  assert.equal((await handleAdminRequest(operation('feed-admin/v1/replay', replay), binding)).status, 503);
  assert.equal((await handleGovernanceRequest(operation('feed-governance/v1/review', { writerEpoch: 1 }), binding)).status, 503);
  assert.equal(calls, 2);
  assert.equal((await handleAdminRequest(operation('feed-admin/v1/replay', replay), { ...binding, FEED_MODE: 'baseline' })).status, 200);
  assert.equal((await handleAdminRequest(operation('feed-admin/v1/sql', {}), { ...binding, FEED_MODE: 'baseline' })).status, 404);
  assert.equal(calls, 3);
});

import { actorConfiguration } from '../src/router';
test('actor configuration reports DO-owned metadata without process or lifecycle calls', async () => {
  const actorId = 'f'.repeat(64), edge = { ...env, FEED_MODE: 'baseline' };
  let reads = 0;
  const forbidden = async () => assert.fail('configuration must not contact or mutate a process');
  const d: Dispatch = {
    fetch: forbidden, stop: forbidden, probe: forbidden, restart: forbidden,
    actorId: () => actorId,
    configuration: async target => { reads++; return actorConfiguration(env, target, actorId); },
  };
  const result = await handleRequest(admin('/internal/runtime/api-0/configuration'), edge, d);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    target: 'api-0', actorId, workerVersionId: env.WORKER_VERSION.id, sourceSha: env.FEED_RELEASE_SHA,
    configuredImage: env.FEED_IMAGE_REFERENCE, imageBuildId: env.FEED_IMAGE_BUILD_ID,
    mode: 'off', writerEpoch: 1,
  });
  assert.equal(reads, 1);
  const unchanged = await handleRequest(admin('/internal/runtime/configuration'), edge, d);
  assert.deepEqual(await unchanged.json(), {
    service: 'feed-runtime', version: env.FEED_RELEASE_SHA, contractVersion: '1',
    workerVersionId: env.WORKER_VERSION.id, configuredImage: env.FEED_IMAGE_REFERENCE,
    imageBuildId: env.FEED_IMAGE_BUILD_ID, mode: 'baseline', writerEpoch: 1,
  });
  assert.equal(reads, 1);
});

test('actor metadata endpoint authenticates and fixes target before binding access', async () => {
  let reads = 0;
  const d = { ...dispatch(), configuration: async () => { reads++; assert.fail('must not read'); } };
  for (const [request, status] of [
    [new Request('https://runtime/internal/runtime/api-0/configuration'), 401],
    [admin('/internal/runtime/api-99/configuration'), 404],
    [admin('/internal/runtime/api-0/configuration?secret=x'), 404],
    [admin('/internal/runtime/api-0/configuration', 'POST'), 405],
  ] as const) assert.equal((await handleRequest(request, env, d)).status, status);
  assert.equal(reads, 0);
});

test('old DO missing configuration method and malformed identities fail without a lifecycle operation', async () => {
  const actorId = 'f'.repeat(64), correct = actorConfiguration(env, 'api-0', actorId);
  const forbidden = async () => assert.fail('must not touch process');
  for (const patch of [null, {}, { actorId: 'e'.repeat(64) }, { target: 'api-1' }, { mode: 'other' },
    { workerVersionId: 'unknown' }, { imageBuildId: 'bad' }, { sourceSha: 'bad' },
    { configuredImage: 'bad' }, { writerEpoch: 0 }, { secret: 'never-return' }]) {
    const d: Dispatch = { fetch: forbidden, stop: forbidden, probe: forbidden, restart: forbidden,
      actorId: () => actorId,
      configuration: async () => patch === null ? null : Object.keys(patch).length ? { ...correct, ...patch } : {},
    };
    const result = await handleRequest(admin('/internal/runtime/api-0/configuration'), env, d);
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: 'runtime_configuration_invalid' });
  }
  const old = await handleRequest(admin('/internal/runtime/api-0/configuration'), env,
    { fetch: forbidden, stop: forbidden, actorId: () => actorId });
  assert.equal(old.status, 503);
  assert.deepEqual(await old.json(), { error: 'runtime_configuration_unavailable' });
});

test('disabled off executor exposes only metadata while readiness and lifecycle stay gated', async () => {
  const off = { ...env, FEED_MODE: 'off', FEED_EXECUTOR_ENABLED: 'false' };
  const actorId = 'f'.repeat(64);
  let reads = 0;
  const forbidden = async () => assert.fail('disabled executor must not contact or mutate a process');
  const d: Dispatch = {
    fetch: forbidden, stop: forbidden, probe: forbidden, restart: forbidden,
    actorId: () => actorId,
    configuration: async target => { reads++; return actorConfiguration(off, target, actorId); },
  };
  const result = await handleRequest(admin('/internal/runtime/executor-0/configuration'), off, d);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), actorConfiguration(off, 'executor-0', actorId));
  for (const [path, method] of [['ready', 'GET'], ['restart', 'POST'], ['stop', 'POST']]) {
    const gated = await handleRequest(admin(`/internal/runtime/executor-0/${path}`, method), off, d);
    assert.equal(gated.status, 503);
    assert.deepEqual(await gated.json(), { error: 'executor_not_enabled' });
  }
  assert.equal(reads, 1);
});
