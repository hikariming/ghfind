import {
  AccountNotFoundError,
  GitHubAuthRequiredError,
  GitHubDataUnavailableError,
  GitHubRateLimitError,
  computeImpactFromContribMap,
  computeImpactQualitySignals,
  bestOriginalRepoQuality,
  topStarredOriginalRepoQuality,
  collect,
  type ContribRepoAgg,
} from "@/lib/github";
import { score } from "@/lib/score";
import type { ScanResult, TopRepo } from "@/lib/types";

/**
 * Deterministic scan: crawl GitHub via `collect()` and run the pure `score()`
 * engine. NO LLM — this is the money-free scoring path shared by POST /api/scan
 * and the on-miss fallthrough in GET /api/score/[username].
 *
 * Wrap calls in `coalesceScan()` (single-flight + cache) so a burst of identical
 * requests only crawls GitHub once.
 */
export async function buildScanResult(username: string): Promise<ScanResult> {
  const {
    metrics,
    top_repos,
    recent_prs,
    flood_pr_titles,
    impact_repos,
    verified_impact_prs,
    pinned_repos,
    organizations,
  } = await collect(username);
  return {
    metrics,
    top_repos,
    recent_prs,
    flood_pr_titles,
    impact_repos,
    verified_impact_prs,
    pinned_repos,
    organizations,
    scoring: score(metrics),
  };
}

/**
 * Rebuild the contribution-derived portion of a scan from a durable complete
 * public-history aggregate. The score engine itself remains unchanged: this
 * function only replaces bounded collection input with the persisted full set.
 */
export function applyPublicContributionAggregate(
  scan: ScanResult,
  aggregates: ContribRepoAgg[],
  workflow: { total: number; impact: number },
): ScanResult {
  const loginLower = scan.metrics.username.toLowerCase();
  const impact = computeImpactFromContribMap(aggregates, loginLower);
  const quality = computeImpactQualitySignals(
    scan.recent_prs,
    impact.impact_pr_count,
    loginLower,
    workflow.impact,
  );
  const metrics = {
    ...scan.metrics,
    workflow_landed_pr_count: workflow.total,
    workflow_landed_impact_pr_count: workflow.impact,
    max_impact_repo_stars: impact.max_impact_repo_stars,
    impact_depth_raw: impact.impact_depth_raw,
    impact_repo_count: impact.impact_repo_count,
    impact_commit_count: impact.impact_commit_count,
    impact_pr_count: impact.impact_pr_count,
    ...quality,
    // A durable aggregate is only published after the graph path or the
    // default-branch REST recovery completes. Do not carry a quick-scan graph
    // failure marker into a complete snapshot.
    commit_contribution_aggregation_unavailable: false,
    merged_pr_contribution_aggregation_incomplete: false,
  };
  return {
    ...scan,
    metrics,
    impact_repos: impact.impact_repos,
    scoring: score(metrics),
  };
}

/**
 * Replace the bounded owner-repository inventory with a durable full inventory.
 * README hydration remains intentionally bounded by the worker before calling
 * this function; unhydrated projects still receive their conservative metadata
 * quality score instead of being treated as empty.
 */
export function applyPublicOriginalRepoInventory(
  scan: ScanResult,
  ownedRepos: TopRepo[],
): ScanResult {
  const attributed = scan.top_repos.filter((repo) => repo.attributed_original);
  const all = [
    ...new Map(
      [...ownedRepos, ...attributed].map((repo) => [
        (repo.name_with_owner ?? `${repo.owner_login ?? scan.metrics.username}/${repo.name}`).toLowerCase(),
        repo,
      ]),
    ).values(),
  ];
  const loginLower = scan.metrics.username.toLowerCase();
  const best = bestOriginalRepoQuality(all, loginLower);
  const topStarred = topStarredOriginalRepoQuality(all, loginLower);
  const metrics = {
    ...scan.metrics,
    fetched_repo_count: Math.max(scan.metrics.fetched_repo_count, ownedRepos.length),
    original_repo_count: all.length,
    nonempty_original_repo_count: all.filter((repo) => repo.size > 0).length,
    empty_original_repo_count: ownedRepos.filter((repo) => repo.size <= 0).length,
    total_stars: all.reduce((sum, repo) => sum + Math.max(0, repo.stars), 0),
    max_stars: all.reduce((max, repo) => Math.max(max, repo.stars), 0),
    best_original_repo_quality_score: best.score,
    best_original_repo_quality_repo: best.repo,
    top_starred_original_repo_quality_score: topStarred.score,
    top_starred_original_repo_quality_repo: topStarred.repo,
  };
  return {
    ...scan,
    metrics,
    top_repos: all.sort((a, b) => b.stars - a.stars || b.size - a.size).slice(0, 10),
    scoring: score(metrics),
  };
}

/** Maps a GitHub/scan error to the canonical `{ error, status }` used by the
 * scan + score routes, so both surface identical codes. */
export function scanErrorResponse(e: unknown): {
  error: string;
  status: number;
  retry_after?: number;
} {
  if (e instanceof GitHubAuthRequiredError) {
    return { error: "github_token_required", status: 500 };
  }
  if (e instanceof AccountNotFoundError) {
    return { error: "account_not_found", status: 404 };
  }
  if (e instanceof GitHubRateLimitError) {
    return { error: "github_rate_limited", status: 503 };
  }
  if (e instanceof GitHubDataUnavailableError) {
    return { error: "github_unavailable", status: 503, retry_after: 60 };
  }
  console.error("scan failed:", e);
  return { error: "scan_failed", status: 500 };
}
