import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { handleRequest, type RuntimeSettings, type Dispatch } from '../src/router';
import { handleAdminRequest } from '../src/admin';
import { handleGovernanceRequest } from '../src/governance';
const env: RuntimeSettings = {
  FEED_ENVIRONMENT: 'production', FEED_RELEASE_SHA: 'a'.repeat(40),
  FEED_IMAGE_REFERENCE: `registry.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/ghfind-feed@sha256:${'b'.repeat(64)}`,
  FEED_MODE: 'off', FEED_WRITER_EPOCH: '1', FEED_EXECUTOR_ENABLED: 'true', FEED_SOURCE_RELAY_ENABLED: 'false',
  FEED_QUEUE_NAME: 'ghfind-feed-production-jobs', FEED_DLQ_NAME: 'ghfind-feed-production-dlq',
  FEED_GATEWAY_SECRET: 'g'.repeat(32), FEED_SIGNING_SECRET: 's'.repeat(32), FEED_BRIDGE_SECRET: 'b'.repeat(32),
  FEED_RUNTIME_ADMIN_SECRET: 'r'.repeat(32), FEED_EXECUTOR_SECRET: 'e'.repeat(32), FEED_SOURCE_SECRET: 'q'.repeat(32), FEED_DELIVERY_SECRET: 'd'.repeat(32),
  WORKER_VERSION: { id: '12345678-1234-4234-8234-123456789012', tag: 'test', timestamp: '2026-09-09T00:00:00Z' },
};
function dispatch(mode = 'off', patch: Record<string, unknown> = {}): Dispatch {
  return { fetch: async target => Response.json({ ready: true, version: env.FEED_RELEASE_SHA, contractVersion: '1', storageWriterVersion: 2,
    service: target === 'executor-0' ? 'feed-worker' : 'feed-api', storeProfile: 'cf_d1_r2', writerEpoch: 1, mode,
    credentials: 'never-upload', ...patch }), stop: async () => assert.fail('production must never stop an instance') };
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
