import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFacetRank: vi.fn(),
  getScoreBrief: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getFacetRank: mocks.getFacetRank,
  getScoreBrief: mocks.getScoreBrief,
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitHeaders: mocks.rateLimitHeaders,
}));

import { GET } from "./route";

const context = { params: Promise.resolve({ username: "DemoDev" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ success: true });
  mocks.rateLimitHeaders.mockReturnValue({});
});

describe("facet-rank public guardrails", () => {
  it("limits before both database reads", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "60" });

    const response = await GET(
      new NextRequest("https://example.test/api/facet-rank/DemoDev", {
        headers: { "x-forwarded-for": "198.51.100.10" },
      }),
      context,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mocks.getScoreBrief).not.toHaveBeenCalled();
    expect(mocks.getFacetRank).not.toHaveBeenCalled();
  });

  it("fails closed before both database reads when request protection is unavailable", async () => {
    mocks.checkRateLimit.mockResolvedValue({ success: false, unavailable: true, retryAfter: 15 });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "15" });

    const response = await GET(new NextRequest("https://example.test/api/facet-rank/DemoDev"), context);

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
    await expect(response.json()).resolves.toEqual({ error: "rate_limit_unavailable" });
    expect(mocks.getScoreBrief).not.toHaveBeenCalled();
    expect(mocks.getFacetRank).not.toHaveBeenCalled();
  });

  it("CDN-caches null ranks after the limiter passes", async () => {
    mocks.getScoreBrief.mockResolvedValue(null);

    const response = await GET(
      new NextRequest("https://example.test/api/facet-rank/DemoDev"),
      context,
    );

    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600",
    );
    await expect(response.json()).resolves.toEqual({ facetRank: null });
  });
});
