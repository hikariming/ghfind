import { SCORE_CACHE_VERSION } from "./cache-version";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "./scan-run-types";

/**
 * Version comparison for stored score artifacts. The current release labels
 * come from cache-version.ts / scan-run-types.ts (the single source of truth);
 * nothing here hard-codes a version literal.
 */

export interface ScoreProvenance {
  scoreVersion: string | null | undefined;
  sourceCollectionVersion: string | null | undefined;
  sourceSnapshotHash: string | null | undefined;
}

/** "v17" → 17; anything else (null, "", "legacy") → null. */
export function scoreVersionNumber(version: string | null | undefined): number | null {
  if (typeof version !== "string") return null;
  const match = /^v(\d+)$/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Negative when `stored` is older than `current`, 0 when equal, positive when
 * newer. An unparseable stored label counts as older (it predates the vN
 * scheme); an unparseable current label compares as equal (never "behind").
 */
export function compareScoreVersions(
  stored: string | null | undefined,
  current: string = SCORE_CACHE_VERSION,
): number {
  const target = scoreVersionNumber(current);
  if (target === null) return 0;
  const have = scoreVersionNumber(stored);
  if (have === null) return -1;
  return have - target;
}

/** True when a stored score carries the current release's full provenance. */
export function isCurrentScoreProvenance(p: ScoreProvenance): boolean {
  return (
    p.scoreVersion === SCORE_CACHE_VERSION &&
    p.sourceCollectionVersion === PUBLIC_SCAN_COLLECTION_VERSION &&
    typeof p.sourceSnapshotHash === "string" &&
    /^[a-f0-9]{64}$/.test(p.sourceSnapshotHash)
  );
}

/**
 * Whether a stored score should be re-evaluated under the current rules: it is
 * not current, and its score label is not *newer* than this release (a newer
 * label means this deployment is the stale side, e.g. during a rollback, and
 * must not overwrite it).
 */
export function needsScoreVersionUpgrade(p: ScoreProvenance): boolean {
  if (isCurrentScoreProvenance(p)) return false;
  return compareScoreVersions(p.scoreVersion) <= 0;
}
