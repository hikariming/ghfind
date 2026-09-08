import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// Always a fresh workerd database. No remote bindings, no deployment, and no
// test-only SQL HTTP endpoint is added to the production capability surface.
if (!process.env.FEED_TEST_DATABASE_URL) throw new Error('FEED_TEST_DATABASE_URL is required; skipping is forbidden');
const dsn = new URL(process.env.FEED_TEST_DATABASE_URL);
if (!dsn.pathname.endsWith('_test') || !['127.0.0.1', 'localhost'].includes(dsn.hostname)) {
  throw new Error('Use a disposable local PostgreSQL database ending in _test');
}
const root = resolve(import.meta.dirname, '..');
const wrangler = join(root, 'platform/feed/node_modules/.bin/wrangler');
const config = join(root, 'platform/feed/wrangler.jsonc');
const temporary = await mkdtemp(join(tmpdir(), 'ghfind-crossprofile-'));
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error',
  FEED_BRIDGE_SECRET: randomBytes(32).toString('hex'), FEED_SOURCE_SECRET: randomBytes(32).toString('hex'),
  FEED_EXECUTOR_SECRET: randomBytes(32).toString('hex'), FEED_OPERATOR_SECRET: randomBytes(32).toString('hex'), FEED_DELIVERY_SECRET: randomBytes(32).toString('hex') };
const run = (binary, args, childEnv = env) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { cwd: root, env: childEnv, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${binary.split('/').at(-1)} exited ${code}`)));
});
let worker;
try {
  for (const database of ['ghfind-feed-isolated-placeholder', 'ghfind-feed-core-isolated-placeholder']) {
    await run(wrangler, ['d1', 'migrations', 'apply', database, '--local', '--persist-to', temporary, '--config', config]);
  }
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  worker = spawn(wrangler, ['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', temporary, '--config', config, '--log-level', 'error'], {
    cwd: root, env, stdio: 'inherit', detached: true,
  });
  let startupError;
  worker.once('error', error => { startupError = error; });
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startupError) throw startupError;
    if (worker.exitCode !== null) throw new Error('workerd exited before readiness');
    try {
      const response = await fetch(`${endpoint}/internal/feed/v1/health`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-feed-contract': '1', authorization: `Bearer ${env.FEED_BRIDGE_SECRET}` },
        body: '{}', signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).ready) { ready = true; break; }
    } catch { /* Finite startup grace, never an accepted test result. */ }
    await delay(250);
  }
  if (!ready) throw new Error('workerd failed readiness before the bounded deadline');
  await run('go', ['test', '-count=1', '-timeout=150s', '-v', './internal/backend', '-run', '^TestPortable(API|Archive)BothProfiles$'], {
    ...env, FEED_REQUIRE_CROSSPROFILE_TESTS: '1', FEED_TEST_BRIDGE_ENDPOINT: endpoint, FEED_TEST_BRIDGE_SECRET: env.FEED_BRIDGE_SECRET, FEED_TEST_EXECUTOR_SECRET: env.FEED_EXECUTOR_SECRET,
  });
} finally {
  if (worker && worker.exitCode === null) {
    try { process.kill(-worker.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await Promise.race([new Promise(resolve => worker.once('exit', resolve)), delay(3000)]);
    if (worker.exitCode === null) { try { process.kill(-worker.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  }
  await rm(temporary, { recursive: true, force: true });
}
