/**
 * Real-GitHub local HTTP smoke test. Requires sqld and GITHUB_TOKEN (or gh login).
 * Usage: SQLD_BIN=/path/to/sqld node scripts/smoke-scan-local.mjs [login ...]
 * Uses a fresh localhost database, no Redis or LLM, and never production storage.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { createClient } from "@libsql/client/web";

const root = resolve(import.meta.dirname, "..");
for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
  assert(!existsSync(join(root, name)), `Refusing auto-loaded environment file: ${name}`);
}
assert(process.env.SQLD_BIN, "Set SQLD_BIN to the local sqld executable");
const token = process.env.GITHUB_TOKEN || execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
assert(token, "GitHub token required");
const out = mkdtempSync(join(tmpdir(), "ghfind-scan-local-"));
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
  const dbPort = await freePort(); const appPort = await freePort();
  const db = `http://127.0.0.1:${dbPort}`; const base = `http://127.0.0.1:${appPort}`;
  const sqld = start(process.env.SQLD_BIN, ["--db-path", join(out, "db"), "--http-listen-addr", `127.0.0.1:${dbPort}`], env, "sqld");
  await ready(db, sqld);
  const app = start(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    // instrumentation.ts skips its remote Cloudflare initializer under CI.
    ...env, CI: "true", NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", TURSO_DATABASE_URL: db,
    AUTH_SECRET: randomBytes(32).toString("hex"), GITHUB_TOKEN: token,
    NODE_OPTIONS: `--require=${tracePath}`,
  }, "next");
  await ready(`${base}/api/scan`, app);
  const users = process.argv.slice(2);
  for (const username of users.length ? users : ["Cyrene2008", "suzuki-shunsuke", "samzong"]) {
    const started = Date.now();
    const row = { username, startedAt: new Date().toISOString(), passed: false };
    try {
      const response = await fetch(`${base}/api/scan?force=1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }), signal: AbortSignal.timeout(240_000) });
      const scan = await response.json();
      row.scanStatus = response.status; row.scanMs = Date.now() - started;
      row.error = scan.error; row.coverage = scan.coverage; row.score = scan.scoring?.final_score;
      row.unknownClosed = scan.metrics?.unknown_closed_unmerged_pr_count;
      assert.equal(response.status, 200, `scan: ${scan.error}`);
      assert.equal(scan.coverage, "quick"); assert(!scan.legacy_read_fallback); assert.equal(scan.cached, false);
      const scoreResponse = await fetch(`${base}/api/score/${username}`, { signal: AbortSignal.timeout(15_000) });
      const score = await scoreResponse.json();
      row.scoreStatus = scoreResponse.status; row.scoreSource = score.source;
      assert.equal(scoreResponse.status, 200); assert.equal(score.source, "indexed");
      assert.equal(score.stale, false); assert.equal(score.final_score, scan.scoring.final_score);
      const localDb = createClient({ url: db });
      try {
        const persisted = await localDb.execute({ sql: "SELECT score_source_collection_version, score_source_snapshot_hash FROM scores WHERE username = ?", args: [username.toLowerCase()] });
        assert.equal(persisted.rows.length, 1);
        row.collectionVersion = persisted.rows[0].score_source_collection_version;
        assert(persisted.rows[0].score_source_snapshot_hash);
        const runs = await localDb.execute({ sql: "SELECT COUNT(*) AS n FROM public_scan_runs WHERE username = ? AND state = 'complete_public' AND collection_version = ?", args: [username.toLowerCase(), row.collectionVersion] });
        row.completeLocalRuns = Number(runs.rows[0].n);
        assert(row.completeLocalRuns > 0);
      } finally { localDb.close(); }
      const roastResponse = await fetch(`${base}/api/roast`, { method: "POST", headers: { "content-type": "application/json", cookie: (response.headers.get("set-cookie") || "").split(";")[0] }, body: JSON.stringify({ username, lang: "en" }), signal: AbortSignal.timeout(15_000) });
      const roast = await roastResponse.json();
      row.roastStatus = roastResponse.status; row.roastError = roast.error;
      // This sentinel occurs only after canonical snapshot + score identity validation.
      // No model is configured intentionally: no paid inference or production writes.
      assert.equal(roast.error, "no_llm_configured");
      row.passed = true;
    } catch (error) { row.elapsedMs = Date.now() - started; row.failure = String(error); process.exitCode = 1; }
    results.push(row); console.log(JSON.stringify(row));
    writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
    // A timed-out HTTP client does not cancel the server's collector. End the
    // server before any next case so pending work cannot overlap another scan.
    if (!row.passed) break;
  }
} finally {
  for (const child of children.reverse()) child.kill("SIGTERM");
  console.log(`Local artifacts: ${out}`);
}
