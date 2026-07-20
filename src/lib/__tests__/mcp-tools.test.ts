import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDetail } from "@/lib/db";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  buildScanResult: vi.fn(),
  coalesceScan: vi.fn(),
  getAccountDetail: vi.fn(),
  getCachedScan: vi.fn(),
  getPercentileCached: vi.fn(),
  getRankCached: vi.fn(),
  publishCompleteQuickScan: vi.fn(),
  scanErrorResponse: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getAccountDetail: mocks.getAccountDetail,
  publishCompleteQuickScan: mocks.publishCompleteQuickScan,
  searchScoredUsers: vi.fn(),
}));
vi.mock("@/lib/rank", () => ({
  getPercentileCached: mocks.getPercentileCached,
  getRankCached: mocks.getRankCached,
}));
vi.mock("@/lib/leaderboard", () => ({ getLeaderboardCached: vi.fn() }));
vi.mock("@/lib/redis", () => ({
  coalesceScan: mocks.coalesceScan,
  getCachedScan: mocks.getCachedScan,
}));
vi.mock("@/lib/scan-core", () => ({
  buildScanResult: mocks.buildScanResult,
  scanErrorResponse: mocks.scanErrorResponse,
}));

import { scoreUser } from "@/lib/mcp-tools";

const quickScan = {
  metrics: { username: "fixture-user", name: "Fixture User" },
  scoring: {
    final_score: 71,
    tier: "人上人",
    sub_scores: {},
    red_flags: [],
  },
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

describe("MCP score release reads", () => {
  beforeEach(() => {
    mocks.getAccountDetail.mockResolvedValue(legacyFallback);
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.coalesceScan.mockImplementation(async (_handle: string, producer: () => unknown) => producer());
    mocks.buildScanResult.mockResolvedValue(quickScan);
    mocks.publishCompleteQuickScan.mockResolvedValue(true);
    mocks.getPercentileCached.mockResolvedValue(null);
    mocks.getRankCached.mockResolvedValue(null);
    mocks.scanErrorResponse.mockReturnValue({ error: "scan_failed", status: 503 });
  });

  it("materializes v9 from quick scan before exposing a v5 fallback", async () => {
    await expect(scoreUser("fixture-user")).resolves.toMatchObject({
      source: "quick",
      coverage: "quick",
      final_score: 71,
    });
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledWith(quickScan);
  });

  it("returns v5 only after quick scan fails", async () => {
    mocks.buildScanResult.mockRejectedValue(new Error("upstream unavailable"));

    await expect(scoreUser("fixture-user")).resolves.toMatchObject({
      source: "legacy_v5_v5_v3",
      coverage: "legacy",
      stale: true,
      final_score: 64,
    });
  });
});
