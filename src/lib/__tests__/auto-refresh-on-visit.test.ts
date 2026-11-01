import { describe, expect, it } from "vitest";
import type { AtomicStore } from "@/lib/atomic-store";
import {
  AUTO_REFRESH_ON_VISIT_DEFAULT_HOURLY_BUDGET,
  AUTO_REFRESH_ON_VISIT_STALE_MS,
  AUTO_REFRESH_ON_VISIT_USER_COOLDOWN_SECONDS,
  admitAutoRefreshOnVisit,
  autoRefreshOnVisitBudgetKey,
  autoRefreshOnVisitEnabled,
  autoRefreshOnVisitMaxPerHour,
  autoRefreshOnVisitUserKey,
  isAutomatedVisitClient,
  snapshotStaleForVisitRefresh,
} from "@/lib/auto-refresh-on-visit";
import { RESCAN_COOLDOWN_MS } from "@/lib/freshness";

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

const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

describe("auto refresh on visit config", () => {
  it("is on by default and switched off by explicit values", () => {
    expect(autoRefreshOnVisitEnabled({})).toBe(true);
    for (const value of ["0", "false", "OFF", "no"]) {
      expect(autoRefreshOnVisitEnabled({ AUTO_REFRESH_ON_VISIT_ENABLED: value })).toBe(false);
    }
    expect(autoRefreshOnVisitEnabled({ AUTO_REFRESH_ON_VISIT_ENABLED: "1" })).toBe(true);
  });

  it("defaults the hourly budget to 3000 and accepts overrides", () => {
    expect(AUTO_REFRESH_ON_VISIT_DEFAULT_HOURLY_BUDGET).toBe(3000);
    expect(autoRefreshOnVisitMaxPerHour({})).toBe(AUTO_REFRESH_ON_VISIT_DEFAULT_HOURLY_BUDGET);
    expect(autoRefreshOnVisitMaxPerHour({ AUTO_REFRESH_ON_VISIT_HOURLY_BUDGET: "50" })).toBe(50);
    expect(autoRefreshOnVisitMaxPerHour({ AUTO_REFRESH_ON_VISIT_HOURLY_BUDGET: "0" })).toBe(0);
    expect(autoRefreshOnVisitMaxPerHour({ AUTO_REFRESH_ON_VISIT_HOURLY_BUDGET: "lots" })).toBe(
      AUTO_REFRESH_ON_VISIT_DEFAULT_HOURLY_BUDGET,
    );
  });

  it("uses the 24h rescan cooldown as the stale age", () => {
    expect(AUTO_REFRESH_ON_VISIT_STALE_MS).toBe(RESCAN_COOLDOWN_MS);
    expect(snapshotStaleForVisitRefresh(Date.now() - RESCAN_COOLDOWN_MS)).toBe(true);
    expect(snapshotStaleForVisitRefresh(Date.now() - 60_000)).toBe(false);
    expect(snapshotStaleForVisitRefresh(null)).toBe(false);
  });
});

describe("isAutomatedVisitClient", () => {
  it("accepts a same-origin browser fetch", () => {
    expect(
      isAutomatedVisitClient(
        new Headers({
          "user-agent": BROWSER_UA,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
        }),
      ),
    ).toBe(false);
  });

  it("accepts a document navigation when documentNavigate is set", () => {
    expect(
      isAutomatedVisitClient(
        new Headers({
          "user-agent": BROWSER_UA,
          "sec-fetch-site": "none",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        }),
        { documentNavigate: true },
      ),
    ).toBe(false);
  });

  it("still rejects bot user agents on document navigations", () => {
    expect(
      isAutomatedVisitClient(
        new Headers({
          "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
          "sec-fetch-mode": "navigate",
        }),
        { documentNavigate: true },
      ),
    ).toBe(true);
  });
});

describe("admitAutoRefreshOnVisit", () => {
  const now = Date.UTC(2026, 0, 1, 10, 30);

  it("admits once per user per 24h on a separate key namespace", async () => {
    const store = memoryStore();
    await expect(admitAutoRefreshOnVisit(store, "DemoDev", { maxPerHour: 5, now })).resolves.toEqual({
      ok: true,
    });
    expect(store.ttls.get(autoRefreshOnVisitUserKey("demodev"))).toBe(
      AUTO_REFRESH_ON_VISIT_USER_COOLDOWN_SECONDS,
    );
    expect(store.data.has("auto-rescan:v1:user:demodev")).toBe(false);
    await expect(
      admitAutoRefreshOnVisit(store, "demodev", { maxPerHour: 5, now: now + 1000 }),
    ).resolves.toMatchObject({ ok: false, reason: "cooldown" });
    expect(store.data.get(autoRefreshOnVisitBudgetKey(now))).toBe(1);
  });

  it("enforces the hourly budget", async () => {
    const store = memoryStore();
    await expect(admitAutoRefreshOnVisit(store, "sample-a", { maxPerHour: 1, now })).resolves.toEqual({
      ok: true,
    });
    const denied = await admitAutoRefreshOnVisit(store, "sample-b", { maxPerHour: 1, now });
    expect(denied).toMatchObject({ ok: false, reason: "budget" });
    expect(store.data.has(autoRefreshOnVisitUserKey("sample-b"))).toBe(false);
  });
});
