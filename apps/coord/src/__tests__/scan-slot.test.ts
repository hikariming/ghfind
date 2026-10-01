// Drives the real ScanSlot/ScanCapacity (and KeyValue) objects, both directly
// and through src/lib/redis.ts. Lives under apps/coord because it imports the
// Durable Objects, whose cloudflare:workers types only this app's tsconfig knows.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
}));

const libEnv: Record<string, unknown> = {};
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: libEnv }) }));

const { ScanSlot } = await import("../scan-slot");
const { ScanCapacity } = await import("../scan-capacity");
const { KeyValue } = await import("../key-value");

function fakeCtx() {
  const data = new Map<string, unknown>();
  return {
    storage: {
      kv: {
        get: (k: string) => data.get(k),
        put: (k: string, v: unknown) => void data.set(k, structuredClone(v)),
        delete: (k: string) => data.delete(k),
        *list(opts: { prefix?: string } = {}) {
          for (const [k, v] of data) if (!opts.prefix || k.startsWith(opts.prefix)) yield [k, v];
        },
      },
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      deleteAll: async () => data.clear(),
    },
  };
}

/** A namespace of real objects; each call is async like RPC. */
function namespace<T extends object>(make: (ctx: ReturnType<typeof fakeCtx>) => T) {
  const objects = new Map<string, T>();
  return {
    idFromName: (name: string) => name,
    get(id: unknown) {
      const name = id as string;
      if (!objects.has(name)) objects.set(name, make(fakeCtx()));
      const obj = objects.get(name)!;
      return new Proxy(obj, {
        get: (target, prop) => {
          const value = (target as Record<string | symbol, unknown>)[prop];
          return typeof value === "function"
            ? (...args: unknown[]) => Promise.resolve().then(() => (value as (...a: unknown[]) => unknown).apply(target, args))
            : value;
        },
      });
    },
    objects,
  };
}

function world() {
  const capacity = namespace((ctx) => new ScanCapacity(ctx as never, {} as never));
  const slots = namespace((ctx) => new ScanSlot(ctx as never, { SCAN_CAPACITY: capacity } as never));
  const kv = namespace((ctx) => new KeyValue(ctx as never, {} as never));
  return { capacity, slots, kv };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const k of Object.keys(libEnv)) delete libEnv[k];
});

describe("ScanSlot", () => {
  it("admits one producer, makes others wait, and publishes only for the owner", async () => {
    const { slots } = world();
    const slot = slots.get("scan:k");
    expect(await slot.admit("a", 300_000, "pool", 96)).toBe(1);
    expect(await slot.admit("b", 300_000, "pool", 96)).toBe(0);
    expect(await slot.publish("b", '{"x":1}', 60, true)).toBe(0);
    expect(await slot.publish("a", '{"x":2}', 60, true)).toBe(1);
    expect(await slot.payload()).toBe('{"x":2}');
    expect(await slot.revision()).toBe("a");
  });

  it("puts a failed key on a 15s cooldown and frees its capacity lease", async () => {
    vi.useFakeTimers({ now: 0 });
    const { slots, capacity } = world();
    const slot = slots.get("scan:k");
    await slot.admit("a", 300_000, "pool", 1);
    await slot.release("a", true, "pool");
    expect(await slot.admit("b", 300_000, "pool", 1)).toBe(-1); // cooldown
    vi.setSystemTime(15_000);
    expect(await slot.admit("b", 300_000, "pool", 1)).toBe(1); // lease was released
    expect(await capacity.get("pool").acquire("c", 300_000, 1)).toBe(false);
  });

  it("returns -1 when the global pool is full and rolls its lock back", async () => {
    const { slots } = world();
    expect(await slots.get("scan:1").admit("a", 300_000, "pool", 2)).toBe(1);
    expect(await slots.get("scan:2").admit("b", 300_000, "pool", 2)).toBe(1);
    const third = slots.get("scan:3");
    expect(await third.admit("c", 300_000, "pool", 2)).toBe(-1);
    // No stale lock left behind: after a lease frees up, the key is admissible.
    await slots.get("scan:1").release("a", false, "pool");
    expect(await third.admit("c", 300_000, "pool", 2)).toBe(1);
  });

  it("recovers capacity and the lock after a killed producer's lease expires", async () => {
    vi.useFakeTimers({ now: 0 });
    const { slots } = world();
    await slots.get("scan:1").admit("dead", 300_000, "pool", 1);
    expect(await slots.get("scan:2").admit("b", 300_000, "pool", 1)).toBe(-1);
    vi.setSystemTime(300_000);
    expect(await slots.get("scan:1").admit("next", 300_000, "pool", 1)).toBe(1);
    expect(await slots.get("scan:1").publish("dead", "{}", 60, false)).toBe(0);
  });

  it("serves a forced reader only a publication newer than its baseline", async () => {
    const { slots } = world();
    const slot = slots.get("scan:k");
    await slot.admit("a", 300_000, "pool", 96);
    await slot.publish("a", '"old"', 60, true);
    await slot.release("a", false, "pool");
    const baseline = (await slot.revision())!;
    expect(await slot.payloadAfter(baseline)).toBeNull();
    await slot.admit("b", 300_000, "pool", 96);
    await slot.publish("b", '"new"', 60, true);
    expect(await slot.payloadAfter(baseline)).toBe('"new"');
  });
});

describe("redis.ts scan paths on Durable Objects", () => {
  async function loadRedis() {
    vi.resetModules();
    return import("../../../../src/lib/redis");
  }

  function useDurableObjects() {
    const w = world();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GHFIND_DEPLOY_ENV", "production");
    vi.stubEnv("GHFIND_COORD_BACKEND", "do");
    libEnv.SCAN_SLOT = w.slots;
    libEnv.COORD_KV = w.kv;
    return w;
  }

  const scan = (login: string) =>
    ({ metrics: { username: login }, login }) as unknown as import("../../../../src/lib/types").ScanResult;

  it("coalesces concurrent cold scans into one producer", async () => {
    useDurableObjects();
    vi.doMock("../../../../src/lib/score", () => ({ score: () => ({ final: 1 }) }));
    const { coalesceScan } = await loadRedis();
    let produced = 0;
    const producer = async () => {
      produced++;
      await new Promise((r) => setTimeout(r, 20));
      return scan("u");
    };
    const results = await Promise.all([coalesceScan("u", producer), coalesceScan("U", producer), coalesceScan("u", producer)]);
    expect(produced).toBe(1);
    expect(results.map((r) => (r as unknown as { login: string }).login)).toEqual(["u", "u", "u"]);
    vi.doUnmock("../../../../src/lib/score");
  });

  it("serves the cached scan afterwards and clears it", async () => {
    useDurableObjects();
    vi.doMock("../../../../src/lib/score", () => ({ score: () => ({ final: 1 }) }));
    const { coalesceScan, getCachedScan, clearCachedScan } = await loadRedis();
    await coalesceScan("u", async () => scan("u"));
    expect(await getCachedScan("u")).toMatchObject({ login: "u", scoring: { final: 1 } });
    await clearCachedScan("u");
    expect(await getCachedScan("u")).toBeNull();
    vi.doUnmock("../../../../src/lib/score");
  });

  it("a forced refresh produces again instead of accepting the warm snapshot", async () => {
    useDurableObjects();
    vi.doMock("../../../../src/lib/score", () => ({ score: () => ({ final: 1 }) }));
    const { coalesceScan } = await loadRedis();
    await coalesceScan("u", async () => ({ ...scan("u"), login: "v1" }) as never);
    const refreshed = await coalesceScan("u", async () => ({ ...scan("u"), login: "v2" }) as never, { force: true });
    expect((refreshed as unknown as { login: string }).login).toBe("v2");
    vi.doUnmock("../../../../src/lib/score");
  });

  it("score detail is cached per revision and advancing the revision reloads", async () => {
    useDurableObjects();
    const { getCachedScoreDetail, advanceScoreDetailRevision } = await loadRedis();
    let loads = 0;
    const load = async () => ({ username: "u", n: ++loads }) as never;
    expect(await getCachedScoreDetail("u", load)).toEqual({ username: "u", n: 1 });
    expect(await getCachedScoreDetail("u", load)).toEqual({ username: "u", n: 1 });
    await advanceScoreDetailRevision("u");
    expect(await getCachedScoreDetail("u", load)).toEqual({ username: "u", n: 2 });
  });

  it("fails closed in production when the slot object is unreachable", async () => {
    useDurableObjects();
    libEnv.SCAN_SLOT = {
      idFromName: (n: string) => n,
      get: () => ({ admit: async () => { throw new Error("down"); }, payload: async () => null, release: async () => {} }),
    };
    const { coalesceScan } = await loadRedis();
    const { ScanBusyError } = await import("../../../../src/lib/scan-protection");
    const producer = vi.fn(async () => scan("u"));
    await expect(coalesceScan("u", producer)).rejects.toBeInstanceOf(ScanBusyError);
    expect(producer).not.toHaveBeenCalled();
  });
});
