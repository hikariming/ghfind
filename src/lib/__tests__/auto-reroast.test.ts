import { describe, expect, it } from "vitest";
import type { AtomicStore } from "@/lib/atomic-store";
import {
  AUTO_REROAST_DEFAULT_MAX_PER_HOUR,
  AUTO_REROAST_QUEUE_TAIL_KEY,
  AUTO_REROAST_USER_COOLDOWN_SECONDS,
  admitAutoReroast,
  autoReroastArmedKey,
  autoReroastBudgetKey,
  autoReroastDisabled,
  autoReroastJobKey,
  autoReroastMaxPerHour,
  autoReroastSessionKey,
  autoReroastSlotKey,
  autoReroastUserKey,
  isActiveJob,
  type AutoReroastJob,
} from "@/lib/auto-reroast";
import { ROAST_CACHE_VERSION } from "@/lib/cache-version";

function memoryStore(): AtomicStore & { data: Map<string, unknown>; ttls: Map<string, number> } {
  const data = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  return {
    backend: "redis",
    data,
    ttls,
    async get<T>(key: string) {
      return (data.get(key) as T) ?? null;
    },
    async set(key, value, ttl) {
      data.set(key, value);
      if (ttl) ttls.set(key, ttl);
    },
    async setIfAbsent(key, value, ttl) {
      if (data.has(key)) return false;
      data.set(key, value);
      ttls.set(key, ttl);
      return true;
    },
    async del(key) {
      data.delete(key);
    },
    async incr(key, ttl) {
      const next = Number(data.get(key) ?? 0) + 1;
      data.set(key, next);
      ttls.set(key, ttl);
      return next;
    },
  };
}

const NOW = Date.UTC(2026, 9, 27, 3, 15);

describe("auto re-roast config", () => {
  it("is on by default and has its own kill switch", () => {
    expect(autoReroastDisabled({})).toBe(false);
    for (const value of ["1", "true", "ON", "yes"]) {
      expect(autoReroastDisabled({ GHFIND_AUTO_REROAST_DISABLED: value })).toBe(true);
    }
    // The score rescan kill switch does not stop re-roasts (and vice versa).
    expect(autoReroastDisabled({ GHFIND_AUTO_RESCAN_DISABLED: "1" })).toBe(false);
  });

  it("uses a conservative default hourly budget", () => {
    expect(AUTO_REROAST_DEFAULT_MAX_PER_HOUR).toBe(60);
    expect(autoReroastMaxPerHour({})).toBe(60);
    expect(autoReroastMaxPerHour({ GHFIND_AUTO_REROAST_MAX_PER_HOUR: "5" })).toBe(5);
    expect(autoReroastMaxPerHour({ GHFIND_AUTO_REROAST_MAX_PER_HOUR: "0" })).toBe(0);
    expect(autoReroastMaxPerHour({ GHFIND_AUTO_REROAST_MAX_PER_HOUR: "-3" })).toBe(60);
    expect(autoReroastMaxPerHour({ GHFIND_AUTO_REROAST_MAX_PER_HOUR: "lots" })).toBe(60);
  });

  it("keys are case-insensitive and version-driven", () => {
    expect(autoReroastJobKey("DemoDev", "zh")).toBe(autoReroastJobKey("demodev", "zh"));
    expect(autoReroastUserKey("v12", "DemoDev", "en")).not.toBe(autoReroastUserKey("v13", "DemoDev", "en"));
    expect(autoReroastSessionKey("DemoDev", "zh")).toBe(autoReroastSessionKey("demodev", "zh"));
    expect(autoReroastSessionKey("DemoDev", "zh")).not.toBe(autoReroastSessionKey("DemoDev", "en"));
    expect(autoReroastArmedKey("DemoDev")).toBe(autoReroastArmedKey("demodev"));
  });
});

describe("admitAutoReroast", () => {
  it("claims the user slot and one budget unit, then queues a job for the current release", async () => {
    const store = memoryStore();
    const admission = await admitAutoReroast(store, { username: "DemoDev", lang: "zh" }, { maxPerHour: 20, now: NOW });
    expect(admission).toMatchObject({ ok: true, existing: false });
    if (!admission.ok) throw new Error("expected admission");
    expect(admission.job).toMatchObject({
      state: "queued",
      username: "demodev",
      lang: "zh",
      target: ROAST_CACHE_VERSION,
      attempts: 0,
    });
    expect(store.ttls.get(autoReroastUserKey(ROAST_CACHE_VERSION, "demodev", "zh"))).toBe(
      AUTO_REROAST_USER_COOLDOWN_SECONDS,
    );
    expect(store.data.get(autoReroastBudgetKey(NOW))).toBe(1);
    expect(store.data.get(AUTO_REROAST_QUEUE_TAIL_KEY)).toBe(1);
    expect(store.data.get(autoReroastSlotKey(1))).toEqual({
      username: "demodev",
      lang: "zh",
      target: ROAST_CACHE_VERSION,
    });
  });

  it("joins an active job for free instead of spending budget", async () => {
    const store = memoryStore();
    await admitAutoReroast(store, { username: "DemoDev", lang: "zh" }, { maxPerHour: 20, now: NOW });
    const again = await admitAutoReroast(store, { username: "demodev", lang: "zh" }, { maxPerHour: 20, now: NOW + 1 });
    expect(again).toMatchObject({ ok: true, existing: true });
    expect(store.data.get(autoReroastBudgetKey(NOW))).toBe(1);
    expect(store.data.get(AUTO_REROAST_QUEUE_TAIL_KEY)).toBe(1);
  });

  it("defers with cooldown once the user/lang/release attempt was spent", async () => {
    const store = memoryStore();
    const failed: AutoReroastJob = {
      state: "failed",
      username: "demodev",
      lang: "en",
      target: ROAST_CACHE_VERSION,
      queuedAt: NOW,
      attempts: 2,
      updatedAt: NOW,
      reason: "generation_failed",
    };
    await store.set(autoReroastJobKey("demodev", "en"), failed);
    await store.set(autoReroastUserKey(ROAST_CACHE_VERSION, "demodev", "en"), NOW);
    const admission = await admitAutoReroast(store, { username: "DemoDev", lang: "en" }, { maxPerHour: 20, now: NOW });
    expect(admission).toMatchObject({ ok: false, reason: "cooldown" });
    // The other language is independent.
    const zh = await admitAutoReroast(store, { username: "DemoDev", lang: "zh" }, { maxPerHour: 20, now: NOW });
    expect(zh.ok).toBe(true);
  });

  it("a newer roast release gets a fresh attempt (version-driven cooldown)", async () => {
    const store = memoryStore();
    await store.set(autoReroastUserKey("v-old", "demodev", "zh"), NOW);
    const admission = await admitAutoReroast(
      store,
      { username: "DemoDev", lang: "zh", target: "v-new" },
      { maxPerHour: 20, now: NOW },
    );
    expect(admission).toMatchObject({ ok: true, existing: false });
    if (admission.ok) expect(admission.job.target).toBe("v-new");
  });

  it("enforces the global hourly budget and releases the user slot it could not use", async () => {
    const store = memoryStore();
    const first = await admitAutoReroast(store, { username: "sample-a", lang: "zh" }, { maxPerHour: 1, now: NOW });
    expect(first.ok).toBe(true);
    const second = await admitAutoReroast(store, { username: "DemoDev", lang: "zh" }, { maxPerHour: 1, now: NOW });
    expect(second).toMatchObject({ ok: false, reason: "budget" });
    if (!second.ok) expect(second.retryAfter).toBeGreaterThan(0);
    expect(store.data.has(autoReroastUserKey(ROAST_CACHE_VERSION, "demodev", "zh"))).toBe(false);
    expect(store.data.get(AUTO_REROAST_QUEUE_TAIL_KEY)).toBe(1);
  });

  it("a zero budget disables admission without touching the store", async () => {
    const store = memoryStore();
    const admission = await admitAutoReroast(store, { username: "DemoDev", lang: "zh" }, { maxPerHour: 0, now: NOW });
    expect(admission).toMatchObject({ ok: false, reason: "budget" });
    expect(store.data.size).toBe(0);
  });

  it("fails closed without a store or when the store throws", async () => {
    await expect(
      admitAutoReroast(null, { username: "DemoDev", lang: "zh" }, { maxPerHour: 20, now: NOW }),
    ).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    const broken = memoryStore();
    broken.setIfAbsent = async () => {
      throw new Error("down");
    };
    await expect(
      admitAutoReroast(broken, { username: "DemoDev", lang: "zh" }, { maxPerHour: 20, now: NOW }),
    ).resolves.toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("only queued/running jobs for the current release are active", () => {
    const job: AutoReroastJob = {
      state: "running",
      username: "demodev",
      lang: "zh",
      target: ROAST_CACHE_VERSION,
      queuedAt: NOW,
      attempts: 0,
      updatedAt: NOW,
    };
    expect(isActiveJob(job)).toBe(true);
    expect(isActiveJob({ ...job, state: "done" })).toBe(false);
    expect(isActiveJob({ ...job, target: "v-old" })).toBe(false);
    expect(isActiveJob(null)).toBe(false);
  });
});
