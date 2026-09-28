import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDetail } from "@/lib/db";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  logFreshScanFailure: vi.fn(),
  checkRateLimit: vi.fn(),
  getAccountDetail: vi.fn(),
  getCachedScan: vi.fn(),
  getPercentileCached: vi.fn(),
  getRankCached: vi.fn(),
  rateLimitHeaders: vi.fn(),
  recordAccountLookup: vi.fn(),
  requestDevscoreJob: vi.fn(),
  scanErrorResponse: vi.fn(),
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
  checkRateLimit: mocks.checkRateLimit,
  getCachedScoreDetail: (_handle: string, load: () => unknown) => load(),
  getCachedScan: mocks.getCachedScan,
  rateLimitHeaders: mocks.rateLimitHeaders,
}));
vi.mock("@/lib/scan-core", () => ({
  logFreshScanFailure: mocks.logFreshScanFailure,
  scanErrorResponse: mocks.scanErrorResponse,
}));
vi.mock("@/lib/devscore-jobs", () => ({ requestDevscoreJob: mocks.requestDevscoreJob }));

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
  score_version: "v9",
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

describe("GET /api/score background devscore contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccountDetail.mockResolvedValue(null);
    mocks.checkRateLimit.mockResolvedValue({ success: true });
    mocks.rateLimitHeaders.mockReturnValue({});
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.requestDevscoreJob.mockResolvedValue({ state: "running", phase: "contribs", progress: 0.2 });
    mocks.recordAccountLookup.mockResolvedValue(undefined);
    mocks.getPercentileCached.mockResolvedValue(null);
    mocks.getRankCached.mockResolvedValue(null);
    mocks.scanErrorResponse.mockReturnValue({ error: "scan_failed", status: 500 });
  });

  function get(username: string) {
    return GET(new NextRequest(`https://example.test/api/score/${username}`), {
      params: Promise.resolve({ username }),
    });
  }

  it("queues a cold account and answers 202 with the pending status", async () => {
    const response = await get("DemoDev");

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe("/api/scan/status/DemoDev");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      status: { state: "running", phase: "contribs", progress: 0.2 },
    });
  });

  it("serves a published scan from the cache without queueing", async () => {
    mocks.getCachedScan.mockResolvedValue(quickScan);

    const response = await get("DemoDev");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ source: "quick", final_score: 71 });
    expect(mocks.requestDevscoreJob).not.toHaveBeenCalled();
  });

  it("queues a v10 fallback account instead of serving the stale score", async () => {
    mocks.getAccountDetail.mockResolvedValue(legacyFallback);

    const response = await get("fixture-user");

    expect(response.status).toBe(202);
    expect(mocks.requestDevscoreJob).toHaveBeenCalledWith("fixture-user");
  });

  it("serves the verified fallback only when no job can be recorded", async () => {
    mocks.getAccountDetail.mockResolvedValue(legacyFallback);
    mocks.requestDevscoreJob.mockResolvedValue(null);

    const response = await get("fixture-user");

    expect(response.status).toBe(200);
    expect(mocks.logFreshScanFailure).toHaveBeenCalledWith(null, {
      route: "score", username: "fixture-user", persistenceFailure: true,
    });
    await expect(response.json()).resolves.toMatchObject({
      source: "legacy_v5_v5_v3",
      coverage: "legacy",
      stale: true,
      final_score: 64,
    });
  });

  it("never replays an obsolete v8 detail", async () => {
    mocks.getAccountDetail.mockResolvedValue(obsoleteV8Detail);
    mocks.requestDevscoreJob.mockResolvedValue(null);

    const response = await get("fixture-user");

    expect(response.status).toBe(503);
  });

  it("maps a failed job for a missing account to 404", async () => {
    mocks.requestDevscoreJob.mockResolvedValue({ state: "failed", error: "account_not_found" });

    const response = await get("ghost-user");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "account_not_found" });
  });
});
