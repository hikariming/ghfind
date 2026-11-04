/**
 * The public rating ladder: how a 0–100 final score maps to a rating.
 *
 * Ratings run from 30 to 100 with one step every 10 points; scores below 30
 * share the entry rating. `Lv.N` is floor(score) clamped to 1…100.
 *
 *   [0, 30) qi · [30, 40) foundation · [40, 50) goldenCore · [50, 60) nascentSoul
 *   [60, 70) deity · [70, 80) voidRefining · [80, 90) integration · [90, 100] mahayana
 *
 * Boundary rule: a score exactly on a threshold belongs to that rating
 * (30.0 -> foundation, 90.0 -> mahayana). Names, colors, glyphs and effects are
 * presentation and live with each frontend; only the rule lives here.
 * `fixtures/rating-ladder.json` pins the TypeScript, Go and Python ports.
 */

export type RatingId =
  | "qi"
  | "foundation"
  | "goldenCore"
  | "nascentSoul"
  | "deity"
  | "voidRefining"
  | "integration"
  | "mahayana";

export interface RatingStep {
  id: RatingId;
  /** Inclusive lower bound; the next step's minScore is the exclusive upper bound. */
  minScore: number;
  /** 1 (qi) … 8 (mahayana). */
  rank: number;
}

/** Lowest score that earns a rating above the entry step. */
export const RATING_FLOOR = 30;
/** Width of every rating step from RATING_FLOOR to 100. */
export const RATING_STEP = 10;

/** Ascending, contiguous ladder. */
export const RATING_LADDER: readonly RatingStep[] = [
  { id: "qi", minScore: 0, rank: 1 },
  { id: "foundation", minScore: 30, rank: 2 },
  { id: "goldenCore", minScore: 40, rank: 3 },
  { id: "nascentSoul", minScore: 50, rank: 4 },
  { id: "deity", minScore: 60, rank: 5 },
  { id: "voidRefining", minScore: 70, rank: 6 },
  { id: "integration", minScore: 80, rank: 7 },
  { id: "mahayana", minScore: 90, rank: 8 },
];

/** floor(score) clamped to Lv.1 … Lv.100; non-finite input is Lv.1. */
export function ratingLevel(score: number): number {
  if (!Number.isFinite(score)) return 1;
  return Math.min(100, Math.max(1, Math.floor(score)));
}

/** The rating a score belongs to. Non-finite input is treated as 0. */
export function ratingForScore(score: number): RatingStep {
  const s = Number.isFinite(score) ? score : 0;
  let current = RATING_LADDER[0]!;
  for (const step of RATING_LADDER) if (s >= step.minScore) current = step;
  return current;
}

/** The next rating and the score needed to reach it, or null at the top. */
export function nextRating(score: number): { threshold: number; rating: RatingStep } | null {
  const idx = RATING_LADDER.indexOf(ratingForScore(score));
  const next = RATING_LADDER[idx + 1];
  return next ? { threshold: next.minScore, rating: next } : null;
}
