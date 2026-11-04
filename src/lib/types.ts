/**
 * App-level scan/roast types. The evidence, RawMetrics and Scoring contract
 * lives in the public scoring module (scoring/src/types.ts, @ghfind/scoring).
 */
import type { EstimatedContributionLanguages, ImpactRepo, OrganizationMaintainedRepo, RawMetrics, RecentPr, Scoring, SignatureWork, Tier, TopRepo } from "@ghfind/scoring/types";

export type * from "@ghfind/scoring/types";

/** Full scan payload — same shape the Python script prints. */
export interface ScanResult {
  collection?: import("./scan-coverage").CollectionCoverage;
  metrics: RawMetrics;
  top_repos: TopRepo[];
  recent_prs: RecentPr[];
  /** Representative titles from the largest templated-PR cluster (for the LLM). */
  flood_pr_titles: string[];
  /** Popular repos the user contributed to all-time (PRs + commits). Optional
   * for backward compatibility with cached scans written before this field. */
  impact_repos?: ImpactRepo[];
  /** Verified popular-repo PR samples with file paths, for LLM qualitative review. */
  verified_impact_prs?: RecentPr[];
  /** Representative concrete work examples for report generation. */
  signature_work?: SignatureWork;
  /** Display-only org maintenance evidence collected alongside the scan. */
  organization_maintained_repos?: OrganizationMaintainedRepo[];
  /** Display-only contribution-weighted language estimate. */
  estimated_contribution_languages?: EstimatedContributionLanguages;
  /** "owner/name" of the user's pinned repos — their self-selected best work, a
   * strong signal of the direction they identify with. Optional for back-compat. */
  pinned_repos?: string[];
  /** Organizations the user belongs to (e.g. huggingface, pytorch) — high-signal
   * for circle/affiliation. Optional for back-compat. */
  organizations?: string[];
  scoring: Scoring;
}

/** Fun, viral tags the AI assigns to an account (3-5 each), for sharing. */
export interface Tags {
  zh: string[];
  en: string[];
}

/**
 * The savage one-liner roast, generated in both languages in a single LLM call
 * (so switching site language never shows an empty roast). The full report stays
 * single-language; only this one-liner is bilingual — the extra cost is ~one
 * short sentence, mirroring the bilingual {@link Tags}.
 */
export interface RoastLine {
  zh: string;
  en: string;
}

/**
 * Factual LLM judgment produced before the roast-writing pass. This is the only
 * model output allowed to affect the score delta; the later writer pass must
 * treat it as fixed input.
 */
export interface RoastJudgeResult {
  delta: number;
  reason: string;
  verdict: string;
  risk_notes: string[];
  final_score?: number;
  tier?: string;
  tier_label?: string;
}

/**
 * Metadata the roast stream emits on its first line. `final_score` is the
 * authoritative deterministic score; `delta` remains zero because the model
 * generates report text only.
 */
export interface RoastMeta {
  final_score: number;
  tier: Tier;
  tier_label: string;
  delta: number;
  percentile: { beat: number | null; total: number; rank: number | null } | null;
  tags: Tags;
  /** Bilingual savage one-liner; the UI shows the side matching the locale. */
  roast_line: RoastLine;
}
