/**
 * Shared dimension ordering + bar coloring for the score breakdown, used by the
 * profile page and the /vs comparison page so both render the six sub-scores
 * identically. Labels come from the `dimensions` i18n namespace (keyed by the
 * SubScoreKey); the max per dimension is `SUBSCORE_MAX` in `score-presentation.ts`.
 */
import type { SubScoreKey } from "./types";

export const DIMENSIONS: SubScoreKey[] = [
  "account_maturity",
  "original_project_quality",
  "contribution_quality",
  "ecosystem_impact",
  "community_influence",
  "activity_authenticity",
];

/** Tailwind bg class for a dimension bar, by fill ratio (0-1). */
export function barColor(pct: number): string {
  if (pct >= 0.75) return "bg-emerald-400";
  if (pct >= 0.45) return "bg-amber-400";
  return "bg-rose-400";
}
