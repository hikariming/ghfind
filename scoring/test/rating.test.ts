import { describe, expect, it } from "vitest";
import fixture from "../fixtures/rating-ladder.json";
import { RATING_FLOOR, RATING_LADDER, RATING_STEP, nextRating, ratingForScore, ratingLevel } from "../src/rating";

describe("rating ladder", () => {
  it("is 30–100 with one rating every 10 points above the entry step", () => {
    expect(RATING_LADDER[0]).toMatchObject({ minScore: 0, rank: 1 });
    const stepped = RATING_LADDER.slice(1);
    stepped.forEach((step, i) => {
      expect(step.minScore).toBe(RATING_FLOOR + i * RATING_STEP);
      expect(step.rank).toBe(i + 2);
    });
    expect(stepped.at(-1)!.minScore + RATING_STEP).toBe(100);
  });

  it("matches the cross-runtime fixture", () => {
    expect(RATING_LADDER).toEqual(fixture.ladder);
    for (const c of fixture.cases) {
      expect(ratingLevel(c.score), `level ${c.score}`).toBe(c.level);
      expect(ratingForScore(c.score).id, `rating ${c.score}`).toBe(c.rating);
      expect(nextRating(c.score)?.threshold ?? null, `next ${c.score}`).toBe(c.next_threshold);
    }
  });

  it("treats non-finite scores as the entry step at Lv.1", () => {
    for (const s of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(ratingLevel(s)).toBe(1);
      expect(ratingForScore(s).id).toBe("qi");
    }
  });
});
