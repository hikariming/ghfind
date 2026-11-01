/**
 * Single-key atomic store for the coordination state in src/lib/redis.ts
 * that needs read-your-writes consistency: roast/verdict caches and their
 * single-flight locks, the lookup gate, and campaign leaderboard revisions.
 *
 * Backends: Upstash Redis, or the KeyValue Durable Object in ghfind-coord
 * (one object per key, same single-key atomicity). Chosen per deployment:
 * `GHFIND_COORD_BACKEND=do` plus a `COORD_KV` binding selects Durable
 * Objects; anything else keeps Redis. All Workers sharing these keys must use
 * the same backend or leaders and followers stop seeing each other.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";

export interface AtomicStore {
  readonly backend: "do" | "redis";
  get<T>(key: string): Promise<T | null>;
  /** SET [EX ttl]; no TTL = never expires. */
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  /** SET NX EX; true when this call created the key. */
  setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
  /** INCR then EXPIRE ttl; returns the new value. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

/** RPC surface of apps/coord's KeyValue Durable Object. */
interface KeyValueStub {
  get(): Promise<unknown>;
  set(value: unknown, ttlSeconds?: number): Promise<void>;
  setIfAbsent(value: unknown, ttlSeconds: number): Promise<boolean>;
  delete(): Promise<boolean>;
  incr(ttlSeconds: number): Promise<number>;
}

export interface KeyValueNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): KeyValueStub;
}

/** The slice of the Upstash client the Redis backend uses. */
export interface AtomicRedisLike {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options?: { ex?: number; nx?: boolean }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

function durableObjectAtomicStore(ns: KeyValueNamespace): AtomicStore {
  const stub = (key: string) => ns.get(ns.idFromName(key));
  return {
    backend: "do",
    async get<T>(key: string) {
      return ((await stub(key).get()) as T | null) ?? null;
    },
    async set(key, value, ttlSeconds) {
      await stub(key).set(value, ttlSeconds);
    },
    setIfAbsent: (key, value, ttlSeconds) => stub(key).setIfAbsent(value, ttlSeconds),
    async del(key) {
      await stub(key).delete();
    },
    incr: (key, ttlSeconds) => stub(key).incr(ttlSeconds),
  };
}

function redisAtomicStore(redis: AtomicRedisLike): AtomicStore {
  return {
    backend: "redis",
    async get<T>(key: string) {
      return (await redis.get<T>(key)) ?? null;
    },
    async set(key, value, ttlSeconds) {
      if (ttlSeconds === undefined) await redis.set(key, value);
      else await redis.set(key, value, { ex: ttlSeconds });
    },
    async setIfAbsent(key, value, ttlSeconds) {
      return (await redis.set(key, value, { nx: true, ex: ttlSeconds })) === "OK";
    },
    async del(key) {
      await redis.del(key);
    },
    async incr(key, ttlSeconds) {
      const value = await redis.incr(key);
      await redis.expire(key, ttlSeconds);
      return value;
    },
  };
}

function getKeyValueBinding(): KeyValueNamespace | null {
  try {
    const env = getCloudflareContext().env as { COORD_KV?: KeyValueNamespace };
    return env.COORD_KV ?? null;
  } catch {
    return null;
  }
}

/** Durable Objects when opted in and bound; else the Redis client (or null). */
export function selectAtomicStore(redis: AtomicRedisLike | null): AtomicStore | null {
  if (process.env.GHFIND_COORD_BACKEND === "do") {
    const ns = getKeyValueBinding();
    if (ns) return durableObjectAtomicStore(ns);
  }
  return redis ? redisAtomicStore(redis) : null;
}
