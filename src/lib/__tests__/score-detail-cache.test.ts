import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountDetail } from "../db";
import { ADMIT_SCAN, PUBLISH_SCAN, RELEASE_SCAN, ScanBusyError } from "../scan-protection";

const state = vi.hoisted(() => ({ values: new Map<string, unknown>(), failGet: false, failSet: false }));
vi.mock("@upstash/redis", () => ({ Redis: class {
  async get(key: string) {
    if (state.failGet) throw new Error("redis read unavailable");
    return state.values.get(key) ?? null;
  }
  async set(key: string, value: unknown) {
    if (state.failSet) throw new Error("redis write unavailable");
    state.values.set(key, value); return "OK";
  }
  async eval(script: string, keys: string[], args: unknown[]) {
    if (script === ADMIT_SCAN) {
      if (state.values.has(keys[0])) return 0;
      if (state.values.has(keys[2])) return -1;
      state.values.set(keys[0], args[0]); return 1;
    }
    if (script === PUBLISH_SCAN) {
      if (state.values.get(keys[0]) !== args[0]) return 0;
      state.values.set(keys[1], JSON.parse(String(args[1]))); return 1;
    }
    if (script === RELEASE_SCAN) {
      if (state.values.get(keys[0]) === args[0]) state.values.delete(keys[0]);
      return 1;
    }
    throw new Error("unknown script");
  }
} }));
import { advanceScoreDetailRevision, getCachedScoreDetail } from "../redis";
const detail = (score: number) => ({ username: "demo", final_score: score }) as AccountDetail;
beforeEach(() => {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unused.invalid");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fixture");
  state.values.clear(); state.failGet = false; state.failSet = false;
});
afterEach(() => vi.unstubAllEnvs());

it("reuses warm indexed details without loading the database", async () => {
  const load = vi.fn(async () => detail(40));
  await getCachedScoreDetail("Demo", load);
  expect(await getCachedScoreDetail("demo", load)).toMatchObject({ final_score: 40 });
  expect(load).toHaveBeenCalledOnce();
});

it("moves negative cache entries to a new namespace on publication", async () => {
  const load = vi.fn<() => Promise<AccountDetail | null>>().mockResolvedValueOnce(null).mockResolvedValue(detail(50));
  expect(await getCachedScoreDetail("demo", load)).toBeNull();
  expect(await getCachedScoreDetail("demo", load)).toBeNull();
  expect(load).toHaveBeenCalledOnce();
  await advanceScoreDetailRevision("demo");
  expect(await getCachedScoreDetail("demo", load)).toMatchObject({ final_score: 50 });
  expect(load).toHaveBeenCalledTimes(2);
});

it("does not let an old in-flight loader poison the new publication", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const load = vi.fn<() => Promise<AccountDetail | null>>()
    .mockImplementationOnce(async () => { entered(); await gate; return detail(40); })
    .mockResolvedValue(detail(60));
  const reading = getCachedScoreDetail("demo", load);
  await started;
  await advanceScoreDetailRevision("demo");
  release();
  expect(await reading).toMatchObject({ final_score: 60 });
  expect(await getCachedScoreDetail("demo", load)).toMatchObject({ final_score: 60 });
  expect(load).toHaveBeenCalledTimes(2);
});

it("fails closed on a revision read failure before touching the database", async () => {
  state.failGet = true;
  const load = vi.fn();
  await expect(getCachedScoreDetail("demo", load)).rejects.toBeInstanceOf(ScanBusyError);
  expect(load).not.toHaveBeenCalled();
});

it("propagates failed revision writes so publication cannot claim freshness", async () => {
  state.failSet = true;
  await expect(advanceScoreDetailRevision("demo")).rejects.toThrow();
});

it("bounds retries when every load races another publication", async () => {
  const load = vi.fn(async () => {
    await advanceScoreDetailRevision("demo");
    return detail(50);
  });
  await expect(getCachedScoreDetail("demo", load)).rejects.toBeInstanceOf(ScanBusyError);
  expect(load).toHaveBeenCalledTimes(3);
});
