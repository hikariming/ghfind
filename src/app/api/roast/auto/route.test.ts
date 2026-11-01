import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtomicStore } from "@/lib/atomic-store";

const mocks = vi.hoisted(() => ({
  getAccountDetail: vi.fn(),
  machineAuth: vi.fn(),
  checkRateLimit: vi.fn(),
  store: { current: null as AtomicStore | null },
}));
vi.mock("@/lib/db", () => ({ getAccountDetail: mocks.getAccountDetail }));
vi.mock("@/lib/machine-auth", () => ({ machineAuth: mocks.machineAuth }));
vi.mock("@/lib/redis", () => ({
  autoReroastStore: () => mocks.store.current,
  checkRateLimit: mocks.checkRateLimit,
  rateLimitHeaders: () => ({}),
}));

import { autoReroastJobKey, autoReroastUserKey, type AutoReroastJob } from "@/lib/auto-reroast";
import { ROAST_CACHE_VERSION, SCORE_CACHE_VERSION } from "@/lib/cache-version";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "@/lib/scan-run-types";
import { GET, POST } from "./route";

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

const BROWSER = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "cf-connecting-ip": "203.0.113.7",
};

const post = (body: unknown, headers: Record<string, string> = BROWSER) =>
  POST(
    new NextRequest("https://ghfind.test/api/roast/auto", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

const currentScore = (roast: string | null = null, roastEn: string | null = null) => ({
  username: "DemoDev",
  legacy_read_fallback: false,
  score_version: SCORE_CACHE_VERSION,
  score_source_collection_version: PUBLIC_SCAN_COLLECTION_VERSION,
  score_source_snapshot_hash: "a".repeat(64),
  roast,
  roast_en: roastEn,
});

let store: ReturnType<typeof memoryStore>;

beforeEach(() => {
  vi.clearAllMocks();
  store = memoryStore();
  mocks.store.current = store;
  mocks.machineAuth.mockResolvedValue("absent");
  mocks.checkRateLimit.mockResolvedValue({ success: true });
  mocks.getAccountDetail.mockResolvedValue(currentScore());
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.GHFIND_AUTO_REROAST_DISABLED;
  delete process.env.GHFIND_AUTO_REROAST_MAX_PER_HOUR;
  vi.restoreAllMocks();
});

describe("POST /api/roast/auto", () => {
  it("queues one job for a current score without a current report and points at the status URL", async () => {
    const res = await post({ username: "DemoDev", lang: "zh", trigger: "roast_version_upgrade" });
    expect(res.status).toBe(202);
    expect(res.headers.get("Location")).toBe("/api/roast/auto?username=DemoDev&lang=zh");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ state: "queued", target_version: ROAST_CACHE_VERSION });
    expect(store.data.get(autoReroastJobKey("demodev", "zh"))).toMatchObject({ state: "queued" });
  });

  it("joins the in-flight job without re-reading the profile or spending budget", async () => {
    await post({ username: "DemoDev", lang: "zh" });
    mocks.getAccountDetail.mockClear();
    const res = await post({ username: "demodev", lang: "zh" });
    expect(res.status).toBe(202);
    expect(mocks.getAccountDetail).not.toHaveBeenCalled();
  });

  it("answers done when the report is already on the current release", async () => {
    mocks.getAccountDetail.mockResolvedValue(currentScore(null, "# report"));
    const res = await post({ username: "DemoDev", lang: "en" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "done" });
  });

  it("refuses profiles whose score is not current (the score rescan goes first)", async () => {
    mocks.getAccountDetail.mockResolvedValue({ ...currentScore(), score_version: "v-old" });
    const res = await post({ username: "DemoDev", lang: "zh" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "not_eligible", state: "none" });
    mocks.getAccountDetail.mockResolvedValue({ ...currentScore(), legacy_read_fallback: true });
    expect((await post({ username: "DemoDev", lang: "zh" })).status).toBe(409);
  });

  it("honours the kill switch, the automated-client filter and machine callers", async () => {
    process.env.GHFIND_AUTO_REROAST_DISABLED = "1";
    expect((await post({ username: "DemoDev", lang: "zh" })).status).toBe(503);
    delete process.env.GHFIND_AUTO_REROAST_DISABLED;
    expect((await post({ username: "DemoDev", lang: "zh" }, { "user-agent": "curl/8.0" })).status).toBe(403);
    expect(
      (await post({ username: "DemoDev", lang: "zh" }, { ...BROWSER, "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    mocks.machineAuth.mockResolvedValue("valid");
    expect((await post({ username: "DemoDev", lang: "zh" })).status).toBe(403);
    expect(store.data.size).toBe(0);
  });

  it("applies the per-IP limit", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false });
    expect((await post({ username: "DemoDev", lang: "zh" })).status).toBe(429);
    mocks.checkRateLimit.mockResolvedValue({ success: false, unavailable: true });
    expect((await post({ username: "DemoDev", lang: "zh" })).status).toBe(503);
  });

  it("defers on the per-user cooldown and the hourly budget with Retry-After", async () => {
    await store.set(autoReroastUserKey(ROAST_CACHE_VERSION, "demodev", "zh"), 1);
    const cooldown = await post({ username: "DemoDev", lang: "zh" });
    expect(cooldown.status).toBe(429);
    expect(await cooldown.json()).toMatchObject({ reason: "cooldown" });
    expect(cooldown.headers.get("Retry-After")).toBe("86400");

    process.env.GHFIND_AUTO_REROAST_MAX_PER_HOUR = "0";
    const budget = await post({ username: "sample-a", lang: "zh" });
    expect(budget.status).toBe(429);
    expect(await budget.json()).toMatchObject({ reason: "budget" });
  });

  it("fails closed without the coordination store", async () => {
    mocks.store.current = null;
    const res = await post({ username: "DemoDev", lang: "zh" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: "unavailable" });
  });

  it("rejects bad input", async () => {
    expect((await post({ username: "not a user!", lang: "zh" })).status).toBe(400);
    expect((await post({ username: "DemoDev", lang: "zh", trigger: "batch" })).status).toBe(400);
  });
});

describe("GET /api/roast/auto", () => {
  const get = (q: string) => GET(new NextRequest(`https://ghfind.test/api/roast/auto?${q}`));
  const job = (state: AutoReroastJob["state"], reason?: string): AutoReroastJob => ({
    state,
    username: "demodev",
    lang: "zh",
    target: ROAST_CACHE_VERSION,
    queuedAt: 1,
    attempts: 0,
    updatedAt: 1,
    reason,
  });

  it("reports an active job from the store without reading the profile", async () => {
    await store.set(autoReroastJobKey("demodev", "zh"), job("running"));
    const res = await get("username=DemoDev&lang=zh");
    expect(await res.json()).toEqual({ state: "running", target_version: ROAST_CACHE_VERSION });
    expect(mocks.getAccountDetail).not.toHaveBeenCalled();
  });

  it("reports done once the current report is persisted, failed (with reason) otherwise", async () => {
    await store.set(autoReroastJobKey("demodev", "zh"), job("failed", "generation_failed"));
    expect(await (await get("username=DemoDev&lang=zh")).json()).toEqual({
      state: "failed",
      target_version: ROAST_CACHE_VERSION,
      reason: "generation_failed",
    });
    mocks.getAccountDetail.mockResolvedValue(currentScore("# report"));
    expect(await (await get("username=DemoDev&lang=zh")).json()).toMatchObject({ state: "done" });
  });

  it("reports none when nothing was queued", async () => {
    expect(await (await get("username=DemoDev&lang=en")).json()).toMatchObject({ state: "none" });
    expect((await get("username=")).status).toBe(400);
  });
});
