import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  logFreshScanFailure: vi.fn(),
  checkRateLimit: vi.fn(),
  checkScanNetworkRateLimit: vi.fn(),
  getCachedScan: vi.fn(),
  getCurrentCanonicalQuickScan: vi.fn(),
  requestDevscoreJob: vi.fn(),
  getLegacyReadFallbackScan: vi.fn(),
  hasLegacyReadFallbackProfile: vi.fn(),
  rateLimitHeaders: vi.fn(),
  recordAccountLookup: vi.fn(),
  recordCampaignParticipant: vi.fn(),
  verifyTurnstile: vi.fn(),
  anonymousSessionPrincipal: vi.fn(),
  attachAnonymousSession: vi.fn(),
  establishAnonymousSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getCurrentCanonicalQuickScan: mocks.getCurrentCanonicalQuickScan,
  getLegacyReadFallbackScan: mocks.getLegacyReadFallbackScan,
  hasLegacyReadFallbackProfile: mocks.hasLegacyReadFallbackProfile,
  recordAccountLookup: mocks.recordAccountLookup,
  recordCampaignParticipant: mocks.recordCampaignParticipant,
}));
vi.mock("@/lib/redis", () => ({
  checkRateLimit: mocks.checkRateLimit,
  checkScanNetworkRateLimit: mocks.checkScanNetworkRateLimit,
  getCachedScan: mocks.getCachedScan,
  rateLimitHeaders: mocks.rateLimitHeaders,
}));
vi.mock("@/lib/scan-core", () => ({ logFreshScanFailure: mocks.logFreshScanFailure }));
vi.mock("@/lib/devscore-jobs", () => ({ requestDevscoreJob: mocks.requestDevscoreJob }));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }));
vi.mock("@/lib/anonymous-session", () => ({
  anonymousSessionPrincipal: mocks.anonymousSessionPrincipal,
  attachAnonymousSession: mocks.attachAnonymousSession,
  establishAnonymousSession: mocks.establishAnonymousSession,
}));

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

describe("POST /api/scan background devscore contract", () => {
  beforeEach(() => {
    process.env.GITHUB_ROAST_CLI_API_KEY = "test-key";
    mocks.checkRateLimit.mockResolvedValue({ success: true });
    mocks.checkScanNetworkRateLimit.mockResolvedValue({ success: true });
    mocks.rateLimitHeaders.mockReturnValue({});
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue(null);
    mocks.requestDevscoreJob.mockResolvedValue({ state: "queued", phase: "queued", progress: 0 });
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

  it("queues a first-time account and answers 202 with the status Location", async () => {
    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe("/api/scan/status/DemoDev");
    await expect(response.json()).resolves.toMatchObject({ status: { state: "queued" } });
    expect(mocks.requestDevscoreJob).toHaveBeenCalledWith("DemoDev", { rescan: false });
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("0.0.0.0");
  });

  it("serves a published score inline without queueing or republishing", async () => {
    mocks.getCachedScan.mockResolvedValue(quickScan);

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cached: true,
      coverage: "quick",
      metrics: { username: "DemoDev" },
    });
    expect(mocks.requestDevscoreJob).not.toHaveBeenCalled();
    expect(mocks.recordAccountLookup).toHaveBeenCalledWith("DemoDev", "0.0.0.0");
  });

  it("force=1 skips the published score and restarts the job", async () => {
    mocks.getCachedScan.mockResolvedValue(quickScan);

    const response = await POST(new NextRequest("https://example.test/api/scan?force=1", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ username: "DemoDev" }),
    }));

    expect(response.status).toBe(202);
    expect(mocks.requestDevscoreJob).toHaveBeenCalledWith("DemoDev", { rescan: true });
  });

  it("serves the previous release tuple when no job can be recorded", async () => {
    mocks.requestDevscoreJob.mockResolvedValue(null);
    mocks.getLegacyReadFallbackScan.mockResolvedValue(quickScan);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.logFreshScanFailure).toHaveBeenCalledWith(null, {
      route: "scan", username: "DemoDev", persistenceFailure: true,
    });
    expect(mocks.logFreshScanFailure.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.getLegacyReadFallbackScan.mock.invocationCallOrder[0]);
    await expect(response.json()).resolves.toMatchObject({
      coverage: "legacy",
      legacy_read_fallback: true,
      served_score_version: "v10",
      served_roast_version: "v11",
      served_collection_version: "v6",
    });
  });

  it("answers 503 when neither a job nor a fallback is available", async () => {
    mocks.requestDevscoreJob.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("keeps a Turnstile-issued browser outside the machine rate limit", async () => {
    delete process.env.GITHUB_ROAST_CLI_API_KEY;
    mocks.establishAnonymousSession.mockReturnValue({ id: "session-fixture", issued: true });

    const response = await POST(new NextRequest("https://example.test/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.10" },
      body: JSON.stringify({ username: "DemoDev", turnstileToken: "token" }),
    }));

    expect(response.status).toBe(202);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.checkScanNetworkRateLimit).not.toHaveBeenCalled();
    expect(mocks.attachAnonymousSession).toHaveBeenCalledWith(
      expect.any(Response),
      { id: "session-fixture", issued: true },
    );
  });
});
