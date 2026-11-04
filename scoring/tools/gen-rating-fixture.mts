/** Regenerate fixtures/rating-ladder.json from the TypeScript reference. */
import { writeFileSync } from "node:fs";
import { RATING_LADDER, nextRating, ratingForScore, ratingLevel } from "../src/rating";

const scores = [-5, 0, 0.5, 1, 29.99, 30, 30.01, 39.99, 40, 49.5, 50, 59.99, 60, 69.99, 70, 79.99, 80, 89.99, 90, 94.6, 99.99, 100, 120];
const cases = scores.map((score) => {
  const next = nextRating(score);
  return { score, level: ratingLevel(score), rating: ratingForScore(score).id, next_threshold: next?.threshold ?? null };
});
writeFileSync(
  new URL("../fixtures/rating-ladder.json", import.meta.url),
  JSON.stringify({ ladder: RATING_LADDER, cases }, null, 2) + "\n",
);
