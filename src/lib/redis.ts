/**
 * Upstash Redis cache + rate limiting.
 *
 * Both are optional: if the env vars are absent (e.g. local dev), caching and
 * rate limiting silently no-op so the app still runs. Caching scan results by
 * username is the primary cost lever — popular accounts get scanned repeatedly
 * when a report is shared, and a cache hit avoids both GitHub API calls and an
 * LLM call.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { LeaderboardEntry } from "./db";
import type { Lang } from "./lang";
import type { ScanResult } from "./types";

let redis: Redis | null = null;
let scanLimiter: Ratelimit | null = null;
let roastMinuteLimiter: Ratelimit | null = null;
let roastDayLimiter: Ratelimit | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

const SCAN_TTL_SECONDS = 60 * 60 * 24; // 24h
// v2: all-time ecosystem-impact (per-repo PR + commit aggregation). Bumping the
// prefix invalidates pre-v2 entries that scored old high-value work as 0.
const scanKey = (username: string) => `scan:v2:${username.toLowerCase()}`;
const lockKey = (username: string) => `lock:scan:${username.toLowerCase()}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getCachedScan(username: string): Promise<ScanResult | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get<ScanResult>(scanKey(username))) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedScan(username: string, scan: ScanResult): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(scanKey(username), scan, { ex: SCAN_TTL_SECONDS });
  } catch {
    // best-effort cache; ignore failures
  }
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
  const r = getRedis();
  if (!r) return producer();

  // Re-check cache (a producer may have just finished).
  const cached = await getCachedScan(username);
  if (cached) return cached;

  const key = lockKey(username);
  let acquired = false;
  try {
    acquired = (await r.set(key, "1", { nx: true, ex: 30 })) === "OK";
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

  // Another request is producing — poll the cache for up to ~10s.
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const c = await getCachedScan(username);
    if (c) return c;
    const stillLocked = await r.get(key).catch(() => null);
    if (!stillLocked) break; // producer finished (possibly errored) — stop waiting
  }
  return producer(); // fallback: produce ourselves rather than starve.
}

/** Per-IP sliding-window limiter for scans. No-ops when Redis is unconfigured. */
export async function checkRateLimit(ip: string): Promise<{ success: boolean }> {
  const r = getRedis();
  if (!r) return { success: true };
  if (!scanLimiter) {
    scanLimiter = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(10, "60 s"),
      prefix: "rl:scan",
      analytics: false,
    });
  }
  try {
    const { success } = await scanLimiter.limit(ip);
    return { success };
  } catch {
    return { success: true };
  }
}

/**
 * Per-IP limiter for the (expensive) roast endpoint — the LLM call burns the
 * operator's credit, so it's limited tighter than scans: a burst window and a
 * daily cap. Only gates the default model; BYO keys are not limited.
 */
export async function checkRoastRateLimit(ip: string): Promise<{ success: boolean }> {
  const r = getRedis();
  if (!r) return { success: true };
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
  } catch {
    return { success: true };
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
  `roast:${lang}:${username.toLowerCase()}`;

export async function getCachedRoast(username: string, lang: Lang): Promise<CachedRoast | null> {
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
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(roastKey(username, lang), value, { ex: ROAST_TTL_SECONDS });
  } catch {
    // best-effort
  }
}

// Single-flight for roast generation — the analogue of `coalesceScan` for the
// (credit-spending) LLM call. When a hot account's roast cache goes cold and N
// requests arrive at once, only the lock holder runs the LLM; the rest wait for
// its result via the cache. Without this, a viral account re-generates N times
// per cold window instead of once.
const ROAST_LOCK_TTL_SECONDS = 60; // long enough to cover a full report stream
const roastLockKey = (username: string, lang: Lang) =>
  `lock:roast:${lang}:${username.toLowerCase()}`;

/** Try to become the sole generator for (username, lang). `true` = leader.
 *  Without Redis there's no coordination, so everyone leads (behavior unchanged). */
export async function acquireRoastLock(username: string, lang: Lang): Promise<boolean> {
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
  timeoutMs = 60000,
): Promise<CachedRoast | null> {
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

const leaderboardKey = (view: LeaderboardCacheView) => `leaderboard:${view}`;
const LEADERBOARD_TTL_SECONDS = 300; // 5 min — board moves slowly; fewer DB reads

export async function getCachedLeaderboard(
  view: LeaderboardCacheView = "trending",
): Promise<LeaderboardEntry[] | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get<LeaderboardEntry[]>(leaderboardKey(view))) ?? null;
  } catch {
    return null;
  }
}

export async function setCachedLeaderboard(
  entries: LeaderboardEntry[],
  view: LeaderboardCacheView = "trending",
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(leaderboardKey(view), entries, { ex: LEADERBOARD_TTL_SECONDS });
  } catch {
    // best-effort
  }
}

export async function clearCachedLeaderboards(): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(
      leaderboardKey("trending"),
      leaderboardKey("score"),
      leaderboardKey("heat"),
      leaderboardKey("progress"),
    );
  } catch {
    // best-effort
  }
}
