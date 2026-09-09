import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webTemplate, validateWebManifest, coreManifest, renderWeb, renderWebRuntime,
  safeBuildEnvironment, assertNoLocalEnvironmentFiles, validateStagingSecrets, stagingSecretNames } from "./feed-platform-web.mjs";
import { ACCOUNT, validateManifest } from "./feed-platform-manifest.mjs";
import { verifyWebVersion, verifyWebDeployment, verifyWebResources, boundedJSON } from "./feed-platform-web-verify.mjs";
import { artifactInventory } from "./feed-platform-web-build.mjs";

export function fixture() {
  const m = webTemplate();
  m.coreDatabase.id = "12345678-1234-1234-1234-123456789012";
  m.feedDatabase.id = "22345678-1234-1234-1234-123456789012";
  m.billing = { confirmed: true, evidence: "https://example.com/billing", maximumMonthlyUSD: 100, projectedMonthlyUSD: 79 };
  m.isolation = { reviewed: true, evidence: "https://example.com/isolation" };
  m.executorImplemented = true;
  m.web.origin = "https://ghfind-feed-web-staging.fixture-account.workers.dev";
  m.web.runtimeOrigin = "https://ghfind-feed-runtime-staging.fixture-account.workers.dev";
  m.web.oauth = { clientId: "0123456789abcdef0123", callbackUrl: m.web.origin + "/api/auth/callback/github", dedicated: true,
    registrationEvidence: "https://example.com/oauth-registration", holderFirstLoginRequired: true,
    identities: [{ role: "ordinary", githubId: "10001", login: "fixture-user" }, { role: "governance", githubId: "10002", login: "fixture-reviewer" }] };
  m.web.sourceProvider = { apiBase: "https://provider.example.com/api/v1", agentId: "isolated-project-agent", dedicated: true,
    isolationEvidence: "https://example.com/source-isolation", repositories: ["fixture-owner/fixture-project"] };
  return m;
}
test("unconfigured web example blocks; complete v2 preserves old fixed-resource checks", () => {
  assert.throws(() => validateWebManifest(webTemplate()));
  const m = fixture();
  assert.equal(validateWebManifest(m), m);
  assert.equal(validateManifest(coreManifest(m)).schemaVersion, 1);
  assert.throws(() => validateWebManifest(coreManifest(m)), /version 2/);
});
test("missing registration/source/auth, wrong-account origins and every production database fail closed", () => {
  const changes = [
    m => delete m.web, m => { m.web.worker = "ghfind-dev"; }, m => { m.web.cacheBucket = "ghfind-next-cache"; },
    m => { m.web.origin = "https://dev.ghfind.com"; }, m => { m.web.origin += "/"; },
    m => { m.web.runtimeOrigin = m.web.runtimeOrigin.replace("fixture-account", "foreign"); },
    m => { m.web.oauth.callbackUrl = "https://ghfind.com/api/auth/callback/github"; },
    m => { m.web.oauth.dedicated = false; }, m => { m.web.oauth.registrationEvidence = null; },
    m => { m.web.oauth.holderFirstLoginRequired = false; }, m => { m.web.oauth.identities[1].githubId = "10001"; },
    m => { m.web.oauth.identities[1].login = "FIXTURE-USER"; }, m => { m.web.oauth.identities[0].githubId = "9007199254740992"; },
    m => { m.web.oauth.identities[0].role = "admin"; }, m => { m.web.sourceProvider.apiBase = "http://127.0.0.1:8787/api/v1"; },
    m => { m.web.sourceProvider.apiBase = "https://user:secret@example.com/api/v1"; },
    m => { m.web.sourceProvider.apiBase += "?token=secret"; }, m => { m.web.sourceProvider.dedicated = false; },
    m => { m.web.sourceProvider.repositories = []; }, m => { m.web.sourceProvider.repositories = ["fixture/x", "fixture/x"]; },
    m => { m.web.sourceProvider.repositories = ["fixture/X"]; }, m => { m.web.sourceProvider.token = "wrong-place"; },
    m => { m.billing.projectedMonthlyUSD = 81; }, m => { m.web.oauth.cookie = "fabricated"; },
    ...["60d45096-bfe7-4de1-8b85-c1b66a466b0d", "9c4ac13a-4c90-40a8-9d56-d7141f864bbf", "bd305af9-2cab-4fe8-8c2f-324391cf105e"].map(id => m => { m.coreDatabase.id = id; }),
  ];
  for (const change of changes) { const m = fixture(); change(m); assert.throws(() => validateWebManifest(m)); }
});
test("Web config has only isolated D1/cache/runtime and no inherited production bindings or secret values", () => {
  const m = fixture(), sha = "a".repeat(40), c = renderWeb(m, sha);
  assert.deepEqual(c.d1_databases.map(d => d.database_id), [m.coreDatabase.id, m.feedDatabase.id]);
  assert.deepEqual(c.services, [{ binding: "FEED_RUNTIME", service: m.runtimeWorker }]);
  assert.equal(c.vars.FEED_SOURCE_OUTBOX_ENABLED, "true");
  assert.equal(c.vars.FEED_BACKEND, "go"); assert.equal(c.vars.GHFIND_DEPLOY_ENV, "feed-staging");
  assert.equal(c.vars.FEED_STAGING_ALLOWED_GITHUB_IDS, "10001,10002");
  assert.equal(c.vars.PROJECT_ANALYSIS_RUNTIME_ALLOWLIST, "");
  assert.equal(c.vars.PROJECT_ANALYSIS_CREATE_MAX_ATTEMPTS, "1");
  assert.equal(c.vars.AUTH_SECRET, undefined); assert.equal(c.routes, undefined); assert.equal(c.env, undefined);
  assert.equal(c.vars.NEXT_PUBLIC_SITE_URL, m.web.origin);
  const image = `registry.cloudflare.com/${ACCOUNT}/ghfind-feed@sha256:${"b".repeat(64)}`;
  const runtime = renderWebRuntime(m, image, sha);
  assert.equal(runtime.vars.FEED_MODE, "baseline");
  assert.deepEqual(runtime.containers.map(c => c.max_instances), [2, 1]);
  assert.throws(() => renderWebRuntime(m, image.replace("@sha256:", ":"), sha));
});
test("build environment is explicit and cannot inherit secrets, NODE_OPTIONS or public production origin", () => {
  const env = safeBuildEnvironment(fixture(), "a".repeat(40), {
    PATH: "/bin", HOME: "/tmp/fixture", AUTH_SECRET: "secret", MOSOO_API_TOKEN: "token", GH_TOKEN: "token",
    CLOUDFLARE_API_TOKEN: "token", NODE_OPTIONS: "--require malicious", NEXT_PUBLIC_SITE_URL: "https://ghfind.com",
    NEXT_PUBLIC_UNINTENDED_SECRET: "leak", TURSO_DATABASE_URL: "production", UPSTASH_REDIS_REST_TOKEN: "production",
  });
  assert.equal(env.HOME, "/tmp/fixture"); assert.equal(env.NEXT_PUBLIC_SITE_URL, fixture().web.origin);
  for (const k of ["AUTH_SECRET", "MOSOO_API_TOKEN", "GH_TOKEN", "CLOUDFLARE_API_TOKEN", "NODE_OPTIONS", "NEXT_PUBLIC_UNINTENDED_SECRET", "TURSO_DATABASE_URL", "UPSTASH_REDIS_REST_TOKEN"]) assert.equal(env[k], undefined);
});
test("build rejects local dotenv/devvars files before invoking any compiler", () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-web-env-"));
  try {
    mkdirSync(join(dir, "platform/runtime"), { recursive: true }); mkdirSync(join(dir, "platform/feed"));
    writeFileSync(join(dir, ".env.example"), "EXAMPLE=public"); assertNoLocalEnvironmentFiles(dir);
    for (const name of [".env", ".env.local", ".env.production", "platform/runtime/.dev.vars", "platform/feed/.dev.vars.staging"]) {
      writeFileSync(join(dir, name), "PRIVATE=never-read");
      assert.throws(() => assertNoLocalEnvironmentFiles(dir), /forbidden/); rmSync(join(dir, name));
    }
  } finally { rmSync(dir, { recursive: true }); }
});
test("runtime credential files share only the intentional gateway role; missing/reused roles reject", () => {
  const env = Object.fromEntries(stagingSecretNames.map((name, i) => [name, `${i}`.padEnd(40, "s")]));
  const result = validateStagingSecrets(env);
  assert.equal(result.web.FEED_GATEWAY_SECRET, result.runtime.FEED_GATEWAY_SECRET);
  assert.equal(result.web.FEED_OPERATOR_SECRET, undefined); assert.equal(result.web.FEED_BRIDGE_SECRET, undefined);
  assert.equal(result.runtime.AUTH_SECRET, undefined); assert.equal(result.adapter.MOSOO_API_TOKEN, undefined);
  assert.throws(() => validateStagingSecrets({ ...env, AUTH_SECRET: env.FEED_GATEWAY_SECRET }), /distinct/);
  assert.throws(() => validateStagingSecrets({ ...env, MOSOO_API_TOKEN: undefined }), /MOSOO_API_TOKEN/);
});

function versionFixture() {
  const m = fixture(), sha = "a".repeat(40), c = renderWeb(m, sha);
  const active = { deployments: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", versions: [{ version_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", percentage: 100 }] }] };
  const bindings = [
    ...Object.entries(c.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    ...c.secrets.required.map(name => ({ name, type: "secret_text" })),
    ...c.d1_databases.map(b => ({ name: b.binding, type: "d1", id: b.database_id })),
    ...c.r2_buckets.map(b => ({ name: b.binding, type: "r2_bucket", bucket_name: b.bucket_name })),
    { name: "FEED_RUNTIME", type: "service", service: m.runtimeWorker }, { name: "ASSETS", type: "assets" }, { name: "WORKER_VERSION", type: "version_metadata" },
  ];
  const version = { id: active.deployments[0].versions[0].version_id, annotations: { "workers/tag": `staging-${sha}` },
    resources: { bindings, script: { etag: "fixture-etag" }, script_runtime: { compatibility_date: c.compatibility_date, compatibility_flags: ["nodejs_compat"] } } };
  return { m, sha, active, version };
}
test("active Web version validates bound resources and rejects partial rollout, wrong source or inherited production storage", () => {
  const f = versionFixture();
  assert.equal(verifyWebVersion(f.m, f.sha, f.active, f.version).bindingsVerified, true);
  for (const mutate of [
    f => { f.active.deployments[0].versions[0].percentage = 10; }, f => { f.version.annotations["workers/tag"] = "staging-old"; },
    f => { f.version.resources.bindings.find(b => b.type === "d1").id = "60d45096-bfe7-4de1-8b85-c1b66a466b0d"; },
    f => { f.version.resources.bindings.find(b => b.type === "r2_bucket").bucket_name = "ghfind-next-cache"; },
    f => { f.version.resources.bindings.find(b => b.type === "service").service = "ghfind"; },
    f => { f.version.resources.bindings.find(b => b.type === "service").entrypoint = "Privileged"; },
    f => { f.version.resources.bindings.push({ name: "TURSO_DATABASE_URL", type: "plain_text", text: "production" }); },
    f => { f.version.resources.bindings = f.version.resources.bindings.filter(b => b.name !== "AUTH_SECRET"); },
    f => { delete f.version.resources.script.etag; },
  ]) {
    const bad = versionFixture(); mutate(bad);
    assert.throws(() => verifyWebVersion(bad.m, bad.sha, bad.active, bad.version));
  }
});
test("OAuth begin probe discards state/cookies and explicitly cannot claim a real login", async () => {
  const f = versionFixture(), calls = [];
  const fetcher = async (raw, init) => {
    const url = new URL(raw); calls.push(url.pathname);
    assert.notEqual(init.method, "POST");
    if (url.hostname === "api.cloudflare.com") {
      const result = url.pathname.endsWith("/deployments") ? f.active : url.pathname.endsWith("/subdomain") ? { enabled: true, previews_enabled: false } : f.version;
      return Response.json({ success: true, result });
    }
    assert.equal(url.origin, f.m.web.origin);
    if (url.pathname === "/api/auth/github") return new Response(null, { status: 302, headers: {
      location: "https://github.com/login/oauth/authorize?" + new URLSearchParams({ client_id: f.m.web.oauth.clientId, redirect_uri: f.m.web.oauth.callbackUrl, scope: "read:user", state: "private-state-fixture" }),
      "set-cookie": "ghfind_oauth_state=private-state-fixture; HttpOnly; Secure",
    } });
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  };
  const result = await verifyWebDeployment(f.m, f.sha, { token: "fixture", fetcher });
  assert.equal(result.realOAuth, false); assert.equal(result.oauthBeginVerified, true);
  assert.equal(JSON.stringify(result).includes("private-state-fixture"), false);
  assert.equal(calls.length, 6);
  await assert.rejects(verifyWebDeployment(f.m, f.sha, { token: "fixture", fetcher: (raw, init) => {
    if (new URL(raw).pathname === "/api/auth/github") return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://ghfind.com/" } }));
    return fetcher(raw, init);
  } }), /OAuth begin/);
});
test("Web resource preflight requires its own cache and actual account subdomain; denied reads are not absence", async () => {
  const m = fixture(), calls = [];
  const fetcher = async raw => {
    const url = new URL(raw); calls.push(url.pathname);
    let result;
    if (url.pathname.endsWith(m.coreDatabase.id)) result = { name: m.coreDatabase.name };
    else if (url.pathname.endsWith(m.feedDatabase.id)) result = { name: m.feedDatabase.name };
    else if (url.pathname.includes("/r2/buckets/")) result = { name: url.pathname.split("/").at(-1) };
    else if (url.pathname.endsWith("/workers/subdomain")) result = { subdomain: "fixture-account" };
    else if (url.searchParams.has("name")) result = [{ queue_id: "a".repeat(32), queue_name: url.searchParams.get("name") }];
    else result = { queue_id: "a".repeat(32), queue_name: m.terminalParkingQueue, settings: { message_retention_period: 1209600 }, consumers: [] };
    return Response.json({ success: true, result });
  };
  assert.equal((await verifyWebResources(m, { token: "fixture", fetcher })).verified, true);
  assert.equal(calls.length, 9);
  await assert.rejects(verifyWebResources(m, { token: "fixture", fetcher: async raw => {
    if (new URL(raw).pathname.endsWith("/workers/subdomain")) return Response.json({ success: true, result: { subdomain: "another-account" } });
    return fetcher(raw);
  } }), /subdomain/);
  await assert.rejects(verifyWebResources(m, { token: "fixture", fetcher: async raw => {
    if (new URL(raw).pathname.endsWith(m.web.cacheBucket)) return new Response(null, { status: 403 });
    return fetcher(raw);
  } }), /403/);
});
test("response and built artifact inventories are bounded and content-sensitive", async () => {
  await assert.rejects(boundedJSON(new Response(" ".repeat(1025)), 1024), /oversized/);
  const dir = mkdtempSync(join(tmpdir(), "feed-web-build-"));
  try {
    mkdirSync(join(dir, "assets")); writeFileSync(join(dir, "assets/index.html"), "fixture");
    assert.throws(() => artifactInventory(dir), /missing/);
    writeFileSync(join(dir, "worker.js"), "export default {}");
    const before = artifactInventory(dir);
    writeFileSync(join(dir, "worker.js"), "export default {fetch(){}}");
    assert.notEqual(artifactInventory(dir).sha256, before.sha256);
    symlinkSync(join(dir, "worker.js"), join(dir, "assets/linked.js"));
    assert.throws(() => artifactInventory(dir), /symlink/);
    rmSync(join(dir, "assets/linked.js"));
    symlinkSync("worker.js", join(dir, "internal.js"));
    const linked = artifactInventory(dir);
    assert.equal(linked.files.find(f => f.path === "internal.js").symlink, "worker.js");
    symlinkSync("../outside", join(dir, "outside.js"));
    assert.throws(() => artifactInventory(dir), /symlink/);
  } finally { rmSync(dir, { recursive: true }); }
});
