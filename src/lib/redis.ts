/**
 * Upstash Redis cache + rate limiting.
 *
 * Cache reads are always best-effort. Rate limiting also no-ops locally, but a
 * production deployment fails closed for protected cost-bearing routes when its
 * Redis limiter is unavailable. Caching scan results by username is the primary
 * cost lever — popular accounts get scanned repeatedly when a report is shared,
 * and a cache hit avoids both GitHub API calls and an LLM call.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import {
  bypassGeneratedCaches,
  ROAST_CACHE_VERSION,
  SCORE_CACHE_VERSION,
  VERDICT_CACHE_VERSION,
} from "./cache-version";
import type {
  FacetCategory,
  LeaderboardEntry,
  LeaderboardWindow,
  ScoreHistogramRow,
} from "./db";
import type { FacetType } from "./facets";
import type { Lang } from "./lang";
import type { ProfileReactionCounts } from "./reactions";
import type { RoastJudgeResult, RoastLine, ScanResult } from "./types";

let redis: Redis | null = null;
let scanLimiter: Ratelimit | null = null;
let publicScanStatusLimiter: Ratelimit | null = null;
let mcpLimiter: Ratelimit | null = null;
let roastRequestLimiter: Ratelimit | null = null;
let roastMinuteLimiter: Ratelimit | null = null;
let roastDayLimiter: Ratelimit | null = null;
let verdictMinuteLimiter: Ratelimit | null = null;
let verdictDayLimiter: Ratelimit | null = null;

export const RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SECONDS = 15;
const LIMITER_UNAVAILABLE_LOG_INTERVAL_MS = 60_000;
const limiterUnavailableLogAt = new Map<string, number>();

function isProductionDeployment(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    (process.env.NODE_ENV === "production" && process.env.VERCEL_ENV !== "preview")
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
  redis = new Redis({ url, token, cache: "default" });
  return redis;
}

const SCAN_TTL_SECONDS = 60 * 60 * 24; // 24h
// A full scan can cross 30s for prolific accounts, especially when GitHub
// forces contribution-graph fallbacks. Keep the distributed lock longer than
// the public route budget so a cold-account burst remains one GitHub crawl.
const SCAN_SINGLE_FLIGHT_LOCK_SECONDS = 75;
const SCAN_SINGLE_FLIGHT_WAIT_ATTEMPTS = 120; // 60s at 500ms per poll
export const scanKey = (username: string) =>
  `scan:${SCORE_CACHE_VERSION}:${username.toLowerCase()}`;
const lockKey = (username: string) => `lock:scan:${username.toLowerCase()}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getCachedScan(username: string): Promise<ScanResult | null> {
  if (bypassGeneratedCaches()) return null;
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get<ScanResult>(scanKey(username))) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedScan(username: string, scan: ScanResult): Promise<void> {
  if (bypassGeneratedCaches()) return;
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(scanKey(username), scan, { ex: SCAN_TTL_SECONDS });
  } catch {
    // best-effort cache; ignore failures
  }
}

/** Remove a bounded quick snapshot when a durable public-history run takes
 * ownership. A partial score must never be replayed into the writer while the
 * complete immutable snapshot is still collecting. */
export async function clearCachedScan(username: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.del(scanKey(username)).catch(() => {});
}

/**
 * Single-flight a cold scan: when many requests hit the same username at once
 * (cache cold), only the first one calls GitHub; the rest wait for its result
 * via the cache. Prevents a thundering herd from burning the rate limit on
 * identical work. Falls back to producing directly when Redis is unconfigured
 * or the waiter times out.
 */
export async function coalesceScan(
  username: string,
  producer: () => Promise<ScanResult>,
): Promise<ScanResult> {
  if (bypassGeneratedCaches()) return producer();
  const r = getRedis();
  if (!r) return producer();

  // Re-check cache (a producer may have just finished).
  const cached = await getCachedScan(username);
  if (cached) return cached;

  const key = lockKey(username);
  let acquired = false;
  try {
    acquired =
      (await r.set(key, "1", { nx: true, ex: SCAN_SINGLE_FLIGHT_LOCK_SECONDS })) === "OK";
  } catch {
    return producer(); // Redis hiccup — don't block the scan.
  }

  if (acquired) {
    try {
      const result = await producer();
      await setCachedScan(username, result);
      return result;
    } finally {
      await r.del(key).catch(() => {});
    }
  }

  // Another request is producing — wait for the bounded scan route rather than
  // starting a duplicate expensive crawl after the old ~10s window.
  for (let i = 0; i < SCAN_SINGLE_FLIGHT_WAIT_ATTEMPTS; i++) {
    await sleep(500);
    const c = await getCachedScan(username);
    if (c) return c;
    const stillLocked = await r.get(key).catch(() => null);
    if (!stillLocked) break; // producer finished (possibly errored) — stop waiting
  }
  return producer(); // fallback: produce ourselves rather than starve.
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
  const r = getRedis();
  if (!r) return true;
  try {
    return (await r.set(key, "1", { nx: true, ex: windowSeconds })) === "OK";
  } catch {
    return true;
  }
}

/** Release a lookup gate acquired by tryAcquireLookupGate, so a failed Turso
 *  write doesn't suppress the count for a whole window. Best-effort. */
export async function releaseLookupGate(key: string): Promise<void> {
  const r = getRedis();
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

/** Per-IP sliding-window limiter for scan and bounded public-read routes. */
export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  const r = getRedis();
  if (!r) return unavailableRateLimitResult("scan", "missing_redis_config");
  if (!scanLimiter) {
    scanLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(10, "60 s"),
      prefix: "rl:scan",
      analytics: false,
    });
  }
  try {
    const { success, limit, remaining, reset } = await scanLimiter.limit(ip);
    return { success, limit, remaining, reset };
  } catch (error) {
    return unavailableRateLimitResult(
      "scan",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

/**
 * Durable scan status is polled by the browser while historical collection is
 * pending. Keep its budget separate from new scan admission: polling must not
 * consume the user's scan allowance, but it also must not become a free Turso
 * and Function invocation amplifier.
 */
export async function checkPublicScanStatusRateLimit(ip: string): Promise<RateLimitResult> {
  const r = getRedis();
  if (!r) return unavailableRateLimitResult("public_scan_status", "missing_redis_config");
  if (!publicScanStatusLimiter) {
    publicScanStatusLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(20, "60 s"),
      prefix: "rl:public-scan-status",
      analytics: false,
    });
  }
  try {
    const { success, limit, remaining, reset } = await publicScanStatusLimiter.limit(ip);
    return { success, limit, remaining, reset };
  } catch (error) {
    return unavailableRateLimitResult(
      "public_scan_status",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

/**
 * Gate every roast request before it reads a durable run or scan cache. This is
 * separate from the stricter default-model credit limiter: BYO requests do not
 * spend our model credit, but they still invoke a function and read Turso.
 */
export async function checkRoastRequestRateLimit(ip: string): Promise<RateLimitResult> {
  const r = getRedis();
  if (!r) return unavailableRateLimitResult("roast_request", "missing_redis_config");
  if (!roastRequestLimiter) {
    roastRequestLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(20, "60 s"),
      prefix: "rl:roast-request",
      analytics: false,
    });
  }
  try {
    const { success, limit, remaining, reset } = await roastRequestLimiter.limit(ip);
    return { success, limit, remaining, reset };
  } catch (error) {
    return unavailableRateLimitResult(
      "roast_request",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

/**
 * Per-IP limiter for the MCP server. Tighter than the web scan limiter — the
 * tools are unauthenticated and callable in a loop by an autonomous agent, so we
 * cap harder to protect the GitHub token and DB.
 */
export async function checkMcpRateLimit(ip: string): Promise<RateLimitResult> {
  const r = getRedis();
  if (!r) return unavailableRateLimitResult("mcp", "missing_redis_config");
  if (!mcpLimiter) {
    mcpLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(15, "60 s"),
      prefix: "rl:mcp",
      analytics: false,
    });
  }
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
 * Per-IP limiter for the (expensive) roast endpoint — the LLM call burns the
 * operator's credit, so it's limited tighter than scans: a burst window and a
 * daily cap. Only gates the default model; BYO keys are not limited.
 */
export async function checkRoastRateLimit(ip: string): Promise<RateLimitResult> {
  const r = getRedis();
  if (!r) return unavailableRateLimitResult("roast_generation", "missing_redis_config");
  if (!roastMinuteLimiter) {
    roastMinuteLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(8, "60 s"),
      prefix: "rl:roast:m",
      analytics: false,
    });
  }
  if (!roastDayLimiter) {
    roastDayLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(60, "1 d"),
      prefix: "rl:roast:d",
      analytics: false,
    });
  }
  try {
    const [minute, day] = await Promise.all([
      roastMinuteLimiter.limit(ip),
      roastDayLimiter.limit(ip),
    ]);
    return { success: minute.success && day.success };
  } catch (error) {
    return unavailableRateLimitResult(
      "roast_generation",
      error instanceof Error ? error.name : "redis_request_failed",
    );
  }
}

/** Cached roast: the LLM-written report + its ±delta + tags, keyed by
 * language + username (24h). The roast text differs by language, so the cache
 * key carries the lang; the scan cache stays language-neutral (deterministic). */
export interface CachedRoast {
  report: string;
  delta: number;
  tags: import("./types").Tags;
  /** Persisted final score for archived/cache replay. Older cache entries omit it. */
  final_score?: number;
  /** Persisted tier for archived/cache replay. Older cache entries omit it. */
  tier?: import("./types").Tier;
  /** Bilingual one-liner (optional: pre-deploy entries lack it; caller defaults). */
  roast_line?: import("./types").RoastLine;
}

const ROAST_TTL_SECONDS = 60 * 60 * 24;
export const roastKey = (username: string, lang: Lang) =>
  `roast:${ROAST_CACHE_VERSION}:${lang}:${username.toLowerCase()}`;

export async function getCachedRoast(username: string, lang: Lang): Promise<CachedRoast | null> {
  if (bypassGeneratedCaches()) return null;
  const r = getRedis();
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
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(roastKey(username, lang), value, { ex: ROAST_TTL_SECONDS });
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
  const r = getRedis();
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
  `roast-judge:${ROAST_CACHE_VERSION}:${SCORE_CACHE_VERSION}:${username.toLowerCase()}`;

export async function getCachedRoastJudge(username: string): Promise<CachedRoastJudge | null> {
  if (bypassGeneratedCaches()) return null;
  const r = getRedis();
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
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(roastJudgeKey(username), value, { ex: ROAST_TTL_SECONDS });
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
  `lock:roast:${lang}:${username.toLowerCase()}`;

/** Try to become the sole generator for (username, lang). `true` = leader.
 *  Without Redis there's no coordination, so everyone leads (behavior unchanged). */
export async function acquireRoastLock(username: string, lang: Lang): Promise<boolean> {
  if (bypassGeneratedCaches()) return true;
  const r = getRedis();
  if (!r) return true;
  try {
    return (
      (await r.set(roastLockKey(username, lang), "1", {
        nx: true,
        ex: ROAST_LOCK_TTL_SECONDS,
      })) === "OK"
    );
  } catch {
    return true; // Redis hiccup — don't block the roast.
  }
}

export async function releaseRoastLock(username: string, lang: Lang): Promise<void> {
  if (bypassGeneratedCaches()) return;
  const r = getRedis();
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
  const r = getRedis();
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
// per pair per window. Mirrors the roast cache/lock/limit machinery.
// ---------------------------------------------------------------------------

export interface CachedVerdict {
  verdict: RoastLine;
  advice: RoastLine;
  winner: string | null;
  bucket: string;
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

export async function getCachedVerdict(a: string, b: string): Promise<CachedVerdict | null> {
  if (bypassGeneratedCaches()) return null;
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get<CachedVerdict>(verdictKey(a, b))) ?? null;
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
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(verdictKey(a, b), value, { ex: VERDICT_TTL_SECONDS });
  } catch {
    // best-effort
  }
}

export async function acquireVerdictLock(a: string, b: string): Promise<boolean> {
  if (bypassGeneratedCaches()) return true;
  const r = getRedis();
  if (!r) return true;
  try {
    return (
      (await r.set(verdictLockKey(a, b), "1", {
        nx: true,
        ex: VERDICT_LOCK_TTL_SECONDS,
      })) === "OK"
    );
  } catch {
    return true;
  }
}

export async function releaseVerdictLock(a: string, b: string): Promise<void> {
  if (bypassGeneratedCaches()) return;
  const r = getRedis();
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
  timeoutMs = 45000,
): Promise<CachedVerdict | null> {
  if (bypassGeneratedCaches()) return null;
  const r = getRedis();
  if (!r) return null;
  const steps = Math.max(1, Math.floor(timeoutMs / 500));
  for (let i = 0; i < steps; i++) {
    await sleep(500);
    const cached = await getCachedVerdict(a, b);
    if (cached) return cached;
    const stillLocked = await r.get(verdictLockKey(a, b)).catch(() => null);
    if (!stillLocked) return (await getCachedVerdict(a, b)) ?? null;
  }
  return null;
}

/** Per-IP limiter for the PK verdict LLM call (operator credit). Burst + daily. */
export async function checkVerdictRateLimit(ip: string): Promise<RateLimitResult> {
  const r = getRedis();
  if (!r) return unavailableRateLimitResult("vs_verdict", "missing_redis_config");
  if (!verdictMinuteLimiter) {
    verdictMinuteLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(6, "60 s"),
      prefix: "rl:verdict:m",
      analytics: false,
    });
  }
  if (!verdictDayLimiter) {
    verdictDayLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(40, "1 d"),
      prefix: "rl:verdict:d",
      analytics: false,
    });
  }
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
const SCORE_HISTOGRAM_KEY = "score-hist:v1";
const SCORE_HISTOGRAM_TTL_SECONDS = 300;

export async function getCachedScoreHistogram(): Promise<ScoreHistogramRow[] | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get<ScoreHistogramRow[]>(SCORE_HISTOGRAM_KEY)) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedScoreHistogram(rows: ScoreHistogramRow[]): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(SCORE_HISTOGRAM_KEY, rows, { ex: SCORE_HISTOGRAM_TTL_SECONDS });
  } catch {
    // best-effort
  }
}

const STATS_KEY = "stats:count";
const STATS_TTL_SECONDS = 60;

export async function getCachedStats(): Promise<number | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const v = await r.get<number>(STATS_KEY);
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

export async function setCachedStats(total: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(STATS_KEY, total, { ex: STATS_TTL_SECONDS });
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
  `leaderboard:${view}:${window}`;
const LEADERBOARD_TTL_SECONDS = 300; // 5 min — board moves slowly; fewer DB reads

export async function getCachedLeaderboard(
  view: LeaderboardCacheView = "trending",
  window: LeaderboardWindow = "all",
): Promise<LeaderboardEntry[] | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get<LeaderboardEntry[]>(leaderboardKey(view, window))) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedLeaderboard(
  entries: LeaderboardEntry[],
  view: LeaderboardCacheView = "trending",
  window: LeaderboardWindow = "all",
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(leaderboardKey(view, window), entries, { ex: LEADERBOARD_TTL_SECONDS });
  } catch {
    // best-effort
  }
}

export async function clearCachedLeaderboards(): Promise<void> {
  const r = getRedis();
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

// /developers directory caches. Both reads (per-bucket dev list, category grid)
// are slow-moving — a bucket's ranking only shifts when someone in it re-scans —
// and the category grid runs an expensive GROUP BY, so a longer TTL than the
// leaderboard (5 min) is warranted. Paired with the API route's CDN cache and an
// in-process single-flight (lib/developers.ts), the DB query runs at most once
// per key per TTL even under a burst.
const FACET_TTL_SECONDS = 600; // 10 min
// The repo graph only changes on scans/backfills, and each cold miss on the
// unfiltered /projects list is a whole-graph aggregation — so discovery reads
// tolerate hours of staleness. Matches the facet boards' 6h ISR window.
const PROJECT_DISCOVERY_TTL_SECONDS = 21600; // 6h

// Bucket values are canonical (e.g. "Rust", "C++") and safe in a Redis key.
const facetCategoriesKey = (type: FacetType) => `facets:cat:${type}`;
const facetListKey = (type: FacetType, value: string) => `facets:list:${type}:${value}`;

export async function getCachedFacetCategories(
  type: FacetType,
): Promise<FacetCategory[] | null> {
  const r = getRedis();
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
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(facetCategoriesKey(type), categories, { ex: FACET_TTL_SECONDS });
  } catch {
    // best-effort
  }
}

export async function getCachedFacetDevelopers(
  type: FacetType,
  value: string,
): Promise<LeaderboardEntry[] | null> {
  const r = getRedis();
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
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(facetListKey(type, value), entries, { ex: FACET_TTL_SECONDS });
  } catch {
    // best-effort
  }
}

/** Generic JSON cache used by the project-discovery service. Keys include their
 * own namespace and normalized filters; values are always public read models. */
export async function getCachedProjectValue<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get<T>(key)) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedProjectValue<T>(key: string, value: T): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, value, { ex: PROJECT_DISCOVERY_TTL_SECONDS });
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
  const r = getRedis();
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
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(reactionCountsKey(target), counts, { ex: REACTION_COUNTS_TTL_SECONDS });
  } catch {
    // best-effort
  }
}

export async function clearCachedReactionCounts(target: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(reactionCountsKey(target));
  } catch {
    // best-effort
  }
}
