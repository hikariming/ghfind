import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDetail } from "@/lib/db";
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
  scanErrorResponse: vi.fn(),
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
vi.mock("@/lib/scan-core", () => ({
  buildScanResult: mocks.buildScanResult,
  scanErrorResponse: mocks.scanErrorResponse,
}));

import { GET } from "./route";

const quickScan = {
  metrics: { username: "DemoDev", name: "Demo", profile_url: "https://github.com/DemoDev", avatar_url: null },
  scoring: { final_score: 71, tier: "人上人", tier_label: "trusted", sub_scores: {}, base_score: 71, total_penalty: 0, red_flags: [] },
} as unknown as ScanResult;

const subScores = {
  account_maturity: 10,
  original_project_quality: 10,
  contribution_quality: 10,
  ecosystem_impact: 10,
  community_influence: 10,
  activity_authenticity: 10,
};

const legacyFallback = {
  username: "fixture-user",
  display_name: "Fixture User",
  avatar_url: null,
  profile_url: "https://github.com/fixture-user",
  final_score: 64,
  tier: "人上人",
  tags: { zh: [], en: [] },
  sub_scores: subScores,
  roast_line: { zh: "", en: "" },
  roast: "legacy report",
  roast_en: "legacy report",
  score_version: "v5",
  legacy_read_fallback: true,
  score_source_collection_version: null,
  score_source_snapshot_hash: null,
  scanned_at: 1,
  prev_score: null,
  prev_scanned_at: null,
} as AccountDetail;

const obsoleteV8Detail = {
  ...legacyFallback,
  score_version: "v8",
  legacy_read_fallback: false,
};

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
    mocks.scanErrorResponse.mockReturnValue({ error: "scan_failed", status: 500 });
  });

  it("materializes a cold account instead of returning 202", async () => {
    const response = await GET(new NextRequest("https://example.test/api/score/DemoDev"), {
      params: Promise.resolve({ username: "DemoDev" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ source: "quick", coverage: "quick", final_score: 71 });
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledWith(quickScan, expect.any(Number));
  });

  it("refreshes a v5 fallback with quick scan before serving it", async () => {
    mocks.getAccountDetail.mockResolvedValue(legacyFallback);

    const response = await GET(new NextRequest("https://example.test/api/score/fixture-user"), {
      params: Promise.resolve({ username: "fixture-user" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: "quick",
      coverage: "quick",
      final_score: 71,
    });
    expect(mocks.buildScanResult).toHaveBeenCalledWith("fixture-user");
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledWith(quickScan, expect.any(Number));
  });

  it("serves the verified v5 fallback only after quick scan fails", async () => {
    mocks.getAccountDetail.mockResolvedValue(legacyFallback);
    mocks.buildScanResult.mockRejectedValue(new Error("upstream unavailable"));

    const response = await GET(new NextRequest("https://example.test/api/score/fixture-user"), {
      params: Promise.resolve({ username: "fixture-user" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: "legacy_v5_v5_v3",
      coverage: "legacy",
      stale: true,
      final_score: 64,
    });
  });

  it("never replays a v8 detail when quick scan fails", async () => {
    mocks.getAccountDetail.mockResolvedValue(obsoleteV8Detail);
    mocks.buildScanResult.mockRejectedValue(new Error("upstream unavailable"));

    const response = await GET(new NextRequest("https://example.test/api/score/fixture-user"), {
      params: Promise.resolve({ username: "fixture-user" }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "scan_failed" });
  });
});
