/** Test-process-only composition. None of these controls are imported by production. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import next from 'next';
import { installProviders } from './provider-fixtures.mjs';
import { relayOnce } from '../../platform/runtime/src/relay';
import type { RuntimeSettings } from '../../platform/runtime/src/router';
import { consumeBatch } from '../../platform/runtime/src/consumer';

const root = resolve(import.meta.dirname, '../..');
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(config.format, 'ghfind-local-e2e-config-v1');
assert.match(config.owner, /^[0-9a-f-]{36}$/);
assert(['cf_d1_r2', 'postgres'].includes(config.profile));
const own = createRequire(join(root, 'platform/feed/package.json'));
const wranglerRequire = createRequire(own.resolve('wrangler'));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const { splitSqlQuery } = own('wrangler');
const bundle = join(config.directory, 'adapter.mjs');
await build({ entryPoints: [join(root, 'platform/feed/src/index.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: bundle, external: ['cloudflare:*', 'node:*'] });
const secrets = Object.fromEntries(['FEED_BRIDGE_SECRET', 'FEED_SOURCE_SECRET', 'FEED_EXECUTOR_SECRET', 'FEED_OPERATOR_SECRET', 'FEED_DELIVERY_SECRET'].map(key => [key, process.env[key]]));
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: bundle, compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], host: '127.0.0.1', port: config.adapterPort,
  bindings: { ...secrets, FEED_SEMANTIC_STATE: 'disabled' }, d1Databases: { CORE_DB: 'e2e-core', FEED_DB: 'e2e-feed' }, r2Buckets: ['FEED_ARCHIVE'],
  d1Persist: join(config.directory, 'd1'), r2Persist: join(config.directory, 'r2') }));
await mf.ready;
const core = await mf.getD1Database('CORE_DB');
const feed = await mf.getD1Database('FEED_DB');
const migrationReport: Record<string, string[]> = {};
for (const [key, db, folder] of [['core', core, 'migrations'], ['feed', feed, 'migrations-feed']] as const) {
  const names = (await readdir(join(root, folder))).filter(name => name.endsWith('.sql')).sort();
  for (const name of names) {
    const statements = splitSqlQuery(await readFile(join(root, folder, name), 'utf8'));
    if (statements.length) await db.batch(statements.map((sql: string) => db.prepare(sql)));
  }
  migrationReport[key] = names;
}
// The actual workerd proxy implements D1. This is the same OpenNext runtime
// context symbol used by its production Worker and documented dev initializer.
(globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for('__cloudflare-context__')] = { env: { GHFIND_D1: core, GHFIND_FEED_D1: feed }, ctx: { waitUntil: (p: Promise<unknown>) => p.catch(() => {}) }, cf: {} };
const providers = installProviders();
const app = next({ dev: true, dir: root, hostname: '127.0.0.1', port: config.webPort });
await app.prepare();
const handler = app.getRequestHandler();
const web = createServer((req, res) => handler(req, res));
await new Promise<void>((done, reject) => { web.once('error', reject); web.listen(config.webPort, '127.0.0.1', done); });
const queueDirectory = join(config.directory, 'queue');
await mkdir(queueDirectory, { mode: 0o700 });
let published = 0, acknowledged = 0, redelivered = 0;
const settings = {
  ...process.env, FEED_ENVIRONMENT: 'staging', FEED_RELEASE_SHA: config.sourceSha,
  // The production relay validates shape; local transport does not use/push a registry image.
  FEED_IMAGE_REFERENCE: 'registry.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/ghfind-feed@sha256:' + config.sourceTree.padEnd(64, '1'),
  FEED_MODE: 'baseline', FEED_WRITER_EPOCH: '1', FEED_EXECUTOR_ENABLED: 'true', FEED_SOURCE_RELAY_ENABLED: 'true',
  FEED_QUEUE_NAME: 'ghfind-feed-staging-jobs', FEED_DLQ_NAME: 'ghfind-feed-staging-dlq', WORKER_VERSION: { id: config.owner },
} as unknown as RuntimeSettings;
const adapter = (request: Request) => {
  const url = new URL(request.url);
  return fetch(`http://127.0.0.1:${config.adapterPort}${url.pathname}${url.search}`, request);
};
const dispatch = {
  fetch: async (_target: string, request: Request) => fetch(`http://127.0.0.1:${config.executorPort}${new URL(request.url).pathname}`, request),
  stop: async () => { throw new Error('local_stop_not_part_of_queue_transport'); },
};
async function persist(name: string, data: unknown) {
  const path = join(queueDirectory, name), temp = path + '.tmp';
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(data)); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
  const directory = await open(queueDirectory, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function drain() {
  const summary = await relayOnce(settings, { source: adapter, send: async (messages) => {
    for (const message of messages) { await persist(`${randomUUID()}.json`, { body: message, attempts: 0 }); published++; }
  } });
  assert.equal(summary.retried, 0);
  assert.equal(summary.leaseConflicts, 0);
  // Read each delivery back from disk. No in-memory job payload is authoritative.
  const files = (await readdir(queueDirectory)).filter(name => name.endsWith('.json')).sort();
  assert(files.length <= 100);
  for (const name of files) {
    const path = join(queueDirectory, name);
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.attempts++;
    let ack = false, retry = false;
    await consumeBatch({ queue: settings.FEED_QUEUE_NAME, messages: [{ body: data.body, id: name.slice(0, -5), attempts: data.attempts,
      ack: () => { ack = true; }, retry: () => { retry = true; } }] }, settings, dispatch, adapter, (entry, failed) => { if (failed) console.error(JSON.stringify(entry)); });
    assert(ack && !retry, 'real executor must durably complete before acknowledgement');
    // Deliberate ack loss: repeat the same persisted delivery against its durable
    // completed job. The real executor must report a duplicate, then acknowledge.
    if (ack && !data.redeliveryVerified) {
      let duplicateAck = false;
      await consumeBatch({ queue: settings.FEED_QUEUE_NAME, messages: [{ body: data.body, id: name.slice(0, -5), attempts: 2,
        ack: () => { duplicateAck = true; }, retry: () => {} }] }, settings, dispatch, adapter, () => {});
      assert(duplicateAck, 'ack-loss redelivery failed'); redelivered++;
    }
    await unlink(path); acknowledged++;
  }
  return { published, acknowledged, redelivered, pending: (await readdir(queueDirectory)).length };
}
async function inspect() {
  const facts = await core.prepare("SELECT (SELECT count(*) FROM project_analysis_runs WHERE status='completed') AS completed,(SELECT count(*) FROM project_assessments) AS assessments,(SELECT count(*) FROM feed_submission_receipts) AS receipts,(SELECT count(*) FROM feed_source_outbox WHERE status='delivered') AS delivered,(SELECT count(*) FROM feed_source_outbox) AS outbox").first();
  return { providers, source: facts, queue: { published, acknowledged, redelivered, pending: (await readdir(queueDirectory)).length }, migrations: migrationReport };
}
let controlBusy = false;
const control = createServer(async (req, res) => {
  try {
    assert(req.headers.authorization === `Bearer ${config.owner}`);
    assert(req.method === 'POST');
    assert(!controlBusy, 'one test control command at a time');
    controlBusy = true;
    const result = req.url === '/drain' ? await drain() : req.url === '/inspect' ? await inspect() : null;
    assert(result, 'unknown local control operation');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  } catch (error) {
    console.error(error); res.writeHead(500); res.end('{"error":"local_e2e_control_failed"}');
  } finally { controlBusy = false; }
});
await new Promise<void>((done, reject) => { control.once('error', reject); control.listen(config.controlPort, '127.0.0.1', done); });
await writeFile(join(config.directory, 'server-ready.json'), JSON.stringify({ sourceSha: config.sourceSha, sourceTree: config.sourceTree, migrations: migrationReport }) + '\n', { mode: 0o600 });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  control.closeAllConnections(); control.close(); web.closeAllConnections(); web.close();
  await app.close(); await mf.dispose(); process.exit(0);
}
process.on('SIGTERM', close); process.on('SIGINT', close);
