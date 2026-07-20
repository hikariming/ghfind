import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  buildScanResult: vi.fn(),
  checkRateLimit: vi.fn(),
  coalesceScan: vi.fn(),
  getCachedScan: vi.fn(),
  getLegacyReadFallbackScan: vi.fn(),
  hasLegacyReadFallbackProfile: vi.fn(),
  publishCompleteQuickScan: vi.fn(),
  rateLimitHeaders: vi.fn(),
  recordAccountLookup: vi.fn(),
  recordCampaignParticipant: vi.fn(),
  verifyTurnstile: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getLegacyReadFallbackScan: mocks.getLegacyReadFallbackScan,
  hasLegacyReadFallbackProfile: mocks.hasLegacyReadFallbackProfile,
  publishCompleteQuickScan: mocks.publishCompleteQuickScan,
  recordAccountLookup: mocks.recordAccountLookup,
  recordCampaignParticipant: mocks.recordCampaignParticipant,
}));
vi.mock("@/lib/redis", () => ({
  checkRateLimit: mocks.checkRateLimit,
  coalesceScan: mocks.coalesceScan,
  getCachedScan: mocks.getCachedScan,
  rateLimitHeaders: mocks.rateLimitHeaders,
}));
vi.mock("@/lib/scan-core", () => ({ buildScanResult: mocks.buildScanResult }));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }));

import { POST } from "./route";

const quickScan = {
  metrics: { username: "DemoDev", profile_url: "https://github.com/DemoDev", avatar_url: null },
  scoring: { final_score: 71, tier: "人上人", tier_label: "trusted", sub_scores: {}, base_score: 71, total_penalty: 0, red_flags: [] },
} as unknown as ScanResult;

function request() {
  return new NextRequest("https://example.test/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-key" },
    body: JSON.stringify({ username: "DemoDev" }),
  });
}

describe("POST /api/scan immediate quick contract", () => {
  beforeEach(() => {
    process.env.GITHUB_ROAST_CLI_API_KEY = "test-key";
    mocks.checkRateLimit.mockResolvedValue({ success: true });
    mocks.rateLimitHeaders.mockReturnValue({});
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.coalesceScan.mockImplementation(async (_handle: string, produce: () => unknown) => produce());
    mocks.buildScanResult.mockResolvedValue(quickScan);
    mocks.publishCompleteQuickScan.mockResolvedValue(true);
    mocks.recordAccountLookup.mockResolvedValue(undefined);
    mocks.recordCampaignParticipant.mockResolvedValue(undefined);
    mocks.getLegacyReadFallbackScan.mockResolvedValue(null);
    mocks.hasLegacyReadFallbackProfile.mockResolvedValue(false);
  });

  afterEach(() => {
    delete process.env.GITHUB_ROAST_CLI_API_KEY;
    vi.clearAllMocks();
  });

  it("persists and returns the current v9 quick result without a queue response", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cached: false,
      coverage: "quick",
      metrics: { username: "DemoDev" },
      scoring: { final_score: 71 },
    });
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledWith(quickScan, expect.any(Number));
  });

  it("serves v5 only after the quick collector fails", async () => {
    mocks.buildScanResult.mockRejectedValue(new Error("github unavailable"));
    mocks.getLegacyReadFallbackScan.mockResolvedValue(quickScan);

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      coverage: "legacy",
      legacy_read_fallback: true,
      served_score_version: "v5",
      served_roast_version: "v5",
      served_collection_version: "v3",
    });
  });
});
