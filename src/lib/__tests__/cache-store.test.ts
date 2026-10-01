import { afterEach, describe, expect, it, vi } from "vitest";

const env: { GHFIND_CACHE?: unknown } = {};
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env }) }));

import { kvCacheStore, redisCacheStore, selectCacheStore, type KVNamespaceLike, type RedisLike } from "../cache-store";

function fakeKV() {
  const data = new Map<string, { value: string; ttl?: number }>();
  const kv: KVNamespaceLike = {
    async get(key) {
      const hit = data.get(key);
      return hit ? JSON.parse(hit.value) : null;
    },
    async put(key, value, options) {
      data.set(key, { value, ttl: options?.expirationTtl });
    },
    async delete(key) {
      data.delete(key);
    },
  };
  return { kv, data };
}

function fakeRedis(): RedisLike & { calls: unknown[][] } {
  const store = new Map<string, unknown>();
  const calls: unknown[][] = [];
  return {
    calls,
    async get<T>(key: string) {
      return (store.get(key) as T) ?? null;
    },
    async set(key, value, options) {
      calls.push(["set", key, options]);
      store.set(key, value);
      return "OK";
    },
    async del(...keys) {
      calls.push(["del", ...keys]);
      keys.forEach((k) => store.delete(k));
      return keys.length;
    },
  };
}

afterEach(() => {
  delete process.env.GHFIND_CACHE_BACKEND;
  delete env.GHFIND_CACHE;
});

describe("kvCacheStore", () => {
  it("round-trips JSON and deletes many keys", async () => {
    const { kv } = fakeKV();
    const store = kvCacheStore(kv);
    await store.set("a", { n: 1, list: [1, 2] }, 300);
    await store.set("b", 42, 300);
    expect(await store.get("a")).toEqual({ n: 1, list: [1, 2] });
    expect(await store.get("b")).toBe(42);
    await store.del("a", "b");
    expect(await store.get("a")).toBeNull();
    expect(await store.get("missing")).toBeNull();
  });

  it("clamps TTLs to KV's 60s minimum", async () => {
    const { kv, data } = fakeKV();
    const store = kvCacheStore(kv);
    await store.set("short", 1, 10);
    await store.set("long", 1, 600);
    expect(data.get("short")?.ttl).toBe(60);
    expect(data.get("long")?.ttl).toBe(600);
  });
});

describe("redisCacheStore", () => {
  it("maps ttl to Upstash's { ex } option", async () => {
    const redis = fakeRedis();
    const store = redisCacheStore(redis);
    await store.set("k", [1], 300);
    await store.del();
    await store.del("k");
    expect(redis.calls).toEqual([["set", "k", { ex: 300 }], ["del", "k"]]);
  });
});

describe("selectCacheStore", () => {
  it("keeps Redis unless the deployment opts into KV", () => {
    env.GHFIND_CACHE = fakeKV().kv;
    expect(selectCacheStore(fakeRedis())?.backend).toBe("redis");
  });

  it("uses KV when opted in and bound", () => {
    process.env.GHFIND_CACHE_BACKEND = "kv";
    env.GHFIND_CACHE = fakeKV().kv;
    expect(selectCacheStore(fakeRedis())?.backend).toBe("kv");
    expect(selectCacheStore(null)?.backend).toBe("kv");
  });

  it("falls back to Redis when opted in but the binding is missing", () => {
    process.env.GHFIND_CACHE_BACKEND = "kv";
    expect(selectCacheStore(fakeRedis())?.backend).toBe("redis");
    expect(selectCacheStore(null)).toBeNull();
  });
});
