import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  buildScanResult: vi.fn(),
  logFreshScanFailure: vi.fn(),
  checkRateLimit: vi.fn(),
  checkScanNetworkRateLimit: vi.fn(),
  coalesceScan: vi.fn(),
  getCachedScan: vi.fn(),
  getStaleCachedScan: vi.fn(),
  isScanPending: vi.fn(),
  tryAcquireScanRefresh: vi.fn(),
  getCurrentCanonicalQuickScan: vi.fn(),
  getLatestVerifiedCanonicalScan: vi.fn(),
  getLegacyReadFallbackScan: vi.fn(),
  hasLegacyReadFallbackProfile: vi.fn(),
  publishCompleteQuickScan: vi.fn(),
  rateLimitHeaders: vi.fn(),
  recordAccountLookup: vi.fn(),
  recordCampaignParticipant: vi.fn(),
  verifyTurnstile: vi.fn(),
  anonymousSessionPrincipal: vi.fn(),
  attachAnonymousSession: vi.fn(),
  establishAnonymousSession: vi.fn(),
  after: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getCurrentCanonicalQuickScan: mocks.getCurrentCanonicalQuickScan,
  getLatestVerifiedCanonicalScan: mocks.getLatestVerifiedCanonicalScan,
  getLegacyReadFallbackScan: mocks.getLegacyReadFallbackScan,
  hasLegacyReadFallbackProfile: mocks.hasLegacyReadFallbackProfile,
  publishCompleteQuickScan: mocks.publishCompleteQuickScan,
  recordAccountLookup: mocks.recordAccountLookup,
  recordCampaignParticipant: mocks.recordCampaignParticipant,
}));
vi.mock("@/lib/redis", () => ({
  checkRateLimit: mocks.checkRateLimit,
  checkScanNetworkRateLimit: mocks.checkScanNetworkRateLimit,
  coalesceScan: mocks.coalesceScan,
  getCachedScan: mocks.getCachedScan,
  getStaleCachedScan: mocks.getStaleCachedScan,
  isScanPending: mocks.isScanPending,
  tryAcquireScanRefresh: mocks.tryAcquireScanRefresh,
  rateLimitHeaders: mocks.rateLimitHeaders,
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mocks.after };
});
vi.mock("@/lib/scan-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scan-core")>();
  return {
    ...actual,
    buildScanResult: mocks.buildScanResult,
    logFreshScanFailure: mocks.logFreshScanFailure,
  };
});
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }));
vi.mock("@/lib/anonymous-session", () => ({
  anonymousSessionPrincipal: mocks.anonymousSessionPrincipal,
  attachAnonymousSession: mocks.attachAnonymousSession,
  establishAnonymousSession: mocks.establishAnonymousSession,
}));

import { LEGACY_READ_FALLBACK } from "@/lib/release-versions";
import { SCORE_CACHE_VERSION } from "@/lib/cache-version";
import { GitHubCollectDeadlineError, GitHubDataUnavailableError } from "@/lib/github";
import { ScanBusyError, ScanPendingError } from "@/lib/scan-protection";
import { GET, POST } from "./route";

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
    mocks.checkScanNetworkRateLimit.mockResolvedValue({ success: true });
    mocks.rateLimitHeaders.mockReturnValue({});
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.getStaleCachedScan.mockResolvedValue(null);
    mocks.isScanPending.mockResolvedValue(false);
    mocks.tryAcquireScanRefresh.mockResolvedValue(true);
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue(null);
    mocks.getLatestVerifiedCanonicalScan.mockResolvedValue(null);
    mocks.after.mockImplementation((task: () => unknown) => { void task(); });
    mocks.coalesceScan.mockImplementation(async (_handle: string, produce: () => unknown) => produce());
    mocks.buildScanResult.mockResolvedValue(quickScan);
    mocks.publishCompleteQuickScan.mockResolvedValue(true);
    mocks.recordAccountLookup.mockResolvedValue(undefined);
    mocks.recordCampaignParticipant.mockResolvedValue(undefined);
    mocks.getLegacyReadFallbackScan.mockResolvedValue(null);
    mocks.hasLegacyReadFallbackProfile.mockResolvedValue(false);
    mocks.verifyTurnstile.mockResolvedValue(true);
    mocks.anonymousSessionPrincipal.mockReturnValue(null);
    mocks.establishAnonymousSession.mockReturnValue(null);
    mocks.attachAnonymousSession.mockImplementation((response) => response);
  });

  afterEach(() => {
    delete process.env.GITHUB_ROAST_CLI_API_KEY;
    vi.clearAllMocks();
  });

  it("persists and returns the current v10 quick result without a queue response", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cached: false,
      coverage: "quick",
      metrics: { username: "DemoDev" },
      scoring: { final_score: 71 },
    });
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledWith(quickScan, expect.any(Number));
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("0.0.0.0");
  });

  it("passes force through to distributed coalescing", async () => {
    const req = new NextRequest("https://example.test/api/scan?force=1", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ username: "DemoDev" }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
    expect(mocks.getCurrentCanonicalQuickScan).not.toHaveBeenCalled();
    expect(mocks.coalesceScan).toHaveBeenCalledWith("DemoDev", expect.any(Function), {
      force: true,
      continueOnDeadline: true,
    });
  });

  it("serves a cached quick scan without republishing it as newly scanned", async () => {
    mocks.getCachedScan.mockResolvedValue(quickScan);

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cached: true,
      coverage: "quick",
      metrics: { username: "DemoDev" },
    });
    expect(mocks.publishCompleteQuickScan).not.toHaveBeenCalled();
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
    expect(mocks.recordAccountLookup).toHaveBeenCalledWith("DemoDev", "0.0.0.0");
  });

  it("serves the previous collection tuple after the quick collector fails", async () => {
    mocks.buildScanResult.mockRejectedValue(new Error("github unavailable"));
    mocks.getLegacyReadFallbackScan.mockResolvedValue(quickScan);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.logFreshScanFailure).toHaveBeenCalledWith(expect.any(Error), {
      route: "scan", username: "DemoDev", persistenceFailure: false,
    });
    expect(mocks.logFreshScanFailure.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.getLegacyReadFallbackScan.mock.invocationCallOrder[0]);
    await expect(response.json()).resolves.toMatchObject({
      coverage: "legacy",
      legacy_read_fallback: true,
      served_score_version: LEGACY_READ_FALLBACK.score,
      served_roast_version: LEGACY_READ_FALLBACK.roast,
      served_collection_version: LEGACY_READ_FALLBACK.collection,
    });
  });

  it("keeps a Turnstile-issued browser outside the machine rate limit", async () => {
    delete process.env.GITHUB_ROAST_CLI_API_KEY;
    mocks.establishAnonymousSession.mockReturnValue({ id: "session-fixture", issued: true });

    const response = await POST(new NextRequest("https://example.test/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.10" },
      body: JSON.stringify({ username: "DemoDev", turnstileToken: "token" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.checkScanNetworkRateLimit).not.toHaveBeenCalled();
    expect(mocks.attachAnonymousSession).toHaveBeenCalledWith(
      expect.any(Response),
      { id: "session-fixture", issued: true },
    );
  });

  it("serves a verified indexed v10 snapshot without crawling GitHub", async () => {
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue({
      scan: quickScan,
      snapshotHash: "a".repeat(64),
      scannedAt: 1_800_000_000_000,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      cached: true,
      coverage: "quick",
      scanned_at: 1_800_000_000_000,
      scoring: { final_score: 71 },
    });
    expect(mocks.coalesceScan).not.toHaveBeenCalled();
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("falls back to the stale scan:v5 shadow after logging a collect deadline", async () => {
    mocks.coalesceScan.mockRejectedValue(new GitHubCollectDeadlineError("deadline"));
    mocks.getStaleCachedScan.mockResolvedValue(quickScan);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.logFreshScanFailure).toHaveBeenCalledWith(expect.any(GitHubCollectDeadlineError), {
      route: "scan", username: "DemoDev", persistenceFailure: false,
    });
    expect(mocks.logFreshScanFailure.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.getStaleCachedScan.mock.invocationCallOrder[0]);
    await expect(response.json()).resolves.toMatchObject({
      stale: true,
      coverage: "quick",
      served_score_version: SCORE_CACHE_VERSION,
    });
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.coalesceScan).toHaveBeenCalledWith("DemoDev", expect.any(Function), { background: true });
  });

  it("skips background GitHub refresh when the cooldown is held", async () => {
    mocks.coalesceScan.mockRejectedValue(new GitHubCollectDeadlineError("deadline"));
    mocks.getStaleCachedScan.mockResolvedValue(quickScan);
    mocks.tryAcquireScanRefresh.mockResolvedValue(false);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.coalesceScan).toHaveBeenCalledTimes(1);
    expect(mocks.coalesceScan).not.toHaveBeenCalledWith(
      "DemoDev",
      expect.any(Function),
      { background: true },
    );
  });

  it("falls back to a verified D1 v10 row when the stale shadow is empty", async () => {
    mocks.coalesceScan.mockRejectedValue(new ScanBusyError());
    mocks.getLatestVerifiedCanonicalScan.mockResolvedValue({
      scan: quickScan,
      snapshotHash: "b".repeat(64),
      scannedAt: 1_750_000_000_000,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stale: true,
      coverage: "quick",
      served_score_version: SCORE_CACHE_VERSION,
      scanned_at: 1_750_000_000_000,
    });
    expect(mocks.getLegacyReadFallbackScan).not.toHaveBeenCalled();
  });

  it("uses the stale chain for github_unavailable", async () => {
    mocks.coalesceScan.mockRejectedValue(new GitHubDataUnavailableError("upstream"));
    mocks.getStaleCachedScan.mockResolvedValue(quickScan);

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ stale: true, coverage: "quick" });
  });

  it("returns github_collect_deadline with a short Retry-After when no snapshot remains", async () => {
    mocks.coalesceScan.mockRejectedValue(new GitHubCollectDeadlineError("deadline"));

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("15");
    await expect(response.json()).resolves.toMatchObject({ error: "github_collect_deadline" });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("does not use the emergency stale chain for a missing GitHub account", async () => {
    const { AccountNotFoundError } = await import("@/lib/github");
    mocks.coalesceScan.mockRejectedValue(new AccountNotFoundError("missing"));
    mocks.getStaleCachedScan.mockResolvedValue(quickScan);

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.getStaleCachedScan).not.toHaveBeenCalled();
    expect(mocks.getLatestVerifiedCanonicalScan).not.toHaveBeenCalled();
  });

  it("returns 202 scan_pending with Retry-After and a GET poll Location", async () => {
    mocks.coalesceScan.mockRejectedValue(new ScanPendingError());

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("location")).toBe("/api/scan?username=DemoDev");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: "scan_pending",
      scan_pending: true,
      poll: { method: "GET", path: "/api/scan?username=DemoDev", interval_seconds: 5 },
      status: { state: "running" },
    });
    expect(mocks.logFreshScanFailure).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.coalesceScan).toHaveBeenCalledWith("DemoDev", expect.any(Function), {
      force: false,
      continueOnDeadline: true,
    });
  });

  it("GET polls a pending collect without starting GitHub work", async () => {
    mocks.isScanPending.mockResolvedValue(true);
    const response = await GET(new NextRequest("https://example.test/api/scan?username=tj"));
    expect(response.status).toBe(202);
    expect(mocks.coalesceScan).not.toHaveBeenCalled();
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.checkScanNetworkRateLimit).toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ error: "scan_pending", scan_pending: true });
  });

  it("GET serves a cached snapshot as 200", async () => {
    mocks.getCachedScan.mockResolvedValue(quickScan);
    const response = await GET(new NextRequest("https://example.test/api/scan?username=DemoDev"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ cached: true, coverage: "quick" });
  });

  it("GET returns 404 when nothing is cached or in flight", async () => {
    const response = await GET(new NextRequest("https://example.test/api/scan?username=nobody"));
    expect(response.status).toBe(404);
    expect(mocks.coalesceScan).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ error: "not_scored" });
  });
});
