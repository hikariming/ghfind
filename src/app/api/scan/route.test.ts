import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  score: vi.fn(),
  verifyTurnstile: vi.fn(),
  ensureCanonicalScoreForPublicRun: vi.fn(),
  hasLegacyReadFallbackProfile: vi.fn(),
  getLegacyReadFallbackScan: vi.fn(),
  publishCompleteQuickScan: vi.fn(),
  recordAccountLookup: vi.fn(),
  getLatestPublicScanRun: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(),
  coalesceScan: vi.fn(),
  getCachedScan: vi.fn(),
  clearCachedScan: vi.fn(),
  setCachedScan: vi.fn(),
  getPublicScanStatus: vi.fn(),
  publicScanAdmission: vi.fn(() => ({ bucket: "test", limit: 2, windowMs: 60_000, maxActiveJobs: 24 })),
  requiresDurablePublicScan: vi.fn(),
  resolvePublicScanFromTrustedQuickScan: vi.fn(),
  startPublicScan: vi.fn(),
  kickPublicScanDrain: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  ensureCanonicalScoreForPublicRun: mocks.ensureCanonicalScoreForPublicRun,
  hasLegacyReadFallbackProfile: mocks.hasLegacyReadFallbackProfile,
  getLegacyReadFallbackScan: mocks.getLegacyReadFallbackScan,
  publishCompleteQuickScan: mocks.publishCompleteQuickScan,
  recordAccountLookup: mocks.recordAccountLookup,
  getLatestPublicScanRun: mocks.getLatestPublicScanRun,
}));

vi.mock("@/lib/github", () => {
  class AccountNotFoundError extends Error {}
  class GitHubAuthRequiredError extends Error {}
  class GitHubDataUnavailableError extends Error {}
  class GitHubRateLimitError extends Error {}
  return {
    AccountNotFoundError,
    GitHubAuthRequiredError,
    GitHubDataUnavailableError,
    GitHubRateLimitError,
    collect: mocks.collect,
  };
});

vi.mock("@/lib/redis", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitHeaders: mocks.rateLimitHeaders,
  coalesceScan: mocks.coalesceScan,
  clearCachedScan: mocks.clearCachedScan,
  getCachedScan: mocks.getCachedScan,
  setCachedScan: mocks.setCachedScan,
}));

vi.mock("@/lib/public-scan", () => ({
  getPublicScanStatus: mocks.getPublicScanStatus,
  publicScanAdmission: mocks.publicScanAdmission,
  requiresDurablePublicScan: mocks.requiresDurablePublicScan,
  resolvePublicScanFromTrustedQuickScan: mocks.resolvePublicScanFromTrustedQuickScan,
  startPublicScan: mocks.startPublicScan,
}));

vi.mock("@/lib/public-scan-dispatcher", () => ({
  kickPublicScanDrain: mocks.kickPublicScanDrain,
}));

vi.mock("@/lib/score", () => ({
  score: mocks.score,
}));

vi.mock("@/lib/turnstile", () => ({
  verifyTurnstile: mocks.verifyTurnstile,
}));

import { POST } from "./route";

const originalCliKey = process.env.GITHUB_ROAST_CLI_API_KEY;

const metrics = {
  username: "DemoDev",
  profile_url: "https://github.com/DemoDev",
  avatar_url: "https://avatars.githubusercontent.com/u/1",
};

const scoring = {
  sub_scores: {
    account_maturity: 1,
    original_project_quality: 2,
    contribution_quality: 3,
    ecosystem_impact: 4,
    community_influence: 5,
    activity_authenticity: 6,
  },
  base_score: 21,
  red_flags: [],
  total_penalty: 0,
  final_score: 21,
  tier: "NPC",
  tier_label: "普通账号 · 特征平庸存疑",
};

function request(init?: { token?: string; auth?: string }): NextRequest {
  return new NextRequest("https://example.test/api/scan", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init?.auth ? { authorization: init.auth } : {}),
    },
    body: JSON.stringify({ username: "DemoDev", turnstileToken: init?.token }),
  });
}

describe("scan route machine auth", () => {
  beforeEach(() => {
    process.env.GITHUB_ROAST_CLI_API_KEY = "cli-secret";
    mocks.collect.mockResolvedValue({
      metrics,
      top_repos: [],
      recent_prs: [],
      flood_pr_titles: [],
      impact_repos: [],
      verified_impact_prs: [],
      pinned_repos: [],
      organizations: [],
    });
    mocks.score.mockReturnValue(scoring);
    mocks.verifyTurnstile.mockResolvedValue(false);
    mocks.publishCompleteQuickScan.mockResolvedValue({
      scannedAt: 1_800_000_000_000,
      token: "score-write-token",
    });
    mocks.ensureCanonicalScoreForPublicRun.mockResolvedValue({
      scannedAt: 1_800_000_000_000,
      token: "score-write-token",
    });
    mocks.hasLegacyReadFallbackProfile.mockResolvedValue(false);
    mocks.getLegacyReadFallbackScan.mockResolvedValue(null);
    mocks.clearCachedScan.mockResolvedValue(undefined);
    mocks.recordAccountLookup.mockResolvedValue(true);
    mocks.getLatestPublicScanRun.mockResolvedValue(null);
    mocks.checkRateLimit.mockResolvedValue({ success: true });
    mocks.rateLimitHeaders.mockReturnValue({});
    mocks.coalesceScan.mockImplementation(async (_username: string, fn: () => unknown) => fn());
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.getPublicScanStatus.mockResolvedValue(null);
    mocks.requiresDurablePublicScan.mockReturnValue(false);
  });

  afterEach(() => {
    if (originalCliKey === undefined) delete process.env.GITHUB_ROAST_CLI_API_KEY;
    else process.env.GITHUB_ROAST_CLI_API_KEY = originalCliKey;
    vi.clearAllMocks();
  });

  it("keeps requiring Turnstile when machine auth is missing", async () => {
    const response = await POST(request());

    expect(response.status).toBe(403);
    // Structured error shape: stable machine code plus human-readable fields.
    expect(await response.json()).toEqual({
      error: "turnstile_failed",
      message: "turnstile failed",
      hint: "Complete the browser verification, or call with a Bearer API key.",
    });
    expect(mocks.verifyTurnstile).toHaveBeenCalledWith(null, "0.0.0.0");
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("allows the same scan API to be called by CLI with a bearer token", async () => {
    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.metrics.username).toBe("DemoDev");
    expect(body.scoring.final_score).toBe(21);
    expect(body.cached).toBe(false);
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.collect).toHaveBeenCalledWith("DemoDev");
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: expect.objectContaining({ username: "DemoDev" }) }),
      expect.any(Number),
    );
  });

  it("rejects a non-string username with a 400 instead of crashing", async () => {
    const response = await POST(
      new NextRequest("https://example.test/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: 12345 }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_username");
  });

  it("rate-limits before the cache lookup so cached hits can't bypass the limiter", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: Date.now() + 60_000 });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "60" });
    mocks.getCachedScan.mockResolvedValue({ metrics, scoring });

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
    expect(mocks.recordAccountLookup).not.toHaveBeenCalled();
  });

  it("fails closed before cache and lookup work when production rate limiting is unavailable", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false, unavailable: true, retryAfter: 15 });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "15" });

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
    await expect(response.json()).resolves.toMatchObject({ error: "rate_limit_unavailable" });
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
    expect(mocks.recordAccountLookup).not.toHaveBeenCalled();
  });

  it("serves a complete persisted run with RateLimit headers once the limiter passes", async () => {
    mocks.rateLimitHeaders.mockReturnValue({ "RateLimit-Remaining": "9" });
    mocks.getCachedScan.mockResolvedValue({ metrics, scoring });
    const run = { id: "complete-run" };
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "complete",
      run,
      scan: { metrics, scoring },
    });

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(200);
    expect((await response.json()).cached).toBe(true);
    expect(response.headers.get("RateLimit-Remaining")).toBe("9");
    expect(mocks.ensureCanonicalScoreForPublicRun).toHaveBeenCalledWith(run);
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.publishCompleteQuickScan).not.toHaveBeenCalled();
  });

  it("serves a v3 snapshot and starts only one explicit v4 refresh", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "stale",
      run: { id: "legacy-run", username: "DemoDev", collectionVersion: "v3" },
      scan: { metrics, scoring, top_repos: [], recent_prs: [], flood_pr_titles: [] },
      refreshPending: false,
      refreshRun: null,
      servedCollectionVersion: "v3",
      targetCollectionVersion: "v4",
    });
    mocks.startPublicScan.mockResolvedValue({
      status: "pending",
      run: { id: "refresh-run" },
      retryAfterSeconds: 5,
      headStartJobId: "refresh-job",
    });

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stale: true,
      refresh_pending: true,
      run_id: "refresh-run",
      served_collection_version: "v3",
      target_collection_version: "v4",
    });
    expect(mocks.startPublicScan).toHaveBeenCalledTimes(1);
    expect(mocks.kickPublicScanDrain).toHaveBeenCalledWith("refresh-job");
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.ensureCanonicalScoreForPublicRun).not.toHaveBeenCalled();
    expect(mocks.publishCompleteQuickScan).not.toHaveBeenCalled();
  });

  it("hands a verified v5/v5/v3 profile to the home flow while v9/v4 refreshes", async () => {
    const legacyScan = {
      metrics,
      scoring,
      top_repos: [],
      recent_prs: [],
      flood_pr_titles: [],
      impact_repos: [],
      verified_impact_prs: [],
      pinned_repos: [],
      organizations: [],
    };
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "pending",
      run: { id: "canonical-run" },
      retryAfterSeconds: 5,
      headStartJobId: null,
    });
    mocks.getLegacyReadFallbackScan.mockResolvedValue(legacyScan);
    mocks.startPublicScan.mockResolvedValue({
      status: "pending",
      run: { id: "canonical-run" },
      retryAfterSeconds: 5,
      headStartJobId: "canonical-job",
    });

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      metrics: { username: "DemoDev" },
      cached: true,
      stale: true,
      legacy_read_fallback: true,
      refresh_pending: true,
      run_id: "canonical-run",
      served_score_version: "v5",
      served_roast_version: "v5",
      served_collection_version: "v3",
      target_score_version: "v9",
      target_roast_version: "v9",
      target_collection_version: "v4",
    });
    expect(mocks.startPublicScan).toHaveBeenCalledTimes(1);
    expect(mocks.kickPublicScanDrain).toHaveBeenCalledWith("canonical-job");
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.ensureCanonicalScoreForPublicRun).not.toHaveBeenCalled();
    expect(mocks.publishCompleteQuickScan).not.toHaveBeenCalled();
    expect(mocks.recordAccountLookup).not.toHaveBeenCalled();
  });

  it("hands a stored v5 profile to the browser without fabricating a v3 scan", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "pending",
      run: { id: "canonical-run" },
      retryAfterSeconds: 5,
      headStartJobId: null,
    });
    mocks.hasLegacyReadFallbackProfile.mockResolvedValue(true);
    mocks.startPublicScan.mockResolvedValue({
      status: "pending",
      run: { id: "canonical-run" },
      retryAfterSeconds: 5,
      headStartJobId: "canonical-job",
    });

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      username: "DemoDev",
      cached: true,
      stale: true,
      legacy_read_fallback: true,
      legacy_profile: true,
      refresh_pending: true,
      run_id: "canonical-run",
      served_score_version: "v5",
      served_roast_version: "v5",
      served_collection_version: "v3",
      target_score_version: "v9",
      target_roast_version: "v9",
      target_collection_version: "v4",
    });
    expect(mocks.getLegacyReadFallbackScan).toHaveBeenCalledWith("DemoDev");
    expect(mocks.startPublicScan).toHaveBeenCalledTimes(1);
    expect(mocks.kickPublicScanDrain).toHaveBeenCalledWith("canonical-job");
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("keeps the verified v5/v5/v3 profile readable when v9 admission is full", async () => {
    mocks.getLegacyReadFallbackScan.mockResolvedValue({
      metrics,
      scoring,
      top_repos: [],
      recent_prs: [],
      flood_pr_titles: [],
      impact_repos: [],
      verified_impact_prs: [],
      pinned_repos: [],
      organizations: [],
    });
    mocks.startPublicScan.mockResolvedValue({
      status: "queue_full",
      run: null,
      retryAfterSeconds: 60,
    });

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      legacy_read_fallback: true,
      refresh_pending: false,
    });
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.kickPublicScanDrain).not.toHaveBeenCalled();
  });

  it("keeps the verified v5/v5/v3 profile readable when starting v9 refresh throws", async () => {
    mocks.getLegacyReadFallbackScan.mockResolvedValue({
      metrics,
      scoring,
      top_repos: [],
      recent_prs: [],
      flood_pr_titles: [],
      impact_repos: [],
      verified_impact_prs: [],
      pinned_repos: [],
      organizations: [],
    });
    mocks.startPublicScan.mockRejectedValue(new Error("storage unavailable"));

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      legacy_read_fallback: true,
      refresh_pending: false,
    });
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.kickPublicScanDrain).not.toHaveBeenCalled();
  });

  it("lets an explicit scan retry after a failed v4 refresh while serving v3", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "stale",
      run: { id: "legacy-run", username: "DemoDev", collectionVersion: "v3" },
      scan: { metrics, scoring, top_repos: [], recent_prs: [], flood_pr_titles: [] },
      refreshPending: false,
      refreshRun: { id: "failed-refresh", username: "DemoDev", collectionVersion: "v4" },
      servedCollectionVersion: "v3",
      targetCollectionVersion: "v4",
    });
    mocks.startPublicScan.mockResolvedValue({
      status: "pending",
      run: { id: "retry-run" },
      retryAfterSeconds: 5,
      headStartJobId: "retry-job",
    });

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stale: true,
      refresh_pending: true,
      run_id: "retry-run",
    });
    expect(mocks.startPublicScan).toHaveBeenCalledTimes(1);
    expect(mocks.kickPublicScanDrain).toHaveBeenCalledWith("retry-job");
  });

  it("discards an orphaned scan cache and publishes a fresh trusted quick scan", async () => {
    mocks.getCachedScan.mockResolvedValue({ metrics, scoring });

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(200);
    expect((await response.json()).cached).toBe(false);
    expect(mocks.clearCachedScan).toHaveBeenCalledWith("DemoDev");
    expect(mocks.collect).toHaveBeenCalledWith("DemoDev");
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a complete run cannot materialize its canonical score", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "complete",
      run: { id: "complete-run" },
      scan: { metrics, scoring },
    });
    mocks.ensureCanonicalScoreForPublicRun.mockResolvedValue(null);

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.setCachedScan).not.toHaveBeenCalled();
  });

  it("does not republish a scan returned by the single-flight cache race", async () => {
    mocks.coalesceScan.mockResolvedValue({
      metrics,
      scoring,
      top_repos: [],
      recent_prs: [],
      flood_pr_titles: [],
    });

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(200);
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.publishCompleteQuickScan).not.toHaveBeenCalled();
  });

  it("does not rerun a quick GitHub scan while a durable job is pending", async () => {
    mocks.getCachedScan.mockResolvedValue({ metrics, scoring });
    mocks.requiresDurablePublicScan.mockReturnValue(true);
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "pending",
      run: { id: "active-run" },
      retryAfterSeconds: 5,
    });

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      error: "scan_enrichment_pending",
      run_id: "active-run",
    });
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.resolvePublicScanFromTrustedQuickScan).not.toHaveBeenCalled();
    expect(mocks.kickPublicScanDrain).not.toHaveBeenCalled();
    expect(mocks.publishCompleteQuickScan).not.toHaveBeenCalled();
  });

  it("starts one response-side step only when this request created the durable job", async () => {
    mocks.requiresDurablePublicScan.mockReturnValue(true);
    mocks.resolvePublicScanFromTrustedQuickScan.mockResolvedValue({
      status: "pending",
      run: { id: "new-run" },
      retryAfterSeconds: 5,
      headStartJobId: "new-job-id",
    });

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(202);
    expect(mocks.kickPublicScanDrain).toHaveBeenCalledTimes(1);
    expect(mocks.kickPublicScanDrain).toHaveBeenCalledWith("new-job-id");
    expect(mocks.publishCompleteQuickScan).not.toHaveBeenCalled();
  });

  it("returns 503 instead of claiming a fresh quick scan succeeded when persistence returns null", async () => {
    mocks.publishCompleteQuickScan.mockResolvedValue(null);

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({
      error: "scan_failed",
      message: "score persistence is temporarily unavailable",
    });
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledTimes(1);
  });

  it("returns 503 instead of claiming a fresh quick scan succeeded when persistence throws", async () => {
    mocks.publishCompleteQuickScan.mockRejectedValue(new Error("storage unavailable"));

    const response = await POST(request({ auth: "Bearer cli-secret" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "scan_failed" });
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledTimes(1);
  });
});
