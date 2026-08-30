import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getScoreCount: vi.fn(),
  getCachedStats: vi.fn(),
  setCachedStats: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getScoreCount: mocks.getScoreCount,
}));

vi.mock("@/lib/redis", () => ({
  getCachedStats: mocks.getCachedStats,
  setCachedStats: mocks.setCachedStats,
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCachedStats.mockResolvedValue(null);
  mocks.getScoreCount.mockResolvedValue(42);
  mocks.setCachedStats.mockResolvedValue(undefined);
});

describe("stats API cache policy", () => {
  it("shares cached totals at the CDN without touching Turso", async () => {
    mocks.getCachedStats.mockResolvedValue(99);

    const response = await GET();

    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
    await expect(response.json()).resolves.toEqual({ total: 99, cached: true });
    expect(mocks.getScoreCount).not.toHaveBeenCalled();
  });

  it("keeps the same CDN policy when the origin refreshes the count", async () => {
    const response = await GET();

    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
    await expect(response.json()).resolves.toEqual({ total: 42, cached: false });
    expect(mocks.setCachedStats).toHaveBeenCalledWith(42);
  });
});
