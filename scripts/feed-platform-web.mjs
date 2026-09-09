#!/usr/bin/env node
// Offline manifest/config generation only. No provision, upload, or deployment.
import { readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT, template, validateManifest, renderRuntime, renderAdapter,
  secretNames, adapterSecretNames, allSecretNames } from "./feed-platform-manifest.mjs";

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WEB_WORKER = "ghfind-feed-web-staging";
export const WEB_CACHE = "ghfind-feed-staging-web-cache";
export const webSecretNames = Object.freeze(["AUTH_SECRET", "AUTH_GITHUB_SECRET", "FEED_GATEWAY_SECRET", "MOSOO_API_TOKEN"]);
export const stagingSecretNames = Object.freeze([...new Set([...allSecretNames, ...webSecretNames])]);
const configNames = Object.freeze({
  web: "platform/runtime/wrangler.web.staging.generated.json",
  runtime: "platform/runtime/wrangler.staging.generated.json",
  adapter: "platform/feed/wrangler.staging.generated.json",
});
function requireThat(value, message) { if (!value) throw new Error(message); }
function exact(value, fields, label) {
  requireThat(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && Object.keys(value).every(k => fields.includes(k)), `invalid ${label} fields`);
}
function https(value, label) {
  requireThat(typeof value === "string" && value.length <= 512 && !/[\x00-\x20\x7f]/.test(value), `invalid ${label}`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`invalid ${label}`); }
  requireThat(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && !url.port &&
    !["localhost", "ghfind.com", "dev.ghfind.com"].includes(url.hostname) &&
    !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) && !url.hostname.includes(":"), `unsafe ${label}`);
  return url;
}
function proof(value, label) {
  const url = https(value, label);
  requireThat(url.hostname.includes("."), `missing ${label}`);
}
export function webTemplate() {
  return { ...template(), schemaVersion: 2, web: {
    worker: WEB_WORKER, cacheBucket: WEB_CACHE, origin: null, runtimeOrigin: null,
    oauth: { clientId: null, callbackUrl: null, dedicated: false, registrationEvidence: null,
      holderFirstLoginRequired: true, identities: [] },
    sourceProvider: { apiBase: null, agentId: null, dedicated: false, isolationEvidence: null, repositories: [] },
  } };
}
export function coreManifest(m) {
  const { web: _web, ...base } = m;
  void _web;
  return { ...base, schemaVersion: 1 };
}
export function validateWebManifest(m) {
  requireThat(m?.schemaVersion === 2, "OAuth staging requires manifest version 2");
  const base = coreManifest(m);
  validateManifest(base); // Retains the fixed live/dev D1 denylist and budget gates.
  exact(m.web, ["worker", "cacheBucket", "origin", "runtimeOrigin", "oauth", "sourceProvider"], "web");
  const w = m.web;
  requireThat(w.worker === WEB_WORKER && w.cacheBucket === WEB_CACHE, "only isolated web Worker/cache allowed");
  const origin = https(w.origin, "web origin"), runtime = https(w.runtimeOrigin, "runtime origin");
  requireThat(origin.origin === w.origin && runtime.origin === w.runtimeOrigin, "origins must be canonical without paths");
  const match = /^ghfind-feed-web-staging\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.workers\.dev$/.exec(origin.hostname);
  requireThat(match && runtime.hostname === `${base.runtimeWorker}.${match[1]}.workers.dev`, "web/runtime must use the same isolated workers.dev subdomain");
  exact(w.oauth, ["clientId", "callbackUrl", "dedicated", "registrationEvidence", "holderFirstLoginRequired", "identities"], "OAuth");
  requireThat(typeof w.oauth.clientId === "string" && /^[A-Za-z0-9._-]{10,80}$/.test(w.oauth.clientId), "dedicated OAuth client ID missing");
  requireThat(w.oauth.callbackUrl === `${w.origin}/api/auth/callback/github`, "OAuth callback must match the isolated Web origin");
  requireThat(w.oauth.dedicated === true && w.oauth.holderFirstLoginRequired === true, "dedicated OAuth/holder-first-login prerequisites required");
  proof(w.oauth.registrationEvidence, "OAuth registration evidence");
  const identities = w.oauth.identities;
  requireThat(Array.isArray(identities) && identities.length === 2, "two distinct real GitHub identities required");
  for (const [i, identity] of identities.entries()) {
    exact(identity, ["role", "githubId", "login"], "OAuth identity");
    requireThat(identity.role === ["ordinary", "governance"][i] && typeof identity.githubId === "string" &&
      /^[1-9][0-9]{0,15}$/.test(identity.githubId) && Number.isSafeInteger(Number(identity.githubId)) &&
      typeof identity.login === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(identity.login), "invalid OAuth identity");
  }
  requireThat(new Set(identities.map(i => i.githubId)).size === 2 && new Set(identities.map(i => i.login.toLowerCase())).size === 2, "OAuth identities must be distinct");
  exact(w.sourceProvider, ["apiBase", "agentId", "dedicated", "isolationEvidence", "repositories"], "source provider");
  const provider = https(w.sourceProvider.apiBase, "source provider URL");
  requireThat(provider.hostname.includes(".") && provider.origin !== w.origin && provider.origin !== w.runtimeOrigin &&
    !/^(?:ghfind|ghfind-dev)\./.test(provider.hostname) &&
    !provider.hostname.endsWith(".invalid") && !provider.hostname.endsWith(".test") &&
    w.sourceProvider.apiBase === provider.href.replace(/\/$/, ""), "explicit canonical external source provider URL required");
  requireThat(typeof w.sourceProvider.agentId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(w.sourceProvider.agentId) &&
    w.sourceProvider.dedicated === true, "dedicated source provider agent missing");
  proof(w.sourceProvider.isolationEvidence, "source provider isolation evidence");
  const repos = w.sourceProvider.repositories;
  requireThat(Array.isArray(repos) && repos.length >= 1 && repos.length <= 4 && new Set(repos).size === repos.length &&
    repos.every(repo => typeof repo === "string" && /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9_.-]{1,100}$/.test(repo)), "one to four unique approved source repositories required");
  return m;
}
export function webVariables(m, sha) {
  validateWebManifest(m);
  requireThat(/^[a-f0-9]{40}$/.test(sha), "exact release SHA required");
  return {
    GHFIND_DEPLOY_ENV: "feed-staging", FEED_ENVIRONMENT: "staging", FEED_RELEASE_SHA: sha,
    PUBLIC_SITE_URL: m.web.origin, NEXT_PUBLIC_SITE_URL: m.web.origin,
    NEXT_PUBLIC_GHFIND_DEPLOY_PLATFORM: "cloudflare", AUTH_GITHUB_ID: m.web.oauth.clientId,
    FEED_BACKEND: "go", FEED_API_ORIGIN: m.web.runtimeOrigin,
    FEED_STAGING_ALLOWED_GITHUB_IDS: m.web.oauth.identities.map(i => i.githubId).join(","),
    FEED_STAGING_ALLOWED_REPOSITORIES: m.web.sourceProvider.repositories.join(","),
    MOSOO_API_BASE: m.web.sourceProvider.apiBase, MOSOO_PROJECT_AGENT_ID: m.web.sourceProvider.agentId,
    MOSOO_PROJECT_REQUEST_TIMEOUT_MS: "15000", PROJECT_ANALYSIS_MAX_CONCURRENCY: "1",
    PROJECT_ANALYSIS_CREATE_MAX_ATTEMPTS: "1", PROJECT_ANALYSIS_RUNTIME_ALLOWLIST: "",
  };
}
export function renderWeb(m, sha) {
  return {
    $schema: "./node_modules/wrangler/config-schema.json", name: WEB_WORKER, account_id: ACCOUNT,
    main: "../../.open-next/worker.js", compatibility_date: "2026-09-09", compatibility_flags: ["nodejs_compat"],
    workers_dev: true, preview_urls: false, assets: { directory: "../../.open-next/assets", binding: "ASSETS" },
    observability: { enabled: true, head_sampling_rate: 0.1 }, limits: { cpu_ms: 10000 },
    version_metadata: { binding: "WORKER_VERSION" }, vars: webVariables(m, sha),
    secrets: { required: [...webSecretNames] },
    d1_databases: [
      { binding: "GHFIND_D1", database_name: m.coreDatabase.name, database_id: m.coreDatabase.id, migrations_dir: "../../migrations" },
      { binding: "GHFIND_FEED_D1", database_name: m.feedDatabase.name, database_id: m.feedDatabase.id, migrations_dir: "../../migrations-feed" },
    ],
    r2_buckets: [{ binding: "NEXT_INC_CACHE_R2_BUCKET", bucket_name: WEB_CACHE }],
    services: [{ binding: "FEED_RUNTIME", service: m.runtimeWorker }],
  };
}
export function renderWebRuntime(m, image, sha) {
  validateWebManifest(m);
  const c = renderRuntime(coreManifest(m), image, sha);
  c.vars.FEED_MODE = "baseline";
  return c;
}
export function validateStagingSecrets(env) {
  const values = {};
  for (const name of stagingSecretNames) {
    const value = env[name];
    requireThat(typeof value === "string" && Buffer.byteLength(value) >= 32 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value), `missing or invalid ${name}`);
    values[name] = value;
  }
  requireThat(new Set(Object.values(values)).size === stagingSecretNames.length, "staging roles require distinct secrets");
  return {
    runtime: Object.fromEntries(secretNames.map(n => [n, values[n]])),
    adapter: Object.fromEntries(adapterSecretNames.map(n => [n, values[n]])),
    web: Object.fromEntries(webSecretNames.map(n => [n, values[n]])),
  };
}
export function assertNoLocalEnvironmentFiles(directory = repository) {
  for (const relative of [".", "platform/runtime", "platform/feed"]) {
    for (const name of readdirSync(resolve(directory, relative))) {
      if ((/^\.env(?:\.|$)/.test(name) && name !== ".env.example") || /^\.dev\.vars(?:\.|$)/.test(name))
        throw new Error("local environment files are forbidden in the staging build checkout");
    }
  }
}
export function safeBuildEnvironment(m, sha, inherited = process.env) {
  const vars = webVariables(m, sha);
  // Never pass OAuth/provider/CF credentials, NODE_OPTIONS, arbitrary build
  // flags, or caller NEXT_PUBLIC_* variables into Next/OpenNext compilation.
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "PNPM_HOME"].filter(k => typeof inherited[k] === "string").map(k => [k, inherited[k]]));
  return { ...env, NODE_ENV: "production", CI: "true", WRANGLER_SEND_METRICS: "false", NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_GHFIND_DEPLOY_PLATFORM: "cloudflare", NEXT_PUBLIC_SITE_URL: vars.NEXT_PUBLIC_SITE_URL,
    PUBLIC_SITE_URL: vars.PUBLIC_SITE_URL, GHFIND_DEPLOY_ENV: "feed-staging", FEED_RELEASE_SHA: sha };
}
function writeJSON(path, value, mode = 0o644) {
  try { requireThat(!lstatSync(path).isSymbolicLink(), "output symlink rejected"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode, flag: "wx" });
}
function main(args) {
  const [command, path, ...rest] = args;
  if (command === "template" && !path) return console.log(JSON.stringify(webTemplate(), null, 2));
  const m = validateWebManifest(JSON.parse(readFileSync(path, "utf8")));
  if (command === "validate" && rest.length === 0) return console.log("Isolated OAuth Web manifest prerequisites validated; real journey remains required");
  if (command === "render-web" && rest.length === 1) return writeJSON(resolve(repository, configNames.web), renderWeb(m, rest[0]));
  if (command === "render" && rest.length === 2) {
    writeJSON(resolve(repository, configNames.runtime), renderWebRuntime(m, rest[0], rest[1]));
    writeJSON(resolve(repository, configNames.adapter), renderAdapter(coreManifest(m)));
    return;
  }
  if (command === "prepare" && rest.length === 1) {
    const out = resolve(rest[0]);
    requireThat(out !== repository && !out.startsWith(repository + "/"), "secret output must be outside checkout");
    const secrets = validateStagingSecrets(process.env);
    writeJSON(resolve(out, "feed-staging-core-manifest.json"), coreManifest(m));
    for (const [role, values] of Object.entries(secrets)) writeJSON(resolve(out, `feed-${role}-secrets.json`), values, 0o600);
    return;
  }
  throw new Error("usage: feed-platform-web.mjs template | validate manifest | render-web manifest SHA | render manifest IMAGE SHA | prepare manifest OUTSIDE_CHECKOUT_DIRECTORY");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
