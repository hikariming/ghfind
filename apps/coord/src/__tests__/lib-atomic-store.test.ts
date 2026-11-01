import { afterEach, describe, expect, it, vi } from "vitest";
// Drives src/lib/redis.ts against real KeyValue objects. Lives here (not in
// src/lib/__tests__) because it imports the Durable Object, whose
// cloudflare:workers types only this app's tsconfig knows.
import type { KeyValueNamespace } from "../../../../src/lib/atomic-store";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: unknown) {}
  },
}));

const env: { COORD_KV?: KeyValueNamespace } = {};
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env }) }));

const { KeyValue } = await import("../key-value");

/** Namespace of real KeyValue objects over in-memory storage, called async like RPC. */
function keyValueNamespace() {
  const objects = new Map<string, InstanceType<typeof KeyValue>>();
  const calls: string[] = [];
  const ns: KeyValueNamespace = {
    idFromName: (name) => name,
    get(id) {
      const name = id as string;
      if (!objects.has(name)) {
        const data = new Map<string, unknown>();
        const ctx = {
          storage: {
            kv: {
              get: (k: string) => data.get(k),
              put: (k: string, v: unknown) => void data.set(k, structuredClone(v)),
              delete: (k: string) => data.delete(k),
            },
            setAlarm: async () => {},
            deleteAlarm: async () => {},
            deleteAll: async () => data.clear(),
          },
        };
        objects.set(name, new KeyValue(ctx as never, {} as never));
      }
      const obj = objects.get(name)!;
      const call = <T>(method: string, fn: () => T) => {
        calls.push(`${method} ${name}`);
        return Promise.resolve(fn());
      };
      return {
        get: () => call("get", () => obj.get()),
        set: (v: unknown, ttl?: number) => call("set", () => obj.set(v, ttl)),
        setIfAbsent: (v: unknown, ttl: number) => call("setIfAbsent", () => obj.setIfAbsent(v, ttl)),
        delete: () => call("delete", () => obj.delete()),
        incr: (ttl: number) => call("incr", () => obj.incr(ttl)),
      };
    },
  };
  return { ns, calls };
}

async function loadRedis() {
  vi.resetModules();
  return import("../../../../src/lib/redis");
}

function useDurableObjects() {
  const { ns, calls } = keyValueNamespace();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("GHFIND_DEPLOY_ENV", "preview");
  vi.stubEnv("GHFIND_COORD_BACKEND", "do");
  env.COORD_KV = ns;
  return calls;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  delete env.COORD_KV;
});

const ROAST = {
  report: "savage",
  delta: 0 as const,
  tags: { en: ["a"], zh: ["甲"] },
  final_score: 88,
};

describe("roast single-flight on Durable Objects", () => {
  it("elects one leader per (username, lang) until released", async () => {
    useDurableObjects();
    const { acquireRoastLock, releaseRoastLock } = await loadRedis();
    expect(await acquireRoastLock("Torvalds", "en")).toBe(true);
    expect(await acquireRoastLock("torvalds", "en")).toBe(false); // case-insensitive key
    expect(await acquireRoastLock("torvalds", "zh")).toBe(true); // per language
    await releaseRoastLock("torvalds", "en");
    expect(await acquireRoastLock("torvalds", "en")).toBe(true);
  });

  it("round-trips and clears the roast cache", async () => {
    useDurableObjects();
    const { getCachedRoast, setCachedRoast, clearCachedRoast } = await loadRedis();
    expect(await getCachedRoast("u", "en")).toBeNull();
    await setCachedRoast("u", "en", ROAST);
    expect(await getCachedRoast("U", "en")).toEqual(ROAST);
    await clearCachedRoast("u", "en");
    expect(await getCachedRoast("u", "en")).toBeNull();
  });

  it("a follower receives the leader's roast", async () => {
    vi.useFakeTimers();
    useDurableObjects();
    const { acquireRoastLock, releaseRoastLock, setCachedRoast, waitForCachedRoast } = await loadRedis();
    expect(await acquireRoastLock("u", "en")).toBe(true);
    const follower = waitForCachedRoast("u", "en", 10_000);
    await vi.advanceTimersByTimeAsync(1_200);
    await setCachedRoast("u", "en", ROAST);
    await releaseRoastLock("u", "en");
    await vi.advanceTimersByTimeAsync(600);
    await expect(follower).resolves.toEqual(ROAST);
  });

  it("a follower stops waiting when the leader gives up without a result", async () => {
    vi.useFakeTimers();
    useDurableObjects();
    const { acquireRoastLock, releaseRoastLock, waitForCachedRoast } = await loadRedis();
    await acquireRoastLock("u", "en");
    const follower = waitForCachedRoast("u", "en", 60_000);
    await releaseRoastLock("u", "en");
    await vi.advanceTimersByTimeAsync(600);
    await expect(follower).resolves.toBeNull();
  });
});

describe("verdicts, lookup gate and campaign revisions on Durable Objects", () => {
  it("shares one verdict per canonical pair and locks it", async () => {
    useDurableObjects();
    const { setCachedVerdict, getCachedVerdict, acquireVerdictLock } = await loadRedis();
    const verdict = { verdict: { en: "a", zh: "甲" }, advice: { en: "b", zh: "乙" }, winner: "a", bucket: "x" };
    await setCachedVerdict("B", "a", verdict);
    expect(await getCachedVerdict("a", "b")).toEqual(verdict);
    expect(await acquireVerdictLock("a", "b")).toBe(true);
    expect(await acquireVerdictLock("b", "a")).toBe(false);
  });

  it("counts a lookup once per window and can release early", async () => {
    vi.useFakeTimers({ now: 0 });
    useDurableObjects();
    const { tryAcquireLookupGate, releaseLookupGate } = await loadRedis();
    expect(await tryAcquireLookupGate("gate:u:ip", 60)).toBe(true);
    expect(await tryAcquireLookupGate("gate:u:ip", 60)).toBe(false);
    await releaseLookupGate("gate:u:ip");
    expect(await tryAcquireLookupGate("gate:u:ip", 60)).toBe(true);
    vi.setSystemTime(60_000);
    expect(await tryAcquireLookupGate("gate:u:ip", 60)).toBe(true);
  });

  it("increments campaign revisions across instances", async () => {
    const calls = useDurableObjects();
    const { bumpCampaignLeaderboardRevision, getCampaignLeaderboardRevision } = await loadRedis();
    expect(await getCampaignLeaderboardRevision("advx")).toBe(0);
    await bumpCampaignLeaderboardRevision("advx");
    await bumpCampaignLeaderboardRevision("advx");
    expect(await getCampaignLeaderboardRevision("advx")).toBe(2);
    expect(calls).toContain("incr campaign-leaderboard:advx:revision");
  });
});
