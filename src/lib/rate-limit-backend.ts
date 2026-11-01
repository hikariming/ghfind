/**
 * Rate-limiter backends for src/lib/redis.ts. Either Upstash
 * (`@upstash/ratelimit` sliding window) or the RateLimiter Durable Object in
 * the ghfind-coord Worker, which runs the same algorithm. Chosen per
 * deployment: `GHFIND_RATELIMIT_BACKEND=do` plus a `RATE_LIMITER` binding
 * selects the Durable Object; anything else keeps Upstash.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";

interface LimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms when the current fixed window ends. */
  reset: number;
}

export interface Limiter {
  limit(identifier: string): Promise<LimitResult>;
}

/** RPC surface of apps/coord's RateLimiter Durable Object. */
interface RateLimiterStub {
  limit(tokens: number, windowMs: number): Promise<LimitResult>;
}

export interface RateLimiterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): RateLimiterStub;
}

export type LimitWindow = `${number} ${"s" | "m" | "h" | "d"}`;

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parse the Upstash duration strings used in redis.ts ("60 s", "60 m", "1 d"). */
export function windowMs(window: LimitWindow): number {
  const [amount, unit] = window.split(" ") as [string, keyof typeof UNIT_MS];
  const ms = Number(amount) * UNIT_MS[unit];
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`invalid window ${window}`);
  return ms;
}

/** The RATE_LIMITER binding when running on Cloudflare, else null. */
export function getRateLimiterBinding(): RateLimiterNamespace | null {
  try {
    const env = getCloudflareContext().env as { RATE_LIMITER?: RateLimiterNamespace };
    return env.RATE_LIMITER ?? null;
  } catch {
    return null;
  }
}

/**
 * Sliding-window limiter backed by one Durable Object per `<prefix>:<id>` —
 * the same key Upstash used. Like @upstash/ratelimit's default ephemeral cache,
 * an identifier that was just blocked is answered in-isolate until its window
 * resets, so a hammering client does not cost a Durable Object call per request.
 */
export function durableObjectLimiter(
  namespace: RateLimiterNamespace,
  prefix: string,
  tokens: number,
  window: LimitWindow,
): Limiter {
  const ms = windowMs(window);
  const blockedUntil = new Map<string, number>();
  return {
    async limit(identifier) {
      const key = `${prefix}:${identifier}`;
      const until = blockedUntil.get(key);
      if (until !== undefined) {
        if (Date.now() < until) return { success: false, limit: tokens, remaining: 0, reset: until };
        blockedUntil.delete(key);
      }
      const result = await namespace.get(namespace.idFromName(key)).limit(tokens, ms);
      if (!result.success) {
        if (blockedUntil.size > 10_000) blockedUntil.clear();
        blockedUntil.set(key, result.reset);
      }
      return result;
    },
  };
}
