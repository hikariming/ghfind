import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { CollectStore } from "@/lib/devscore/collect";
import { readDevscoreCache, writeDevscoreCache } from "@/lib/db";

/**
 * devscore collect store: JSON blobs keyed by the collector (`run:<id>:*`,
 * `http:<sha1>`). Production uses the DEVSCORE_CACHE R2 bucket (TTL recorded
 * in customMetadata and checked on read; configure an R2 lifecycle rule to
 * actually delete old objects). Without the binding (local dev, tests) it
 * falls back to the `devscore_cache` table, and without a database to a
 * per-process map.
 */

/** The slice of the R2 bucket binding this store uses. */
export interface R2BucketLike {
  get(key: string): Promise<{ text(): Promise<string>; customMetadata?: Record<string, string> } | null>;
  put(
    key: string,
    value: string,
    options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

export function getDevscoreCacheBucket(): R2BucketLike | null {
  try {
    const env = getCloudflareContext().env as { DEVSCORE_CACHE?: R2BucketLike };
    return env.DEVSCORE_CACHE ?? null;
  } catch {
    return null;
  }
}

function expiryOf(now: number, ttlSeconds: number | undefined): number | null {
  return ttlSeconds && ttlSeconds > 0 ? now + ttlSeconds * 1000 : null;
}

export function r2CollectStore(bucket: R2BucketLike, now: () => number = Date.now): CollectStore {
  return {
    async get<T>(key: string): Promise<T | null> {
      const object = await bucket.get(key);
      if (!object) return null;
      const expiresAt = Number(object.customMetadata?.expires_at);
      if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now()) return null;
      return JSON.parse(await object.text()) as T;
    },
    async put(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
      const expiresAt = expiryOf(now(), ttlSeconds);
      await bucket.put(key, JSON.stringify(value), {
        httpMetadata: { contentType: "application/json" },
        ...(expiresAt ? { customMetadata: { expires_at: String(expiresAt) } } : {}),
      });
    },
  };
}

export function memoryCollectStore(now: () => number = Date.now): CollectStore {
  const entries = new Map<string, { value: string; expiresAt: number | null }>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return JSON.parse(entry.value) as T;
    },
    async put(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
      entries.set(key, { value: JSON.stringify(value), expiresAt: expiryOf(now(), ttlSeconds) });
    },
  };
}

let processStore: CollectStore | null = null;

/** Database-backed store; degrades to the per-process map when no database is configured. */
export function databaseCollectStore(now: () => number = Date.now): CollectStore {
  const memory = (processStore ??= memoryCollectStore(now));
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = await readDevscoreCache(key, now());
      if (raw === undefined) return memory.get<T>(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    async put(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
      const written = await writeDevscoreCache(key, JSON.stringify(value), expiryOf(now(), ttlSeconds));
      if (!written) await memory.put(key, value, ttlSeconds);
    },
  };
}

export function getDevscoreCollectStore(): CollectStore {
  const bucket = getDevscoreCacheBucket();
  return bucket ? r2CollectStore(bucket) : databaseCollectStore();
}
