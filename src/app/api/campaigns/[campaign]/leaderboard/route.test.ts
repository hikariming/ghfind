import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCampaignLeaderboard: vi.fn(),
  checkRateLimit: vi.fn(),
  checkCampaignLeaderboardReadRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getCampaignLeaderboard: mocks.getCampaignLeaderboard,
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: mocks.checkRateLimit,
  checkCampaignLeaderboardReadRateLimit: mocks.checkCampaignLeaderboardReadRateLimit,
  rateLimitHeaders: mocks.rateLimitHeaders,
}));

import { GET } from "./route";

const context = { params: Promise.resolve({ campaign: "advx" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ success: true });
  mocks.checkCampaignLeaderboardReadRateLimit.mockResolvedValue({ success: true });
  mocks.rateLimitHeaders.mockReturnValue({});
  mocks.getCampaignLeaderboard.mockResolvedValue([]);
});

describe("campaign leaderboard public guardrails", () => {
  it("limits before the leaderboard database query", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "60" });

    const response = await GET(
      new NextRequest("https://example.test/api/campaigns/advx/leaderboard", {
        headers: { "x-forwarded-for": "198.51.100.10" },
      }),
      context,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mocks.getCampaignLeaderboard).not.toHaveBeenCalled();
  });

  it("fails closed before the leaderboard database query when request protection is unavailable", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false, unavailable: true, retryAfter: 15 });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "15" });

    const response = await GET(
      new NextRequest("https://example.test/api/campaigns/advx/leaderboard"),
      context,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
    await expect(response.json()).resolves.toEqual({ error: "rate_limit_unavailable" });
    expect(mocks.getCampaignLeaderboard).not.toHaveBeenCalled();
  });

  it("canonicalizes cache-busting query strings before Turso", async () => {
    const response = await GET(
      new NextRequest("https://example.test/api/campaigns/advx/leaderboard?limit=0100&utm=x"),
      context,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://example.test/api/campaigns/advx/leaderboard",
    );
    expect(mocks.getCampaignLeaderboard).not.toHaveBeenCalled();
  });

  it("serves live refreshes without CDN caching", async () => {
    mocks.getCampaignLeaderboard.mockResolvedValue([]);

    const response = await GET(
      new NextRequest(
        "https://example.test/api/campaigns/advx/leaderboard?limit=500&live=1",
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.checkCampaignLeaderboardReadRateLimit).toHaveBeenCalledWith("0.0.0.0");
    expect(mocks.getCampaignLeaderboard).toHaveBeenCalledWith("advx", 500);
  });

  it("uses the event-read budget for live refresh failures", async () => {
    mocks.checkCampaignLeaderboardReadRateLimit.mockResolvedValue({
      success: false,
      limit: 600,
      remaining: 0,
      reset: Date.now() + 30_000,
    });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "30" });

    const response = await GET(
      new NextRequest(
        "https://example.test/api/campaigns/advx/leaderboard?limit=500&live=1",
      ),
      context,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.getCampaignLeaderboard).not.toHaveBeenCalled();
  });
});
