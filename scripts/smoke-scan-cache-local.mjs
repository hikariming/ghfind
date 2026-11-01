/**
 * Real-GitHub local HTTP smoke test. Requires sqld and GITHUB_TOKEN (or gh login).
 * Usage: SQLD_BIN=/path/to/sqld node scripts/smoke-scan-cache-local.mjs [login]
 * Uses isolated Docker Redis through a local REST bridge and localhost libSQL.
 * Requires Docker and redis:7-alpine. No production storage or LLM.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync, execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@libsql/client/web";

const root = resolve(import.meta.dirname, "..");
for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
  assert(!existsSync(join(root, name)), `Refusing auto-loaded environment file: ${name}`);
}
assert(process.env.SQLD_BIN, "Set SQLD_BIN to the local sqld executable");
const token = process.env.GITHUB_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
assert(token, "GitHub token required");
const out = mkdtempSync(join(tmpdir(), "ghfind-cache-local-"));
const sourcePaths = ["src/lib/github.ts", "src/lib/scan-core.ts", "src/app/api/scan/route.ts", "src/app/api/score/[username]/route.ts", "src/app/api/roast/route.ts", "src/lib/db.ts", "src/lib/redis.ts", "src/lib/scan-protection.ts"];
const fingerprints = () => Object.fromEntries(sourcePaths.map((path) => [path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")]));
const source = { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), startedAt: new Date().toISOString(), fingerprints: fingerprints() };
writeFileSync(join(out, "source.json"), JSON.stringify(source, null, 2), { mode: 0o600 });
const tracePath = join(out, "trace.cjs");
writeFileSync(tracePath, `
const original = globalThis.fetch;
const trace = ${process.env.SCAN_TRACE === "1"} ? console.log : () => {};
globalThis.fetch = async function(input, options) {
  const url = new URL(typeof input === 'string' ? input : input.url || input);
  if (!['api.github.com', 'raw.githubusercontent.com', '127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Unexpected local E2E outbound host');
  const started = Date.now();
  let category = url.hostname === 'api.github.com' ? (url.pathname === '/graphql' ? 'graphql' : 'rest') : url.hostname === 'raw.githubusercontent.com' ? 'raw-readme' : 'local-storage';
  if (category === 'graphql' && typeof options?.body === 'string') {
    try { const query = JSON.parse(options.body).query || ''; category += ':' + ['closedPRs','contributionsCollection','contributions','search','repository','pullRequests'].filter(x => query.includes(x)).join(','); } catch {}
  }
  trace('[github-e2e-start]', category);
  try { const response = await original.apply(this, arguments); trace('[github-e2e-end]', category, response.status, Date.now() - started); return response; }
  catch (error) { trace('[github-e2e-error]', category, error.name, Date.now() - started); throw error; }
};
`, { mode: 0o600 });
const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const children = [];
const results = [];
const container = `ghfind-cache-e2e-${randomBytes(6).toString("hex")}`;
const restToken = randomBytes(24).toString("hex");
const commands = [];
const execute = promisify(execFile);
async function redisCommand(command) {
  const { stdout } = await execute("docker", ["exec", container, "redis-cli", "--json", ...command.map(String)], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}
function encode(value) {
  if (Array.isArray(value)) return value.map(encode);
  return typeof value === "string" && value !== "OK" ? Buffer.from(value).toString("base64") : value;
}
const bridge = createHttpServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${restToken}`) { res.writeHead(401).end(); return; }
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    const batch = req.url === "/pipeline" || req.url === "/multi-exec";
    // The tested SDK uses pipeline and individual commands; fail closed for transactions.
    assert(req.url !== "/multi-exec", "Transaction REST emulation is not implemented");
    const output = [];
    for (const command of batch ? payload : [payload]) {
      commands.push({ command: String(command[0]).toUpperCase(), key: String(command[1] || "").slice(0, 160) });
      const result = await redisCommand(command);
      output.push({ result: req.headers["upstash-encoding"] === "base64" ? encode(result) : result });
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(batch ? output : output[0]));
  } catch (error) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error) })); }
});
const freePort = () => new Promise((done, reject) => {
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => done(port)); });
});
function start(command, args, childEnv, name) {
  const log = createWriteStream(join(out, `${name}.log`), { mode: 0o600 });
  const child = spawn(command, args, { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  children.push(child);
  return child;
}
async function ready(url, child) {
  for (let i = 0; i < 120; i++) {
    assert(child.exitCode === null, `Server exited; inspect ${out}`);
    try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return; } catch { /* startup */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server startup timed out: ${url}`);
}
try {
  execFileSync("docker", ["run", "--rm", "-d", "--name", container, "redis:7-alpine"], { stdio: "ignore" });
  assert.equal(await redisCommand(["PING"]), "PONG");
  await new Promise((done) => bridge.listen(0, "127.0.0.1", done));
  const rest = `http://127.0.0.1:${bridge.address().port}`;
  const dbPort = await freePort(); const appPort = await freePort();
  const db = `http://127.0.0.1:${dbPort}`; const base = `http://127.0.0.1:${appPort}`;
  const sqld = start(process.env.SQLD_BIN, ["--db-path", join(out, "db"), "--http-listen-addr", `127.0.0.1:${dbPort}`], env, "sqld");
  await ready(db, sqld);
  const app = start(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    // instrumentation.ts skips its remote Cloudflare initializer under CI.
    ...env, CI: "true", NODE_ENV: "development", ENABLE_DEV_GENERATED_CACHE: "1", NEXT_TELEMETRY_DISABLED: "1", TURSO_DATABASE_URL: db,
    UPSTASH_REDIS_REST_URL: rest, UPSTASH_REDIS_REST_TOKEN: restToken,
    AUTH_SECRET: randomBytes(32).toString("hex"), GITHUB_TOKEN: token,
    NODE_OPTIONS: `--require=${tracePath}`,
  }, "next");
  await ready(`${base}/api/scan`, app);
  const username = process.argv[2] || "sandeep780049";
  const localDb = createClient({ url: db });
  async function scan(force) {
    const response = await fetch(`${base}/api/scan${force ? "?force=1" : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }), signal: AbortSignal.timeout(240_000) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert(!body.legacy_read_fallback); return body;
  }
  async function detail() {
    const response = await fetch(`${base}/api/score/${username}`);
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.source, "indexed"); assert.equal(body.stale, false); return body;
  }
  async function canonical() {
    const result = await localDb.execute({ sql: "SELECT scanned_at, final_score FROM scores WHERE username = ?", args: [username.toLowerCase()] });
    assert.equal(result.rows.length, 1); return result.rows[0];
  }
  async function runs() {
    const result = await localDb.execute({ sql: "SELECT COUNT(*) AS n FROM public_scan_runs WHERE username = ? AND state = 'complete_public'", args: [username.toLowerCase()] });
    return Number(result.rows[0].n);
  }
  try {
    const first = await scan(false); assert.equal(first.cached, false);
    const before = await detail(); const beforeDb = await canonical(); const beforeRuns = await runs();
    const scanKeys = await redisCommand(["KEYS", `scan:*:${username.toLowerCase()}`]);
    const detailKeys = await redisCommand(["KEYS", `score-detail:*:${username.toLowerCase()}:generation:*`]);
    assert.equal(scanKeys.length, 1, "Real scan cache was not populated");
    assert.equal(detailKeys.length, 1, "Real score-detail cache was not populated");
    assert(Number(await redisCommand(["TTL", scanKeys[0]])) > 0);
    const cached = await scan(false); assert.equal(cached.cached, true);
    assert.equal(await runs(), beforeRuns, "Cache-hit scan unexpectedly recollected");
    const cachedDetail = await detail(); assert.equal(cachedDetail.scanned_at, before.scanned_at);
    const started = Date.now();
    const forced = await scan(true); assert.equal(forced.cached, false);
    const after = await detail(); const afterDb = await canonical(); const afterRuns = await runs();
    assert(Number(afterDb.scanned_at) > Number(beforeDb.scanned_at), "Forced scan did not publish a fresh timestamp");
    assert(afterRuns > beforeRuns, "Forced scan did not persist a new completed run");
    assert.equal(Number(after.scanned_at), Number(afterDb.scanned_at), "Immediate score read served stale cache");
    assert.equal(after.final_score, forced.scoring.final_score);
    assert.equal(Number(afterDb.final_score), forced.scoring.final_score);
    const generations = await redisCommand(["KEYS", `score-detail:*:${username.toLowerCase()}:generation:*`]);
    assert(generations.length >= 2, "Publication did not advance cache generation");
    assert(commands.some(x => x.command === "EVAL" || x.command === "EVALSHA"), "Real Redis Lua paths were not exercised");
    const row = { username, passed: true, beforeScannedAt: beforeDb.scanned_at, afterScannedAt: afterDb.scanned_at, beforeRuns, afterRuns, forceMs: Date.now() - started, score: after.final_score, cacheGenerations: generations.length, redisCommands: commands.length };
    results.push(row); console.log(JSON.stringify(row));
    writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
  } finally { localDb.close(); }
  assert.deepEqual(fingerprints(), source.fingerprints, "Runtime source changed during E2E; rerun against stable source");
} finally {
  for (const child of children.reverse()) child.kill("SIGTERM");
  bridge.closeAllConnections(); bridge.close();
  try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); } catch { /* already stopped */ }
  writeFileSync(join(out, "redis-commands.json"), JSON.stringify(commands, null, 2), { mode: 0o600 });
  console.log(`Local artifacts: ${out}`);
}
