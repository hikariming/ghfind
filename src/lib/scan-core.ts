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
import type { PublicScanPrFact } from "@/lib/scan-run-types";
import type { ImpactRepo, RecentPr, ScanResult, SignatureWork, SignatureWorkCluster, TopRepo } from "@/lib/types";

const SIGNATURE_WORK_RE =
  /\b(fix|security|auth|credential|capabilit|boundary|bound|revoke|cleanup|retry|ledger|atomic|consistency|provenance|runtime|workflow|inference|metadata|lifecycle|parser|type inference|rustdoc|inlay|syntax)\b/i;
const PRESENTATION_OR_DOC_TITLE_RE =
  /\b(docs?|documentation|readme|typo|translate|translation|i18n|website|site|blog|examples?|templates?|tutorial|guide|manual|css|tailwind|style|styles|ui|ux)\b|homepage|home\s*page|media\s*quer/i;

function isSignatureQualityTitle(title: string): boolean {
  return SIGNATURE_WORK_RE.test(title) && !PRESENTATION_OR_DOC_TITLE_RE.test(title);
}

function signatureImpactRepos(impactRepos: ImpactRepo[] | undefined): ImpactRepo[] {
  return (impactRepos ?? [])
    .filter((repo) => repo.prs + repo.commits >= 2 || repo.stars >= 10_000)
    .sort((a, b) => b.prs * 4 + b.commits - (a.prs * 4 + a.commits) || b.stars - a.stars)
    .slice(0, 12);
}

function clusterSortScore(cluster: SignatureWorkCluster): number {
  return cluster.quality_keyword_hits * 3 + (cluster.all_time_prs ?? cluster.recent_merged_prs_in_sample ?? 0);
}

function addClusterExample(
  group: SignatureWorkCluster,
  title: string,
  important: boolean,
  max: number,
) {
  if (important) {
    group.examples = [title, ...group.examples.filter((example) => example !== title)].slice(0, max);
  } else if (group.examples.length < 2 && !group.examples.includes(title)) {
    group.examples.push(title);
  }
}

function buildClustersFromRecentPrs(recentPrs: RecentPr[]): SignatureWorkCluster[] {
  const groups = new Map<string, SignatureWorkCluster>();
  for (const pr of recentPrs) {
    if (!pr.repo) continue;
    const group =
      groups.get(pr.repo) ??
      {
        repo: pr.repo,
        stars: pr.repo_stars,
        recent_merged_prs_in_sample: 0,
        quality_keyword_hits: 0,
        examples: [],
      };
    group.recent_merged_prs_in_sample = (group.recent_merged_prs_in_sample ?? 0) + 1;
    group.stars = Math.max(group.stars, pr.repo_stars);
    const title = pr.title?.trim();
    if (title && isSignatureQualityTitle(title)) {
      group.quality_keyword_hits += 1;
      addClusterExample(group, title, true, 4);
    } else if (title) {
      addClusterExample(group, title, false, 4);
    }
    groups.set(pr.repo, group);
  }
  return [...groups.values()]
    .filter((group) => (group.recent_merged_prs_in_sample ?? 0) >= 3 || group.quality_keyword_hits >= 2)
    .sort((a, b) => clusterSortScore(b) - clusterSortScore(a) || b.stars - a.stars)
    .slice(0, 5);
}

function attachOrgContext(
  clusters: SignatureWorkCluster[],
  impactRepos: ImpactRepo[] | undefined,
  options: { allowSubstantiveLowStarSignal?: boolean } = {},
): SignatureWorkCluster[] {
  const byOwner = new Map<string, ImpactRepo>();
  for (const repo of impactRepos ?? []) {
    const owner = repo.repo.split("/", 1)[0]?.toLowerCase();
    if (!owner || repo.stars < 10_000) continue;
    const current = byOwner.get(owner);
    if (!current || repo.stars > current.stars) byOwner.set(owner, repo);
  }
  return clusters.map((cluster) => {
    const owner = cluster.repo.split("/", 1)[0]?.toLowerCase();
    const context = owner ? byOwner.get(owner) : undefined;
    const substantiveLowStarSignal =
      options.allowSubstantiveLowStarSignal === true &&
      cluster.stars < 200 &&
      ((cluster.all_time_prs ?? cluster.recent_merged_prs_in_sample ?? 0) >= 3) &&
      cluster.quality_keyword_hits >= 2;
    if (!context || context.repo.toLowerCase() === cluster.repo.toLowerCase()) {
      return {
        ...cluster,
        substantive_low_star_signal: substantiveLowStarSignal,
      };
    }
    return {
      ...cluster,
      org_context_repo: context.repo,
      org_context_stars: context.stars,
      substantive_low_star_signal: substantiveLowStarSignal,
    };
  });
}

function buildClustersFromPublicPrFacts(
  facts: PublicScanPrFact[],
  impactRepos: ImpactRepo[] | undefined,
): SignatureWorkCluster[] {
  const groups = new Map<string, SignatureWorkCluster>();
  for (const fact of facts) {
    if (!fact.repoKey || fact.isPrivate || fact.isFork) continue;
    const group =
      groups.get(fact.repoKey) ??
      {
        repo: fact.repoKey,
        stars: fact.stars,
        all_time_prs: 0,
        quality_keyword_hits: 0,
        examples: [],
      };
    group.all_time_prs = (group.all_time_prs ?? 0) + 1;
    group.stars = Math.max(group.stars, fact.stars);
    const title = fact.title?.trim();
    if (title && isSignatureQualityTitle(title)) {
      group.quality_keyword_hits += 1;
      addClusterExample(group, title, true, 5);
    } else if (title) {
      addClusterExample(group, title, false, 5);
    }
    groups.set(fact.repoKey, group);
  }
  const candidates = [...groups.values()]
    .filter((group) => (group.all_time_prs ?? 0) >= 5 || group.quality_keyword_hits >= 3);
  const clusters = candidates
    .sort((a, b) => clusterSortScore(b) - clusterSortScore(a) || b.stars - a.stars)
    .slice(0, 16);
  return attachOrgContext(clusters, impactRepos, { allowSubstantiveLowStarSignal: true });
}

export function buildRecentSignatureWork(scan: ScanResult): SignatureWork {
  return {
    impact_repo_representatives: signatureImpactRepos(scan.impact_repos),
    work_clusters: attachOrgContext(buildClustersFromRecentPrs(scan.recent_prs ?? []), scan.impact_repos),
    source: "recent_sample",
  };
}

export function buildPublicSignatureWork(
  impactRepos: ImpactRepo[] | undefined,
  prFacts: PublicScanPrFact[],
): SignatureWork {
  return {
    impact_repo_representatives: signatureImpactRepos(impactRepos),
    work_clusters: buildClustersFromPublicPrFacts(prFacts, impactRepos),
    source: "all_history_public_scan",
  };
}

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
  const scan = {
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
  return {
    ...scan,
    signature_work: buildRecentSignatureWork(scan),
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
  prFacts: PublicScanPrFact[] = [],
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
    impact_prestige_score: impact.impact_prestige_score,
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
    signature_work: prFacts.length
      ? buildPublicSignatureWork(impact.impact_repos, prFacts)
      : buildRecentSignatureWork({ ...scan, metrics, impact_repos: impact.impact_repos }),
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
