import { describe, expect, it } from "vitest";
import { computeTrendingScore, rankTrending } from "../hotness";

const NOW = Date.UTC(2026, 5, 28, 12);
const DAY = 24 * 60 * 60 * 1000;

function candidate(overrides: {
  username: string;
  final_score: number;
  lookup_count?: number;
  recent_lookup_count?: number;
  last_lookup_at?: number | null;
}) {
  return {
    lookup_count: 1,
    recent_lookup_count: 0,
    last_lookup_at: null,
    ...overrides,
  };
}

describe("computeTrendingScore", () => {
  it("keeps the composite trend score in a 0-100 range", () => {
    const score = computeTrendingScore(
      candidate({
        username: "maxed",
        final_score: 1000,
        lookup_count: 1_000_000,
        recent_lookup_count: 1_000_000,
        last_lookup_at: NOW,
      }),
      NOW,
    );

    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("lets recent interest lift a strong account above a stale legacy account", () => {
    const staleLegend = computeTrendingScore(
      candidate({
        username: "stale",
        final_score: 100,
        recent_lookup_count: 0,
        last_lookup_at: NOW - 90 * DAY,
      }),
      NOW,
    );
    const activeStrong = computeTrendingScore(
      candidate({
        username: "active",
        final_score: 86,
        lookup_count: 80,
        recent_lookup_count: 12,
        last_lookup_at: NOW - 2 * DAY,
      }),
      NOW,
    );

    expect(activeStrong).toBeGreaterThan(staleLegend);
  });

  it("keeps low-score accounts from winning only because they are queried often", () => {
    const lowScoreViral = computeTrendingScore(
      candidate({
        username: "viral",
        final_score: 61,
        lookup_count: 1000,
        recent_lookup_count: 1000,
        last_lookup_at: NOW,
      }),
      NOW,
    );
    const quietHighQuality = computeTrendingScore(
      candidate({
        username: "quality",
        final_score: 94,
        lookup_count: 2,
        recent_lookup_count: 0,
        last_lookup_at: NOW - 30 * DAY,
      }),
      NOW,
    );

    expect(quietHighQuality).toBeGreaterThan(lowScoreViral);
  });

  it("saturates recent heat so extra repeated attention has diminishing returns", () => {
    const warm = computeTrendingScore(
      candidate({
        username: "warm",
        final_score: 80,
        recent_lookup_count: 20,
        last_lookup_at: NOW,
      }),
      NOW,
    );
    const flooded = computeTrendingScore(
      candidate({
        username: "flooded",
        final_score: 80,
        recent_lookup_count: 2000,
        last_lookup_at: NOW,
      }),
      NOW,
    );

    expect(flooded - warm).toBeLessThan(0.001);
  });
});

describe("rankTrending", () => {
  it("orders by trending score with stable public tie-breakers", () => {
    const ranked = rankTrending(
      [
        candidate({ username: "z-last", final_score: 80, lookup_count: 5 }),
        candidate({ username: "a-first", final_score: 80, lookup_count: 5 }),
        candidate({ username: "better-score", final_score: 82, lookup_count: 1 }),
        candidate({
          username: "hot",
          final_score: 86,
          lookup_count: 40,
          recent_lookup_count: 8,
          last_lookup_at: NOW,
        }),
      ],
      NOW,
    ).map((entry) => entry.username);

    expect(ranked).toEqual(["hot", "better-score", "a-first", "z-last"]);
  });
});
