import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ScanResult } from "../types";
import { ADMIT_SCAN, PUBLISH_SCAN, RELEASE_SCAN, ScanBusyError } from "../scan-protection";

const state = vi.hoisted(() => ({ values: new Map<string, unknown>(), broken: false }));
vi.mock("@upstash/redis", () => ({ Redis: class {
  async get(key: string) {
    if (state.broken) throw new Error("offline");
    return state.values.get(key) ?? null;
  }
  async eval(script: string, keys: string[], args: unknown[]) {
    if (state.broken) throw new Error("offline");
    if (script === ADMIT_SCAN) {
      if (state.values.has(keys[0])) return 0;
      if (state.values.has(keys[2])) return -1;
      state.values.set(keys[0], args[0]); return 1;
    }
    if (script === PUBLISH_SCAN) {
      if (state.values.get(keys[0]) !== args[0]) return 0;
      state.values.set(keys[1], JSON.parse(String(args[1])));
      if (keys[2]) state.values.set(keys[2], args[0]);
      return 1;
    }
    if (script === RELEASE_SCAN) {
      if (state.values.get(keys[0]) === args[0]) {
        state.values.delete(keys[0]);
        if (args[1] === "failed") state.values.set(keys[2], "1");
      }
      return 1;
    }
    if (script === READ_REFRESHED_SCAN) {
      const revision = state.values.get(keys[1]);
      return revision && revision !== args[0] ? state.values.get(keys[0]) ?? null : null;
    }
    throw new Error("unhandled script");
  }
} }));
vi.mock("../score", () => ({ score: (metrics: unknown) => ({ metrics }) }));
import { coalesceScan, READ_REFRESHED_SCAN, scanKey } from "../redis";
const scan = (name: string) => ({ metrics: { username: name }, scoring: {} }) as ScanResult;
const key = scanKey("demo");
const revision = `revision:${key}`;
beforeEach(() => {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unused.invalid");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fixture");
  state.values.clear(); state.broken = false;
});
afterEach(() => vi.unstubAllEnvs());

it("refreshes a warm cache without deleting it first", async () => {
  const old = scan("old"); state.values.set(key, old); state.values.set(revision, "baseline");
  const producer = vi.fn(async () => {
    expect(state.values.get(key)).toBe(old);
    return scan("new");
  });
  expect((await coalesceScan("demo", producer, { force: true })).metrics.username).toBe("new");
  expect(producer).toHaveBeenCalledOnce();
  expect(state.values.get(revision)).not.toBe("baseline");
});

it("accepts pre-revision warm caches for normal reads but refreshes them on force", async () => {
  state.values.set(key, scan("old"));
  const producer = vi.fn(async () => scan("new"));
  expect((await coalesceScan("demo", producer)).metrics.username).toBe("old");
  expect(producer).not.toHaveBeenCalled();
  expect((await coalesceScan("demo", producer, { force: true })).metrics.username).toBe("new");
  expect(producer).toHaveBeenCalledOnce();
});

it("joins a fresh concurrent publication while ignoring the warm baseline", async () => {
  state.values.set(key, scan("old")); state.values.set(revision, "baseline");
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const producer = vi.fn(async () => { entered(); await gate; return scan("new"); });
  const first = coalesceScan("demo", producer, { force: true });
  await started;
  const second = coalesceScan("demo", producer, { force: true });
  // Let the follower capture the old revision before the leader publishes.
  await Promise.resolve();
  release();
  const results = await Promise.all([first, second]);
  expect(results.map(x => x.metrics.username)).toEqual(["new", "new"]);
  expect(producer).toHaveBeenCalledOnce();
});

it("a later forced request does not accept an earlier completed refresh", async () => {
  const producer = vi.fn().mockResolvedValueOnce(scan("first")).mockResolvedValueOnce(scan("second"));
  await coalesceScan("demo", producer, { force: true });
  expect((await coalesceScan("demo", producer, { force: true })).metrics.username).toBe("second");
  expect(producer).toHaveBeenCalledTimes(2);
});

it("fails closed when Redis cannot establish a fresh baseline", async () => {
  state.values.set(key, scan("old")); state.broken = true;
  const producer = vi.fn();
  await expect(coalesceScan("demo", producer, { force: true })).rejects.toBeInstanceOf(ScanBusyError);
  expect(producer).not.toHaveBeenCalled();
});

it("retains the old cache and cooldown when a forced producer fails", async () => {
  const old = scan("old"); state.values.set(key, old); state.values.set(revision, "baseline");
  await expect(coalesceScan("demo", async () => { throw new Error("upstream"); }, { force: true })).rejects.toThrow("upstream");
  expect(state.values.get(key)).toBe(old);
  expect(state.values.get(revision)).toBe("baseline");
  expect(state.values.has(`cooldown:${key}`)).toBe(true);
});

it("rejects an expired owner without changing either fresh payload or revision", async () => {
  state.values.set(key, scan("old")); state.values.set(revision, "baseline");
  const newer = scan("new-owner");
  await expect(coalesceScan("demo", async () => {
    // A new lease holder has already atomically published while this worker ran.
    state.values.set(`lock:${key}`, "new-owner");
    state.values.set(key, newer); state.values.set(revision, "new-publication");
    return scan("expired-owner");
  }, { force: true })).rejects.toBeInstanceOf(ScanBusyError);
  expect(state.values.get(key)).toBe(newer);
  expect(state.values.get(revision)).toBe("new-publication");
});
