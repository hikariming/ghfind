import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captureProductionApplications } from './feed-platform-production.mjs';

const manifest = JSON.parse(readFileSync(new URL('../ops/feed-production-manifest.json', import.meta.url)));
const image = `registry.cloudflare.com/${manifest.accountId}/ghfind-feed@sha256:${'a'.repeat(64)}`;
const names = ['feedapi', 'feedexecutor'].map(suffix => `${manifest.runtimeWorker}-${suffix}`);
const ids = ['a03bde57-2e65-4185-a0ac-d95e13941703', 'a03818ef-42c6-48e4-8dd9-70225e7f6702'];
function setup(change = {}) {
  const listing = names.map((name, i) => ({ id: ids[i], name, version: 7, image: 'stale-dashboard-image', state: 'degraded' }));
  const details = names.map((name, i) => ({ id: ids[i], name, version: 8, configuration: { image, env: { MUST_NOT_COPY: 'fixture-private-value' } }, health: { instances: { active: 0 } } }));
  const calls = [];
  const metadata = async (args, { signal }) => {
    assert.ok(signal instanceof AbortSignal);
    calls.push(args);
    if (args[1] === 'list') return Object.hasOwn(change, 'listing') ? change.listing : listing;
    assert.equal(args[1], 'info');
    const i = ids.indexOf(args[2]);
    assert.ok(i >= 0);
    return change.detail ? change.detail(structuredClone(details[i]), i) : details[i];
  };
  return { metadata, calls, listing, details };
}

test('predeployment snapshot uses direct identities despite stale dashboard versions and health', async () => {
  const f = setup();
  const result = await captureProductionApplications(manifest, f);
  assert.deepEqual(result, names.map((name, i) => ({ id: ids[i], name, version: 8, image })));
  assert.equal(f.calls.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /MUST_NOT_COPY|fixture-private|health|stale/);
});

test('first install has no old-image permission and reads no nonexistent application', async () => {
  const f = setup({ listing: [{ id: 'unrelated', name: 'another-project' }] });
  assert.deepEqual(await captureProductionApplications(manifest, f), []);
  assert.equal(f.calls.length, 1);
});

test('ambiguous or invalid discovery fails before detail requests', async () => {
  const initial = setup();
  for (const listing of [null, {}, [...initial.listing, initial.listing[0]], [{ name: names[0], id: '../bad' }], initial.listing.map(a => ({ ...a, id: ids[0] }))]) {
    const f = setup({ listing });
    await assert.rejects(captureProductionApplications(manifest, f));
    assert.equal(f.calls.length, 1);
  }
});

test('changed direct identity, invalid version or unpinned image cannot become a prior anchor', async () => {
  for (const detail of [a => ({ ...a, id: ids[1] }), a => ({ ...a, name: 'unowned' }), a => ({ ...a, version: null }), a => ({ ...a, configuration: { image: 'some-registry/image:latest' } })]) {
    await assert.rejects(captureProductionApplications(manifest, setup({ detail })));
  }
});

test('a direct-read failure is terminal and never falls back to dashboard identity', async () => {
  const f = setup();
  const metadata = async (args, options) => {
    if (args[1] === 'info') throw new Error('fixture metadata unavailable');
    return f.metadata(args, options);
  };
  await assert.rejects(captureProductionApplications(manifest, { metadata }), /metadata unavailable/);
});
