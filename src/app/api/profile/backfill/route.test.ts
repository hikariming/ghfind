import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getScoreBrief: vi.fn(),
  hasProfileSnapshot: vi.fn(),
  recordProfileSnapshot: vi.fn(),
  collect: vi.fn(),
  score: vi.fn(),
  checkRateLimit: vi.fn(),
  coalesceScan: vi.fn(),
  getCachedScan: vi.fn(),
  rateLimitHeaders: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getScoreBrief: mocks.getScoreBrief,
  hasProfileSnapshot: mocks.hasProfileSnapshot,
  recordProfileSnapshot: mocks.recordProfileSnapshot,
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
  coalesceScan: mocks.coalesceScan,
  getCachedScan: mocks.getCachedScan,
  rateLimitHeaders: mocks.rateLimitHeaders,
}));

vi.mock("@/lib/score", () => ({
  score: mocks.score,
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ success: true });
  mocks.rateLimitHeaders.mockReturnValue({});
});

describe("profile backfill rate-limit ordering", () => {
  it("limits before any score or snapshot database read", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "60" });

    const response = await POST(
      new NextRequest("https://example.test/api/profile/backfill", {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.10" },
        body: JSON.stringify({ username: "DemoDev" }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mocks.getScoreBrief).not.toHaveBeenCalled();
    expect(mocks.hasProfileSnapshot).not.toHaveBeenCalled();
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("fails closed before any database read when request protection is unavailable", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false, unavailable: true, retryAfter: 15 });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "15" });

    const response = await POST(
      new NextRequest("https://example.test/api/profile/backfill", {
        method: "POST",
        body: JSON.stringify({ username: "DemoDev" }),
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
    await expect(response.json()).resolves.toEqual({ error: "rate_limit_unavailable" });
    expect(mocks.getScoreBrief).not.toHaveBeenCalled();
    expect(mocks.hasProfileSnapshot).not.toHaveBeenCalled();
  });
});
