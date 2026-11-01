import { describe, expect, it } from "vitest";
import { SCORE_CACHE_VERSION } from "@/lib/cache-version";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "@/lib/scan-run-types";
import {
  compareScoreVersions,
  isCurrentScoreProvenance,
  needsScoreVersionUpgrade,
  scoreVersionNumber,
} from "@/lib/score-version";

const current = scoreVersionNumber(SCORE_CACHE_VERSION)!;
const older = `v${current - 1}`;
const newer = `v${current + 1}`;
const canonical = {
  scoreVersion: SCORE_CACHE_VERSION,
  sourceCollectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
  sourceSnapshotHash: "b".repeat(64),
};

describe("score version helpers", () => {
  it("parses vN labels and rejects everything else", () => {
    expect(current).toBeGreaterThan(0);
    expect(scoreVersionNumber("v3")).toBe(3);
    expect(scoreVersionNumber(" v12 ")).toBe(12);
    expect(scoreVersionNumber("v3-previous")).toBeNull();
    expect(scoreVersionNumber("")).toBeNull();
    expect(scoreVersionNumber(null)).toBeNull();
  });

  it("compares numerically against the shared current version", () => {
    expect(compareScoreVersions(older)).toBeLessThan(0);
    expect(compareScoreVersions(SCORE_CACHE_VERSION)).toBe(0);
    expect(compareScoreVersions(newer)).toBeGreaterThan(0);
    expect(compareScoreVersions("v9", "v10")).toBeLessThan(0);
    expect(compareScoreVersions(null)).toBeLessThan(0);
    expect(compareScoreVersions("v1", "not-a-version")).toBe(0);
  });

  it("only treats the full current provenance as current", () => {
    expect(isCurrentScoreProvenance(canonical)).toBe(true);
    expect(isCurrentScoreProvenance({ ...canonical, scoreVersion: older })).toBe(false);
    expect(isCurrentScoreProvenance({ ...canonical, sourceSnapshotHash: "short" })).toBe(false);
    expect(isCurrentScoreProvenance({ ...canonical, sourceCollectionVersion: null })).toBe(false);
  });

  it("asks for an upgrade only when the stored score is behind (or lacks provenance)", () => {
    expect(needsScoreVersionUpgrade(canonical)).toBe(false);
    expect(needsScoreVersionUpgrade({ ...canonical, scoreVersion: older })).toBe(true);
    expect(needsScoreVersionUpgrade({ ...canonical, scoreVersion: null })).toBe(true);
    expect(needsScoreVersionUpgrade({ ...canonical, sourceSnapshotHash: null })).toBe(true);
    // A newer label means this deployment is the stale side (rollback): never overwrite.
    expect(needsScoreVersionUpgrade({ ...canonical, scoreVersion: newer })).toBe(false);
  });
});
