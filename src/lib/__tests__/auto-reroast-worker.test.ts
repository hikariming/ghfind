import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtomicStore } from "@/lib/atomic-store";

const { getAccountDetail } = vi.hoisted(() => ({ getAccountDetail: vi.fn() }));
vi.mock("@/lib/db", () => ({ getAccountDetail }));
vi.mock("@/lib/redis", () => ({ autoReroastStore: () => null }));
vi.mock("@/lib/roast-handler", () => ({ handleRoastPost: vi.fn() }));

import {
  AUTO_REROAST_JOB_MAX_AGE_MS,
  AUTO_REROAST_QUEUE_HEAD_KEY,
  AUTO_REROAST_QUEUE_TAIL_KEY,
  AUTO_REROAST_WORKER_LEASE_KEY,
  admitAutoReroast,
  autoReroastJobKey,
  type AutoReroastJob,
  type AutoReroastSlot,
} from "@/lib/auto-reroast";
import { runAutoReroastQueue } from "@/lib/auto-reroast-worker";
import { ROAST_CACHE_VERSION } from "@/lib/cache-version";

function memoryStore(): AtomicStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    backend: "redis",
    data,
    async get<T>(key: string) {
      return (data.get(key) as T) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async setIfAbsent(key, value) {
      if (data.has(key)) return false;
      data.set(key, value);
      return true;
    },
    async del(key) {
      data.delete(key);
    },
    async incr(key) {
      const next = Number(data.get(key) ?? 0) + 1;
      data.set(key, next);
      return next;
    },
  };
}

const NOW = Date.UTC(2026, 9, 27, 3, 15);
const clock = () => NOW;

async function enqueue(store: AtomicStore, username: string, lang: "zh" | "en" = "zh") {
  const admission = await admitAutoReroast(store, { username, lang }, { maxPerHour: 20, now: NOW });
  if (!admission.ok) throw new Error("expected admission");
}

const job = async (store: AtomicStore, username: string, lang: "zh" | "en" = "zh") =>
  store.get<AutoReroastJob>(autoReroastJobKey(username, lang));

beforeEach(() => {
  getAccountDetail.mockReset();
  getAccountDetail.mockResolvedValue({ roast: null, roast_en: null, legacy_read_fallback: false });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.GHFIND_AUTO_REROAST_DISABLED;
  vi.restoreAllMocks();
});

describe("runAutoReroastQueue", () => {
  it("does nothing when disabled, without a store, or while another worker holds the lease", async () => {
    const produce = vi.fn();
    process.env.GHFIND_AUTO_REROAST_DISABLED = "1";
    await expect(runAutoReroastQueue({ store: memoryStore(), produce })).resolves.toEqual({ status: "disabled" });
    delete process.env.GHFIND_AUTO_REROAST_DISABLED;
    await expect(runAutoReroastQueue({ store: null, produce })).resolves.toEqual({ status: "unavailable" });
    const store = memoryStore();
    await store.set(AUTO_REROAST_WORKER_LEASE_KEY, NOW);
    await enqueue(store, "DemoDev");
    await expect(runAutoReroastQueue({ store, produce })).resolves.toEqual({ status: "busy" });
    expect(produce).not.toHaveBeenCalled();
  });

  it("drains FIFO up to maxJobs, marks jobs done and releases the lease", async () => {
    const store = memoryStore();
    for (const name of ["sample-a", "sample-b", "sample-c", "DemoDev"]) await enqueue(store, name);
    const produce = vi.fn(async (_slot: AutoReroastSlot) => "done" as const);
    const result = await runAutoReroastQueue({ store, produce, maxJobs: 3, now: clock });
    expect(result).toEqual({ status: "ran", processed: 3, outcomes: { done: 3 } });
    expect(produce.mock.calls.map(([slot]) => slot.username)).toEqual(["sample-a", "sample-b", "sample-c"]);
    expect((await job(store, "sample-a"))?.state).toBe("done");
    expect((await job(store, "demodev"))?.state).toBe("queued");
    expect(store.data.get(AUTO_REROAST_QUEUE_HEAD_KEY)).toBe(3);
    expect(store.data.has(AUTO_REROAST_WORKER_LEASE_KEY)).toBe(false);
  });

  it("skips the producer when the report is already current", async () => {
    const store = memoryStore();
    await enqueue(store, "DemoDev");
    getAccountDetail.mockResolvedValue({ roast: "# report", roast_en: null, legacy_read_fallback: false });
    const produce = vi.fn();
    await runAutoReroastQueue({ store, produce, now: clock });
    expect(produce).not.toHaveBeenCalled();
    expect(await job(store, "demodev")).toMatchObject({ state: "done", reason: "already_current" });
  });

  it("re-queues a failed attempt once, then marks the job failed", async () => {
    const store = memoryStore();
    await enqueue(store, "DemoDev");
    const produce = vi.fn(async () => "failed" as const);
    const first = await runAutoReroastQueue({ store, produce, maxJobs: 1, now: clock });
    expect(first.outcomes).toEqual({ retry: 1 });
    expect(await job(store, "demodev")).toMatchObject({ state: "queued", attempts: 1 });
    const second = await runAutoReroastQueue({ store, produce, now: clock });
    expect(second.outcomes).toEqual({ failed: 1 });
    expect(await job(store, "demodev")).toMatchObject({ state: "failed", attempts: 2, reason: "generation_failed" });
    expect(store.data.get(AUTO_REROAST_QUEUE_TAIL_KEY)).toBe(2);
  });

  it("treats a thrown producer as a failed attempt", async () => {
    const store = memoryStore();
    await enqueue(store, "DemoDev");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const produce = vi.fn(async () => {
      throw new Error("model down");
    });
    const result = await runAutoReroastQueue({ store, produce, maxJobs: 1, now: clock });
    expect(result.outcomes).toEqual({ retry: 1 });
  });

  it("keeps an async producer's pending job queued without spending an attempt", async () => {
    const store = memoryStore();
    await enqueue(store, "DemoDev");
    const produce = vi.fn(async () => "pending" as const);
    const result = await runAutoReroastQueue({ store, produce, maxJobs: 1, now: clock });
    expect(result.outcomes).toEqual({ pending: 1 });
    expect(await job(store, "demodev")).toMatchObject({ state: "queued", attempts: 0 });
    // Re-enqueued behind the head for the next tick.
    expect(store.data.get(AUTO_REROAST_QUEUE_TAIL_KEY)).toBe(2);
    expect(store.data.get(AUTO_REROAST_QUEUE_HEAD_KEY)).toBe(1);
  });

  it("expires jobs that outlived the max age (slow async generation)", async () => {
    const store = memoryStore();
    await enqueue(store, "DemoDev");
    const produce = vi.fn();
    const later = () => NOW + AUTO_REROAST_JOB_MAX_AGE_MS + 1;
    const result = await runAutoReroastQueue({ store, produce, now: later });
    expect(result.outcomes).toEqual({ expired: 1 });
    expect(produce).not.toHaveBeenCalled();
    expect(await job(store, "demodev")).toMatchObject({ state: "failed", reason: "expired" });
  });

  it("supersedes jobs queued for a roast release that is no longer current", async () => {
    const store = memoryStore();
    const admission = await admitAutoReroast(
      store,
      { username: "DemoDev", lang: "en", target: `${ROAST_CACHE_VERSION}-previous` },
      { maxPerHour: 20, now: NOW },
    );
    expect(admission.ok).toBe(true);
    const produce = vi.fn();
    const result = await runAutoReroastQueue({ store, produce, now: clock });
    expect(result.outcomes).toEqual({ superseded: 1 });
    expect(produce).not.toHaveBeenCalled();
    expect(await job(store, "demodev", "en")).toMatchObject({ state: "failed", reason: "superseded" });
  });

  it("stops taking new jobs once the tick's time budget is spent", async () => {
    const store = memoryStore();
    for (const name of ["sample-a", "sample-b"]) await enqueue(store, name);
    let t = NOW;
    const produce = vi.fn(async () => {
      t += 10 * 60_000;
      return "done" as const;
    });
    const result = await runAutoReroastQueue({ store, produce, budgetMs: 8 * 60_000, now: () => t });
    expect(result.processed).toBe(1);
    expect((await job(store, "sample-b"))?.state).toBe("queued");
  });
});
