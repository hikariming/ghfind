/**
 * collect.py function name → TS port, and the comparison of one corpus case: shared by the
 * classify parity test (fixture) and scripts/devscore-classify-parity.mts (full corpus).
 */
import * as C from "../classify";

type Fn = (...args: never[]) => unknown;

export const CLASSIFY_CASES: Record<string, Fn> = {
  classify_commit: C.classifyCommit,
  classify_pr: C.classifyPr,
  core_area: C.coreArea,
  file_kind: C.fileKind,
  has_ci: C.hasCi,
  has_tests: C.hasTests,
  is_content_tree: C.isContentTree,
  issue_authors: C.issueAuthors,
  kind_with_evidence: C.kindWithEvidence,
  maint_months: C.maintMonths,
  merger_key: C.mergerKey,
  month_key: C.monthKey,
  mutual_merger_pairs: C.mutualMergerPairs,
  package_dependents: C.packageDependents,
  package_names: C.packageNames,
  pr_batch_share: C.prBatchShare,
  pr_mergers: C.prMergers,
  pr_sample_priority: C.prSamplePriority,
  pr_substance: C.prSubstance,
  repo_kind: C.repoKind,
  repo_priority: C.repoPriority,
  scale_counts: C.scaleCounts,
  star_history_candidates: C.starHistoryCandidates,
  _github_owner: C.githubOwner,
  _gap_series: C.gapSeries,
  _month_add: C.monthAdd,
  _norm_repo_url: C.normRepoUrl,
};

/** Deep equality in JSON terms, key order included (Python dict order is part of the output). */
function diff(got: unknown, want: unknown, path: string): string | null {
  if (typeof want === "number" && typeof got === "number") {
    return Math.abs(got - want) <= 1e-12 * Math.max(1, Math.abs(want)) ? null : `${path}: ${got} != ${want}`;
  }
  if (Array.isArray(want) && Array.isArray(got)) {
    if (got.length !== want.length) return `${path}: length ${got.length} != ${want.length}`;
    for (let i = 0; i < want.length; i++) {
      const d = diff(got[i], want[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (want && got && typeof want === "object" && typeof got === "object" && !Array.isArray(got)) {
    const wk = Object.keys(want);
    const gk = Object.keys(got);
    if (wk.join("\0") !== gk.join("\0")) return `${path}: keys ${JSON.stringify(gk)} != ${JSON.stringify(wk)}`;
    for (const k of wk) {
      const d = diff((got as Record<string, unknown>)[k], (want as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return got === want ? null : `${path}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`;
}

/** null when the TS port returns `want` for `args`, else a description of the difference. */
export function runClassifyCase(fn: string, args: unknown[], want: unknown): string | null {
  return diff(CLASSIFY_CASES[fn](...(args as never[])), want, "out");
}
