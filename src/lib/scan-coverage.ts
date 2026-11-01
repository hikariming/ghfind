import type { ScanResult } from "./types";

export interface CollectionCoverage {
  mode: "quick" | "full";
  coverage: "partial_public" | "complete_public";
  truncation_reasons: string[];
}

/** Historical payloads have no evidence of public-history completeness. */
export function scanCoverage(scan: ScanResult): CollectionCoverage["coverage"] | "quick" {
  return scan.collection?.coverage ?? "quick";
}

export function needsFullScan(scan: ScanResult): boolean {
  return scan.collection?.mode === "quick" && scan.collection.coverage === "partial_public";
}
