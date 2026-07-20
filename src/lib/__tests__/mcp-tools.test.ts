import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccountDetail: vi.fn(),
  searchScoredUsers: vi.fn(),
  getPercentileCached: vi.fn(),
  getRankCached: vi.fn(),
  getLeaderboardCached: vi.fn(),
  coalesceScan: vi.fn(),
  getCachedScan: vi.fn(),
  buildScanResult: vi.fn(),
  scanErrorResponse: vi.fn(),
  getPublicScanStatus: vi.fn(),
  publicScanAdmission: vi.fn(),
  requiresDurablePublicScan: vi.fn(),
  resolvePublicScanFromTrustedQuickScan: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getAccountDetail: mocks.getAccountDetail,
  searchScoredUsers: mocks.searchScoredUsers,
}));

vi.mock("@/lib/rank", () => ({
  getPercentileCached: mocks.getPercentileCached,
  getRankCached: mocks.getRankCached,
}));

vi.mock("@/lib/leaderboard", () => ({
  getLeaderboardCached: mocks.getLeaderboardCached,
}));

vi.mock("@/lib/redis", () => ({
  coalesceScan: mocks.coalesceScan,
  getCachedScan: mocks.getCachedScan,
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

import { scoreUser } from "../mcp-tools";

describe("MCP stored score guardrail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccountDetail.mockResolvedValue({
      username: "mcp-stored-fixture",
      display_name: "MCP Stored Fixture",
      final_score: 82,
      tier: "人上人",
      sub_scores: {},
      score_version: "v8",
      scanned_at: 1_800_000_000_000,
    });
    mocks.getPercentileCached.mockResolvedValue({ below: 8, total: 10 });
    mocks.getRankCached.mockResolvedValue({ rank: 2, total: 10, below: 8 });
  });

  it("returns a stale stored score without entering any scan path", async () => {
    await expect(scoreUser("mcp-stored-fixture")).resolves.toMatchObject({
      source: "indexed",
      stale: true,
      username: "mcp-stored-fixture",
      final_score: 82,
    });

    expect(mocks.getPublicScanStatus).not.toHaveBeenCalled();
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
    expect(mocks.resolvePublicScanFromTrustedQuickScan).not.toHaveBeenCalled();
  });
});
