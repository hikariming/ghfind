/**
 * `ghfind/local` — verify ghfind scores locally (pure, no I/O).
 *
 * This entry point bundles the public, open-source scoring module
 * (`@ghfind/scoring`) — the same code the ghfind service scores with — so you
 * can recompute any score from its published evidence and check it yourself.
 * It never calls GitHub or ghfind and needs no token. No LLM is involved.
 *
 *   import { GhFind } from "ghfind";
 *   import { verifyScan } from "ghfind/local";
 *   const scan = await new GhFind({ apiKey }).scan("torvalds");
 *   const check = verifyScan(scan);
 *   console.log(check.verified, check.differences);
 *
 * Collecting evidence from GitHub happens on the ghfind service (it is rate
 * limited and runs against a managed token pool), so local crawling was removed
 * in 0.2.0. Get a scan from the remote client and verify it here.
 */

import { score } from "@ghfind/scoring/score";
import { nextRating, ratingForScore, ratingLevel } from "@ghfind/scoring/rating";
import type { RawMetrics, ScanResult, Scoring, SubScores } from "./types.js";

export { nextRating, ratingForScore, ratingLevel };
export type { RatingId, RatingStep } from "@ghfind/scoring/rating";

/** Run the pure deterministic scorer over metrics you already have. No I/O. */
export function scoreMetrics(metrics: RawMetrics): Scoring {
  return score(metrics as never) as unknown as Scoring;
}

export interface ScoreDifference {
  /** `final_score`, `base_score`, `total_penalty`, `tier` or `sub_scores.<name>`. */
  field: string;
  server: unknown;
  local: unknown;
}

export interface ScanVerification {
  /** True when every compared field matches the published score. */
  verified: boolean;
  /** The score recomputed locally from `scan.metrics`. */
  local: Scoring;
  differences: ScoreDifference[];
}

const NUMERIC_TOLERANCE = 1e-9;

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= NUMERIC_TOLERANCE;
  return a === b;
}

/**
 * Recompute `scan.scoring` from `scan.metrics` and compare.
 *
 * A difference means the scan was altered or was scored by a different version
 * of the scoring module than this SDK bundles (update the SDK and retry).
 */
export function verifyScan(scan: Pick<ScanResult, "metrics" | "scoring">): ScanVerification {
  if (typeof scan?.metrics?.username !== "string" || typeof scan?.scoring?.sub_scores !== "object") {
    throw new TypeError("verifyScan needs a full scan with `metrics` and `scoring` (from GhFind.scan()).");
  }
  const local = scoreMetrics(scan.metrics);
  const server = scan.scoring;
  const differences: ScoreDifference[] = [];
  for (const field of ["final_score", "base_score", "total_penalty", "tier"] as const) {
    if (!same(server[field], local[field])) differences.push({ field, server: server[field], local: local[field] });
  }
  const names = new Set([...Object.keys(server.sub_scores ?? {}), ...Object.keys(local.sub_scores)]);
  for (const name of [...names].sort()) {
    const s = server.sub_scores?.[name as keyof SubScores];
    const l = local.sub_scores[name as keyof SubScores];
    if (!same(s, l)) differences.push({ field: `sub_scores.${name}`, server: s, local: l });
  }
  return { verified: differences.length === 0, local, differences };
}
