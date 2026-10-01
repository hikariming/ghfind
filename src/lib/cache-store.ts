/**
 * Backend for the public read-model caches (leaderboards, stats, facet boards,
 * histogram, project discovery, reaction counts, project-analysis index).
 *
 * These caches are best-effort and tolerate eventual consistency, so they can
 * live in Workers KV instead of Upstash Redis. The backend is chosen per
 * deployment: `GHFIND_CACHE_BACKEND=kv` plus a `GHFIND_CACHE` KV binding
 * selects KV; anything else keeps Redis. Every Worker that reads or clears a
 * cache (the Next Worker and the Hono API Worker) must use the same backend,
 * or clears on one side miss entries read on the other.
 *
 * Caches that coordinate with locks (roast/verdict/scan) are NOT here: a
 * follower polling for a leader's result across colos cannot wait out KV's
 * propagation delay. Those move to Durable Objects separately.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";

/** The slice of the Workers KV binding this module uses. */
export interface KVNamespaceLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The slice of the Upstash client this module uses. */
export interface RedisLike {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options: { ex: number }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export interface CacheStore {
  readonly backend: "kv" | "redis";
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
}

// KV rejects expirationTtl below 60 seconds.
const KV_MIN_TTL_SECONDS = 60;

export function kvCacheStore(kv: KVNamespaceLike): CacheStore {
  return {
    backend: "kv",
    async get<T>(key: string) {
      return ((await kv.get(key, "json")) as T | null) ?? null;
    },
    async set(key, value, ttlSeconds) {
      await kv.put(key, JSON.stringify(value), {
        expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ttlSeconds)),
      });
    },
    async del(...keys) {
      await Promise.all(keys.map((key) => kv.delete(key)));
    },
  };
}

export function redisCacheStore(redis: RedisLike): CacheStore {
  return {
    backend: "redis",
    async get<T>(key: string) {
      return (await redis.get<T>(key)) ?? null;
    },
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, { ex: ttlSeconds });
    },
    async del(...keys) {
      if (keys.length) await redis.del(...keys);
    },
  };
}

/** The GHFIND_CACHE binding when running on Cloudflare, else null. */
function getCacheKVBinding(): KVNamespaceLike | null {
  try {
    const env = getCloudflareContext().env as { GHFIND_CACHE?: KVNamespaceLike };
    return env.GHFIND_CACHE ?? null;
  } catch {
    return null;
  }
}

/**
 * Pick the read-model cache backend. KV only when the deployment opts in and
 * the binding exists; otherwise the Redis client (or null = caching off).
 */
export function selectCacheStore(redis: RedisLike | null): CacheStore | null {
  if (process.env.GHFIND_CACHE_BACKEND === "kv") {
    const kv = getCacheKVBinding();
    if (kv) return kvCacheStore(kv);
  }
  return redis ? redisCacheStore(redis) : null;
}
