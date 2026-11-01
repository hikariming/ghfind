// Explicit live integration: pnpm exec tsx platform/github-app/scripts/jev-worker-live.mts --live
// Only Jev is real. GitHub, scoring, delivery identities and D1 are isolated fixtures.
import { strict as assert } from "node:assert";
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  if (process.argv.slice(2).join(" ") !== "--live") {
    console.log("Usage: pnpm exec tsx platform/github-app/scripts/jev-worker-live.mts --live");
    return;
  }
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const require = createRequire(await realpath(join(appRoot, "node_modules/wrangler/package.json")));
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = require("miniflare");
  const { build } = require("esbuild");
  const { unstable_splitSqlQuery } = require("wrangler");
  const credential = process.env.JEV_CREDENTIAL_FILE || join(process.env.HOME || "", ".config/ghfind/.env.openrouter");
  assert.equal((await stat(credential)).mode & 0o077, 0, "Credential file must be private");
  const key = (await readFile(credential, "utf8")).match(/^OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/m)?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
  assert.ok(key, "Missing external Jev credential");
  const endpoint = "https://openrouter.ai/api/alpha/decisions";
  const fullName = "synthetic/local";
  const token = "synthetic-installation-token";
  const queueKey = randomBytes(24).toString("hex");
  const webhookSecret = randomBytes(24).toString("hex");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const allowed = ["bug", "enhancement"];
  const humanLabel = "human:needs-reproduction";
  const issue = { number: 42, title: "CLI crashes when the configuration file is missing",
    body: "The existing CLI crashes every time the configuration file is absent. Reproduction: delete the config file, then run status. Expected: a clear setup instruction. Actual: an unhandled TypeError while reading an undefined value.",
    state: "open", user: { id: 42, login: "synthetic-author", type: "User" } };
  const repoLabels = [
    ...["low", "medium", "high", "top", "no-score"].map((level) => ({ name: `review: ${level}`, color: "123456", description: "Synthetic score label fixture" })),
    { name: "bug", color: "d73a4a", description: "A report that an existing feature does not work correctly: a crash, regression, or incorrect behavior." },
    { name: "enhancement", color: "a2eeef", description: "A request to add a new capability or improve the product beyond its existing behavior, rather than reporting a defect." },
    { name: humanLabel, color: "cccccc", description: "A maintainer's existing human label" },
  ];
  const applied = new Set([humanLabel]);
  const acknowledged: { method: string; path: string; labels: string[]; status: number }[] = [];
  const rejected: { labels: string[]; status: number }[] = [];
  const unexpected: string[] = [];
  const models: { status: number; latencyMs: number; transportFailure?: boolean; transportCode?: string; model?: string; probabilities?: Record<string, number>; usage?: Record<string, number> }[] = [];
  let rejectIntentOnce = true;
  let tokenIssuances = 0;
  let scoreReads = 0;
  const outbound = async (request: Request) => {
    const url = new URL(request.url);
    if (request.url === endpoint && request.method === "POST") {
      if (request.headers.get("authorization") !== `Bearer ${key}`)
        throw new Error("Unexpected model credential");
      assert.ok(!models.some((call) => call.status >= 400), "No automatic model retry after provider failure");
      const start = performance.now();
      const observation: typeof models[number] = { status: 0, latencyMs: 0 };
      models.push(observation);
      let response: Response;
      try {
        // Copy production protocol headers without Miniflare's local transport
        // headers (Host/content-length), which belong to its Node bridge.
        response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${key}`,
          "content-type": "application/json", accept: "application/json", "user-agent": "ghfind-review" },
          body: await request.arrayBuffer(), redirect: "manual", signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        observation.transportFailure = true;
        const code = error && typeof error === "object" ? (error as { cause?: { code?: unknown } }).cause?.code : undefined;
        if (typeof code === "string" && /^[A-Z_]{1,60}$/.test(code)) observation.transportCode = code;
        throw new Error("Model transport failure");
      } finally { observation.latencyMs = Math.round(performance.now() - start); }
      observation.status = response.status;
      if (response.ok) {
        const raw = await response.clone().json() as Record<string, unknown>;
        if (typeof raw.model === "string" && /^typesafe\/jev-1\.13(?:-\d{8})?$/.test(raw.model)) observation.model = raw.model;
        if (raw.answers && typeof raw.answers === "object") observation.probabilities = Object.fromEntries(
          Object.entries(raw.answers).flatMap(([id, value]) => {
            const n = value && typeof value === "object" ? (value as { noul?: unknown }).noul : undefined;
            return /^label_\d+$/.test(id) && typeof n === "number" && Number.isFinite(n) ? [[id, n]] : [];
          }));
        if (raw.usage && typeof raw.usage === "object") observation.usage = Object.fromEntries(
          Object.entries(raw.usage).filter(([name, value]) => ["input_tokens", "output_tokens", "cost"].includes(name) &&
            typeof value === "number" && Number.isFinite(value)));
      }
      return response;
    }
    if (url.origin !== "https://api.github.com") {
      unexpected.push("non-allowlisted outbound host");
      return Response.json({ error: "Blocked fixture endpoint" }, { status: 502 });
    }
    const path = url.pathname;
    if (path === "/app/installations/10/access_tokens" && request.method === "POST") {
      const parts = (request.headers.get("authorization") || "").replace(/^Bearer /, "").split(".");
      assert.equal(parts.length, 3, "Missing actual App JWT");
      assert.ok(verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url")), "Invalid App JWT");
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      assert.equal(claims.iss, "123");
      assert.deepEqual(await request.json(), { repository_ids: [100], permissions: { pull_requests: "write", issues: "write" } });
      tokenIssuances++;
      return Response.json({ token }, { status: 201 });
    }
    assert.equal(request.headers.get("authorization"), `Bearer ${token}`, "Unexpected fixture installation token");
    if (path === "/repositories/100" && request.method === "GET")
      return Response.json({ id: 100, full_name: fullName, archived: false });
    if (path === `/repos/${fullName}/issues/42` && request.method === "GET") return Response.json(issue);
    if (request.method === "GET" && [ `/repos/${fullName}/labels`, `/repos/${fullName}/issues/42/labels` ].includes(path)) {
      assert.equal(url.search, "?per_page=100&page=1", "Unexpected fixture pagination");
      return Response.json(path.endsWith("/issues/42/labels") ? [...applied].map((name) => ({ name })) : repoLabels);
    }
    if (path === `/repos/${fullName}/issues/42/labels` && request.method === "POST") {
      const body = await request.json() as { labels: string[] };
      assert.ok(Array.isArray(body.labels) && body.labels.length === 1, "Unexpected label write shape");
      assert.ok(["review: high", "bug"].includes(body.labels[0]), "Unexpected label selection");
      if (body.labels[0] === "bug" && rejectIntentOnce) {
        rejectIntentOnce = false;
        rejected.push({ labels: [...body.labels], status: 422 });
        return Response.json({ error: "Synthetic rejected label write" }, { status: 422 });
      }
      body.labels.forEach((name) => applied.add(name));
      acknowledged.push({ method: "POST", path, labels: [...body.labels], status: 200 });
      return Response.json([...applied].map((name) => ({ name })));
    }
    unexpected.push(`${request.method} ${path}`);
    return Response.json({ error: "Blocked fixture GitHub endpoint" }, { status: 502 });
  };
  const directory = await mkdtemp(join(tmpdir(), "ghfind-jev-worker-"));
  const output = resolve(process.env.JEV_WORKER_OUTPUT_DIR || "tmp/saas-jev-worker");
  await mkdir(output, { recursive: true });
  // Installed Miniflare has no dispatchQueue. This private test-only adapter
  // invokes the actual production queue handler; no production source changes.
  const entry = `import production from ${JSON.stringify(join(appRoot, "src/index.ts"))};
export default {...production, async fetch(request,env){
 if(new URL(request.url).pathname!=="/__test/run-queue")return production.fetch(request,env);
 if(request.method!=="POST"||request.headers.get("authorization")!=="Bearer "+env.TEST_QUEUE_KEY)return new Response("Forbidden",{status:403});
 const input=await request.json();if(typeof input.id!=="string"||!/^[-a-zA-Z0-9]{1,100}$/.test(input.id))return new Response("Invalid fixture id",{status:400});
 let acked=0,retried=0;const message={id:"fixture-message",timestamp:new Date(),body:{id:input.id},attempts:1,ack(){acked++},retry(){retried++}};
 await production.queue({queue:"local-live-jobs",messages:[message],ackAll(){acked++},retryAll(){retried++}},env);
 return Response.json({acked,retried});
}};`;
  await build({ stdin: { contents: entry, resolveDir: appRoot, sourcefile: "test-only-queue-entry.mjs" },
    outfile: join(directory, "worker.mjs"), bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["node:*"] });
  const source = await readFile(join(directory, "worker.mjs"), "utf8");
  const bundleSha256 = createHash("sha256").update(source).digest("hex");
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "isolated-jev-worker-live", modules: true, script: source,
    compatibilityDate: "2026-09-10", compatibilityFlags: ["nodejs_compat"], host: "127.0.0.1", port: 0, cf: false,
    log: new Log(LogLevel.ERROR), d1Databases: { DB: "isolated-jev-live-only" }, d1Persist: false,
    queueProducers: { JOBS: "local-live-jobs", DEAD: "local-live-dead" }, outboundService: outbound,
    serviceBindings: { SCORE: async (request: Request) => {
      assert.equal(request.url, "https://ghfind.com/api/score/synthetic-author", "Unexpected synthetic score request");
      assert.equal(request.method, "GET"); scoreReads++; return Response.json({ final_score: 82.7 });
    } },
    bindings: { APP_ID: "123", APP_SLUG: "local-live-fixture", APP_PRIVATE_KEY: privateKey, ENABLED: "true",
      ALLOWED_ACCOUNTS: "synthetic", EMAIL_ENABLED: "false", WEBHOOK_SECRET: webhookSecret,
      SESSION_SECRET: randomBytes(32).toString("hex"), TEST_QUEUE_KEY: queueKey,
      TRIAGE_PROVIDER: "jev", OPENROUTER_API_KEY: key, JEV_MODEL: "typesafe/jev-1.13", JEV_THRESHOLD: "0.8" },
  }));
  const report: Record<string, unknown> = { success: false, fixture: "synthetic/local #42", productionEntry: "src/index.ts",
    queueAdapter: "private test-only wrapper invoking production default.queue", bundleSha256, llmKeyPresent: false, phase: "runtime-starting",
    requestVersion: "description-only-v2", classifierSourceSha256: createHash("sha256")
      .update(await readFile(join(appRoot, "src/jev.ts"))).update(await readFile(join(appRoot, "src/triage.ts"))).digest("hex") };
  try {
    await mf.ready;
    report.phase = "runtime-ready";
    const db = await mf.getD1Database("DB");
    const migrations = (await readdir(join(appRoot, "migrations"))).filter((name) => /^000[1-7]_.*\.sql$/.test(name)).sort();
    assert.equal(migrations.length, 7);
    const sql = [];
    for (const migration of migrations) for (const statement of unstable_splitSqlQuery(await readFile(join(appRoot, "migrations", migration), "utf8"))) sql.push(db.prepare(statement));
    await db.batch(sql);
    report.phase = "migrated";
    await db.prepare(`INSERT INTO repo_settings(repository,installation,full_name,triage_enabled,allowed_labels,comments_enabled,updated,updated_by)
      VALUES(100,10,?,1,?,0,?,'synthetic-admin')`).bind(fullName, JSON.stringify(allowed), Date.now()).run();
    const event = JSON.stringify({ action: "opened", installation: { id: 10, app_id: 123 },
      repository: { id: 100, full_name: fullName, owner: { login: "synthetic" } }, issue });
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(event).digest("hex")}`;
    const deliver = (id: string, signed = true) => mf.dispatchFetch("https://isolated-worker.invalid/webhook", {
      method: "POST", headers: { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": id,
        "x-hub-signature-256": signed ? signature : `sha256=${"0".repeat(64)}` }, body: event,
    });
    const run = async (id: string) => {
      const response = await mf.dispatchFetch("https://isolated-worker.invalid/__test/run-queue", { method: "POST",
        headers: { authorization: `Bearer ${queueKey}`, "content-type": "application/json" }, body: JSON.stringify({ id }) });
      report.lastQueueHttpStatus = response.status;
      assert.equal(response.status, 200);
      const queueResult = await response.json();
      report.lastQueueResult = queueResult;
      assert.deepEqual(queueResult, { acked: 1, retried: 0 });
      const state = await db.prepare("SELECT state FROM jobs WHERE id=?").bind(id).first();
      report.lastJobState = state?.state;
      assert.equal(state?.state, "done", "Production job did not finish");
      if (models.some((call) => call.status >= 400)) throw new Error("Provider HTTP failure; coordinate before any new request");
    };
    const ledger = async () => (await db.prepare("SELECT repository,number,label FROM triage_labels ORDER BY label").all()).results;
    const first = `rejected-${randomUUID()}`;
    report.phase = "invalid-signature";
    const negative = await deliver(first, false);
    report.invalidSignatureStatus = negative.status;
    assert.equal(negative.status, 401);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM jobs").first())?.n, 0);
    report.phase = "first-webhook";
    report.firstWebhookStatus = (await deliver(first)).status;
    assert.equal(report.firstWebhookStatus, 202);
    assert.equal((await db.prepare("SELECT state FROM jobs WHERE id=?").bind(first).first())?.state, "pending");
    report.phase = "first-queue";
    await run(first);
    assert.equal(models.length, 1);
    assert.deepEqual(rejected, [{ labels: ["bug"], status: 422 }]);
    assert.deepEqual(await ledger(), [], "Rejected GitHub write must not gain a ledger entry");
    assert.ok(applied.has(humanLabel));
    report.rejectedWriteLedgerEmpty = true;
    const second = `acknowledged-${randomUUID()}`;
    report.phase = "second-webhook";
    assert.equal((await deliver(second)).status, 202);
    report.phase = "second-queue";
    await run(second);
    assert.equal(models.length, 2);
    assert.deepEqual(await ledger(), [{ repository: 100, number: 42, label: "bug" }]);
    assert.equal(acknowledged.filter((write) => write.labels.includes("bug")).length, 1);
    assert.ok(applied.has(humanLabel));
    const beforeReplay = acknowledged.length;
    report.phase = "replay";
    assert.equal((await deliver(second)).status, 202);
    await run(second);
    const third = `already-labeled-${randomUUID()}`;
    assert.equal((await deliver(third)).status, 202);
    await run(third);
    assert.equal(models.length, 2, "Duplicate and already-labeled jobs must not call Jev again");
    assert.equal(acknowledged.length, beforeReplay, "Replay must not add GitHub writes");
    assert.deepEqual(await ledger(), [{ repository: 100, number: 42, label: "bug" }]);
    assert.ok(applied.has(humanLabel));
    assert.deepEqual(unexpected, []);
    Object.assign(report, { success: true, migrations: migrations.length, signedWebhookAccepted: true, invalidSignatureRejected: true,
      queueAcknowledged: true, bugSelectedByRealJev: true, ledger: await ledger(), humanLabelPreserved: true,
      replayModelCalls: 0, replayGitHubWrites: 0, tokenIssuances, scoreReads, acknowledgedGitHubWrites: acknowledged,
      finalLabels: [...applied].sort(), phase: "complete", jobs: (await db.prepare("SELECT state,count(*) AS count FROM jobs GROUP BY state").all()).results });
  } finally {
    Object.assign(report, { modelCalls: models, rejectedGitHubWrites: rejected, acknowledgedGitHubWrites: acknowledged,
      tokenIssuances, scoreReads, finalLabels: [...applied].sort(), unexpectedEndpoints: unexpected });
    await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ success: report.success, actualWorker: true, modelCalls: models.length,
    statuses: models.map((call) => call.status), labels: [...applied].sort(), acknowledgedWrites: acknowledged.length,
    rejectedWrites: rejected.length, replayModelCalls: report.replayModelCalls, output: join(output, "result.json") }));
}

await main().catch(() => {
  // Raw runtime errors may include bindings; never print them with a real key.
  console.error("Worker live integration failed. Inspect sanitized result.json; coordinate provider HTTP failures before retrying.");
  process.exit(1);
});
