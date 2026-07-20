import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCORE_CACHE_VERSION } from "@/lib/cache-version";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "@/lib/scan-run-types";

const mocks = vi.hoisted(() => ({
  getAccountDetail: vi.fn(),
  ensureCanonicalScoreForPublicRun: vi.fn(),
  publishCompleteQuickScan: vi.fn(),
  recordAccountLookup: vi.fn(),
  getPercentileCached: vi.fn(),
  getRankCached: vi.fn(),
  checkPublicScanStatusRateLimit: vi.fn(),
  checkRateLimit: vi.fn(),
  coalesceScan: vi.fn(),
  getCachedScan: vi.fn(),
  clearCachedScan: vi.fn(),
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
  ensureCanonicalScoreForPublicRun: mocks.ensureCanonicalScoreForPublicRun,
  getAccountDetail: mocks.getAccountDetail,
  publishCompleteQuickScan: mocks.publishCompleteQuickScan,
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
  clearCachedScan: mocks.clearCachedScan,
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
    mocks.clearCachedScan.mockResolvedValue(undefined);
    mocks.requiresDurablePublicScan.mockReturnValue(false);
    mocks.publishCompleteQuickScan.mockResolvedValue({
      scannedAt: 1_800_000_000_000,
      token: "score-write-token",
    });
    mocks.ensureCanonicalScoreForPublicRun.mockResolvedValue({
      scannedAt: 1_800_000_000_000,
      token: "score-write-token",
    });
    mocks.coalesceScan.mockImplementation(async (_username: string, producer: () => unknown) => producer());
    mocks.buildScanResult.mockResolvedValue(quickScan);
  });

  it("serves a stored stale score without touching GitHub or the durable queue", async () => {
    mocks.getAccountDetail.mockResolvedValue({
      username: "stored-fixture",
      display_name: "Stored Fixture",
      avatar_url: null,
      profile_url: "https://profiles.example.invalid/stored-fixture",
      final_score: 84,
      tier: "人上人",
      tags: { zh: [], en: [] },
      roast_line: { zh: "", en: "" },
      sub_scores: {},
      roast: null,
      roast_en: null,
      score_version: SCORE_CACHE_VERSION,
      score_source_collection_version: null,
      score_source_snapshot_hash: null,
      scanned_at: 1_800_000_000_000,
      prev_score: null,
      prev_scanned_at: null,
    });
    mocks.getPercentileCached.mockResolvedValue({ below: 8, total: 10 });
    mocks.getRankCached.mockResolvedValue({ rank: 2, total: 10, below: 8 });

    const response = await GET(
      new NextRequest("https://example.test/api/score/stored-fixture"),
      { params: Promise.resolve({ username: "stored-fixture" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=600");
    await expect(response.json()).resolves.toMatchObject({
      source: "indexed",
      stale: true,
      username: "stored-fixture",
      final_score: 84,
      profile: "https://ghfind.com/u/stored-fixture",
    });
    expect(mocks.getPublicScanStatus).not.toHaveBeenCalled();
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
    expect(mocks.resolvePublicScanFromTrustedQuickScan).not.toHaveBeenCalled();
    expect(mocks.kickPublicScanDrain).not.toHaveBeenCalled();
    expect(mocks.publishCompleteQuickScan).not.toHaveBeenCalled();
  });

  it("keeps an existing durable job passive when the public score is read", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "pending",
      run: { id: "active-run", username: "DemoDev" },
      retryAfterSeconds: 5,
      headStartJobId: null,
    });

    const response = await request();

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ run_id: "active-run" });
    expect(mocks.kickPublicScanDrain).not.toHaveBeenCalled();
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
  });

  it("serves a v3 score as stale without writing v9 or creating a refresh", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "stale",
      run: { id: "legacy-run", username: "DemoDev", collectionVersion: "v3" },
      scan: quickScan,
      refreshPending: false,
      refreshRun: null,
      servedCollectionVersion: "v3",
      targetCollectionVersion: "v4",
    });

    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      source: "stale_public",
      stale: true,
      refresh_pending: false,
      served_collection_version: "v3",
      target_collection_version: "v4",
    });
    expect(mocks.ensureCanonicalScoreForPublicRun).not.toHaveBeenCalled();
    expect(mocks.resolvePublicScanFromTrustedQuickScan).not.toHaveBeenCalled();
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
    expect(mocks.publishCompleteQuickScan).not.toHaveBeenCalled();
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
    mocks.requiresDurablePublicScan.mockReturnValue(true);
    mocks.resolvePublicScanFromTrustedQuickScan.mockResolvedValue({
      status: "pending",
      run: { id: "new-run", username: "DemoDev" },
      retryAfterSeconds: 5,
      headStartJobId: "new-job-id",
    });

    const response = await request();

    expect(response.status).toBe(202);
    expect(mocks.kickPublicScanDrain).toHaveBeenCalledTimes(1);
    expect(mocks.kickPublicScanDrain).toHaveBeenCalledWith("new-job-id");
    expect(mocks.publishCompleteQuickScan).not.toHaveBeenCalled();
  });

  it("publishes a fresh trusted quick scan before returning its live score", async () => {
    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: "live",
      cached: false,
      username: "DemoDev",
      final_score: 21,
    });
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledWith(
      quickScan,
      expect.any(Number),
    );
  });

  it("discards cached quick scans without a persisted run and publishes fresh data", async () => {
    mocks.getCachedScan.mockResolvedValue(quickScan);

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: "live",
      cached: false,
    });
    expect(mocks.clearCachedScan).toHaveBeenCalledWith("DemoDev");
    expect(mocks.buildScanResult).toHaveBeenCalledWith("DemoDev");
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledWith(
      quickScan,
      expect.any(Number),
    );
  });

  it("serves a complete persisted run only after its canonical score exists", async () => {
    const run = { id: "complete-run" };
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "complete",
      run,
      scan: quickScan,
    });

    const response = await request();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: "complete_public",
      cached: true,
    });
    expect(mocks.ensureCanonicalScoreForPublicRun).toHaveBeenCalledWith(run);
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
  });

  it("fails closed when a complete run cannot materialize its canonical score", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "complete",
      run: { id: "complete-run" },
      scan: quickScan,
    });
    mocks.ensureCanonicalScoreForPublicRun.mockResolvedValue(null);

    const response = await request();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.setCachedScan).not.toHaveBeenCalled();
  });

  it("uses the long cache only for exact v9/v4 score provenance", async () => {
    mocks.getAccountDetail.mockResolvedValue({
      username: "canonical-fixture",
      display_name: null,
      avatar_url: null,
      profile_url: null,
      final_score: 84,
      tier: "人上人",
      tags: { zh: [], en: [] },
      roast_line: { zh: "", en: "" },
      sub_scores: {},
      roast: null,
      roast_en: null,
      score_version: SCORE_CACHE_VERSION,
      score_source_collection_version: PUBLIC_SCAN_COLLECTION_VERSION,
      score_source_snapshot_hash: "a".repeat(64),
      scanned_at: 1_800_000_000_000,
      prev_score: null,
      prev_scanned_at: null,
    });

    const response = await GET(
      new NextRequest("https://example.test/api/score/canonical-fixture"),
      { params: Promise.resolve({ username: "canonical-fixture" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=3600");
    await expect(response.json()).resolves.toMatchObject({ stale: false });
  });

  it("does not republish a quick scan returned by the single-flight cache race", async () => {
    mocks.coalesceScan.mockResolvedValue(quickScan);

    const response = await request();

    expect(response.status).toBe(200);
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
    expect(mocks.publishCompleteQuickScan).not.toHaveBeenCalled();
  });

  it("returns 503 instead of publishing a fresh score response when persistence returns null", async () => {
    mocks.publishCompleteQuickScan.mockResolvedValue(null);

    const response = await request();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({
      error: "scan_failed",
      message: "score persistence is temporarily unavailable",
    });
  });

  it("returns 503 instead of publishing a fresh score response when persistence throws", async () => {
    mocks.publishCompleteQuickScan.mockRejectedValue(new Error("storage unavailable"));

    const response = await request();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "scan_failed",
    });
  });
});
