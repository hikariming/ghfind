/**
 * Upstash Redis cache + rate limiting.
 *
 * Cache reads are always best-effort. Rate limiting also no-ops locally, but a
 * production deployment fails closed for protected cost-bearing routes when its
 * Redis limiter is unavailable. Caching scan results by username is the primary
 * cost lever — popular accounts get scanned repeatedly when a report is shared,
 * and a cache hit avoids both GitHub API calls and an LLM call.
 */

import { protectedScan, ScanBusyError, scanTtl } from "./scan-protection";
import { selectCacheStore, type CacheStore } from "./cache-store";
import { selectAtomicStore, type AtomicStore } from "./atomic-store";
import { parsePayload, scanSlot, scanSlots, slotCoordinator } from "./scan-slots";
import {
  durableObjectLimiter,
  getRateLimiterBinding,
  type Limiter,
  type LimitWindow,
} from "./rate-limit-backend";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { deployEnv } from "@/lib/deploy-env";
import {
  bypassGeneratedCaches,
  ROAST_CACHE_VERSION,
  SCORE_CACHE_VERSION,
  VERDICT_CACHE_VERSION,
} from "./cache-version";
import { score } from "./score";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "./scan-run-types";
import type {
  AccountDetail,
  FacetCategory,
  FacetRank,
  LeaderboardEntry,
  LeaderboardWindow,
  ScoreHistogramRow,
} from "./db";
import type { FacetType } from "./facets";
import type { Lang } from "./lang";
import type { ProfileReactionCounts } from "./reactions";
import type { RoastJudgeResult, RoastLine, ScanResult } from "./types";

let redis: Redis | null = null;
const limiters = new Map<string, Limiter>();
const localProjectAnalysisWindows = new Map<string, { count: number; reset: number }>();
const PROJECT_ANALYSIS_LIMIT = 5;
const PROJECT_ANALYSIS_WINDOW_MS = 60 * 60 * 1_000;
const PROJECT_ANALYSIS_RESULT_TTL_SECONDS = 60 * 60 * 24 * 30;

export const RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS = 15;
const LIMITER_UNAVAILABLE_LOG_INTERVAL_MS = 60_000;
const limiterUnavailableLogAt = new Map<string, number>();

// Rate limiting fails CLOSED on production outages (see unavailableRateLimitResult)
// — this check must recognize production on every platform we deploy to.
function isProductionDeployment(): boolean {
  return (
    deployEnv() === "production" ||
    (process.env.NODE_ENV === "production" && deployEnv() !== "preview")
  );
}

function logRateLimitUnavailable(limiter: string, reason: string): void {
  const now = Date.now();
  const last = limiterUnavailableLogAt.get(limiter) ?? 0;
  if (now - last < LIMITER_UNAVAILABLE_LOG_INTERVAL_MS) return;
  limiterUnavailableLogAt.set(limiter, now);
  console.error("rate_limit_unavailable", { limiter, reason });
}

function unavailableRateLimitResult(limiter: string, reason: string): RateLimitResult {
  if (!isProductionDeployment()) return { success: true };
  if (process.env.RATE_LIMIT_FAIL_OPEN === "1") {
    logRateLimitUnavailable(limiter, "operator_fail_open_override");
    return { success: true };
  }
  logRateLimitUnavailable(limiter, reason);
  return {
    success: false,
    unavailable: true,
    retryAfter: RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS,
  };
}

function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  // The client defaults to `cache: "no-store"`, and a no-store fetch inside an
  // ISR page flips it "static → dynamic" at runtime (a 500 under next start).
  // Upstash REST calls are POSTs, which Next's data cache never caches anyway,
  // so "default" changes nothing about freshness — it only stops Redis reads
  // from poisoning static rendering (the /developers facet boards).
  redis = new Redis({ url, token, cache: "default", signal: () => AbortSignal.timeout(3000), retry: false });
  return redis;
}

/**
 * Sliding-window limiter for `prefix`, memoized per backend. The RateLimiter
 * Durable Object (ghfind-coord) when the deployment sets
 * GHFIND_RATELIMIT_BACKEND=do and binds RATE_LIMITER; otherwise Upstash.
 * Both run the same algorithm over the same `<prefix>:<id>` keys. Null when
 * neither is available (callers decide fail-open vs fail-closed).
 */
function rateLimiter(prefix: string, tokens: number, window: LimitWindow): Limiter | null {
  const durableObjects =
    process.env.GHFIND_RATELIMIT_BACKEND === "do" ? getRateLimiterBinding() : null;
  const memoKey = `${durableObjects ? "do" : "redis"}:${prefix}`;
  const existing = limiters.get(memoKey);
  if (existing) return existing;
  let limiter: Limiter;
  if (durableObjects) {
    limiter = durableObjectLimiter(durableObjects, prefix, tokens, window);
  } else {
    const r = getRedis();
    if (!r) return null;
    limiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(tokens, window),
      prefix,
      analytics: false,
    });
  }
  limiters.set(memoKey, limiter);
  return limiter;
}

/**
 * Backend for single-key coordination state that needs read-your-writes:
 * roast/verdict caches and their single-flight locks, the lookup gate, and
 * campaign revisions. The KeyValue Durable Object (ghfind-coord) when the
 * deployment sets GHFIND_COORD_BACKEND=do and binds COORD_KV; else Redis.
 */
function atomicStore(): AtomicStore | null {
  return selectAtomicStore(getRedis());
}

/**
 * Backend for the public read-model caches below (KV or Redis, per deployment
 * — see cache-store.ts). Scan/roast/verdict caches coordinate with locks and
 * stay on Redis until they move to Durable Objects.
 */
function cacheStore(): CacheStore | null {
  return selectCacheStore(getRedis());
}

export const scanKey = (username: string) =>
  `scan:${PUBLIC_SCAN_COLLECTION_VERSION}:${username.toLowerCase()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getCachedScan(username: string): Promise<ScanResult | null> {
  if (bypassGeneratedCaches()) return null;
  const slots = scanSlots();
  if (slots) {
    try {
      const cached = parsePayload<ScanResult>(await scanSlot(slots, scanKey(username)).payload());
      return cached ? { ...cached, scoring: score(cached.metrics) } : null;
    } catch {
      return null;
    }
  }
  const r = getRedis();
  if (!r) return null;
  try {
    const cached = (await r.get<ScanResult>(scanKey(username))) ?? null;
    return cached ? { ...cached, scoring: score(cached.metrics) } : null;
  } catch {
    return null;
  }
}

export async function setCachedScan(username: string, scan: ScanResult): Promise<void> {
  if (bypassGeneratedCaches()) return;
  const slots = scanSlots();
  if (slots) {
    await scanSlot(slots, scanKey(username)).setPayload(JSON.stringify(scan), scanTtl()).catch(() => {});
    return;
  }
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(scanKey(username), scan, { ex: scanTtl() });
  } catch {
    // best-effort cache; ignore failures
  }
}

/** Remove a bounded quick snapshot when it is corrupt or superseded. */
export async function clearCachedScan(username: string): Promise<void> {
  const slots = scanSlots();
  if (slots) {
    await scanSlot(slots, scanKey(username)).clearPayload().catch(() => {});
    return;
  }
  const r = getRedis();
  if (!r) return;
  await r.del(scanKey(username)).catch(() => {});
}

const scoreDetailRevisionKey = (username: string) =>
  `score-detail-revision:${SCORE_CACHE_VERSION}:${PUBLIC_SCAN_COLLECTION_VERSION}:${username.toLowerCase()}`;

async function scoreDetailRevision(
  r: { get<T>(key: string): Promise<T | null> },
  username: string,
): Promise<string> {
  try {
    const revision = await r.get<string>(scoreDetailRevisionKey(username));
    if (revision === null) return "initial";
    if (typeof revision !== "string" || !/^[a-zA-Z0-9-]+$/.test(revision)) throw new ScanBusyError();
    return revision;
  } catch {
    throw new ScanBusyError();
  }
}

/** Move readers to a new namespace only after canonical publication. Old
 * in-flight readers can fill their old key, but cannot poison the new one.
 * Keep this pointer without a TTL: expiring it could resurrect an initial key.
 * A configured Redis failure must fail publication rather than claim freshness.
 */
export async function advanceScoreDetailRevision(username: string): Promise<void> {
  // With Durable Objects the pointer lives in the KeyValue object (no TTL).
  if (scanSlots()) {
    const store = atomicStore();
    if (!store) throw new ScanBusyError();
    await store.set(scoreDetailRevisionKey(username), crypto.randomUUID());
    return;
  }
  const r = getRedis();
  if (!r) {
    if (isProductionDeployment()) throw new ScanBusyError();
    return;
  }
  await r.set(scoreDetailRevisionKey(username), crypto.randomUUID());
}

/** Cache-aside indexed reads retry if publication races their database load. */
export async function getCachedScoreDetail(
  username: string,
  load: () => Promise<AccountDetail | null>,
): Promise<AccountDetail | null> {
  const slots = scanSlots();
  const pointers = slots ? atomicStore() : null;
  if (bypassGeneratedCaches() && !isProductionDeployment()) return load();
  if (slots && pointers) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = await scoreDetailRevision(pointers, username);
      const key = `score-detail:${SCORE_CACHE_VERSION}:${PUBLIC_SCAN_COLLECTION_VERSION}:${username.toLowerCase()}:generation:${revision}`;
      const slot = scanSlot(slots, key);
      const result = await protectedScan({
        coordinator: slotCoordinator(slot, "score-detail:active-readers:v1", false),
        key,
        read: async () => {
          try { return parsePayload<{ detail: AccountDetail | null }>(await slot.payload()); }
          catch { return null; }
        },
        produce: async () => ({ detail: await load() }),
        ttl: result => result.detail ? scanTtl() : 10,
      });
      if (await scoreDetailRevision(pointers, username) === revision) return result.detail;
    }
    throw new ScanBusyError();
  }
  const r = getRedis();
  if (!r) {
    if (isProductionDeployment()) throw new ScanBusyError();
    return load();
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = await scoreDetailRevision(r, username);
    const key = `score-detail:${SCORE_CACHE_VERSION}:${PUBLIC_SCAN_COLLECTION_VERSION}:${username.toLowerCase()}:generation:${revision}`;
    const result = await protectedScan({
      redis: r, key,
      read: async () => {
        try { return await r.get<{ detail: AccountDetail | null }>(key); }
        catch { return null; }
      },
      produce: async () => ({ detail: await load() }),
      ttl: result => result.detail ? scanTtl() : 10,
      capacityKey: "score-detail:active-readers:v1",
    });
    if (await scoreDetailRevision(r, username) === revision) return result.detail;
  }
  throw new ScanBusyError();
}

// Atomically pair the payload and publication marker. A forced caller may
// join a scan published after arrival, but never accept its warm baseline.
export const READ_REFRESHED_SCAN = `
local revision = redis.call('GET', KEYS[2])
if not revision or revision == ARGV[1] then return nil end
return redis.call('GET', KEYS[1])`;

/** Cache misses and forced refreshes retain the same distributed admission. */
export async function coalesceScan(
  username: string,
  producer: () => Promise<ScanResult>,
  options: { force?: boolean } = {},
): Promise<ScanResult> {
  if (bypassGeneratedCaches() && !isProductionDeployment()) return producer();
  const slots = scanSlots();
  if (slots) {
    const slot = scanSlot(slots, scanKey(username));
    let baseline = "";
    if (options.force) {
      try { baseline = (await slot.revision()) ?? ""; }
      catch { throw new ScanBusyError(); }
    }
    return protectedScan({
      coordinator: slotCoordinator(slot, "scan:active-producers:v1", true),
      key: scanKey(username),
      read: options.force ? async () => {
        try {
          const cached = parsePayload<ScanResult>(await slot.payloadAfter(baseline));
          return cached ? { ...cached, scoring: score(cached.metrics) } : null;
        } catch { throw new ScanBusyError(); }
      } : () => getCachedScan(username),
      produce: producer,
    });
  }
  const r = getRedis();
  if (!r) {
    if (isProductionDeployment()) throw new ScanBusyError();
    return producer();
  }
  const key = scanKey(username);
  const revisionKey = `revision:${key}`;
  let baseline = "";
  if (options.force) {
    try { baseline = (await r.get<string>(revisionKey)) ?? ""; }
    catch { throw new ScanBusyError(); }
  }
  return protectedScan({ redis: r, key, revisionKey,
    read: options.force ? async () => {
      try {
        const value = await r.eval(READ_REFRESHED_SCAN, [key, revisionKey], [baseline]) as ScanResult | string | null;
        if (!value) return null;
        const cached = typeof value === "string" ? JSON.parse(value) as ScanResult : value;
        return { ...cached, scoring: score(cached.metrics) };
      } catch { throw new ScanBusyError(); }
    } : () => getCachedScan(username),
    produce: producer,
  });
}

/**
 * Best-effort NX gate in front of the Turso heat-lookup transaction. Heat
 * counts once per (username, ip) per window, so replays within the window can
 * be answered by one cheap Redis call instead of opening a Turso write
 * transaction each time — a bot burst replaying the same handles exhausted the
 * connection pool (2026-07 incident). Returns true when the caller should
 * proceed to the Turso gate: first sight of the pair, Redis unconfigured, or
 * Redis erroring — Turso stays the source of truth.
 */
export async function tryAcquireLookupGate(
  key: string,
  windowSeconds: number,
): Promise<boolean> {
  const r = atomicStore();
  if (!r) return true;
  try {
    return await r.setIfAbsent(key, "1", windowSeconds);
  } catch {
    return true;
  }
}

/** Release a lookup gate acquired by tryAcquireLookupGate, so a failed Turso
 *  write doesn't suppress the count for a whole window. Best-effort. */
export async function releaseLookupGate(key: string): Promise<void> {
  const r = atomicStore();
  if (!r) return;
  await r.del(key).catch(() => {});
}

/** Rate-limit outcome. `limit`/`remaining`/`reset` are present when Redis is
 *  configured (reset is epoch ms) so callers can emit RFC RateLimit headers. */
export interface RateLimitResult {
  success: boolean;
  limit?: number;
  remaining?: number;
  reset?: number;
  /** The limiter infrastructure could not be used, distinct from a spent budget. */
  unavailable?: boolean;
  /** A short retry interval for an unavailable limiter. */
  retryAfter?: number;
}

/**
 * Build standard RateLimit response headers from a limiter result, plus
 * Retry-After (seconds) when the request was blocked. Returns {} when the
 * limiter no-op'd (no Redis), so it's safe to always spread into headers.
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  if (result.unavailable) {
    return {
      "Retry-After": String(result.retryAfter ?? RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS),
    };
  }
  if (result.limit === undefined || result.reset === undefined) return {};
  const resetSeconds = Math.max(0, Math.ceil((result.reset - Date.now()) / 1000));
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(Math.max(0, result.remaining ?? 0)),
    "RateLimit-Reset": String(resetSeconds),
  };
  if (!result.success) headers["Retry-After"] = String(resetSeconds || 1);
  return headers;
}

/** Per-principal sliding-window limiter for scan and bounded public-read routes. */
export async function checkRateLimit(principal: string): Promise<RateLimitResult> {
  const scanLimiter = rateLimiter("rl:scan", 10, "60 s");
  if (!scanLimiter) return unavailableRateLimitResult("scan", "missing_redis_config");
  try {
    const { success, limit, remaining, reset } = await scanLimiter.limit(principal);
    return { success, limit, remaining, reset };
  } catch (error) {
    return unavailableRateLimitResult(
      "scan",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

/** Wider second-line scan budget for browsers sharing one public network. */
export async function checkScanNetworkRateLimit(ip: string): Promise<RateLimitResult> {
  const scanNetworkLimiter = rateLimiter("rl:scan-network", 60, "60 s");
  if (!scanNetworkLimiter) return unavailableRateLimitResult("scan_network", "missing_redis_config");
  try {
    const { success, limit, remaining, reset } = await scanNetworkLimiter.limit(ip);
    return { success, limit, remaining, reset };
  } catch (error) {
    return unavailableRateLimitResult(
      "scan_network",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

/**
 * Public event leaderboard refreshes fan out from many browsers that may share
 * one venue NAT. Keep them off the scan budget while still bounding origin reads.
 */
export async function checkCampaignLeaderboardReadRateLimit(
  ip: string,
): Promise<RateLimitResult> {
  const campaignLeaderboardReadLimiter = rateLimiter("rl:campaign-leaderboard-read", 600, "60 s");
  if (!campaignLeaderboardReadLimiter) {
    return unavailableRateLimitResult(
      "campaign_leaderboard_read",
      "missing_redis_config",
    );
  }
  try {
    const { success, limit, remaining, reset } =
      await campaignLeaderboardReadLimiter.limit(ip);
    return { success, limit, remaining, reset };
  } catch (error) {
    return unavailableRateLimitResult(
      "campaign_leaderboard_read",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

/**
 * Gate every roast request before it reads a durable run or scan cache. This is
 * separate from the stricter default-model credit limiter: BYO requests do not
 * spend our model credit, but they still invoke a function and read Turso.
 */
export async function checkRoastRequestRateLimit(principal: string): Promise<RateLimitResult> {
  const roastRequestLimiter = rateLimiter("rl:roast-request", 20, "60 s");
  if (!roastRequestLimiter) return unavailableRateLimitResult("roast_request", "missing_redis_config");
  try {
    const { success, limit, remaining, reset } = await roastRequestLimiter.limit(principal);
    return { success, limit, remaining, reset };
  } catch (error) {
    return unavailableRateLimitResult(
      "roast_request",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

/** Wider second-line request budget for browsers sharing one public network. */
export async function checkRoastRequestNetworkRateLimit(ip: string): Promise<RateLimitResult> {
  const roastRequestNetworkLimiter = rateLimiter("rl:roast-request-network", 120, "60 s");
  if (!roastRequestNetworkLimiter) return unavailableRateLimitResult("roast_request_network", "missing_redis_config");
  try {
    const { success, limit, remaining, reset } = await roastRequestNetworkLimiter.limit(ip);
    return { success, limit, remaining, reset };
  } catch (error) {
    return unavailableRateLimitResult(
      "roast_request_network",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

/** Project analysis starts a long-running Cattle Agent, so it uses a separate,
 * tighter budget than account scans. Turso still deduplicates identical active
 * analyses; this protects against many distinct repository submissions. */
export async function checkProjectAnalysisRateLimit(ip: string): Promise<RateLimitResult> {
  const projectAnalysisLimiter = rateLimiter("rl:project-analysis", PROJECT_ANALYSIS_LIMIT, "60 m");
  if (!projectAnalysisLimiter) return localProjectAnalysisRateLimit(ip);
  try {
    const { success, limit, remaining, reset } = await projectAnalysisLimiter.limit(ip);
    return { success, limit, remaining, reset };
  } catch {
    return localProjectAnalysisRateLimit(ip);
  }
}

const projectAnalysisResultKey = (fingerprint: string) =>
  `project-analysis:completed:v1:${fingerprint}`;

export async function getCachedProjectAnalysisId(
  fingerprint: string,
): Promise<string | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    const value = await r.get<string>(projectAnalysisResultKey(fingerprint));
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function setCachedProjectAnalysisId(
  fingerprint: string,
  analysisId: string,
): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(projectAnalysisResultKey(fingerprint), analysisId, PROJECT_ANALYSIS_RESULT_TTL_SECONDS);
  } catch {
    // Best-effort index only. Durable project analysis remains the source of truth.
  }
}

const GITHUB_NAME_TTL_SECONDS = 60 * 60 * 24;
const githubNameKey = (username: string) => `github-name:v1:${username.toLowerCase()}`;

/**
 * Cached public GitHub profile name (collections' nickname fallback).
 * `undefined` = not cached; `null` = cached "profile has no name".
 */
export async function getCachedGitHubName(username: string): Promise<string | null | undefined> {
  const r = cacheStore();
  if (!r) return undefined;
  try {
    const value = await r.get<{ name: string | null }>(githubNameKey(username));
    return value && typeof value === "object" && "name" in value ? value.name : undefined;
  } catch {
    return undefined;
  }
}

export async function setCachedGitHubName(username: string, name: string | null): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  await r.set(githubNameKey(username), { name }, GITHUB_NAME_TTL_SECONDS).catch(() => {});
}

export async function clearCachedProjectAnalysisId(
  fingerprint: string,
): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  await r.del(projectAnalysisResultKey(fingerprint)).catch(() => {});
}

function localProjectAnalysisRateLimit(ip: string): RateLimitResult {
  const now = Date.now();
  if (localProjectAnalysisWindows.size > 10_000) {
    for (const [key, value] of localProjectAnalysisWindows) {
      if (value.reset <= now) localProjectAnalysisWindows.delete(key);
    }
  }
  const current = localProjectAnalysisWindows.get(ip);
  const window = !current || current.reset <= now
    ? { count: 0, reset: now + PROJECT_ANALYSIS_WINDOW_MS }
    : current;
  window.count += 1;
  localProjectAnalysisWindows.set(ip, window);
  return {
    success: window.count <= PROJECT_ANALYSIS_LIMIT,
    limit: PROJECT_ANALYSIS_LIMIT,
    remaining: Math.max(0, PROJECT_ANALYSIS_LIMIT - window.count),
    reset: window.reset,
  };
}

/**
 * Per-IP limiter for the MCP server. Tighter than the web scan limiter — the
 * tools are unauthenticated and callable in a loop by an autonomous agent, so we
 * cap harder to protect the GitHub token and DB.
 */
export async function checkMcpRateLimit(ip: string): Promise<RateLimitResult> {
  const mcpLimiter = rateLimiter("rl:mcp", 15, "60 s");
  if (!mcpLimiter) return unavailableRateLimitResult("mcp", "missing_redis_config");
  try {
    const { success } = await mcpLimiter.limit(ip);
    return { success };
  } catch (error) {
    return unavailableRateLimitResult(
      "mcp",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

/**
 * Per-principal limiter for the (expensive) roast endpoint — the LLM call burns the
 * operator's credit, so it's limited tighter than scans: a burst window and a
 * daily cap. Only gates the default model; BYO keys are not limited.
 */
export async function checkRoastRateLimit(principal: string): Promise<RateLimitResult> {
  const roastMinuteLimiter = rateLimiter("rl:roast:m", 8, "60 s");
  const roastDayLimiter = rateLimiter("rl:roast:d", 60, "1 d");
  if (!roastMinuteLimiter || !roastDayLimiter) return unavailableRateLimitResult("roast_generation", "missing_redis_config");
  try {
    const [minute, day] = await Promise.all([
      roastMinuteLimiter.limit(principal),
      roastDayLimiter.limit(principal),
    ]);
    return { success: minute.success && day.success };
  } catch (error) {
    return unavailableRateLimitResult(
      "roast_generation",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

/** Wider network-level generation budget, separate from each signed browser. */
export async function checkRoastNetworkRateLimit(ip: string): Promise<RateLimitResult> {
  const roastNetworkMinuteLimiter = rateLimiter("rl:roast-network:m", 48, "60 s");
  const roastNetworkDayLimiter = rateLimiter("rl:roast-network:d", 480, "1 d");
  if (!roastNetworkMinuteLimiter || !roastNetworkDayLimiter) return unavailableRateLimitResult("roast_generation_network", "missing_redis_config");
  try {
    const [minute, day] = await Promise.all([
      roastNetworkMinuteLimiter.limit(ip),
      roastNetworkDayLimiter.limit(ip),
    ]);
    return { success: minute.success && day.success };
  } catch (error) {
    return unavailableRateLimitResult(
      "roast_generation_network",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

/** Cached roast: the LLM-written report + deterministic score metadata, keyed
 * by every input contract plus language and username (48h). A compatible
 * persisted roast can re-warm this cache after expiry without another LLM call.
 */
export interface CachedRoast {
  report: string;
  /** Exact canonical scan identity. Missing on pre-migration cache entries. */
  snapshot_hash?: string;
  /** Retained in the wire shape for compatibility; deterministic scoring fixes it at zero. */
  delta: 0;
  tags: import("./types").Tags;
  /** Persisted final score for archived/cache replay. Older cache entries omit it. */
  final_score?: number;
  /** Persisted tier for archived/cache replay. Older cache entries omit it. */
  tier?: import("./types").Tier;
  /** Bilingual one-liner (optional: pre-deploy entries lack it; caller defaults). */
  roast_line?: import("./types").RoastLine;
}

const ROAST_TTL_SECONDS = 60 * 60 * 48;
export const roastKey = (username: string, lang: Lang) =>
  `roast:${ROAST_CACHE_VERSION}:${SCORE_CACHE_VERSION}:${PUBLIC_SCAN_COLLECTION_VERSION}:${lang}:${username.toLowerCase()}`;

export async function getCachedRoast(username: string, lang: Lang): Promise<CachedRoast | null> {
  if (bypassGeneratedCaches()) return null;
  const r = atomicStore();
  if (!r) return null;
  try {
    return (await r.get<CachedRoast>(roastKey(username, lang))) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedRoast(
  username: string,
  lang: Lang,
  value: CachedRoast,
): Promise<void> {
  if (bypassGeneratedCaches()) return;
  const r = atomicStore();
  if (!r) return;
  try {
    await r.set(roastKey(username, lang), value, ROAST_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

/**
 * Drop the cached roast so a validated `refresh` regenerates instead of
 * replaying — single-flight followers then wait on the NEW report rather than
 * an archive-re-warmed old one. Best-effort, like the other cache writes.
 */
export async function clearCachedRoast(username: string, lang: Lang): Promise<void> {
  if (bypassGeneratedCaches()) return;
  const r = atomicStore();
  if (!r) return;
  try {
    await r.del(roastKey(username, lang));
  } catch {
    // best-effort
  }
}

export interface CachedRoastJudge {
  base_score: number;
  judge: RoastJudgeResult;
}

export const roastJudgeKey = (username: string) =>
  `roast-judge:${ROAST_CACHE_VERSION}:${SCORE_CACHE_VERSION}:${PUBLIC_SCAN_COLLECTION_VERSION}:${username.toLowerCase()}`;

export async function getCachedRoastJudge(username: string): Promise<CachedRoastJudge | null> {
  if (bypassGeneratedCaches()) return null;
  const r = atomicStore();
  if (!r) return null;
  try {
    return (await r.get<CachedRoastJudge>(roastJudgeKey(username))) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedRoastJudge(
  username: string,
  value: CachedRoastJudge,
): Promise<void> {
  if (bypassGeneratedCaches()) return;
  const r = atomicStore();
  if (!r) return;
  try {
    await r.set(roastJudgeKey(username), value, ROAST_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

// Single-flight for roast generation — the analogue of `coalesceScan` for the
// (credit-spending) LLM call. When a hot account's roast cache goes cold and N
// requests arrive at once, only the lock holder runs the LLM; the rest wait for
// its result via the cache. Without this, a viral account re-generates N times
// per cold window instead of once.
// Crash safety net only — the success/error paths release the lock explicitly.
// Must exceed the route's 220s LLM deadline: at the old 60s the lock could expire
// mid-generation, so under concurrency followers
// saw "lock gone, no cache", stopped coalescing and burned a duplicate LLM call.
const ROAST_LOCK_TTL_SECONDS = 270;
const roastLockKey = (username: string, lang: Lang) =>
  `lock:roast:${ROAST_CACHE_VERSION}:${SCORE_CACHE_VERSION}:${PUBLIC_SCAN_COLLECTION_VERSION}:${lang}:${username.toLowerCase()}`;

/** Try to become the sole generator for (username, lang). `true` = leader.
 *  Without Redis there's no coordination, so everyone leads (behavior unchanged). */
export async function acquireRoastLock(username: string, lang: Lang): Promise<boolean> {
  if (bypassGeneratedCaches()) return true;
  const r = atomicStore();
  if (!r) return true;
  try {
    return await r.setIfAbsent(roastLockKey(username, lang), "1", ROAST_LOCK_TTL_SECONDS);
  } catch {
    return true; // Redis hiccup — don't block the roast.
  }
}

export async function releaseRoastLock(username: string, lang: Lang): Promise<void> {
  if (bypassGeneratedCaches()) return;
  const r = atomicStore();
  if (!r) return;
  try {
    await r.del(roastLockKey(username, lang));
  } catch {
    // best-effort
  }
}

/**
 * A non-leader waits for the leader's finished roast to land in cache. Polls
 * until the cache appears, the lock is released (leader finished or errored), or
 * the timeout elapses. Returns the cached roast, or null so the caller can fall
 * back to generating itself rather than starve.
 */
export async function waitForCachedRoast(
  username: string,
  lang: Lang,
  // The loop exits the moment the leader releases the lock, so this ceiling is
  // only reached when the leader is genuinely slow. Giving up too early merely
  // duplicates its work.
  timeoutMs = 120000,
): Promise<CachedRoast | null> {
  if (bypassGeneratedCaches()) return null;
  const r = atomicStore();
  if (!r) return null;
  const steps = Math.max(1, Math.floor(timeoutMs / 500));
  for (let i = 0; i < steps; i++) {
    await sleep(500);
    const cached = await getCachedRoast(username, lang);
    if (cached) return cached;
    const stillLocked = await r.get(roastLockKey(username, lang)).catch(() => null);
    // Lock gone: leader finished (and may have just written cache) or errored.
    // Re-check the cache once to avoid the write/release race before giving up.
    if (!stillLocked) return (await getCachedRoast(username, lang)) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// PK (versus) verdict — bilingual LLM savage verdict + self-improvement advice,
// cached per canonical matchup for ~5 days so the model is called at most once
// per score snapshot per window. Mirrors the roast cache/lock/limit machinery.
// ---------------------------------------------------------------------------

export interface CachedVerdict {
  verdict: RoastLine;
  advice: RoastLine;
  winner: string | null;
  bucket: string;
  /** Scores used to generate this verdict; older entries are treated as stale. */
  scoreA?: number;
  scoreB?: number;
}

const VERDICT_TTL_SECONDS = 60 * 60 * 24 * 5; // ~5 days
const VERDICT_LOCK_TTL_SECONDS = 60;

/** Canonical (lowercased, dictionary-sorted) pair key — so /vs/a/b and /vs/b/a
 *  share one cache entry. */
function verdictPair(a: string, b: string): string {
  return [a.toLowerCase(), b.toLowerCase()].sort().join("|");
}
export const verdictKey = (a: string, b: string) =>
  `verdict:${VERDICT_CACHE_VERSION}:${verdictPair(a, b)}`;
const verdictLockKey = (a: string, b: string) => `lock:verdict:${verdictPair(a, b)}`;

export async function getCachedVerdict(
  a: string,
  b: string,
  expectedScores?: { scoreA: number; scoreB: number },
): Promise<CachedVerdict | null> {
  if (bypassGeneratedCaches()) return null;
  const r = atomicStore();
  if (!r) return null;
  try {
    const cached = (await r.get<CachedVerdict>(verdictKey(a, b))) ?? null;
    if (
      cached &&
      expectedScores &&
      (cached.scoreA !== expectedScores.scoreA || cached.scoreB !== expectedScores.scoreB)
    ) {
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

export async function setCachedVerdict(
  a: string,
  b: string,
  value: CachedVerdict,
): Promise<void> {
  if (bypassGeneratedCaches()) return;
  const r = atomicStore();
  if (!r) return;
  try {
    await r.set(verdictKey(a, b), value, VERDICT_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

export async function acquireVerdictLock(a: string, b: string): Promise<boolean> {
  if (bypassGeneratedCaches()) return true;
  const r = atomicStore();
  if (!r) return true;
  try {
    return await r.setIfAbsent(verdictLockKey(a, b), "1", VERDICT_LOCK_TTL_SECONDS);
  } catch {
    return true;
  }
}

export async function releaseVerdictLock(a: string, b: string): Promise<void> {
  if (bypassGeneratedCaches()) return;
  const r = atomicStore();
  if (!r) return;
  try {
    await r.del(verdictLockKey(a, b));
  } catch {
    // best-effort
  }
}

/** Non-leader waits for the leader's verdict to land in cache (see waitForCachedRoast). */
export async function waitForCachedVerdict(
  a: string,
  b: string,
  expectedScores?: { scoreA: number; scoreB: number },
  timeoutMs = 45000,
): Promise<CachedVerdict | null> {
  if (bypassGeneratedCaches()) return null;
  const r = atomicStore();
  if (!r) return null;
  const steps = Math.max(1, Math.floor(timeoutMs / 500));
  for (let i = 0; i < steps; i++) {
    await sleep(500);
    const cached = await getCachedVerdict(a, b, expectedScores);
    if (cached) return cached;
    const stillLocked = await r.get(verdictLockKey(a, b)).catch(() => null);
    if (!stillLocked) return (await getCachedVerdict(a, b, expectedScores)) ?? null;
  }
  return null;
}

/** Per-IP limiter for the PK verdict LLM call (operator credit). Burst + daily. */
export async function checkVerdictRateLimit(ip: string): Promise<RateLimitResult> {
  const verdictMinuteLimiter = rateLimiter("rl:verdict:m", 6, "60 s");
  const verdictDayLimiter = rateLimiter("rl:verdict:d", 40, "1 d");
  if (!verdictMinuteLimiter || !verdictDayLimiter) return unavailableRateLimitResult("vs_verdict", "missing_redis_config");
  try {
    const [minute, day] = await Promise.all([
      verdictMinuteLimiter.limit(ip),
      verdictDayLimiter.limit(ip),
    ]);
    return { success: minute.success && day.success };
  } catch (error) {
    return unavailableRateLimitResult(
      "vs_verdict",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

// Score histogram backing rank/percentile lookups (lib/rank.ts): one
// whole-table aggregate per TTL serves every profile page, /api/score, share
// card and MCP call, instead of an O(table) scan per request.
const SCORE_HISTOGRAM_KEY = "score-hist:v2";
// Whole-table aggregate (~59k rows_read per refresh) behind every rank and
// percentile. Fresh for 30 min, then served stale while one isolate refreshes
// it: with a plain TTL every isolate that read during the refresh missed at
// once (~24 refreshes/hour at a 30 min TTL, ~36 at 5 min).
export const SCORE_HISTOGRAM_FRESH_MS = 30 * 60_000;
const SCORE_HISTOGRAM_TTL_SECONDS = 6 * 3600;
const SCORE_HISTOGRAM_REFRESH_LOCK = "lock:score-hist";
// Covers one aggregate query; a crashed refresher frees it soon after.
const SCORE_HISTOGRAM_REFRESH_LOCK_SECONDS = 60;

export interface CachedScoreHistogram {
  rows: ScoreHistogramRow[];
  /** Epoch ms the aggregate was computed. */
  at: number;
}

export async function getCachedScoreHistogram(): Promise<CachedScoreHistogram | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    const v = await r.get<CachedScoreHistogram>(SCORE_HISTOGRAM_KEY);
    return v && Array.isArray(v.rows) && typeof v.at === "number" ? v : null;
  } catch {
    return null;
  }
}

export async function setCachedScoreHistogram(rows: ScoreHistogramRow[]): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(SCORE_HISTOGRAM_KEY, { rows, at: Date.now() }, SCORE_HISTOGRAM_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

/** `true` = this caller refreshes a stale histogram; everyone else keeps
 *  serving the stale copy. Without an atomic store everyone refreshes. */
export async function acquireScoreHistogramRefresh(): Promise<boolean> {
  const r = atomicStore();
  if (!r) return true;
  try {
    return await r.setIfAbsent(SCORE_HISTOGRAM_REFRESH_LOCK, "1", SCORE_HISTOGRAM_REFRESH_LOCK_SECONDS);
  } catch {
    return true;
  }
}

const STATS_KEY = "stats:count";
// The homepage counter is decorative; COUNT(*) FROM scores reads every row
// (~42k), so refresh it every 10 minutes, not every minute.
const STATS_TTL_SECONDS = 600;

export async function getCachedStats(): Promise<number | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    const v = await r.get<number>(STATS_KEY);
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

export async function setCachedStats(total: number): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(STATS_KEY, total, STATS_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

// Stored project eligibility only drifts when the eligibility rules change in a
// deploy (new analyses are finalized with current rules), so one isolate per
// hour re-checks it instead of every cold isolate scanning every assessment.
const PROJECT_ELIGIBILITY_KEY = "projects:eligibility-reconciled:v1";
const PROJECT_ELIGIBILITY_TTL_SECONDS = 3600;

export async function isProjectEligibilityReconciled(): Promise<boolean> {
  const r = cacheStore();
  if (!r) return false;
  try {
    return (await r.get<number>(PROJECT_ELIGIBILITY_KEY)) === 1;
  } catch {
    return false;
  }
}

export async function markProjectEligibilityReconciled(): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(PROJECT_ELIGIBILITY_KEY, 1, PROJECT_ELIGIBILITY_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

export type LeaderboardCacheView = "trending" | "score" | "heat" | "progress";

const LEADERBOARD_VIEWS: LeaderboardCacheView[] = ["trending", "score", "heat", "progress"];
const LEADERBOARD_WINDOWS: LeaderboardWindow[] = ["24h", "7d", "30d", "all"];

// One Redis entry per (view, window) pair — 4 × 4 = 16 keys, each a slow-moving
// 500-row payload. A hit skips the triple-LEFT-JOIN DB read entirely.
const leaderboardKey = (view: LeaderboardCacheView, window: LeaderboardWindow) =>
  `leaderboard:v2:${view}:${window}`;
export const LEADERBOARD_FRESH_MS = 5 * 60_000;
const LEADERBOARD_TTL_SECONDS = 30 * 60;
export interface CachedLeaderboard { entries: LeaderboardEntry[]; at: number }

/** Coordinate stale refreshes across isolates; retain the lease until expiry
 * so eventually consistent KV readers cannot trigger another refresh at once. */
export async function acquireLeaderboardRefresh(view: LeaderboardCacheView, window: LeaderboardWindow): Promise<boolean> {
  const r = atomicStore();
  if (!r) return true;
  try { return await r.setIfAbsent(`lock:leaderboard:v2:${view}:${window}`, "1", 60); }
  catch { return true; }
}
const CAMPAIGN_LEADERBOARD_REVISION_TTL_SECONDS = 7 * 24 * 60 * 60;
const localCampaignLeaderboardRevisions = new Map<string, number>();
const campaignLeaderboardRevisionKey = (campaign: string) =>
  `campaign-leaderboard:${campaign}:revision`;

/** Signal that a campaign board's persisted membership or score changed. */
export async function bumpCampaignLeaderboardRevision(campaign: string): Promise<void> {
  const r = atomicStore();
  if (!r) {
    localCampaignLeaderboardRevisions.set(
      campaign,
      (localCampaignLeaderboardRevisions.get(campaign) ?? 0) + 1,
    );
    return;
  }
  try {
    await r.incr(campaignLeaderboardRevisionKey(campaign), CAMPAIGN_LEADERBOARD_REVISION_TTL_SECONDS);
  } catch {
    // Best-effort live signal. The client keeps its periodic refresh fallback.
  }
}

/** Current cross-instance revision consumed by the campaign SSE endpoint. */
export async function getCampaignLeaderboardRevision(campaign: string): Promise<number | null> {
  const r = atomicStore();
  if (!r) return localCampaignLeaderboardRevisions.get(campaign) ?? 0;
  try {
    return (await r.get<number>(campaignLeaderboardRevisionKey(campaign))) ?? 0;
  } catch {
    return null;
  }
}

export async function getCachedLeaderboard(
  view: LeaderboardCacheView = "trending",
  window: LeaderboardWindow = "all",
): Promise<CachedLeaderboard | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    const value = await r.get<CachedLeaderboard>(leaderboardKey(view, window));
    return value && Array.isArray(value.entries) && typeof value.at === "number" ? value : null;
  } catch {
    return null;
  }
}

export async function setCachedLeaderboard(
  entries: LeaderboardEntry[],
  view: LeaderboardCacheView = "trending",
  window: LeaderboardWindow = "all",
): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(leaderboardKey(view, window), { entries, at: Date.now() }, LEADERBOARD_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

export async function clearCachedLeaderboards(): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.del(
      ...LEADERBOARD_VIEWS.flatMap((view) =>
        LEADERBOARD_WINDOWS.map((window) => leaderboardKey(view, window)),
      ),
    );
  } catch {
    // best-effort
  }
}

// Cache recommendation membership; hydrate the few selected users from D1 on
// every hit so hiding a user immediately removes them from recommendations.
export async function getCachedSimilarUsernames(key: string): Promise<string[] | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    const value = await r.get<string[]>(`similar:v1:${key}`);
    return Array.isArray(value) && value.every(name => typeof name === "string") ? value : null;
  } catch { return null; }
}

export async function setCachedSimilarUsernames(key: string, usernames: string[]): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try { await r.set(`similar:v1:${key}`, usernames, 3600); }
  catch { /* best-effort */ }
}

// /developers directory caches. Both reads (per-bucket dev list, category grid)
// are slow-moving — a bucket's ranking only shifts when someone in it re-scans —
// and the category grid runs an expensive GROUP BY, so a longer TTL than the
// leaderboard (5 min) is warranted. Paired with the API route's CDN cache and an
// in-process single-flight (lib/developers.ts), the DB query runs at most once
// per key per TTL even under a burst.
const FACET_TTL_SECONDS = 3600; // 1h
// Per-bucket developer lists (the /developers/{type}/{value} boards). Crawlers
// walk thousands of distinct buckets, so a 1h TTL still missed ~2k times an
// hour (~12k rows_read each — the largest D1 read in production). A bucket's
// head only moves when a member re-scans; six hours of staleness is invisible.
const FACET_LIST_TTL_SECONDS = 21600; // 6h
// The repo graph only changes on scans/backfills, and each cold miss on the
// unfiltered /projects list is a whole-graph aggregation — so discovery reads
// tolerate hours of staleness. Matches the facet boards' 6h ISR window.
const PROJECT_DISCOVERY_TTL_SECONDS = 21600; // 6h

// Per-profile language-board position. Rank shifts only when the bucket is
// rescanned, so an hour of staleness is invisible; uncached it was a join over
// the whole bucket (~13k rows_read) on every profile render.
const FACET_RANK_TTL_SECONDS = 3600;
const facetRankKey = (username: string, score: number) => `facets:rank:${username}:${score}`;

/** Wrapped so a cached "no rank" (null) is distinguishable from a miss. */
export async function getCachedFacetRank(
  username: string,
  score: number,
): Promise<{ value: FacetRank | null } | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    return (await r.get<{ value: FacetRank | null }>(facetRankKey(username, score))) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedFacetRank(
  username: string,
  score: number,
  value: FacetRank | null,
): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(facetRankKey(username, score), { value }, FACET_RANK_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

// One language bucket's ranked scores (the "score ladder"): every per-profile
// rank/total/ahead is answered from it in memory, so the bucket is read once
// per language per TTL instead of three whole-bucket scans per profile.
const LANGUAGE_LADDER_TTL_SECONDS = 3600;
const languageLadderKey = (facetValue: string) => `facets:ladder:v1:${facetValue}`;

export async function getCachedLanguageLadder(
  facetValue: string,
): Promise<{ usernames: string[]; scores: number[] } | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    return (await r.get<{ usernames: string[]; scores: number[] }>(languageLadderKey(facetValue))) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedLanguageLadder(
  facetValue: string,
  ladder: { usernames: string[]; scores: number[] },
): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(languageLadderKey(facetValue), ladder, LANGUAGE_LADDER_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

// Short-lived cache for typeahead lookups whose SQL can't use an index
// (substring/lower() matches): repeated prefixes are common while typing.
const SEARCH_TTL_SECONDS = 900;

export async function getCachedSearch<T>(key: string): Promise<T | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    return (await r.get<T>(`search:${key}`)) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedSearch<T>(key: string, value: T): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(`search:${key}`, value, SEARCH_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

// Bucket values are canonical (e.g. "Rust", "C++") and safe in a Redis key.
const facetCategoriesKey = (type: FacetType) => `facets:cat:${type}`;
const facetListKey = (type: FacetType, value: string) => `facets:list:${type}:${value}`;

export async function getCachedFacetCategories(
  type: FacetType,
): Promise<FacetCategory[] | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    return (await r.get<FacetCategory[]>(facetCategoriesKey(type))) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedFacetCategories(
  type: FacetType,
  categories: FacetCategory[],
): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(facetCategoriesKey(type), categories, FACET_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

export async function getCachedFacetDevelopers(
  type: FacetType,
  value: string,
): Promise<LeaderboardEntry[] | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    return (await r.get<LeaderboardEntry[]>(facetListKey(type, value))) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedFacetDevelopers(
  type: FacetType,
  value: string,
  entries: LeaderboardEntry[],
): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(facetListKey(type, value), entries, FACET_LIST_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

/** Generic JSON cache used by the project-discovery service. Keys include their
 * own namespace and normalized filters; values are always public read models. */
export async function getCachedProjectValue<T>(key: string): Promise<T | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    return (await r.get<T>(key)) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedProjectValue<T>(key: string, value: T): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(key, value, PROJECT_DISCOVERY_TTL_SECONDS);
  } catch {
    // best-effort cache
  }
}

// Reaction *counts* are global to a profile — every visitor sees the same
// numbers — so they cache well. The per-viewer "which did I pick" is NOT cached
// (it's user-specific and read live). Short TTL keeps counts near-real-time;
// writes also bust the key so the actor sees their own vote immediately.
const reactionCountsKey = (target: string) => `reactions:counts:${target}`;
const REACTION_COUNTS_TTL_SECONDS = 60;

export async function getCachedReactionCounts(
  target: string,
): Promise<ProfileReactionCounts | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    return (await r.get<ProfileReactionCounts>(reactionCountsKey(target))) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedReactionCounts(
  target: string,
  counts: ProfileReactionCounts,
): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(reactionCountsKey(target), counts, REACTION_COUNTS_TTL_SECONDS);
  } catch {
    // best-effort
  }
}

export async function clearCachedReactionCounts(target: string): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.del(reactionCountsKey(target));
  } catch {
    // best-effort
  }
}

// The rendered sitemap.xml (~9 MB, built from a full scan of public profiles
// and judged matchups). Served by the API Worker; an hour matches the Next
// app's ISR window for the same route.
const SITEMAP_TTL_SECONDS = 3600;
const SITEMAP_KEY = "sitemap:xml:v1";

export async function getCachedSitemapXml(): Promise<string | null> {
  const r = cacheStore();
  if (!r) return null;
  try {
    return (await r.get<string>(SITEMAP_KEY)) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedSitemapXml(xml: string): Promise<void> {
  const r = cacheStore();
  if (!r) return;
  try {
    await r.set(SITEMAP_KEY, xml, SITEMAP_TTL_SECONDS);
  } catch {
    // best-effort
  }
}
