import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  buildScanResult: vi.fn(),
  checkRateLimit: vi.fn(),
  coalesceScan: vi.fn(),
  getAccountDetail: vi.fn(),
  getCachedScan: vi.fn(),
  getPercentileCached: vi.fn(),
  getRankCached: vi.fn(),
  publishCompleteQuickScan: vi.fn(),
  rateLimitHeaders: vi.fn(),
  recordAccountLookup: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getAccountDetail: mocks.getAccountDetail,
  publishCompleteQuickScan: mocks.publishCompleteQuickScan,
  recordAccountLookup: mocks.recordAccountLookup,
}));
vi.mock("@/lib/rank", () => ({
  getPercentileCached: mocks.getPercentileCached,
  getRankCached: mocks.getRankCached,
}));
vi.mock("@/lib/redis", () => ({
  checkRateLimit: mocks.checkRateLimit,
  coalesceScan: mocks.coalesceScan,
  getCachedScan: mocks.getCachedScan,
  rateLimitHeaders: mocks.rateLimitHeaders,
}));
vi.mock("@/lib/scan-core", () => ({ buildScanResult: mocks.buildScanResult }));

import { GET } from "./route";

const quickScan = {
  metrics: { username: "DemoDev", name: "Demo", profile_url: "https://github.com/DemoDev", avatar_url: null },
  scoring: { final_score: 71, tier: "人上人", tier_label: "trusted", sub_scores: {}, base_score: 71, total_penalty: 0, red_flags: [] },
} as unknown as ScanResult;

describe("GET /api/score immediate quick contract", () => {
  beforeEach(() => {
    mocks.getAccountDetail.mockResolvedValue(null);
    mocks.checkRateLimit.mockResolvedValue({ success: true });
    mocks.rateLimitHeaders.mockReturnValue({});
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.coalesceScan.mockImplementation(async (_handle: string, produce: () => unknown) => produce());
    mocks.buildScanResult.mockResolvedValue(quickScan);
    mocks.publishCompleteQuickScan.mockResolvedValue(true);
    mocks.recordAccountLookup.mockResolvedValue(undefined);
    mocks.getPercentileCached.mockResolvedValue(null);
    mocks.getRankCached.mockResolvedValue(null);
  });

  it("materializes a cold account instead of returning 202", async () => {
    const response = await GET(new NextRequest("https://example.test/api/score/DemoDev"), {
      params: Promise.resolve({ username: "DemoDev" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ source: "quick", coverage: "quick", final_score: 71 });
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledWith(quickScan, expect.any(Number));
  });
});
