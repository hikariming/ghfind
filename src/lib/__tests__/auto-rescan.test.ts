import { describe, expect, it } from "vitest";
import type { AtomicStore } from "@/lib/atomic-store";
import {
  AUTO_RESCAN_DEFAULT_MAX_PER_HOUR,
  AUTO_RESCAN_USER_COOLDOWN_SECONDS,
  admitAutoRescan,
  autoRescanBudgetKey,
  autoRescanDisabled,
  autoRescanMaxPerHour,
  autoRescanUserKey,
  isAutomatedClient,
} from "@/lib/auto-rescan";

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
const browserHeaders = (extra: Record<string, string> = {}) =>
  new Headers({ "user-agent": BROWSER_UA, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", ...extra });

describe("auto rescan config", () => {
  it("is on by default and switched off by the kill switch", () => {
    expect(autoRescanDisabled({})).toBe(false);
    for (const value of ["1", "true", "ON", "yes"]) {
      expect(autoRescanDisabled({ GHFIND_AUTO_RESCAN_DISABLED: value })).toBe(true);
    }
    expect(autoRescanDisabled({ GHFIND_AUTO_RESCAN_DISABLED: "0" })).toBe(false);
  });

  it("uses a conservative default hourly budget and accepts overrides", () => {
    expect(autoRescanMaxPerHour({})).toBe(AUTO_RESCAN_DEFAULT_MAX_PER_HOUR);
    expect(autoRescanMaxPerHour({ GHFIND_AUTO_RESCAN_MAX_PER_HOUR: "5" })).toBe(5);
    expect(autoRescanMaxPerHour({ GHFIND_AUTO_RESCAN_MAX_PER_HOUR: "0" })).toBe(0);
    expect(autoRescanMaxPerHour({ GHFIND_AUTO_RESCAN_MAX_PER_HOUR: "-1" })).toBe(AUTO_RESCAN_DEFAULT_MAX_PER_HOUR);
    expect(autoRescanMaxPerHour({ GHFIND_AUTO_RESCAN_MAX_PER_HOUR: "lots" })).toBe(AUTO_RESCAN_DEFAULT_MAX_PER_HOUR);
  });
});

describe("isAutomatedClient", () => {
  it("accepts the profile page's own browser fetch", () => {
    expect(isAutomatedClient(browserHeaders())).toBe(false);
  });

  it.each([
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0)",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/130.0 Safari/537.36",
    "Mozilla/5.0 (compatible; Discordbot/2.0)",
    "facebookexternalhit/1.1",
    "python-requests/2.31",
    "curl/8.0",
    "",
  ])("rejects %s", (ua) => {
    expect(isAutomatedClient(browserHeaders({ "user-agent": ua }))).toBe(true);
  });

  it("rejects requests without same-origin fetch metadata", () => {
    const missing = new Headers({ "user-agent": BROWSER_UA });
    expect(isAutomatedClient(missing)).toBe(true);
    expect(isAutomatedClient(browserHeaders({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isAutomatedClient(browserHeaders({ "sec-fetch-mode": "navigate" }))).toBe(true);
  });
});

describe("admitAutoRescan", () => {
  const now = Date.UTC(2026, 0, 1, 10, 30);

  it("admits once per user per 24h, keeping the slot after the attempt", async () => {
    const store = memoryStore();
    await expect(admitAutoRescan(store, "DemoDev", { maxPerHour: 5, now })).resolves.toEqual({ ok: true });
    expect(store.ttls.get(autoRescanUserKey("demodev"))).toBe(AUTO_RESCAN_USER_COOLDOWN_SECONDS);
    // Same user, any casing, any later outcome (success or failure): cooldown.
    await expect(admitAutoRescan(store, "demodev", { maxPerHour: 5, now: now + 1000 })).resolves.toMatchObject({
      ok: false,
      reason: "cooldown",
    });
    expect(store.data.get(autoRescanBudgetKey(now))).toBe(1);
  });

  it("enforces the global hourly budget and frees the user slot when over it", async () => {
    const store = memoryStore();
    await expect(admitAutoRescan(store, "sample-a", { maxPerHour: 2, now })).resolves.toEqual({ ok: true });
    await expect(admitAutoRescan(store, "sample-b", { maxPerHour: 2, now })).resolves.toEqual({ ok: true });
    const denied = await admitAutoRescan(store, "sample-c", { maxPerHour: 2, now });
    expect(denied).toMatchObject({ ok: false, reason: "budget" });
    expect(denied.ok ? 0 : denied.retryAfter).toBe(30 * 60);
    expect(store.data.has(autoRescanUserKey("sample-c"))).toBe(false);
    // A new hour opens a new budget window.
    await expect(
      admitAutoRescan(store, "sample-c", { maxPerHour: 2, now: now + 60 * 60 * 1000 }),
    ).resolves.toEqual({ ok: true });
  });

  it("treats a zero budget as off", async () => {
    const store = memoryStore();
    await expect(admitAutoRescan(store, "sample-a", { maxPerHour: 0, now })).resolves.toMatchObject({
      ok: false,
      reason: "budget",
    });
    expect(store.data.size).toBe(0);
  });

  it("fails closed without a store or on store errors", async () => {
    await expect(admitAutoRescan(null, "sample-a", { maxPerHour: 5, now })).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    const broken = memoryStore();
    broken.setIfAbsent = async () => {
      throw new Error("down");
    };
    await expect(admitAutoRescan(broken, "sample-a", { maxPerHour: 5, now })).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });
});
