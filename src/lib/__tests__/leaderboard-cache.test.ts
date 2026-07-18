import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTrendingLeaderboard: vi.fn(),
  getLeaderboard: vi.fn(),
  getHeatLeaderboard: vi.fn(),
  getProgressLeaderboard: vi.fn(),
  getCachedLeaderboard: vi.fn(),
  setCachedLeaderboard: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getTrendingLeaderboard: mocks.getTrendingLeaderboard,
  getLeaderboard: mocks.getLeaderboard,
  getHeatLeaderboard: mocks.getHeatLeaderboard,
  getProgressLeaderboard: mocks.getProgressLeaderboard,
}));

vi.mock("@/lib/redis", () => ({
  getCachedLeaderboard: mocks.getCachedLeaderboard,
  setCachedLeaderboard: mocks.setCachedLeaderboard,
}));

import { getLeaderboardCached } from "@/lib/leaderboard";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCachedLeaderboard.mockResolvedValue(null);
  mocks.setCachedLeaderboard.mockResolvedValue(undefined);
});

describe("getLeaderboardCached", () => {
  it("caches a non-empty fetch", async () => {
    mocks.getTrendingLeaderboard.mockResolvedValue([{ username: "a" }]);
    const res = await getLeaderboardCached("trending", "all");
    expect(res.entries).toHaveLength(1);
    expect(mocks.setCachedLeaderboard).toHaveBeenCalledOnce();
  });

  it("does not cache an empty fetch — a db hiccup must not blank the board for a TTL", async () => {
    mocks.getTrendingLeaderboard.mockResolvedValue([]);
    const res = await getLeaderboardCached("trending", "all");
    expect(res.entries).toEqual([]);
    expect(mocks.setCachedLeaderboard).not.toHaveBeenCalled();
  });
});
