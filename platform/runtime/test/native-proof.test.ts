import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { captureNativeProbe, handleRequest, type Dispatch, type NativeProbe, type RuntimeSettings, type Target } from '../src/router';
import { actorId, nativeDispatch } from './helpers/native-proof';
import { containerEnvironment } from '../src/environment';

const env: RuntimeSettings = {
  FEED_ENVIRONMENT: 'production', FEED_RELEASE_SHA: 'a'.repeat(40), FEED_IMAGE_BUILD_ID: 'd'.repeat(64),
  FEED_IMAGE_REFERENCE: `registry.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/ghfind-feed@sha256:${'b'.repeat(64)}`,
  FEED_MODE: 'off', FEED_WRITER_EPOCH: '1', FEED_EXECUTOR_ENABLED: 'true', FEED_SOURCE_RELAY_ENABLED: 'false',
  FEED_QUEUE_NAME: 'ghfind-feed-production-jobs', FEED_DLQ_NAME: 'ghfind-feed-production-dlq',
  FEED_GATEWAY_SECRET: 'g'.repeat(32), FEED_SIGNING_SECRET: 's'.repeat(32), FEED_BRIDGE_SECRET: 'b'.repeat(32),
  FEED_RUNTIME_ADMIN_SECRET: 'r'.repeat(32), FEED_EXECUTOR_SECRET: 'e'.repeat(32), FEED_SOURCE_SECRET: 'q'.repeat(32), FEED_DELIVERY_SECRET: 'd'.repeat(32),
  WORKER_VERSION: { id: '12345678-1234-4234-8234-123456789012', tag: 'test', timestamp: '2026-09-09T00:00:00Z' },
};
const response = (target: Target, patch: Record<string, unknown> = {}, status = 200) => Response.json({
  ready: true, version: env.FEED_RELEASE_SHA, mode: env.FEED_MODE, imageBuildId: env.FEED_IMAGE_BUILD_ID,
  contractVersion: '1', storageWriterVersion: 2, storeProfile: 'cf_d1_r2', writerEpoch: 1,
  service: target === 'executor-0' ? 'feed-worker' : 'feed-api', ...patch,
}, { status });
const request = (path = '/readyz') => new Request(`https://runtime${path}`, {
  headers: { authorization: `Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}` },
});

test('same source and configured digest cannot conceal a different compiled build ID', async () => {
  for (const imageBuildId of ['e'.repeat(64), undefined, null, 'development']) {
    const d = nativeDispatch(async target => response(target, { imageBuildId }));
    const r = await handleRequest(request(), env, d);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: 'container_version_or_contract_mismatch' });
  }
  const inconsistent = nativeDispatch(async target => response(target, target === 'executor-0' ? { imageBuildId: 'e'.repeat(64) } : {}));
  assert.equal((await handleRequest(request(), env, inconsistent)).status, 503);
  for (const role of ['api', 'executor'] as const) {
    assert.equal(containerEnvironment(env, role).FEED_IMAGE_BUILD_ID, undefined);
    assert.equal(containerEnvironment(env, role).IMAGE_BUILD_ID, undefined);
  }
});

test('native actor and running facts cannot be replaced by Go fields or another actor', async () => {
  for (const patch of [
    { actorId: actorId('api-1') }, { actorId: undefined },
    { running: false }, { running: 'true' },
  ]) {
    const d = nativeDispatch(async target => response(target, { actorId: actorId(target), running: true }));
    const real = d.probe!;
    d.probe = async target => ({ ...await real(target), ...patch }) as NativeProbe;
    const r = await handleRequest(request('/internal/runtime/api-0/ready'), env, d);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: patch.running === false ? 'container_not_ready' : 'container_version_or_contract_mismatch' });
  }
  const duplicate = nativeDispatch(async target => response(target));
  duplicate.actorId = () => actorId('api-0');
  const native = duplicate.probe!;
  duplicate.probe = async target => ({ ...await native(target), actorId: actorId('api-0') });
  assert.equal((await handleRequest(request(), env, duplicate)).status, 503);
});

test('native production proof is mandatory and expected build config is exact; staging retains fetch compatibility', async () => {
  const d: Dispatch = { fetch: async target => response(target), stop: async () => assert.fail('no stop') };
  assert.equal((await handleRequest(request(), env, d)).status, 503);
  for (const imageBuildId of [undefined, '', 'development', 'A'.repeat(64), 'd'.repeat(63)]) {
    const config = { ...env, FEED_IMAGE_BUILD_ID: imageBuildId } as RuntimeSettings;
    const r = await handleRequest(request(), config, nativeDispatch(d.fetch));
    assert.deepEqual(await r.json(), { error: 'runtime_unconfigured' });
  }
  const staging: RuntimeSettings = { ...env, FEED_ENVIRONMENT: 'staging', FEED_QUEUE_NAME: 'ghfind-feed-staging-jobs', FEED_DLQ_NAME: 'ghfind-feed-staging-dlq' };
  delete staging.FEED_IMAGE_BUILD_ID;
  const r = await handleRequest(request(), staging, d);
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(await r.json()).includes('imageBuildId'));
});

test('production only emits the same-DO fact whitelist, never raw Go or RPC fields', async () => {
  const d = nativeDispatch(async target => response(target, { credentials: 'private', running: false, actorId: 'forged' }));
  const real = d.probe!;
  d.probe = async target => ({ ...await real(target), privateContext: 'private' });
  const r = await handleRequest(request(), env, d);
  assert.equal(r.status, 200);
  const payload = await r.json() as { containers: Record<string, unknown>[] };
  for (const [i, item] of payload.containers.entries()) {
    assert.equal(item.actorId, actorId((['api-0', 'api-1', 'executor-0'] as const)[i]!));
    assert.equal(item.running, true);
    assert.equal(item.imageBuildId, env.FEED_IMAGE_BUILD_ID);
  }
  assert.doesNotMatch(JSON.stringify(payload), /private|forged/);
});

test('same-DO capture reads complete bounded Go body before synchronously checking live native state', async () => {
  const events: string[] = [];
  let live = true;
  const proof = await captureNativeProbe(async req => {
    assert.equal(req.url, 'http://feed-container/readyz');
    assert.equal(req.method, 'GET');
    assert.equal([...req.headers].length, 0);
    events.push('request');
    return new Response(new ReadableStream({ pull(controller) {
      events.push('body');
      live = false;
      controller.enqueue(new TextEncoder().encode('{"ready":true}'));
      controller.close();
    } }));
  }, () => {
    events.push('native');
    return { actorId: actorId('api-0'), running: live };
  });
  assert.deepEqual(events, ['request', 'body', 'native']);
  assert.equal(proof.running, false);
  assert.equal(proof.phase, 'response');
  assert.equal(new TextDecoder().decode(proof.body), '{"ready":true}');
  let states = 0;
  await assert.rejects(captureNativeProbe(async () => new Response('x'.repeat(4097)), () => {
    states++; return { actorId: actorId('api-0'), running: true };
  }), /body_too_large/);
  assert.equal(states, 0);
});

test('native operation is bounded at nine seconds with one-second RPC envelope headroom', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false, nativeReads = 0;
  const captured = captureNativeProbe(async req => {
    req.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise<Response>(() => {});
  }, () => { nativeReads++; return { actorId: actorId('api-0'), running: true }; });
  const rejected = assert.rejects(captured, /container_not_ready/);
  t.mock.timers.tick(8999);
  assert.equal(aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(aborted, true); assert.equal(nativeReads, 0);
  const d = nativeDispatch(async target => response(target));
  d.probe = async () => new Promise<NativeProbe>(() => {});
  const pending = handleRequest(request('/internal/runtime/api-0/ready'), env, d);
  await setImmediate();
  t.mock.timers.tick(10000);
  const r = await pending;
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'container_not_ready' });
});

const noInstance = 'there is no container instance that can be provided to this durable object';

test('SDK no-instance is typed only during preparation and only with native stopped proof', async () => {
  let requests = 0;
  const startup = await captureNativeProbe(async () => { requests++; return response('api-0'); },
    () => ({ actorId: actorId('api-0'), running: false }),
    async signal => { assert.equal(signal.aborted, false); throw new Error(noInstance); });
  assert.deepEqual(startup, { phase: 'starting', actorId: actorId('api-0'), running: false });
  assert.equal(requests, 0);
  const dispatch = nativeDispatch(async target => response(target));
  dispatch.probe = async () => startup;
  const result = await handleRequest(request('/internal/runtime/api-0/ready'), env, dispatch);
  assert.deepEqual(await result.json(), { error: 'container_starting' });
  assert.equal(result.status, 503);
  for (const error of [new Error('arbitrary SDK failure'), new Error('you are requesting too many containers per second'), noInstance]) {
    await assert.rejects(captureNativeProbe(async () => response('api-0'),
      () => ({ actorId: actorId('api-0'), running: false }), async () => { throw error; }));
  }
  await assert.rejects(captureNativeProbe(async () => response('api-0'),
    () => ({ actorId: actorId('api-0'), running: true }), async () => { throw new Error(noInstance); }));
  // A standard SDK-looking HTTP 503 after preparation must never gain startup
  // classification: it may be a proxy error or malformed actual application.
  for (const body of [noInstance, '<html>unavailable</html>', '{"ready":false}']) {
    dispatch.probe = async () => captureNativeProbe(async () => new Response(body, { status: 503 }),
      () => ({ actorId: actorId('api-0'), running: false }), async () => {});
    const failed = await handleRequest(request('/internal/runtime/api-0/ready'), env, dispatch);
    assert.equal(failed.status, 503);
    assert.notEqual((await failed.json() as {error:string}).error, 'container_starting');
  }
});

test('preparation deadline returns stopped proof before outer RPC deadline, without resetting the body deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let fetched = 0, aborted = false;
  const preparing = captureNativeProbe(async () => { fetched++; return response('api-0'); },
    () => ({ actorId: actorId('api-0'), running: false }),
    async signal => new Promise<void>((_, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }); }));
  t.mock.timers.tick(8999);
  assert.equal(aborted, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await preparing, { phase: 'starting', actorId: actorId('api-0'), running: false });
  assert.equal(aborted, true); assert.equal(fetched, 0);
  const live = captureNativeProbe(async () => response('api-0'),
    () => ({ actorId: actorId('api-0'), running: true }), async () => new Promise<void>(() => {}));
  const liveFailure = assert.rejects(live, /container_not_ready/);
  t.mock.timers.tick(9000); await liveFailure;
  let prepared!: () => void;
  const body = captureNativeProbe(async () => new Response(new ReadableStream({ start() {} })),
    () => ({ actorId: actorId('api-0'), running: false }), async () => new Promise<void>(resolve => { prepared = resolve; }));
  const bodyFailure = assert.rejects(body, /container_not_ready|body_read_timeout/);
  t.mock.timers.tick(8000); prepared(); await setImmediate();
  t.mock.timers.tick(1000); await bodyFailure;
});

test('aggregate waits for all targets and never hides wrong identity behind a startup proof', async () => {
  const dispatch = nativeDispatch(async target => response(target, { imageBuildId: 'e'.repeat(64) }));
  const real = dispatch.probe!;
  const seen: Target[] = [];
  dispatch.probe = async target => {
    seen.push(target);
    if (target === 'api-0') return { phase: 'starting', actorId: actorId(target), running: false };
    await setImmediate();
    return real(target);
  };
  assert.deepEqual(await (await handleRequest(request(), env, dispatch)).json(), { error: 'container_version_or_contract_mismatch' });
  assert.equal(seen.length, 3);
  for (const patch of [{ actorId: actorId('api-1') }, { running: true }, { status: 503 }, { body: new Uint8Array() }]) {
    dispatch.probe = async () => ({ phase: 'starting', actorId: actorId('api-0'), running: false, ...patch }) as NativeProbe;
    assert.deepEqual(await (await handleRequest(request('/internal/runtime/api-0/ready'), env, dispatch)).json(), { error: 'container_version_or_contract_mismatch' });
  }
});
