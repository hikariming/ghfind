import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID, createHash } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { getPlatformProxy } from "wrangler";
import { encodeSignedPayload, OAUTH_SESSION_COOKIE } from "../../src/lib/oauth-session";
import { encodeSocialSession } from "../../src/lib/social-session";
import { SCORE_CACHE_VERSION, ROAST_CACHE_VERSION } from "../../src/lib/cache-version";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "../../src/lib/scan-run-types";
import { SUBSCORE_MAX } from "../../src/lib/score-presentation";
import type { D1DatabaseLike } from "../../src/lib/d1-client";

const root = resolve(import.meta.dirname, "../..");
const localDir = join(root, ".local/dev");
const origin = "http://127.0.0.1:4390";
const configPath = join(localDir, "wrangler.json");
const persistPath = join(localDir, "state");
const roles = ["owner", "other", "internal", "social"] as const;
const identitySchema = z.object({ login: z.string().regex(/^local-[a-z]+-[a-f0-9]{8}$/), githubId: z.number().int().positive() });
const schema = z.object({ version: z.literal(1), secret: z.string().min(32), databaseId: z.string().uuid(), identities: z.object({ owner: identitySchema, other: identitySchema, internal: identitySchema, social: identitySchema }) });
type LocalState = z.infer<typeof schema>;

function save(name: string, data: unknown) {
  const path = join(localDir, name);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
function load(): LocalState {
  assert(existsSync(join(localDir, "accounts.json")), "Run pnpm run init first");
  return schema.parse(JSON.parse(readFileSync(join(localDir, "accounts.json"), "utf8")));
}
function environment(state: LocalState) {
  // Start without inherited service credentials; block Next's automatic dotenv
  // loading from reintroducing configured remote endpoints or signing keys.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "SHELL", "TERM", "SYSTEMROOT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    if (existsSync(join(root, file))) {
      for (const key of Object.keys(parseEnv(readFileSync(join(root, file), "utf8")))) env[key] = "";
    }
  }
  return { ...env, NODE_ENV: "development", CI: "", NEXT_TELEMETRY_DISABLED: "1", WRANGLER_SEND_METRICS: "false", AUTH_SECRET: state.secret,
    GHFIND_LOCAL_WRANGLER_CONFIG: configPath, GHFIND_LOCAL_PERSIST_PATH: join(persistPath, "v3"),
    GHFIND_DISCOVER_SCORE_V1: "1", GHFIND_DISCOVER_INTERNAL_GITHUB_IDS: String(state.identities.internal.githubId),
    GHFIND_OAUTH_ENABLED: "0", NEXT_PUBLIC_SITE_URL: origin, GHFIND_DEPLOY_ENV: "development" };
}
function refresh(state: LocalState) {
  process.env.AUTH_SECRET = state.secret;
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  for (const role of roles) {
    const identity = state.identities[role];
    const value = role === "social"
      ? encodeSocialSession({ provider: "google", subject: identity.login, name: "Local social test", image: null, expires_at: expires * 1000 })
      : encodeSignedPayload("session", { github_id: identity.githubId, login: identity.login, expires_at: expires * 1000 });
    save(`${role}.json`, { cookies: [{ name: OAUTH_SESSION_COOKIE, value, domain: "127.0.0.1", path: "/", expires, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] });
  }
  save("guest.json", { cookies: [], origins: [] });
}
async function init() {
  mkdirSync(localDir, { recursive: true, mode: 0o700 });
  chmodSync(localDir, 0o700);
  const existing = existsSync(join(localDir, "accounts.json"))
    ? schema.extend({ identities: schema.shape.identities.partial() }).parse(JSON.parse(readFileSync(join(localDir, "accounts.json"), "utf8")))
    : undefined;
  const identities = { ...existing?.identities };
  const usedIds = new Set(Object.values(identities).map(identity => identity.githubId));
  for (const role of roles) {
    if (identities[role]) continue;
    let githubId: number;
    do { githubId = randomInt(1_000_000_000, 2_000_000_000); } while (usedIds.has(githubId));
    usedIds.add(githubId);
    identities[role] = { login: `local-${role}-${randomBytes(4).toString("hex")}`, githubId };
  }
  const state = schema.parse({ version: 1, secret: existing?.secret ?? randomBytes(32).toString("hex"), databaseId: existing?.databaseId ?? randomUUID(), identities });
  save("accounts.json", state);
  save("wrangler.json", { name: "ghfind-local-auth", compatibility_date: "2026-08-06", compatibility_flags: ["nodejs_compat"],
    d1_databases: [
      { binding: "GHFIND_D1", database_name: "ghfind-local", database_id: state.databaseId, migrations_dir: join(root, "migrations") },
      { binding: "GHFIND_FEED_D1", database_name: "ghfind-local-feed", database_id: "00000000-0000-4000-8000-000000000002", migrations_dir: join(root, "migrations-feed") },
    ],
  });
  for (const binding of ["GHFIND_D1", "GHFIND_FEED_D1"]) {
    const result = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", binding, "--local", "--config", configPath, "--persist-to", persistPath], { cwd: root, env: { ...environment(state), CI: "true" }, stdio: "pipe", encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Local migration failed for ${binding}: ${result.stderr || result.stdout}`);
    console.log(`Local migrations ready: ${binding}`);
  }
  const proxy = await getPlatformProxy<{ GHFIND_D1: D1DatabaseLike }>({ configPath, persist: { path: join(persistPath, "v3") }, remoteBindings: false });
  try {
    for (const role of roles.filter(role => role !== "social")) {
      const { login, githubId } = state.identities[role];
      const now = Date.now();
      await proxy.env.GHFIND_D1.prepare("INSERT OR IGNORE INTO users (github_id,login,name,created_at,last_login) VALUES (?,?,?,?,?)")
        .bind(githubId, login, `Local test ${role}`, now, now).all();
      // Deliberately synthetic display data in this isolated database only.
      const snapshot = JSON.stringify({ localFixture: true, role, login });
      await proxy.env.GHFIND_D1.prepare(`INSERT OR IGNORE INTO scores
        (username,display_name,profile_url,final_score,tier,tags,sub_scores,roast,roast_en,roast_line,scanned_at,score_version,roast_version,roast_en_version,score_source_collection_version,score_source_snapshot_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(login, `本地测试 · ${role}`, `${origin}/u/${login}`, 75, "人上人",
          JSON.stringify({ zh: ["本地合成测试资料"], en: ["Local synthetic fixture"] }),
          JSON.stringify(Object.fromEntries(Object.entries(SUBSCORE_MAX).map(([key, max]) => [key, max * 0.75]))),
          "本地合成测试资料，仅用于开发验证，非真实 GitHub 扫描结果。", "Local synthetic fixture, not a GitHub scan.",
          JSON.stringify({ zh: "本地测试账号", en: "Local test account" }), now, SCORE_CACHE_VERSION, ROAST_CACHE_VERSION, ROAST_CACHE_VERSION, PUBLIC_SCAN_COLLECTION_VERSION,
          createHash("sha256").update(snapshot).digest("hex")).all();
    }
  } finally { await proxy.dispose(); }
  refresh(state);
  console.log("Local accounts and sessions ready: owner, other, internal, social, guest.\nStart: pnpm dev:local\nOpen: pnpm local:open owner\nVerify: pnpm local:verify");
}
async function verify() {
  const state = load();
  refresh(state);
  const probe = await fetch(`${origin}/api/me`);
  assert(probe.ok && probe.headers.get("content-type")?.includes("application/json"), "Start pnpm dev:local before verification");
  const anonymous = await probe.json();
  assert(anonymous.user === null && typeof anonymous.scored === "boolean", "Unexpected local API");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    for (const role of [...roles, "guest"] as const) {
      const context = await browser.newContext({ storageState: join(localDir, `${role}.json`) });
      try {
        const meResponse = await context.request.get(`${origin}/api/me`);
        assert.equal(meResponse.status(), 200);
        const me = await meResponse.json();
        if (role === "guest") assert.equal(me.user, null);
        else if (role === "social") { assert.equal(me.user, null); assert.equal(me.account.provider, "google"); }
        else {
          assert.equal(me.user.login, state.identities[role].login);
          assert.equal(me.account.provider, "github");
          assert.equal(me.account.subject, String(state.identities[role].githubId));
          assert.equal(me.scored, true);
        }
        const internal = await context.request.get(`${origin}/api/discover/internal`);
        assert.equal(internal.status(), role === "internal" ? 200 : 404);
        const page = await context.newPage();
        const response = await page.goto(`${origin}/zh/u/${state.identities.owner.login}`);
        assert.equal(response?.status(), 200);
        await page.waitForLoadState("domcontentloaded");
        assert(await page.getByText(`本地测试 · owner`, { exact: false }).count() > 0, "Expected seeded profile content");
        await page.screenshot({ path: join(localDir, `${role}.png`), fullPage: true });
        if (role === "owner") {
          const otherResponse = await page.goto(`${origin}/zh/u/${state.identities.other.login}`);
          assert.equal(otherResponse?.status(), 200);
          const switched = await context.request.get(`${origin}/api/me`);
          assert.equal((await switched.json()).user.login, state.identities.owner.login);
          const uppercase = await page.goto(`${origin}/zh/u/${state.identities.owner.login.toUpperCase()}`);
          assert.equal(uppercase?.status(), 200);
          const cookies = await context.cookies();
          const session = cookies.find(cookie => cookie.name === OAUTH_SESSION_COOKIE);
          assert(session);
          await context.addCookies([{ ...session, value: session.value + "invalid" }]);
          const invalid = await context.request.get(`${origin}/api/me`);
          assert.equal((await invalid.json()).user, null, "Invalid signatures must be rejected");
          const expiredValue = encodeSignedPayload("session", {
            github_id: state.identities.owner.githubId,
            login: state.identities.owner.login,
            expires_at: Date.now() - 1000,
          });
          await context.addCookies([{ ...session, value: expiredValue }]);
          const expired = await context.request.get(`${origin}/api/me`);
          assert.equal((await expired.json()).user, null, "Expired sessions must be rejected");
          await context.clearCookies();
          const signedOut = await context.request.get(`${origin}/api/me`);
          assert.equal((await signedOut.json()).user, null, "Cleared sessions must be anonymous");
        }
        console.log(`${role}: backend identity, Discover permission and real profile verified`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
const command = process.argv[2] ?? "init";
if (command === "init") await init();
else if (command === "dev") {
  const state = load(); refresh(state);
  const env = environment(state);
  const assets = spawnSync("pnpm", ["gen:assets"], { cwd: root, env, stdio: "inherit" });
  assert.equal(assets.status, 0);
  const child = spawn("pnpm", ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", "4390"], { cwd: root, env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("exit", code => { process.exitCode = code ?? 1; });
} else if (command === "open") {
  const state = load(); refresh(state);
  const role = process.argv[3] ?? "owner";
  assert([...roles, "guest"].includes(role), "Unknown role; use owner, other, internal, social or guest");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: join(localDir, `${role}.json`) });
  const page = await context.newPage();
  await page.goto(`${origin}/zh/u/${state.identities.owner.login}`);
  await new Promise<void>(done => browser.on("disconnected", () => done()));
} else if (command === "verify") await verify();
else if (command === "renew") { refresh(load()); console.log("Local sessions renewed"); }
else throw new Error("Unknown command");
