import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScoreHistogramRow } from "@/lib/db";

const mocks = vi.hoisted(() => ({
  getScoreHistogram: vi.fn(),
  getCachedScoreHistogram: vi.fn(),
  setCachedScoreHistogram: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getScoreHistogram: mocks.getScoreHistogram,
}));

vi.mock("@/lib/redis", () => ({
  getCachedScoreHistogram: mocks.getCachedScoreHistogram,
  setCachedScoreHistogram: mocks.setCachedScoreHistogram,
}));

/** rank.ts holds an in-process histogram cache; re-import per test for isolation. */
async function loadRank() {
  vi.resetModules();
  return import("@/lib/rank");
}

const row = (hidden: number, score: number, n: number): ScoreHistogramRow => ({
  hidden,
  bucket: Math.round(score * 10),
  n,
});

// Visible: 95.2, 90.0 ×2, 72.0 ×3, 50.0 — hidden: 100.0.
const HISTOGRAM: ScoreHistogramRow[] = [
  row(1, 100.0, 1),
  row(0, 95.2, 1),
  row(0, 90.0, 2),
  row(0, 72.0, 3),
  row(0, 50.0, 1),
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCachedScoreHistogram.mockResolvedValue(null);
  mocks.getScoreHistogram.mockResolvedValue(HISTOGRAM);
  mocks.setCachedScoreHistogram.mockResolvedValue(undefined);
});

describe("getRankCached", () => {
  it("matches db.getRank semantics: visible only, ties share, strict above/below", async () => {
    const { getRankCached } = await loadRank();
    // 90.0: one visible account strictly above (95.2), four strictly below.
    await expect(getRankCached(90.0)).resolves.toEqual({ rank: 2, total: 7, below: 4 });
    // Top score: nobody above — and the hidden 100.0 must not count.
    await expect(getRankCached(95.2)).resolves.toEqual({ rank: 1, total: 7, below: 6 });
  });

  it("returns null when there is at most one visible account", async () => {
    mocks.getScoreHistogram.mockResolvedValue([row(1, 100.0, 5), row(0, 80.0, 1)]);
    const { getRankCached } = await loadRank();
    await expect(getRankCached(80.0)).resolves.toBeNull();
  });
});

describe("getPercentileCached", () => {
  it("matches db.getPercentile semantics: counts hidden accounts too", async () => {
    const { getPercentileCached } = await loadRank();
    await expect(getPercentileCached(90.0)).resolves.toEqual({ below: 4, total: 8 });
    // 100.0 (the hidden account's score): everyone else is below.
    await expect(getPercentileCached(100.0)).resolves.toEqual({ below: 7, total: 8 });
  });
});

describe("histogram loading", () => {
  it("serves from Redis without touching the database", async () => {
    mocks.getCachedScoreHistogram.mockResolvedValue(HISTOGRAM);
    const { getRankCached } = await loadRank();
    await expect(getRankCached(90.0)).resolves.toEqual({ rank: 2, total: 7, below: 4 });
    expect(mocks.getScoreHistogram).not.toHaveBeenCalled();
    expect(mocks.setCachedScoreHistogram).not.toHaveBeenCalled();
  });

  it("writes the Redis cache on a miss and memoizes in-process", async () => {
    const { getRankCached, getPercentileCached } = await loadRank();
    await getRankCached(90.0);
    await getPercentileCached(72.0);
    expect(mocks.getScoreHistogram).toHaveBeenCalledOnce();
    expect(mocks.getCachedScoreHistogram).toHaveBeenCalledOnce();
    expect(mocks.setCachedScoreHistogram).toHaveBeenCalledWith(HISTOGRAM);
  });

  it("degrades to null (and does not cache) when the table is empty or unreadable", async () => {
    mocks.getScoreHistogram.mockResolvedValue([]);
    const { getRankCached, getPercentileCached } = await loadRank();
    await expect(getRankCached(90.0)).resolves.toBeNull();
    await expect(getPercentileCached(90.0)).resolves.toBeNull();
    expect(mocks.setCachedScoreHistogram).not.toHaveBeenCalled();
  });
});
