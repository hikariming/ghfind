import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
}));

const { KeyValue } = await import("../key-value");

/** Fake DurableObjectState with the sync KV API and alarm bookkeeping. */
function fakeState() {
  const data = new Map<string, unknown>();
  const state = {
    alarm: null as number | null,
    data,
    storage: {
      kv: {
        get: <T>(k: string) => data.get(k) as T | undefined,
        put: (k: string, v: unknown) => void data.set(k, structuredClone(v)),
        delete: (k: string) => data.delete(k),
      },
      setAlarm: async (t: number) => {
        state.alarm = t;
      },
      deleteAlarm: async () => {
        state.alarm = null;
      },
      deleteAll: async () => {
        data.clear();
      },
    },
  };
  return state;
}

function object() {
  const state = fakeState();
  const kv = new KeyValue(state as never, {} as never);
  return { kv, state };
}

afterEach(() => vi.useRealTimers());

describe("KeyValue", () => {
  it("GET/SET/DEL with structured values", () => {
    const { kv } = object();
    expect(kv.get()).toBeNull();
    kv.set({ report: "x", tags: { en: ["a"] } }, 60);
    expect(kv.get()).toEqual({ report: "x", tags: { en: ["a"] } });
    expect(kv.delete()).toBe(true);
    expect(kv.get()).toBeNull();
    expect(kv.delete()).toBe(false);
  });

  it("expires on read and schedules reclamation", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { kv, state } = object();
    kv.set("v", 10);
    expect(state.alarm).toBe(1_000_000 + 10_000);
    vi.setSystemTime(1_000_000 + 9_999);
    expect(kv.get()).toBe("v");
    vi.setSystemTime(1_000_000 + 10_000);
    expect(kv.get()).toBeNull();
    await kv.alarm();
    expect(state.data.size).toBe(0);
  });

  it("SET without TTL persists and clears a previous expiry", () => {
    vi.useFakeTimers({ now: 5_000 });
    const { kv, state } = object();
    kv.set("a", 1);
    kv.set("b");
    expect(state.alarm).toBeNull();
    vi.setSystemTime(10_000_000);
    expect(kv.get()).toBe("b");
  });

  it("SET NX only succeeds when absent or expired", () => {
    vi.useFakeTimers({ now: 0 });
    const { kv } = object();
    expect(kv.setIfAbsent("1", 30)).toBe(true);
    expect(kv.setIfAbsent("1", 30)).toBe(false);
    vi.setSystemTime(30_000);
    expect(kv.setIfAbsent("1", 30)).toBe(true);
  });

  it("INCR restarts the TTL each time", () => {
    vi.useFakeTimers({ now: 0 });
    const { kv, state } = object();
    expect(kv.incr(100)).toBe(1);
    vi.setSystemTime(50_000);
    expect(kv.incr(100)).toBe(2);
    expect(state.alarm).toBe(150_000);
    vi.setSystemTime(149_999);
    expect(kv.get()).toBe(2);
  });

  it("an alarm that fires after the TTL was extended does not reap", async () => {
    vi.useFakeTimers({ now: 0 });
    const { kv, state } = object();
    kv.set("v", 10);
    kv.set("v", 100); // extended; a stale 10s alarm may still fire
    vi.setSystemTime(10_000);
    await kv.alarm();
    expect(kv.get()).toBe("v");
    expect(state.data.size).toBe(2);
  });
});
