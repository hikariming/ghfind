import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { handleRequest, type Dispatch, type RuntimeSettings, type Target } from '../src/router';
const env: RuntimeSettings = {
  FEED_ENVIRONMENT: 'production', FEED_RELEASE_SHA: 'a'.repeat(40),
  FEED_IMAGE_REFERENCE: `registry.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/ghfind-feed@sha256:${'b'.repeat(64)}`,
  FEED_MODE: 'off', FEED_WRITER_EPOCH: '1', FEED_EXECUTOR_ENABLED: 'true', FEED_SOURCE_RELAY_ENABLED: 'false',
  FEED_QUEUE_NAME: 'ghfind-feed-production-jobs', FEED_DLQ_NAME: 'ghfind-feed-production-dlq',
  FEED_GATEWAY_SECRET: 'g'.repeat(32), FEED_SIGNING_SECRET: 's'.repeat(32), FEED_BRIDGE_SECRET: 'b'.repeat(32),
  FEED_RUNTIME_ADMIN_SECRET: 'r'.repeat(32), FEED_EXECUTOR_SECRET: 'e'.repeat(32), FEED_SOURCE_SECRET: 'q'.repeat(32), FEED_DELIVERY_SECRET: 'd'.repeat(32),
  WORKER_VERSION: { id: '12345678-1234-4234-8234-123456789012', tag: 'test', timestamp: '2026-09-09T00:00:00Z' },
};
const ready = (target: Target, status = 200, patch: Record<string, unknown> = {}) => Response.json({
  ready: true, version: env.FEED_RELEASE_SHA, mode: env.FEED_MODE, contractVersion: '1', storageWriterVersion: 2,
  storeProfile: 'cf_d1_r2', writerEpoch: 1, service: target === 'executor-0' ? 'feed-worker' : 'feed-api', ...patch,
}, { status });
const dispatch = (fetch: Dispatch['fetch']): Dispatch => ({ fetch, stop: async () => assert.fail('no lifecycle mutation') });
function request(path = '/readyz', authorized = true) {
  return new Request(`https://runtime${path}`, { headers: authorized ? { authorization: `Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}` } : {} });
}
test('exact-identity HTTP503 ready=false is a dependency on aggregate and single-target paths', async () => {
  for (const path of ['/readyz', '/internal/runtime/api-0/ready', '/internal/runtime/executor-0/ready']) {
    const response = await handleRequest(request(path), env, dispatch(async target => ready(target, 503, { ready: false, secret: 'not-exported' })));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'container_dependency_not_ready' });
  }
  const mixed = await handleRequest(request(), env, dispatch(async target => target === 'api-0' ? ready(target, 503, { ready: false }) : ready(target)));
  assert.deepEqual(await mixed.json(), { error: 'container_dependency_not_ready' });
});
test('every process identity field is checked before classifying an HTTP503', async () => {
  for (const patch of [{ version: 'b'.repeat(40) }, { mode: 'baseline' }, { mode: undefined }, { contractVersion: '2' },
    { storageWriterVersion: 1 }, { writerEpoch: 2 }, { writerEpoch: '1' }, { storeProfile: 'postgres' }, { service: 'other' }]) {
    const response = await handleRequest(request('/internal/runtime/api-0/ready'), env, dispatch(async target => ready(target, 503, { ready: false, ...patch })));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'container_version_or_contract_mismatch' });
  }
});
test('aggregate waits for all targets and prioritizes later identity mismatch over early dependency', async () => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const targets: Target[] = [];
  let settled = false;
  const pending = handleRequest(request(), env, dispatch(async target => {
    targets.push(target);
    if (target === 'api-1') { await delayed; return ready(target, 503, { ready: false, mode: 'baseline' }); }
    return ready(target, 503, { ready: false });
  })).then(result => { settled = true; return result; });
  await setImmediate();
  assert.deepEqual(targets.sort(), ['api-0', 'api-1', 'executor-0']);
  assert.equal(settled, false);
  release();
  assert.deepEqual(await (await pending).json(), { error: 'container_version_or_contract_mismatch' });
});
test('HTML, unknown/oversized JSON and SDK exceptions never become dependency errors or leak content', async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  for (const reply of [
    () => new Response('<html>private-platform-body</html>', { status: 503 }),
    () => Response.json({ error: 'unknown', secret: 'private-platform-body' }, { status: 503 }),
    () => Response.json(null, { status: 503 }),
    () => new Response('x'.repeat(4097), { status: 503 }),
    () => { throw new Error('private-platform-body'); },
  ]) {
    const response = await handleRequest(request(), env, dispatch(async target => target === 'api-1' ? reply() : ready(target, 503, { ready: false })));
    assert.notEqual(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes('container_dependency_not_ready'));
    assert.ok(!text.includes('private-platform-body'));
  }
  assert.ok(!JSON.stringify(logs).includes('private-platform-body'));
});
test('noncanonical status/readiness combinations fail without a retryable code', async () => {
  for (const [status, readiness] of [[200, false], [201, true], [202, true], [503, true], [500, false], [401, false], [503, 'false']] as const) {
    const response = await handleRequest(request('/internal/runtime/api-0/ready'), env, dispatch(async target => ready(target, status, { ready: readiness })));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'container_not_ready' });
  }
});
test('all-ready responses preserve the successful whitelist and unauthorized callers do not probe', async () => {
  let calls = 0;
  const d = dispatch(async target => { calls++; return ready(target, 200, { credentials: 'private' }); });
  assert.equal((await handleRequest(request('/readyz', false), env, d)).status, 401);
  assert.equal(calls, 0);
  const response = await handleRequest(request(), env, d);
  assert.equal(response.status, 200);
  const result = await response.json() as { ready: boolean; containers: unknown[] };
  assert.equal(result.ready, true); assert.equal(result.containers.length, 3); assert.equal(calls, 3);
  assert.ok(!JSON.stringify(result).includes('private'));
});
