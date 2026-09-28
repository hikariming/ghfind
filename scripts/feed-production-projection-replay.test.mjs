import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, commandId, events, execute, intent, transport, validateProjection, validateSource, validateManifest, LIMITS, manifest } from './feed-production-projection-replay.mjs';
const sha = 'a'.repeat(40);
const context = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'hikariming/ghfind', GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'hikariming/ghfind/.github/workflows/feed-production-projection-replay.yml@refs/heads/main', RELEASE_SHA: sha, GITHUB_SHA: sha };
function source(e) { return [{ sequence: e.sourceVersion, event_id: e.eventId, aggregate_key: e.repoKey, source_hash: e.sourceHash, analysis_sha256: e.sourceHash, analysis_id: e.analysisId, receipt_id: e.receiptId, latest_analysis_id: e.analysisId, resolved_commit_sha: e.expectedResolvedCommitSHA, status: 'completed', outbox_status: 'delivered' }]; }
function job(e, status) { return [{ event_id: e.eventId, aggregate_key: e.repoKey, source_version: e.sourceVersion, analysis_id: e.analysisId, receipt_id: e.receiptId, source_hash: e.sourceHash, event_source_version: e.sourceVersion, envelope_event_id: e.eventId, contract_version: 1, event_kind: 'assessment.completed', status }]; }
function projection(e) { return [{ analysis_id: e.analysisId, version_analysis_id: e.analysisId, source_hash: 'd'.repeat(64), version_source_hash: 'd'.repeat(64), resolved_commit_sha: e.expectedResolvedCommitSHA, event_id: e.eventId, source_version: e.sourceVersion, receipt_id: e.receiptId, job_status: 'completed', job_repo: e.repoKey, job_source_version: e.sourceVersion, job_event_id: e.eventId, event_analysis_id: e.analysisId, event_source_hash: e.sourceHash, event_receipt_id: e.receiptId, event_source_version: e.sourceVersion, event_contract_version: 1, revoked_at: null, published: e.expectedPublished, blocked_reason: e.expectedBlockedReason, removed: 0 }]; }
function fixture({ complete = true, already = false, uncertain = false } = {}) {
  const states = new Map(events.map(e => [e.eventId, already ? 'completed' : 'dead_letter']));
  const writes = [], snapshots = [];
  const t = { identity: { releaseSHA: sha }, query: async (name, [id]) => {
    const e = events.find(e => e.eventId === id || e.repoKey === id || commandId(e) === id);
    if (name === 'source') return source(e);
    if (name === 'job') return job(e, states.get(e.eventId));
    if (name === 'command') return [];
    if (name === 'projection') return projection(e);
    throw Error('unexpected');
  }, admin: async (action, body) => {
    const e = events.find(e => e.eventId === body.id);
    if (action === 'replay') {
      assert.equal(snapshots.at(-1).events.at(-1).phase, 'replay_intent_persisted');
      writes.push(body); states.set(e.eventId, complete ? 'completed' : 'pending');
      if (uncertain) throw Error('transport_failed');
      return { ok: true };
    }
    return { job: { id: e.eventId, status: states.get(e.eventId) }, delivery: { deliveryId: commandId(e), status: 'published' }, terminalEvidence: null };
  } };
  return { t, writes, snapshots, persist: x => snapshots.push(structuredClone(x)) };
}
test('manual exact main only, no pull-request or old release context', () => {
  authorize(context);
  for (const patch of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/evil' }, { GITHUB_WORKFLOW_REF: 'other' }, { RELEASE_SHA: 'b'.repeat(40) }]) assert.throws(() => authorize({ ...context, ...patch }));
});
test('four stable command UUIDs independent of deployment SHA and unique', () => {
  assert.deepEqual(events.map(e => e.sourceVersion), [2,3,4,13]);
  const ids = events.map(commandId); assert.equal(new Set(ids).size, 4);
  for (const id of ids) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(intent(sha).events, intent('b'.repeat(40)).events);
});
test('source changes or critical project eligibility changes fail closed', () => {
  const e = events[2]; validateSource(source(e), e); validateProjection(projection(e), e);
  assert.throws(() => validateSource([{ ...source(e)[0], source_hash: 'b'.repeat(64) }], e));
  for (const patch of [{ published: 1 }, { blocked_reason: '' }, { revoked_at: 42 }, { source_version: 99 }, { event_receipt_id: 'different' }]) assert.throws(() => validateProjection([{ ...projection(e)[0], ...patch }], e));
});
test('serial four event replay persists intent before one write and verifies real completion', async () => {
  const f = fixture(); const result = await execute(f.t, f.persist);
  assert.equal(result.completed, true); assert.equal(f.writes.length, 4);
  assert.deepEqual(f.writes.map(w => w.commandId), events.map(commandId));
});
test('already completed event validates actual projection without replay', async () => {
  const f = fixture({ already: true }); await execute(f.t, f.persist); assert.equal(f.writes.length, 0);
});
test('unknown replay outcome stops immediately, no automatic retry or later event', async () => {
  const f = fixture({ uncertain: true }); await assert.rejects(execute(f.t, f.persist), /transport_failed/);
  assert.equal(f.writes.length, 1); assert.equal(f.snapshots.at(-1).events.length, 1);
  assert.equal(f.snapshots.at(-1).events[0].phase, 'failed_or_uncertain');
});
test('completion wait bounded and no second write after exhaustion', async () => {
  const f = fixture({ complete: false }); let sleeps = 0;
  await assert.rejects(execute(f.t, f.persist, { sleep: async () => { sleeps++; }, now: () => 1 }), /completion_budget_exhausted/);
  assert.equal(f.writes.length, 1); assert.equal(sleeps, LIMITS.polls - 1);
});
test('durable command on rerun is observed without another replay write', async () => {
  const f = fixture(); const original = f.t.query;
  f.t.query = async (name, args) => name === 'command' ? [{ id: args[0], kind: 'sourceEvent', target_id: events.find(e => commandId(e) === args[0]).eventId,
    operator: 'github-actions:reviewed-risk-contract-recovery', reason: 'Replay four reviewed assessment source events after risk contract compatibility fix; preserve critical risk exclusion.' }] : original(name, args);
  await assert.rejects(execute(f.t, f.persist), /replay_failed_or_generation_changed/);
  assert.equal(f.writes.length, 0);
});
test('origin mismatch never sends privileged runtime tokens', async () => {
  const calls = [];
  await assert.rejects(transport({ RELEASE_SHA: sha, CLOUDFLARE_API_TOKEN: 'c'.repeat(40), FEED_RUNTIME_ADMIN_SECRET: 'a'.repeat(40), FEED_OPERATOR_SECRET: 'o'.repeat(40) }, async (url, init) => {
    calls.push([url, init]); return new Response(JSON.stringify({ success: true, result: { subdomain: 'evil' } }));
  }), /runtime_origin_changed/);
  assert.equal(calls.length, 1); assert.match(calls[0][0], /^https:\/\/api.cloudflare.com\//);
  assert.equal(calls[0][1].headers.authorization, `Bearer ${'c'.repeat(40)}`);
  assert.equal(calls[0][1].redirect, 'error');
});
test('shared admin/operator key refused before network', async () => {
  await assert.rejects(transport({ CLOUDFLARE_API_TOKEN: 'c'.repeat(40), FEED_RUNTIME_ADMIN_SECRET: 'a'.repeat(40), FEED_OPERATOR_SECRET: 'a'.repeat(40) }, () => { throw Error('should not run'); }), /independent_credentials_required/);
});
test('HTTP success without explicit replay receipt stops as uncertain', async () => {
  const f = fixture(), original = f.t.admin;
  f.t.admin = async (action, body) => action === 'replay' ? {} : original(action, body);
  await assert.rejects(execute(f.t, f.persist), /replay_outcome_uncertain/);
});
test('superseded analysis cannot be replayed even if original run completed', () => {
  const e = events[0]; assert.throws(() => validateSource([{ ...source(e)[0], latest_analysis_id: 'new-analysis' }], e), /source_identity_changed/);
});
test('projection hash may differ from artifact hash but both stored projection hashes must agree', () => {
  const e = events[0], rows = projection(e); assert.notEqual(rows[0].source_hash, e.sourceHash);
  validateProjection(rows, e);
  assert.throws(() => validateProjection([{ ...rows[0], version_source_hash: e.sourceHash }], e));
});
test('database binding mismatch fails before any admin token reaches runtime', async () => {
  const env = { RELEASE_SHA: sha, CLOUDFLARE_API_TOKEN: 'c'.repeat(40), FEED_RUNTIME_ADMIN_SECRET: 'a'.repeat(40), FEED_OPERATOR_SECRET: 'o'.repeat(40) };
  const settings = { bindings: Object.entries({ FEED_ENVIRONMENT: 'production', FEED_MODE: 'baseline', FEED_RELEASE_SHA: sha, FEED_WRITER_EPOCH: '1', FEED_EXECUTOR_ENABLED: 'true', FEED_SOURCE_RELAY_ENABLED: 'true' }).map(([name,text]) => ({ name, text, type: 'plain_text' })) };
  settings.bindings.push({ name: 'FEED_ADAPTER', type: 'service', service: manifest.adapterWorker });
  let count = 0;
  await assert.rejects(transport(env, async url => {
    assert.match(url, /^https:\/\/api.cloudflare.com\//); count++;
    const result = url.endsWith('/subdomain') ? { subdomain: 'beiming1201' } : url.includes(manifest.runtimeWorker) ? settings : { bindings: [{ name: 'CORE_DB', type: 'd1', id: 'wrong' }] };
    return new Response(JSON.stringify({ success: true, result }));
  }), /database_binding_changed/);
  assert.equal(count, 3);
});

test('reviewed allowlist rejects extra events or modified risk expectations', () => {
  validateManifest();
  assert.throws(() => validateManifest([...events, events[0]]));
  assert.throws(() => validateManifest(events.map(e => ({ ...e, expectedPublished: 1 }))));
});
