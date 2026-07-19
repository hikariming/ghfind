import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccountDetail: vi.fn(),
  recordAccountLookup: vi.fn(),
  getPercentileCached: vi.fn(),
  getRankCached: vi.fn(),
  checkPublicScanStatusRateLimit: vi.fn(),
  checkRateLimit: vi.fn(),
  coalesceScan: vi.fn(),
  getCachedScan: vi.fn(),
  rateLimitHeaders: vi.fn(),
  setCachedScan: vi.fn(),
  buildScanResult: vi.fn(),
  scanErrorResponse: vi.fn(),
  getPublicScanStatus: vi.fn(),
  publicScanAdmission: vi.fn(() => ({ bucket: "test", limit: 2, windowMs: 60_000, maxActiveJobs: 24 })),
  requiresDurablePublicScan: vi.fn(),
  resolvePublicScanFromTrustedQuickScan: vi.fn(),
  kickPublicScanDrain: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getAccountDetail: mocks.getAccountDetail,
  recordAccountLookup: mocks.recordAccountLookup,
}));

vi.mock("@/lib/rank", () => ({
  getPercentileCached: mocks.getPercentileCached,
  getRankCached: mocks.getRankCached,
}));

vi.mock("@/lib/redis", () => ({
  checkPublicScanStatusRateLimit: mocks.checkPublicScanStatusRateLimit,
  checkRateLimit: mocks.checkRateLimit,
  coalesceScan: mocks.coalesceScan,
  getCachedScan: mocks.getCachedScan,
  rateLimitHeaders: mocks.rateLimitHeaders,
  setCachedScan: mocks.setCachedScan,
}));

vi.mock("@/lib/scan-core", () => ({
  buildScanResult: mocks.buildScanResult,
  scanErrorResponse: mocks.scanErrorResponse,
}));

vi.mock("@/lib/public-scan", () => ({
  getPublicScanStatus: mocks.getPublicScanStatus,
  publicScanAdmission: mocks.publicScanAdmission,
  requiresDurablePublicScan: mocks.requiresDurablePublicScan,
  resolvePublicScanFromTrustedQuickScan: mocks.resolvePublicScanFromTrustedQuickScan,
}));

vi.mock("@/lib/public-scan-dispatcher", () => ({
  kickPublicScanDrain: mocks.kickPublicScanDrain,
}));

import { GET } from "./route";

const quickScan = {
  metrics: {
    username: "DemoDev",
    profile_url: "https://github.com/DemoDev",
    avatar_url: "https://avatars.githubusercontent.com/u/1",
  },
  scoring: {
    final_score: 21,
    tier: "NPC",
    tier_label: "ordinary",
    sub_scores: {},
    base_score: 21,
    total_penalty: 0,
    red_flags: [],
  },
};

function request() {
  return GET(new NextRequest("https://example.test/api/score/DemoDev"), {
    params: Promise.resolve({ username: "DemoDev" }),
  });
}

describe("score durable scan guardrails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccountDetail.mockResolvedValue(null);
    mocks.checkPublicScanStatusRateLimit.mockResolvedValue({ success: true });
    mocks.checkRateLimit.mockResolvedValue({ success: true });
    mocks.rateLimitHeaders.mockReturnValue({});
    mocks.getPublicScanStatus.mockResolvedValue(null);
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.requiresDurablePublicScan.mockReturnValue(false);
  });

  it("keeps an existing durable job passive when the public score is read", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "pending",
      run: { id: "active-run", username: "DemoDev" },
      retryAfterSeconds: 5,
      shouldDrain: false,
    });

    const response = await request();

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ run_id: "active-run" });
    expect(mocks.kickPublicScanDrain).not.toHaveBeenCalled();
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
  });

  it("limits status reads before a durable lookup", async () => {
    mocks.checkPublicScanStatusRateLimit.mockResolvedValue({ success: false });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "60" });

    const response = await request();

    expect(response.status).toBe(429);
    expect(mocks.getPublicScanStatus).not.toHaveBeenCalled();
  });

  it("fails closed before a durable status lookup when request protection is unavailable", async () => {
    mocks.checkPublicScanStatusRateLimit.mockResolvedValue({ success: false, unavailable: true, retryAfter: 15 });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "15" });

    const response = await request();

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
    await expect(response.json()).resolves.toMatchObject({ error: "rate_limit_unavailable" });
    expect(mocks.getPublicScanStatus).not.toHaveBeenCalled();
  });

  it("starts one response-side step only for a newly created durable job", async () => {
    mocks.getCachedScan.mockResolvedValue(quickScan);
    mocks.requiresDurablePublicScan.mockReturnValue(true);
    mocks.resolvePublicScanFromTrustedQuickScan.mockResolvedValue({
      status: "pending",
      run: { id: "new-run", username: "DemoDev" },
      retryAfterSeconds: 5,
      shouldDrain: true,
    });

    const response = await request();

    expect(response.status).toBe(202);
    expect(mocks.kickPublicScanDrain).toHaveBeenCalledTimes(1);
  });
});
