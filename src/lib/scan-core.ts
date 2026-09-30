import { ScanBusyError } from "./scan-protection";
import {
  AccountNotFoundError,
  GitHubAuthRequiredError,
  GitHubDataUnavailableError,
  GitHubRateLimitError,
  GitHubInternalQueryError,
  GitHubResourceLimitError,
  GitHubQueryTimeoutError,
  collect,
} from "@/lib/github";
import type { PublicScanPrFact } from "@/lib/scan-run-types";
import type { ImpactRepo, RecentPr, ScanResult, SignatureWork, SignatureWorkCluster } from "@/lib/types";

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

/** Copy the display-only Go-era side channels into a signature-work block. */
function attachDisplayOnlyWork(work: SignatureWork, scan: DisplayScan): SignatureWork {
  if (scan.organization_maintained_repos?.length) {
    work.organization_maintained_repos = scan.organization_maintained_repos;
  }
  if (scan.estimated_contribution_languages) {
    work.estimated_contribution_languages = scan.estimated_contribution_languages;
  }
  return work;
}

export function buildRecentSignatureWork(scan: DisplayScan): SignatureWork {
  return attachDisplayOnlyWork(
    {
      impact_repo_representatives: signatureImpactRepos(scan.impact_repos),
      work_clusters: attachOrgContext(buildClustersFromRecentPrs(scan.recent_prs ?? []), scan.impact_repos),
      source: "recent_sample",
    },
    scan,
  );
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

/** A collected scan before devscore has scored it: display/roast evidence only. */
export type DisplayScan = Omit<ScanResult, "scoring" | "devscore">;

/**
 * Display and roast evidence for one account via ghfind's bounded `collect()`.
 * Its RawMetrics never feed a score: the score comes only from the background
 * devscore job (`advanceDevscoreJob`), which merges this data into the
 * published ScanResult.
 */
export async function buildDisplayScan(username: string): Promise<DisplayScan> {
  const collected = await collect(username);
  return { ...collected, signature_work: buildRecentSignatureWork(collected) };
}

/** Maps a GitHub/scan error to the canonical `{ error, status }` used by the
 * scan + score routes, so both surface identical codes. */
export function scanErrorResponse(e: unknown): {
  error: string;
  status: number;
  retry_after?: number;
} {
  if (e instanceof ScanBusyError) {
    return { error: "scan_busy", status: 503, retry_after: 15 };
  }
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
  console.error("scan failed", { category: "unexpected" });
  return { error: "scan_failed", status: 500 };
}

/** Log before legacy fallback can turn a failed fresh scan into HTTP 200.
 * Only allowlisted categories and a normalized public login leave this boundary;
 * never serialize the error, request headers, or upstream response text.
 */
export function logFreshScanFailure(error: unknown, context: {
  route: "scan" | "score";
  username: string;
  persistenceFailure: boolean;
}): void {
  const category = context.persistenceFailure ? "score_persistence"
    : error instanceof GitHubInternalQueryError ? "github_internal"
    : error instanceof GitHubResourceLimitError ? "github_resource_limit"
    : error instanceof GitHubQueryTimeoutError ? "github_query_timeout"
    : error instanceof GitHubRateLimitError ? "github_rate_limited"
    : error instanceof GitHubAuthRequiredError ? "github_token_required"
    : error instanceof AccountNotFoundError ? "account_not_found"
    : error instanceof GitHubDataUnavailableError ? "github_unavailable"
    : error instanceof ScanBusyError ? "scan_busy"
    : "unexpected";
  console.error("fresh_scan_failed", {
    route: context.route,
    username: /^[a-z0-9-]{1,39}$/i.test(context.username) ? context.username : "invalid",
    category,
  });
}
