/**
 * Sub-score profile similarity — the math behind "similar developers".
 *
 * Pure functions (no DB), so the ranking is deterministically unit-testable. Each
 * dimension is normalized by its max (see {@link SUBSCORE_MAX}) so every axis
 * contributes comparably regardless of its point ceiling, then compared by
 * Euclidean distance: smaller = more alike.
 */

import { SUBSCORE_MAX } from "./score-presentation";
import type { SubScoreKey, SubScores } from "./types";

const KEYS = Object.keys(SUBSCORE_MAX) as SubScoreKey[];

/** Normalized 6-dim Euclidean distance between two profiles (0 = identical). */
export function subScoreDistance(a: SubScores, b: SubScores): number {
  let sum = 0;
  for (const k of KEYS) {
    const max = SUBSCORE_MAX[k] || 1;
    const d = ((a[k] ?? 0) - (b[k] ?? 0)) / max;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Rank candidates by how close their sub-score profile is to `target`, ascending,
 * and return the top `k`. Generic over any candidate carrying `sub_scores`.
 */
export function rankSimilar<T extends { sub_scores: SubScores }>(
  target: SubScores,
  candidates: T[],
  k: number,
): T[] {
  return candidates
    .map((c) => ({ c, d: subScoreDistance(target, c.sub_scores) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, Math.max(0, k))
    .map((x) => x.c);
}
