import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFacetRank: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDevelopersByFacet: vi.fn(),
  getFacetCategories: vi.fn(),
  getFacetRank: mocks.getFacetRank,
}));
vi.mock("@/lib/redis", () => ({
  getCachedFacetCategories: vi.fn(),
  getCachedFacetDevelopers: vi.fn(),
  setCachedFacetCategories: vi.fn(),
  setCachedFacetDevelopers: vi.fn(),
}));

import { getFacetRankCached } from "../developers";

const rank = { facetType: "language", facetValue: "Rust", rank: 3, total: 40, ahead: null };

beforeEach(() => {
  mocks.getFacetRank.mockReset();
});

describe("getFacetRankCached", () => {
  it("normalizes the username and keeps no per-profile cache", async () => {
    mocks.getFacetRank.mockResolvedValue(rank);
    expect(await getFacetRankCached("OctoCat", 77.7)).toEqual(rank);
    expect(await getFacetRankCached("octocat", 77.7)).toEqual(rank);
    expect(mocks.getFacetRank).toHaveBeenCalledTimes(2);
    expect(mocks.getFacetRank).toHaveBeenCalledWith("octocat", 77.7);
  });

  it("collapses concurrent misses into one query", async () => {
    mocks.getFacetRank.mockResolvedValue(rank);
    await Promise.all([getFacetRankCached("a", 60), getFacetRankCached("a", 60)]);
    expect(mocks.getFacetRank).toHaveBeenCalledTimes(1);
  });
});
