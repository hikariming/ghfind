// Run from the repository root:
// pnpm exec tsx platform/github-app/scripts/dev-dashboard.mts
// Fixture accounts: --installations=0|1|2 (default 1 preserves the original fixture).
// Optional real Jev decisions: add --jev (reads JEV_CREDENTIAL_FILE in process).
// Everything else stays synthetic and local. No Wrangler config is loaded.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seal } from "../src/secrets.ts";
import { JEV_REQUEST_VERSION } from "../src/jev.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--jev" && !/^--installations=[012]$/.test(arg)) || args.filter(arg => arg.startsWith("--installations=")).length > 1)
    throw new Error("Usage: dev-dashboard.mts [--installations=0|1|2] [--jev]");
  const installationCount = Number(args.find(arg => arg.startsWith("--installations="))?.split("=")[1] ?? "1");
  const liveJev = args.includes("--jev");
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // These dependencies are already pinned by this Worker's installed Wrangler.
  const require = createRequire(await realpath(join(appRoot, "node_modules/wrangler/package.json")));
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require("miniflare");
  const { build } = require("esbuild");
  const { unstable_splitSqlQuery } = require("wrangler");
  const origin = "http://127.0.0.1:4201";
  const sessionId = randomUUID();
  const userToken = "local-dashboard-fixture-user-token";
  const secret = randomBytes(32).toString("hex");
  const byokSecret = randomBytes(32).toString("base64url");
  const now = Date.now();
  const jevEndpoint = "https://openrouter.ai/api/alpha/decisions";
  let openrouterKey = "";
  if (liveJev) {
    const credential = process.env.JEV_CREDENTIAL_FILE || join(process.env.HOME || "", ".config/ghfind/.env.openrouter");
    const mode = (await stat(credential)).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error("Jev credential file must be private (chmod 600)");
    const value = (await readFile(credential, "utf8")).match(/^OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/m)?.[1];
    openrouterKey = value?.replace(/^(["'])(.*)\1$/, "$2") || "";
    if (!openrouterKey) throw new Error("Missing local OpenRouter credential");
  }
  const primaryRepositories = [
    { id: 100, full_name: "sample/maintainer-dashboard", permissions: { admin: true, push: true, pull: true } },
    { id: 200, full_name: "sample/platform-sdk", permissions: { admin: false, push: true, pull: true } },
    { id: 300, full_name: "sample/community-docs", permissions: { admin: true, push: true, pull: true } },
  ];
  const secondaryRepositories = [{ id: 400, full_name: "harbor/service-api", permissions: { admin: true, push: true, pull: true } }];
  const installations = [{ id: 10, account: { login: "sample", type: "Organization" } },
    { id: 20, account: { login: "harbor", type: "Organization" } }].slice(0, installationCount);
  const repositories = installationCount === 0 ? [] : primaryRepositories;
  const accessibleRepositories = [...repositories, ...(installationCount === 2 ? secondaryRepositories : [])];
  const labels = [
    { name: "bug", color: "d73a4a", description: "A reproducible defect or unexpected behavior" },
    { name: "enhancement", color: "a2eeef", description: "A feature request or product improvement" },
    { name: "documentation", color: "0075ca", description: "Documentation corrections and examples" },
    { name: "question", color: "d876e3", description: "A request for help or clarification" },
    { name: "help wanted", color: "008672", description: "Maintainers would welcome a contribution" },
    { name: "review: high", color: "c6e48b", description: "Reserved bot score label" },
  ];
  const fixtureIssue = { number: 42, title: "CLI crashes when the configuration file is missing",
    body: "Running ghfind without a configuration file exits with an unhandled error. Expected: a clear setup instruction. Reproduction: remove the config file and run ghfind status.",
    state: "open", user: { id: 1, login: "octo-admin", type: "User" }, labels: [],
    html_url: "https://github.com/sample/maintainer-dashboard/issues/42" };
  let decisionCalls = 0;
  let githubWriteAttempts = 0;
  let lastDecision: { status: number; latencyMs: number; requestVersion: string; requestSha256: string; model?: string; usage?: { inputTokens: number; outputTokens: number; cost?: number } } | null = null;
  const outbound = async (request: Request) => {
    const url = new URL(request.url);
    // Only the explicit live preview may query the fixed public DoH service,
    // and only for the real provider used in this fixture. Never forward auth.
    if (liveJev && url.origin === "https://cloudflare-dns.com" && url.pathname === "/dns-query" &&
      url.searchParams.get("name") === "openrouter.ai" && ["1", "28"].includes(url.searchParams.get("type") || "") && request.method === "GET")
      return fetch(url.href, { headers: { Accept: "application/dns-json" }, redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (liveJev && request.url === jevEndpoint && request.method === "POST") {
      if (request.headers.get("authorization") !== `Bearer ${openrouterKey}`)
        return Response.json({ error: "Unexpected model credential" }, { status: 403 });
      decisionCalls++;
      // Real provider response, including non-2xx errors. Never return synthetic
      // probabilities or pretend an unavailable classifier succeeded.
      const start = performance.now();
      const decisionBody = await request.arrayBuffer();
      const requestSha256 = createHash("sha256").update(Buffer.from(decisionBody)).digest("hex");
      // Preserve the production protocol without Miniflare bridge transport
      // headers such as Host/content-length (verified by Worker live E2E).
      const result = await fetch(request.url, { method: "POST", headers: {
        authorization: `Bearer ${openrouterKey}`, "content-type": "application/json",
        accept: "application/json", "user-agent": "ghfind-review",
      }, body: decisionBody, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      lastDecision = { status: result.status, latencyMs: Math.round(performance.now() - start), requestVersion: JEV_REQUEST_VERSION, requestSha256 };
      if (result.ok) {
        // Store only approved non-content provider metadata. Never expose auth,
        // request text, provider error bodies, or response headers through health.
        const metadata = await result.clone().json().catch(() => null) as Record<string, unknown> | null;
        if (metadata && typeof metadata.model === "string" && /^typesafe\/jev-1\.13(?:-\d{8})?$/.test(metadata.model)) lastDecision.model = metadata.model;
        const usage = metadata?.usage as Record<string, unknown> | undefined;
        const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
        if (usage && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens) && nonnegative(usage.input_tokens) && nonnegative(usage.output_tokens)) lastDecision.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, ...(nonnegative(usage.cost) ? { cost: usage.cost } : {}) };
      }
      return result;
    }
    if (url.origin !== "https://api.github.com")
      return Response.json({ error: "Preview blocks this outbound endpoint" }, { status: 502 });
    if (request.method !== "GET") githubWriteAttempts++;
    const path = url.pathname;
    if (request.method === "GET" && request.headers.get("authorization") === `Bearer ${userToken}`) {
      if (path === "/user") return Response.json({ id: 1, login: "octo-admin" });
      if (path === "/user/installations") {
        if (url.searchParams.get("per_page") !== "100" || url.searchParams.get("page") !== "1")
          return Response.json({ error: "Unexpected installation pagination" }, { status: 502 });
        return Response.json({ total_count: installations.length, installations });
      }
      const installationMatch = /^\/user\/installations\/(10|20)\/repositories$/.exec(path);
      if (installationMatch && installations.some(item => item.id === Number(installationMatch[1]))) {
        if (url.searchParams.get("per_page") !== "100" || url.searchParams.get("page") !== "1")
          return Response.json({ error: "Unexpected repository pagination" }, { status: 502 });
        const scoped = installationMatch[1] === "10" ? repositories : secondaryRepositories;
        return Response.json({ total_count: scoped.length, repositories: scoped });
      }
      for (const repo of accessibleRepositories) {
        if (path === `/repos/${repo.full_name}`) return Response.json(repo);
        if (path === `/repos/${repo.full_name}/labels`) {
          if (url.searchParams.get("per_page") !== "100" || url.searchParams.get("page") !== "1")
            return Response.json({ error: "Unexpected label pagination" }, { status: 502 });
          return Response.json(labels);
        }
        if (path === `/repos/${repo.full_name}/issues/42`) return Response.json(fixtureIssue);
      }
    }
    // No OAuth exchange, installation-token issuance, or GitHub write is allowed.
    return Response.json({ error: "Preview GitHub fixture rejected this request" }, { status: 404 });
  };

  const directory = await mkdtemp(join(tmpdir(), "ghfind-dashboard-"));
  console.log("Building the actual dashboard Worker for an isolated local preview...");
  await build({ entryPoints: [join(appRoot, "src/index.ts")], outfile: join(directory, "index.mjs"),
    bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["node:*"], sourcemap: false });
  const workerSource = await readFile(join(directory, "index.mjs"), "utf8");
  const builtAt = new Date().toISOString();
  const bundleSha256 = createHash("sha256").update(workerSource).digest("hex");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const mf = new Miniflare(convertV4MiniflareOptions({
    // Miniflare 5 alpha's scriptPath module loader fails on this compiled module;
    // supplying the identical esbuild output as module text boots correctly.
    name: "ghfind-dashboard-fixture", modules: true, script: workerSource,
    compatibilityDate: "2026-09-10", compatibilityFlags: ["nodejs_compat"],
    host: "127.0.0.1", port: 0,
    log: new Log(LogLevel.ERROR), cf: false, d1Databases: { DB: "local-dashboard-only" }, d1Persist: false,
    queueProducers: { JOBS: "local-dashboard-jobs", DEAD: "local-dashboard-dead" },
    // Queues remain local and unconsumed: forms execute real admission and SQL;
    // background processing never calls real GitHub, email or scoring services.
    outboundService: outbound,
    serviceBindings: {
      ASSETS: async (request: Request) => {
        const path = new URL(request.url).pathname;
        const file = path === "/avatar.png" ? "avatar.png" : path === "/fonts/dm-sans-variable.ttf" ? "fonts/dm-sans-variable.ttf" : null;
        if (!file) return new Response("Not found", { status: 404 });
        return new Response(await readFile(join(appRoot, "assets", file)), { headers: { "content-type": file.endsWith(".png") ? "image/png" : "font/ttf" } });
      },
      SCORE: async () => Response.json({ error: "Live scoring is disabled in the preview" }, { status: 503 }),
    },
    bindings: {
      APP_ID: "123", APP_SLUG: "ghfind-review", APP_CLIENT_ID: "local-fixture-client", APP_CLIENT_SECRET: "local-fixture-secret",
      APP_PRIVATE_KEY: privateKey, WEBHOOK_SECRET: "local-fixture-webhook", SESSION_SECRET: secret,
      BYOK_ENCRYPTION_KEY: byokSecret,
      ENABLED: "true", EMAIL_ENABLED: "false", EMAIL_FROM: "preview@example.invalid", ALLOWED_ACCOUNTS: installationCount === 2 ? "sample,harbor" : "sample",
      LLM_BASE_URL: "", LLM_MODEL: "", TRIAGE_PROVIDER: liveJev ? "jev" : "llm", OPENROUTER_API_KEY: openrouterKey,
      JEV_MODEL: "typesafe/jev-1.13", JEV_THRESHOLD: "0.8",
    },
  }));
  await mf.ready;
  console.log("Local Worker runtime ready; applying actual D1 migrations...");
  const db = await mf.getD1Database("DB");
  const migrations = (await readdir(join(appRoot, "migrations"))).filter((name) => /^000[1-8]_.*\.sql$/.test(name)).sort();
  if (migrations.length !== 8) throw new Error("Expected all eight actual Worker migrations");
  const migrationStatements = [];
  for (const migration of migrations) {
    for (const sql of unstable_splitSqlQuery(await readFile(join(appRoot, "migrations", migration), "utf8")))
      migrationStatements.push(db.prepare(sql));
  }
  await db.batch(migrationStatements);
  console.log("All eight migrations applied; seeding synthetic dashboard rows...");
  // Same AES-GCM format and session lookup used by production authentication.
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
  const encrypted = await seal({ SESSION_SECRET: secret } as Env, userToken);
  const seedStatements = [];
  seedStatements.push(db.prepare("INSERT INTO sessions(id,value,expires) VALUES(?,?,?)")
    .bind(`session:${sessionId}`, encrypted, now + 24 * 3600_000));
  for (const [index, repo] of repositories.entries()) {
    seedStatements.push(db.prepare(`INSERT INTO repo_settings(repository,installation,full_name,issues_enabled,prs_enabled,comments_enabled,comment_prompt,triage_enabled,allowed_labels,backfill_limit,updated,updated_by)
      VALUES(?,10,?,?,?,?,?,?,?,?,?,'octo-admin')`)
      .bind(repo.id, repo.full_name, index === 2 ? 0 : 1, index === 2 ? 0 : 1, 0, "", index === 0 ? 1 : 0,
        index === 0 ? '["bug","enhancement","documentation"]' : "[]", 25, now - (index + 1) * 3600_000));
  }
  const states = ["done", "done", "failed", "pending", "running", "cancelled"];
  for (let i = 0; repositories.length && i < 36; i++) {
    const repo = repositories[i % repositories.length];
    const state = states[i % states.length];
    const updated = now - i * 600_000;
    seedStatements.push(db.prepare(`INSERT INTO jobs(id,installation,repository,full_name,pr,kind,state,attempts,created,started,due,lease,result,updated)
      VALUES(?,10,?,?,?,'label',?,?,?,?,?,?,?,?)`)
      .bind(`preview-label-${String(i + 1).padStart(3, "0")}`, repo.id, repo.full_name, 42 + i,
        state, state === "failed" ? 3 : 1, updated - 60_000, state === "pending" ? 0 : updated - 30_000,
        state === "pending" ? now + 60_000 : updated, state === "running" ? now + 120_000 : 0,
        state === "failed" ? "Synthetic fixture: GitHub rate limit; retry available" : state === "done" ? "Synthetic fixture: completed processing" : null, updated));
  }
  if (repositories.length) seedStatements.push(db.prepare(`INSERT INTO jobs(id,installation,repository,full_name,kind,state,created,due,updated,result)
    VALUES('backfill-10-100-preview',10,100,?,'initialize','done',?,?,?,'Synthetic fixture: queued 18 open items')`)
    .bind(repositories[0].full_name, now - 86400_000, now - 86400_000, now - 86300_000));
  for (let i = 0; repositories.length && i < 32; i++) {
    const repo = repositories[i % repositories.length];
    seedStatements.push(db.prepare("INSERT INTO audit_log(repository,actor,via,action,detail,created) VALUES(?,?,?,?,?,?)")
      .bind(repo.id, i % 2 ? "octo-admin" : "octo-cli", i % 2 ? "web" : "api", i % 2 ? "settings.update" : "backfill",
        i % 2 ? '{"changed":["issues_enabled","triage_enabled"]}' : '{"limit":25}', now - i * 3600_000));
  }
  if (repositories.length) seedStatements.push(db.prepare(`INSERT INTO cleanups(id,installation,repository,full_name,scope,state,code_hash,expires,summary,total,requested_by,created,updated)
    VALUES('12345678-1234-1234-1234-123456789012',10,100,?,'{"labels":"review","comments":false,"definitions":false}',
      'planned','local-fixture-no-cli-confirmation',?, '{"review_labels":12,"triage_labels":0,"comments":0,"label_definitions":0,"truncated":false,"bot_active":true}',12,'octo-admin',?,?)`)
    .bind(repositories[0].full_name, Date.now() + 3600_000, now - 120_000, now - 60_000));

  if (installationCount === 2) {
    const repo = secondaryRepositories[0];
    seedStatements.push(db.prepare(`INSERT INTO repo_settings(repository,installation,full_name,issues_enabled,prs_enabled,comments_enabled,comment_prompt,triage_enabled,allowed_labels,backfill_limit,updated,updated_by)
      VALUES(400,20,?,1,1,0,'',0,'[]',25,?,'octo-admin')`).bind(repo.full_name, now));
    for (let i = 0; i < 4; i++) {
      seedStatements.push(db.prepare(`INSERT INTO jobs(id,installation,repository,full_name,pr,kind,state,attempts,created,due,updated,result)
        VALUES(?,20,400,?,?,'label',?,1,?,?,?,'Synthetic harbor fixture')`)
        .bind(`harbor-label-${i + 1}`, repo.full_name, 42 + i, i === 0 ? "failed" : "done", now - i * 600_000, now, now - i * 600_000));
      seedStatements.push(db.prepare("INSERT INTO audit_log(repository,actor,via,action,detail,created) VALUES(400,'harbor-admin','web','settings.update','{}',?)").bind(now - i * 3600_000));
    }
  }
  await db.batch(seedStatements);
  // Read the actual seeded D1 ledger for fixture provenance; these values never
  // replace production dashboard queries or imply later writes are unchanged.
  const seedRows = {
    repositories: Number((await db.prepare("SELECT COUNT(*) AS count FROM repo_settings").first()).count),
    jobs: Number((await db.prepare("SELECT COUNT(*) AS count FROM jobs").first()).count),
    audit: Number((await db.prepare("SELECT COUNT(*) AS count FROM audit_log").first()).count),
  };

  const currentLedger = async () => {
    // Loopback-only read-only diagnostics of the real D1 fixture ledger. Hashes
    // demonstrate preview admission did not update existing rows or save input.
    const tables = ["jobs", "audit_log", "triage_labels", "repo_settings", "ai_providers"] as const;
    const rows = await db.batch(tables.flatMap(table => [db.prepare(`SELECT COUNT(*) AS count FROM ${table}`), db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 1000`)]));
    return Object.fromEntries(tables.map((table, index) => { const count = Number(rows[index * 2].results[0].count); return [table, { count, truncated: count > 1000, sha256: createHash("sha256").update(JSON.stringify(rows[index * 2 + 1].results)).digest("hex") }]; }));
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", origin);
      if (url.pathname === "/__preview/health") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ fixture: true, worker: "src/index.ts", database: "isolated ephemeral D1", migrations: migrations.length,
          builtAt, bundleSha256, installationCount, seedRows, installations: installations.map(({ id, account }) => ({ id, account: account.login })), model: liveJev ? "real Jev enabled explicitly" : "disabled", decisionCalls, lastDecision, githubWriteAttempts, currentLedger: await currentLedger(), rateLimitRows: Number((await db.prepare("SELECT COUNT(*) AS count FROM api_rate").first()).count) }));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && name !== "host") headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      // Authentication stays inside the actual Worker. The loopback wrapper
      // supplies a properly sealed synthetic-user session, never a production flag.
      const cookies = (headers.get("cookie") || "").split(";").map(value => value.trim()).filter(Boolean);
      const fixtureCookie = cookies.find(value => value.startsWith("ghfind_bot_session="))?.slice("ghfind_bot_session=".length);
      if (url.searchParams.get("signedout") === "1") headers.delete("cookie");
      else if (!fixtureCookie || (request.method === "GET" && fixtureCookie !== sessionId)) {
        // A prior preview's cookie must not strand a user's already-open tab
        // after restart. Only GET refreshes stale local fixture identity. POST
        // preserves supplied identity for the real Worker's session/CSRF checks.
        // Reusing this UUID never recreates a deliberately logged-out D1 session.
        headers.set("cookie", [...cookies.filter(value => !value.startsWith("ghfind_bot_session=")), `ghfind_bot_session=${sessionId}`].join("; "));
        response.setHeader("set-cookie", `ghfind_bot_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error("Preview request body too large");
        chunks.push(Buffer.from(chunk));
      }
      const result = await mf.dispatchFetch(url.toString(), { method: request.method, headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.concat(chunks), redirect: "manual" });
      response.statusCode = result.status;
      result.headers.forEach((value: string, name: string) => { if (name !== "set-cookie") response.setHeader(name, value); });
      const wrapperCookie = response.getHeader("set-cookie");
      const wrapperCookies = Array.isArray(wrapperCookie) ? wrapperCookie : typeof wrapperCookie === "string" ? [wrapperCookie] : [];
      const workerCookies = result.headers.getSetCookie();
      // Preserve both fixture-session refresh and Worker locale writes. Worker
      // expiry cookies remain last, so logout cannot be undone by the wrapper.
      if (wrapperCookies.length || workerCookies.length) response.setHeader("set-cookie", [...wrapperCookies, ...workerCookies]);
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.statusCode = 500;
      response.end("Local preview request failed");
    }
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(4201, "127.0.0.1", done); });
  console.log(`Synthetic data, actual Worker and D1 (${installationCount} accounts): ${origin}/admin`);
  console.log(`Preview process: ${process.pid}; compiled ${builtAt}; bundle ${bundleSha256.slice(0, 12)}`);
  console.log(`Model mode: ${liveJev ? "real Jev (explicit --jev); no automated model calls" : "disabled; no external credentials read"}`);
  console.log(`Signed out: ${origin}/admin?signedout=1`);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    server.close();
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
    process.exit(0);
  }
  process.on("SIGINT", () => { void stop().catch(() => process.exit(1)); });
  process.on("SIGTERM", () => { void stop().catch(() => process.exit(1)); });
}
await main().catch(() => {
  // Miniflare validation errors can include binding values. Never dump them
  // when an explicit Jev preview has loaded a real credential.
  console.error("Preview startup failed. Check Worker dependencies, private credential file (with --jev), and that port 4201 is free.");
  process.exit(1);
});
