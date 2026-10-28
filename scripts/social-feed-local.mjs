/** Isolated local API: no deployed services, remote D1 or production secrets. */
import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const api = resolve(root, "apps/api");
const require = createRequire(resolve(root, "package.json"));
const ts = require("typescript");
const parsed = ts.parseConfigFileTextToJson("wrangler.jsonc", readFileSync(resolve(api, "wrangler.jsonc"), "utf8"));
if (parsed.error) throw new Error("Invalid API Wrangler config");
const base = parsed.config;
const directory = resolve(root, ".wrangler/social-feed-local");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const config = resolve(directory, "wrangler.json");
const secretFile = resolve(directory, ".dev.vars");
if (!existsSync(secretFile)) writeFileSync(secretFile,
  `AUTH_SECRET=${randomBytes(32).toString("hex")}\nSOCIAL_FEED_INGEST_SECRET=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
writeFileSync(config, JSON.stringify({
  name: "ghfind-social-feed-local", main: resolve(api, "src/index.ts"),
  compatibility_date: base.compatibility_date, compatibility_flags: ["nodejs_compat"],
  build: { command: "node scripts/vendor-og.mjs", cwd: api, watch_dir: [resolve(root, "src"), resolve(api, "src")] },
  rules: base.rules,
  alias: Object.fromEntries(Object.entries(base.alias).map(([key, value]) => [key, resolve(api, value)])),
  d1_databases: [
    { binding: "GHFIND_D1", database_name: "social-feed-core-local", database_id: "00000000-0000-4000-8000-000000000001", migrations_dir: resolve(root, "migrations") },
    { binding: "GHFIND_FEED_D1", database_name: "social-feed-posts-local", database_id: "00000000-0000-4000-8000-000000000002", migrations_dir: resolve(root, "migrations-feed") },
  ],
  r2_buckets: [{ binding: "SOCIAL_FEED_MEDIA", bucket_name: "social-feed-media-local" }],
  vars: { GHFIND_DEPLOY_ENV: "development", SOCIAL_FEED_PUBLIC_ORIGIN: "http://127.0.0.1:4321", PUBLIC_SITE_URL: "http://127.0.0.1:4321", NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:4321" },
}, null, 2));
const safeEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
safeEnv.WRANGLER_SEND_METRICS = "false";
const state = resolve(directory, "state");
const common = ["--config", config, "--persist-to", state];
const mode = process.argv[2] ?? "api";
function run(args) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], { cwd: api, env: safeEnv, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (mode === "prepare") {
  run(["d1", "migrations", "apply", "social-feed-core-local", "--local", ...common]);
  run(["d1", "migrations", "apply", "social-feed-posts-local", "--local", ...common]);
} else if (mode === "api") {
  const child = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", "8791", ...common], { cwd: api, env: safeEnv, stdio: "inherit" });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));
} else { throw new Error("Usage: node scripts/social-feed-local.mjs [prepare|api]"); }
