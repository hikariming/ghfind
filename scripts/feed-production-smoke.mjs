#!/usr/bin/env node
// Service-contract smoke only: no OAuth cookie, no event/preference/delete API
// mutations. Authenticated Feed GETs still persist profiles/sessions/requests.
import { createHash, createHmac } from "node:crypto";
import { openSync, closeSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_ORIGIN = "https://ghfind-feed-runtime-production.beiming1201.workers.dev";
export const ACTOR_ID = 109743670;
const IDENTITY_URL = `https://api.github.com/user/${ACTOR_ID}`;
export const LIMITS = Object.freeze({ httpRequests: 20, events: 0, mutatingHTTPMethods: 0, totalMs: 120_000, requestMs: 10_000, responseBytes: 65_536, pageItems: 2, retries: 0 });
const SCOPE = "production service-contract smoke using a trusted service signature; not real OAuth, submission/assessment, event/queue, preference-write, deletion, restore, capacity or full Feed E2E";
const PRIVATE_FIELDS = new Set(["analysisId", "sourceHash", "features", "propensity", "embedding", "candidateSources", "score"]);
class SmokeError extends Error { constructor(code) { super(code); this.code = code; } }
function ensure(value, code) { if (!value) throw new SmokeError(code); }
function integer(value) { return Number.isSafeInteger(value) && value > 0; }

export function parseOptions(argv) {
  const flags = new Map();
  const allowed = new Set(["--mode", "--runtime-mode", "--release-sha", "--image", "--writer-epoch", "--profile", "--output", "--execute"]);
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    ensure(allowed.has(key) && !flags.has(key), "invalid_or_duplicate_option");
    if (key === "--execute") flags.set(key, true);
    else { ensure(typeof argv[index + 1] === "string" && !argv[index + 1].startsWith("--"), "option_value_required"); flags.set(key, argv[++index]); }
  }
  const config = { mode: flags.get("--mode"), runtimeMode: flags.get("--runtime-mode"), releaseSHA: flags.get("--release-sha"), image: flags.get("--image"), writerEpoch: Number(flags.get("--writer-epoch")), profile: flags.get("--profile"), output: flags.get("--output"), execute: flags.get("--execute") === true };
  ensure(["paused", "all"].includes(config.mode) && ["off", "baseline"].includes(config.runtimeMode) && (config.mode !== "all" || config.runtimeMode === "baseline"), "invalid_mode");
  ensure(/^[a-f0-9]{40}$/.test(config.releaseSHA ?? ""), "exact_release_sha_required");
  ensure(/^registry\.cloudflare\.com\/8f19bebe359e4ec1a24c68c5f49c1584\/ghfind-feed@sha256:[a-f0-9]{64}$/.test(config.image ?? "") && !/@sha256:0{64}$/.test(config.image), "immutable_production_image_required");
  ensure(/^[1-9][0-9]*$/.test(flags.get("--writer-epoch") ?? "") && integer(config.writerEpoch) && config.profile === "cf_d1_r2", "invalid_writer_epoch_or_profile");
  ensure(typeof config.output === "string" && config.output.length > 0, "output_required");
  config.output = resolve(config.output);
  return config;
}

export function dryPlan(config) {
  return { format: "feed-production-service-contract-plan-v1", mode: config.mode, expectedRuntimeMode: config.runtimeMode, releaseSHA: config.releaseSHA, configuredImage: config.image, writerEpoch: config.writerEpoch, storeProfile: config.profile,
    runtimeOrigin: RUNTIME_ORIGIN, actorGitHubId: config.mode === "all" ? ACTOR_ID : null, limits: LIMITS, scope: SCOPE,
    credentials: ["FEED_RUNTIME_ADMIN_SECRET", ...(config.mode === "all" ? ["FEED_GATEWAY_SECRET"] : [])],
    actions: ["authenticated runtime health and aggregate readiness", "unauthorized ready and anonymous/forged Feed rejection", ...(config.mode === "all" ? ["verify public GitHub identity by numeric ID", "read preferences and taxonomy", "read a bounded Feed page and optional cursor/retry", "re-read unchanged preferences"] : [])],
    warnings: ["No HTTP occurs without --execute.", "Authenticated GETs may persist profile, session, request and served-item rows.", "No preferences or state are overwritten, no events are sent and no user data is deleted.", "Web paused/all is a requested release stage, not proof of the Web Gateway's observed configuration.", "An empty Feed candidate result is incomplete and exits unsuccessfully."] };
}

function safeReadiness(data, config) {
  ensure(data?.ready === true && data.service === "feed-runtime" && data.version === config.releaseSHA && data.contractVersion === "1" && data.configuredImage === config.image && data.mode === config.runtimeMode, "runtime_identity_mismatch");
  ensure(typeof data.workerVersionId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data.workerVersionId), "runtime_worker_version_missing");
  ensure(Array.isArray(data.containers) && data.containers.length === 3, "container_readiness_missing");
  const targets = new Set();
  const containers = data.containers.map(item => {
    ensure(["api-0", "api-1", "executor-0"].includes(item?.target) && !targets.has(item.target), "container_target_mismatch");
    targets.add(item.target);
    ensure(item.ready === true && item.version === config.releaseSHA && item.contractVersion === "1" && item.storageWriterVersion === 2 && item.storeProfile === config.profile && item.writerEpoch === config.writerEpoch && item.mode === config.runtimeMode && item.service === (item.target === "executor-0" ? "feed-worker" : "feed-api"), "container_identity_mismatch");
    return { target: item.target, ready: true, version: item.version, contractVersion: "1", storageWriterVersion: 2, storeProfile: item.storeProfile, writerEpoch: item.writerEpoch, mode: item.mode };
  });
  return { version: data.version, workerVersionId: data.workerVersionId, configuredImage: data.configuredImage, mode: data.mode, containers };
}

function gatewaySignature(identity, target, secret) {
  const issuedAt = Date.now();
  const payload = Buffer.from(JSON.stringify({ version: 1, audience: "feed-api", githubId: ACTOR_ID, login: identity.login, avatarUrl: identity.avatar_url,
    issuedAt, expiresAt: issuedAt + 30_000, method: "GET", target, bodySha256: createHash("sha256").update("").digest("hex") })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(`feed-gateway-v1\n${payload}`).digest("base64url")}`;
}

function publicIdentity(data) {
  // GitHub documents GET /user/{account_id} without authentication for public
  // metadata: https://docs.github.com/en/rest/users/users#get-a-user-using-their-id
  ensure(data?.id === ACTOR_ID && data.type === "User" && typeof data.login === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(data.login), "github_identity_mismatch");
  let avatar;
  try { avatar = new URL(data.avatar_url); } catch { throw new SmokeError("github_avatar_invalid"); }
  ensure(avatar.origin === "https://avatars.githubusercontent.com" && !avatar.username && !avatar.password && avatar.pathname === `/u/${ACTOR_ID}` && avatar.href.length <= 1024, "github_avatar_invalid");
  return { login: data.login, avatar_url: avatar.href };
}

function preferences(data) {
  ensure(integer(data?.taxonomyVersion) && integer(data.profileVersion) && Array.isArray(data.preferences) && data.preferences.length <= 1000, "preferences_shape_invalid");
  const seen = new Set();
  const values = data.preferences.map(p => {
    ensure(typeof p?.tagId === "string" && p.tagId.length > 0 && p.tagId.length <= 200 && ["explicit", "behavior", "graph"].includes(p.source) && [-1, 1].includes(p.value) && Number.isFinite(p.strength) && p.strength >= 0 && p.strength <= 1 && integer(p.taxonomyVersion), "preferences_shape_invalid");
    const key = `${p.source}\n${p.tagId}`;
    ensure(!seen.has(key), "preferences_duplicate"); seen.add(key);
    return { tagId: p.tagId, source: p.source, value: p.value, strength: p.strength, taxonomyVersion: p.taxonomyVersion };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  return { taxonomyVersion: data.taxonomyVersion, profileVersion: data.profileVersion, preferences: values };
}

function page(data) {
  const raw = JSON.stringify(data);
  for (const field of PRIVATE_FIELDS) ensure(!raw.includes(`"${field}":`), "private_feed_fields_exposed");
  ensure(Array.isArray(data?.items) && data.items.length <= LIMITS.pageItems && (data.nextCursor === null || typeof data.nextCursor === "string") && (data.nextCursor?.length ?? 0) <= 16_384, "feed_page_shape_invalid");
  const keys = new Set();
  const items = data.items.map(item => {
    ensure(typeof item?.project?.repoKey === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.project.repoKey) && !keys.has(item.project.repoKey) && typeof item.impressionToken === "string" && item.impressionToken.length > 0 && item.impressionToken.length <= 16_384, "feed_item_shape_invalid");
    keys.add(item.project.repoKey);
    return { repoKey: item.project.repoKey, owner: item.project.repoKey.split("/")[0] };
  });
  return { items, cursor: data.nextCursor };
}

export async function runSmoke(config, { env = process.env, fetcher = fetch, save = () => {}, now = () => performance.now() } = {}) {
  const started = now();
  const report = { ...dryPlan(config), format: "feed-production-service-contract-result-v1", status: "incomplete", startedAt: new Date().toISOString(), observations: [], httpRequests: 0, eventsSent: 0,
    webGatewayModeObserved: false, preferencesWritePerformed: false, deletionPerformed: false, journey: config.mode === "all" ? "not_started" : "not_requested", notProven: ["real OAuth", "real user submission or assessment", "event and queue recovery", "preference write and restore", "deletion", "capacity", "full Feed E2E"] };
  save(report);
  const admin = env.FEED_RUNTIME_ADMIN_SECRET;
  const gateway = env.FEED_GATEWAY_SECRET;
  async function request(label, url, headers, expected = 200, runtime = true) {
    ensure(report.httpRequests < LIMITS.httpRequests && now() - started < LIMITS.totalMs, "smoke_budget_exhausted");
    ensure(runtime ? new URL(url).origin === RUNTIME_ORIGIN : url === IDENTITY_URL, "unregistered_smoke_destination");
    report.httpRequests++;
    const observed = { operation: label, status: null, durationMs: 0 };
    report.observations.push(observed);
    const at = now();
    const controller = new AbortController();
    let timer;
    let reader;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SmokeError("request_deadline")); }, Math.min(LIMITS.requestMs, Math.max(1, LIMITS.totalMs - (now() - started)))); });
    try {
      const response = await Promise.race([fetcher(url, { method: "GET", headers, signal: controller.signal, redirect: "manual", cache: "no-store" }), deadline]);
      observed.status = response.status;
      ensure(response.status === expected, "unexpected_http_status");
      ensure(response.headers.get("content-type")?.toLowerCase().startsWith("application/json") && (!runtime || response.headers.get("cache-control") === "no-store"), "response_contract_invalid");
      ensure(response.body, "response_body_missing");
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const next = await Promise.race([reader.read(), deadline]);
        if (next.done) break;
        size += next.value.byteLength;
        ensure(size <= LIMITS.responseBytes, "response_too_large");
        chunks.push(Buffer.from(next.value));
      }
      ensure(now() - started < LIMITS.totalMs, "smoke_budget_exhausted");
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new SmokeError("response_json_invalid"); }
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      observed.durationMs = Math.round(now() - at);
      save(report);
    }
  }
  try {
    ensure(typeof admin === "string" && Buffer.byteLength(admin) >= 32, "runtime_admin_secret_required");
    if (config.mode === "all") ensure(typeof gateway === "string" && Buffer.byteLength(gateway) >= 32 && gateway !== admin, "independent_gateway_secret_required");
    const authorization = { authorization: `Bearer ${admin}`, accept: "application/json" };
    const health = await request("runtime.health", `${RUNTIME_ORIGIN}/healthz`, authorization);
    ensure(health?.healthy === true && health.service === "feed-runtime", "runtime_health_invalid");
    report.readiness = safeReadiness(await request("runtime.ready", `${RUNTIME_ORIGIN}/readyz`, authorization), config);
    await request("runtime.ready_unauthorized", `${RUNTIME_ORIGIN}/readyz`, {}, 401);
    await request("feed.anonymous", `${RUNTIME_ORIGIN}/api/feed/projects`, {}, 401);
    await request("feed.forged", `${RUNTIME_ORIGIN}/api/feed/projects`, { "x-github-id": String(ACTOR_ID), "x-feed-gateway": "forged.invalid.signature" }, 401);
    if (config.mode === "all") {
      const identity = publicIdentity(await request("github.public_identity", IDENTITY_URL, { accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10", "user-agent": "ghfind-production-service-contract-smoke" }, 200, false));
      report.serviceIdentityVerified = true;
      const signed = (label, target) => request(label, `${RUNTIME_ORIGIN}${target}`, { accept: "application/json", "x-feed-gateway": gatewaySignature(identity, target, gateway) });
      const before = preferences(await signed("feed.preferences_before", "/api/feed/preferences"));
      const tags = await signed("feed.taxonomy", "/api/feed/tags");
      ensure(tags?.taxonomyVersion === before.taxonomyVersion && Array.isArray(tags.tags) && tags.tags.length > 0, "taxonomy_unavailable_or_changed");
      report.journey = "started";
      const first = page(await signed("feed.first_page", "/api/feed/projects?limit=2"));
      report.candidatesObserved = first.items.length;
      ensure(first.items.length > 0, "feed_candidates_empty");
      if (first.cursor) {
        const target = `/api/feed/projects?limit=2&cursor=${encodeURIComponent(first.cursor)}`;
        const next = page(await signed("feed.next_page", target));
        const retry = page(await signed("feed.repeat_page", target));
        ensure(JSON.stringify(next) === JSON.stringify(retry), "feed_cursor_retry_changed");
        const all = [...first.items, ...next.items];
        ensure(new Set(all.map(item => item.repoKey)).size === all.length, "feed_cursor_duplicates");
        for (const owner of new Set(all.map(item => item.owner))) ensure(all.filter(item => item.owner === owner).length <= 2, "feed_owner_cap_broken");
        report.cursorRepeatVerified = true;
        report.candidatesObserved += next.items.length;
      } else report.cursorRepeatVerified = false;
      const after = preferences(await signed("feed.preferences_after", "/api/feed/preferences"));
      ensure(JSON.stringify(before) === JSON.stringify(after), "profile_changed_during_smoke");
      report.profileReadback = { profileVersion: after.profileVersion, taxonomyVersion: after.taxonomyVersion, preferenceCount: after.preferences.length, unchanged: true };
      report.journey = "service_contract_passed";
    }
    ensure(now() - started < LIMITS.totalMs, "smoke_budget_exhausted");
    report.status = "passed";
  } catch (error) {
    report.failureCode = error instanceof SmokeError ? error.code : "smoke_failed";
    if (report.journey !== "not_requested") report.journey = "incomplete";
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Math.round(now() - started);
    save(report);
  }
  return report;
}

export async function main(argv, { env = process.env, fetcher = fetch, stdout = console.log } = {}) {
  const config = parseOptions(argv);
  if (!config.execute) { stdout(JSON.stringify(dryPlan(config), null, 2)); return 0; }
  const fd = openSync(config.output, "wx", 0o600);
  closeSync(fd);
  const save = report => writeFileSync(config.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const report = await runSmoke(config, { env, fetcher, save });
  stdout(`Production service-contract smoke ${report.status}; ${report.httpRequests} HTTP requests, 0 events; not real OAuth E2E.`);
  return report.status === "passed" ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => { console.error("Production service-contract smoke setup failed."); process.exitCode = 1; });
}
