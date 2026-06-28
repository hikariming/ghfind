/**
 * GitHub public-signal collection.
 *
 * Port of `collect()` from the canonical Python skill, with the `gh` CLI replaced
 * by direct REST + GraphQL `fetch` calls authenticated with an operator PAT
 * (`GITHUB_TOKEN`). Output mirrors the script's `metrics` / `top_repos` /
 * `recent_prs` shape exactly so the scoring port consumes it unchanged.
 */

import { logRatio } from "./score";
import type { ImpactRepo, RawMetrics, RecentPr, TopRepo } from "./types";

const GITHUB_API = "https://api.github.com";

/** Raised when the requested account does not exist (404). */
export class AccountNotFoundError extends Error {}
/** Raised when GitHub rate-limits us (403/429 with rate-limit headers). */
export class GitHubRateLimitError extends Error {}

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-roast",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

interface RestRepo {
  name: string;
  fork: boolean;
  size: number;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  description: string | null;
  pushed_at: string | null;
}

interface RestUser {
  login: string;
  id: number;
  html_url: string;
  avatar_url: string | null;
  name: string | null;
  bio: string | null;
  company: string | null;
  created_at: string;
  followers: number;
  following: number;
  public_repos: number;
}

async function restGet<T>(path: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/${path}`, {
      headers: authHeaders(),
      // Edge/runtime caching is handled by our own Redis layer; skip Next cache.
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (res.status === 404) throw new AccountNotFoundError();
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") throw new GitHubRateLimitError();
    return null;
  }
  if (!res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null; // GraphQL requires auth
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const json = (await res.json()) as { data?: T };
    return json.data ?? null;
  } catch {
    return null;
  }
}

function parseTs(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function fetchReadmeExcerpt(
  owner: string,
  repo: string,
  limit = 400,
): Promise<string | null> {
  const data = await restGet<{ content?: string }>(
    `repos/${owner}/${repo}/readme`,
  ).catch(() => null);
  if (!data || !data.content) return null;
  try {
    const text = Buffer.from(data.content, "base64").toString("utf-8");
    return text.split(/\s+/).join(" ").slice(0, limit);
  } catch {
    return null;
  }
}

interface PrNode {
  title: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  repository: {
    nameWithOwner: string;
    stargazerCount: number;
    isPrivate: boolean;
  } | null;
  files?: { nodes: { path: string | null }[] | null } | null;
}

async function fetchRecentPrs(username: string, count = 50): Promise<RecentPr[]> {
  const data = await graphql<{
    user: { pullRequests: { nodes: PrNode[] } } | null;
  }>(
    `query($login: String!, $count: Int!) {
      user(login: $login) {
        pullRequests(first: $count, states: MERGED,
                     orderBy: {field: CREATED_AT, direction: DESC}) {
          nodes {
            title additions deletions changedFiles
            repository { nameWithOwner stargazerCount isPrivate }
            files(first: 50) { nodes { path } }
          }
        }
      }
    }`,
    { login: username, count },
  );
  const nodes = data?.user?.pullRequests?.nodes ?? [];
  return nodes.map((n): RecentPr => {
    const repo = n.repository;
    const churn = (n.additions ?? 0) + (n.deletions ?? 0);
    return {
      title: n.title,
      repo: repo?.nameWithOwner ?? null,
      repo_stars: repo?.stargazerCount ?? 0,
      churn,
      changed_files: n.changedFiles ?? 0,
      trivial: churn <= 5,
      files: (n.files?.nodes ?? []).map((f) => f.path).filter((p): p is string => Boolean(p)),
    };
  });
}

interface AnyPr {
  title: string;
  repo: string;
}

interface ClosedPrNode {
  author: { login: string } | null;
  repository: { owner: { login: string } | null } | null;
  timelineItems: {
    nodes: ({ actor: { login: string } | null } | null)[];
  } | null;
}

export interface ClosedPrBreakdown {
  closed_unmerged_pr_count: number;
  maintainer_closed_unmerged_pr_count: number;
  self_closed_external_pr_count: number;
  self_closed_own_repo_pr_count: number;
  unknown_closed_unmerged_pr_count: number;
}

export function computeClosedPrBreakdown(
  nodes: ClosedPrNode[],
  total: number,
  loginLower: string,
): ClosedPrBreakdown {
  let maintainerClosed = 0;
  let selfClosedExternal = 0;
  let selfClosedOwnRepo = 0;
  let unknownClosed = Math.max(0, total - nodes.length);

  for (const node of nodes) {
    const author = (node.author?.login ?? loginLower).toLowerCase();
    const repoOwner = node.repository?.owner?.login?.toLowerCase() ?? "";
    const actor = node.timelineItems?.nodes?.[0]?.actor?.login?.toLowerCase() ?? "";
    if (!actor) {
      unknownClosed += 1;
    } else if (actor === author || actor === loginLower) {
      if (repoOwner === loginLower) selfClosedOwnRepo += 1;
      else selfClosedExternal += 1;
    } else if (repoOwner === loginLower) {
      unknownClosed += 1;
    } else {
      maintainerClosed += 1;
    }
  }

  return {
    closed_unmerged_pr_count: total,
    maintainer_closed_unmerged_pr_count: maintainerClosed,
    self_closed_external_pr_count: selfClosedExternal,
    self_closed_own_repo_pr_count: selfClosedOwnRepo,
    unknown_closed_unmerged_pr_count: unknownClosed,
  };
}

/** Recent PRs across ALL states (for templated-flood detection). */
async function fetchRecentAllPrs(username: string, count = 30): Promise<AnyPr[]> {
  const data = await graphql<{
    user: { pullRequests: { nodes: { title: string | null; repository: { nameWithOwner: string } | null }[] } } | null;
  }>(
    `query($login: String!, $count: Int!) {
      user(login: $login) {
        pullRequests(first: $count, orderBy: {field: CREATED_AT, direction: DESC}) {
          nodes { title repository { nameWithOwner } }
        }
      }
    }`,
    { login: username, count },
  );
  const nodes = data?.user?.pullRequests?.nodes ?? [];
  return nodes
    .filter((n) => n.title && n.repository)
    .map((n) => ({ title: n.title as string, repo: n.repository!.nameWithOwner }));
}

export interface FloodSignals {
  recent_pr_sample: number;
  top_repo_pr_target: string | null;
  top_repo_pr_share: number;
  templated_pr_ratio: number;
  pr_flood_suspect: boolean;
  flood_pr_titles: string[];
}

/**
 * Detect "templated PR flooding": many recent PRs aimed at a single repo whose
 * titles share a long common prefix (e.g. one-day AI batches of
 * `refactor(api): migrate ___ to BaseModel`). Pure so it can be unit-tested.
 *
 * Only flags flooding of a repo the user does NOT own — blasting your own repo
 * with templated PRs is normal solo-dev work; spamming someone else's project is
 * the problem. Pass the lowercased login to enable that check.
 */
export function computeFloodSignals(prs: AnyPr[], loginLower = ""): FloodSignals {
  const sample = prs.length;
  if (sample === 0) {
    return {
      recent_pr_sample: 0,
      top_repo_pr_target: null,
      top_repo_pr_share: 0,
      templated_pr_ratio: 0,
      pr_flood_suspect: false,
      flood_pr_titles: [],
    };
  }

  // Most-targeted repo.
  const repoCounts = new Map<string, number>();
  for (const p of prs) repoCounts.set(p.repo, (repoCounts.get(p.repo) ?? 0) + 1);
  let topRepo: string | null = null;
  let topRepoCount = 0;
  for (const [repo, n] of repoCounts) {
    if (n > topRepoCount) {
      topRepo = repo;
      topRepoCount = n;
    }
  }
  const topRepoShare = Math.round((topRepoCount / sample) * 100) / 100;

  // Largest cluster of near-identical titles (first 18 normalized chars).
  const prefix = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 18);
  const titleClusters = new Map<string, string[]>();
  for (const p of prs) {
    const key = prefix(p.title);
    const arr = titleClusters.get(key) ?? [];
    arr.push(p.title);
    titleClusters.set(key, arr);
  }
  let biggest: string[] = [];
  for (const arr of titleClusters.values()) if (arr.length > biggest.length) biggest = arr;
  const templatedRatio = Math.round((biggest.length / sample) * 100) / 100;

  const topOwner =
    topRepo && topRepo.includes("/") ? topRepo.split("/", 1)[0].toLowerCase() : "";
  const topIsExternal = topOwner !== "" && topOwner !== loginLower;
  const suspect =
    sample >= 10 && topIsExternal && topRepoShare >= 0.5 && templatedRatio >= 0.5;

  return {
    recent_pr_sample: sample,
    top_repo_pr_target: topRepo,
    top_repo_pr_share: topRepoShare,
    templated_pr_ratio: templatedRatio,
    pr_flood_suspect: suspect,
    flood_pr_titles: biggest.slice(0, 5),
  };
}

/**
 * Whether a merged PR counts toward Ecosystem & Maintainer Impact (dimension 4).
 *
 * A substantial (non-trivial) PR qualifies if it lands in a popular repo, with a
 * higher bar for the user's OWN repos:
 *   - external repo (owner ≠ user): ≥200 stars — contributing to others is itself
 *     a trust signal;
 *   - own repo (owner = user):      ≥1000 stars — actively maintaining a genuinely
 *     popular project (e.g. a 30k-star repo you created) is high-value, unfakeable
 *     work. A low-star own repo does NOT count — that is the self-PR-farming
 *     pattern, penalized separately.
 */
export function isEcosystemImpactPr(pr: RecentPr, loginLower: string): boolean {
  const repo = pr.repo ?? "";
  const owner = repo.includes("/") ? repo.split("/", 1)[0].toLowerCase() : "";
  if (!owner || pr.trivial) return false;
  const threshold = owner === loginLower ? 1000 : 200;
  return pr.repo_stars >= threshold;
}

/**
 * Whether a merged PR is "garbage farming into a popular community project":
 * a trivial (≤5-line) PR into a repo the user does NOT own with ≥200 stars
 * (typo/whitespace PRs to famous repos to farm a contributor badge). PRs into
 * one's own repos never count — those are normal solo-dev work.
 */
export function isExternalTrivialFarmPr(pr: RecentPr, loginLower: string): boolean {
  const repo = pr.repo ?? "";
  const owner = repo.includes("/") ? repo.split("/", 1)[0].toLowerCase() : "";
  return owner !== "" && owner !== loginLower && pr.trivial && pr.repo_stars >= 200;
}

function repoName(nameWithOwner: string | null | undefined): string {
  const repo = nameWithOwner ?? "";
  return repo.includes("/") ? repo.split("/").pop()?.toLowerCase() ?? "" : repo.toLowerCase();
}

function isDocLikeRepo(nameWithOwner: string | null | undefined): boolean {
  const name = repoName(nameWithOwner);
  return (
    /(^|[-_.])(docs?|site|website|blog|examples?|templates?|profile|notebook|learning|tutorial|interview|guide|manual)([-_.]|$)/.test(
      name,
    ) || name.endsWith(".github.io")
  );
}

function isDocLikePath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    /\.(md|mdx|rst|adoc|txt)$/i.test(p) ||
    /(^|\/)(docs?|site|website|blog|content|articles|examples?|templates?|tutorials?|guides?|manual|i18n|locales?)(\/|$)/.test(
      p,
    ) ||
    /(^|\/)(readme|changelog|contributing|license)(\.[^/]*)?$/i.test(p)
  );
}

function isCoreCodePath(path: string): boolean {
  const p = path.toLowerCase();
  if (isDocLikePath(p)) return false;
  return /\.(c|cc|cpp|cs|go|java|js|jsx|kt|m|mm|php|py|rb|rs|scala|swift|ts|tsx)$/i.test(
    p,
  );
}

export function isDocLikeImpactPr(pr: RecentPr): boolean {
  if (isDocLikeRepo(pr.repo)) return true;
  const title = pr.title ?? "";
  if (/\b(docs?|readme|typo|translate|translation|i18n|website|site|blog|examples?|templates?|tutorial|guide)\b/i.test(title)) {
    return true;
  }

  const files = pr.files ?? [];
  if (files.length === 0) return false;
  const docLike = files.filter(isDocLikePath).length;
  const coreCode = files.filter(isCoreCodePath).length;
  return docLike > 0 && (coreCode === 0 || docLike / files.length >= 0.6);
}

export interface ImpactQualitySignals {
  verified_impact_pr_count: number;
  core_impact_pr_count: number;
  doc_like_impact_pr_count: number;
  unverified_impact_pr_count: number;
  impact_quality_cap?: number;
}

export function computeImpactQualitySignals(
  recentPrs: RecentPr[],
  impactPrCount: number,
  loginLower: string,
): ImpactQualitySignals {
  const verifiedImpactPrs = recentPrs.filter((p) => isEcosystemImpactPr(p, loginLower));
  const docLikeCount = verifiedImpactPrs.filter(isDocLikeImpactPr).length;
  const coreCount = verifiedImpactPrs.length - docLikeCount;
  const unverifiedCount = Math.max(0, impactPrCount - verifiedImpactPrs.length);

  let impactQualityCap: number | undefined;
  if (impactPrCount >= 10 && coreCount <= 2 && docLikeCount > coreCount) {
    impactQualityCap = 4;
  } else if (impactPrCount >= 10 && docLikeCount > coreCount) {
    impactQualityCap = 8;
  }

  return {
    verified_impact_pr_count: verifiedImpactPrs.length,
    core_impact_pr_count: coreCount,
    doc_like_impact_pr_count: docLikeCount,
    unverified_impact_pr_count: unverifiedCount,
    impact_quality_cap: impactQualityCap,
  };
}

/** One repo's all-time contribution aggregate, keyed by `nameWithOwner`. */
export interface ContribRepoAgg {
  repo: string;
  stars: number;
  is_private: boolean;
  is_fork: boolean;
  owner_login: string;
  commits: number;
  prs: number;
}

/** Derived ecosystem-impact metrics (the fields `score.ts` consumes plus extras). */
export interface ImpactMetrics {
  max_impact_repo_stars: number;
  impact_depth_raw: number;
  impact_quality_cap?: number;
  verified_impact_pr_count?: number;
  core_impact_pr_count?: number;
  doc_like_impact_pr_count?: number;
  unverified_impact_pr_count?: number;
  impact_repo_count: number;
  impact_commit_count: number;
  impact_pr_count: number;
  impact_repos: ImpactRepo[];
}

/** Cap how many recent years of the contribution graph we aggregate (latency). */
export const IMPACT_YEAR_CAP = 6;
/** Min landed commits for a repo to qualify on commits alone (avoids drive-bys). */
export const IMPACT_COMMIT_MIN = 2;

/**
 * Compute Ecosystem & Maintainer Impact from all-time per-repo contribution
 * aggregates (commits + PRs), instead of the recent-PR window. A repo qualifies
 * when it is popular enough (external ≥200★, the user's own ≥1000★ — same
 * thresholds as {@link isEcosystemImpactPr}) AND the user did real work in it
 * (≥{@link IMPACT_COMMIT_MIN} landed commits OR ≥1 PR). Private and fork repos
 * are excluded (a fork's star count is borrowed; pushing to it isn't impact).
 *
 * Pure so it can be unit-tested without network access.
 */
export function computeImpactFromContribMap(
  repos: ContribRepoAgg[],
  loginLower: string,
): ImpactMetrics {
  const qualifying = repos.filter((r) => {
    if (r.is_private || r.is_fork) return false;
    const isExternal = r.owner_login.toLowerCase() !== loginLower;
    const threshold = isExternal ? 200 : 1000;
    if (r.stars < threshold) return false;
    return r.commits >= IMPACT_COMMIT_MIN || r.prs >= 1;
  });

  const maxImpactRepoStars = qualifying.reduce((a, r) => Math.max(a, r.stars), 0);
  const impactDepthRaw =
    Math.round(
      qualifying.reduce((a, r) => {
        // Weight a repo by how much work landed there, so "17 PRs + many
        // commits" beats a single PR (the per-repo aggregate would otherwise
        // flatten that signal). Bounded so one mega-repo can't dominate.
        const weight = Math.min(1 + Math.log10(r.commits + r.prs), 2.5);
        return a + logRatio(r.stars, 5000) * weight;
      }, 0) * 100,
    ) / 100;

  const impactRepos: ImpactRepo[] = qualifying
    .map((r) => ({ repo: r.repo, stars: r.stars, commits: r.commits, prs: r.prs }))
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 8);

  return {
    max_impact_repo_stars: maxImpactRepoStars,
    impact_depth_raw: impactDepthRaw,
    impact_repo_count: qualifying.length,
    impact_commit_count: qualifying.reduce((a, r) => a + r.commits, 0),
    impact_pr_count: qualifying.reduce((a, r) => a + r.prs, 0),
    impact_repos: impactRepos,
  };
}

interface ContribByRepoNode {
  contributions: { totalCount: number };
  repository: {
    nameWithOwner: string;
    stargazerCount: number;
    isPrivate: boolean;
    isFork: boolean;
    owner: { login: string } | null;
  } | null;
}

interface YearContribs {
  commitContributionsByRepository: ContribByRepoNode[];
  pullRequestContributionsByRepository: ContribByRepoNode[];
}

/**
 * Fetch all-time per-repo commit + PR contributions by aliasing one
 * `contributionsCollection(from,to)` per year (GraphQL caps each to a 1-year
 * span), capped to the most recent {@link IMPACT_YEAR_CAP} years. Returns null
 * when unauthenticated (caller falls back to the recent-PR computation).
 */
async function fetchContribReposByYear(
  username: string,
  years: number[],
): Promise<ContribRepoAgg[] | null> {
  const capped = [...years].sort((a, b) => b - a).slice(0, IMPACT_YEAR_CAP);
  if (capped.length === 0) return null;

  const fragment = `fragment RepoContribs on ContributionsCollection {
    commitContributionsByRepository(maxRepositories: 100) {
      contributions { totalCount }
      repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
    }
    pullRequestContributionsByRepository(maxRepositories: 100) {
      contributions { totalCount }
      repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
    }
  }`;
  const varDecls = capped
    .map((_, i) => `$from${i}: DateTime!, $to${i}: DateTime!`)
    .join(", ");
  const aliases = capped
    .map((_, i) => `y${i}: contributionsCollection(from: $from${i}, to: $to${i}) { ...RepoContribs }`)
    .join("\n        ");
  const query = `query($login: String!, ${varDecls}) {
      user(login: $login) {
        ${aliases}
      }
    }
    ${fragment}`;

  const variables: Record<string, unknown> = { login: username };
  for (let i = 0; i < capped.length; i++) {
    variables[`from${i}`] = `${capped[i]}-01-01T00:00:00Z`;
    variables[`to${i}`] = `${capped[i]}-12-31T23:59:59Z`;
  }

  const data = await graphql<{ user: Record<string, YearContribs> | null }>(
    query,
    variables,
  );
  if (!data?.user) return null;

  // Merge per-year per-repo aggregates: sum commits/prs, take max stars.
  const map = new Map<string, ContribRepoAgg>();
  const ingest = (node: ContribByRepoNode, kind: "commits" | "prs"): void => {
    const repo = node.repository;
    if (!repo) return;
    const key = repo.nameWithOwner;
    const entry =
      map.get(key) ??
      {
        repo: key,
        stars: 0,
        is_private: repo.isPrivate,
        is_fork: repo.isFork,
        owner_login: repo.owner?.login ?? key.split("/", 1)[0],
        commits: 0,
        prs: 0,
      };
    entry.stars = Math.max(entry.stars, repo.stargazerCount ?? 0);
    entry[kind] += node.contributions?.totalCount ?? 0;
    map.set(key, entry);
  };
  for (let i = 0; i < capped.length; i++) {
    const yc = data.user[`y${i}`];
    if (!yc) continue;
    for (const n of yc.commitContributionsByRepository ?? []) ingest(n, "commits");
    for (const n of yc.pullRequestContributionsByRepository ?? []) ingest(n, "prs");
  }
  return [...map.values()];
}

export async function collect(username: string): Promise<{
  metrics: RawMetrics;
  top_repos: TopRepo[];
  recent_prs: RecentPr[];
  flood_pr_titles: string[];
  impact_repos: ImpactRepo[];
  verified_impact_prs: RecentPr[];
}> {
  const now = new Date();

  const user = await restGet<RestUser>(`users/${username}`);
  if (!user || user.id === undefined) {
    throw new AccountNotFoundError();
  }
  const login = user.login ?? username;
  const loginLower = login.toLowerCase();

  // Repositories (up to 200, newest activity first)
  const repos: RestRepo[] = [];
  for (const page of [1, 2]) {
    const chunk = await restGet<RestRepo[]>(
      `users/${username}/repos?per_page=100&sort=pushed&page=${page}`,
    );
    if (!chunk || chunk.length === 0) break;
    repos.push(...chunk);
    if (chunk.length < 100) break;
  }

  const original = repos.filter((r) => !r.fork);
  const forks = repos.filter((r) => r.fork);
  const empty = repos.filter((r) => (r.size ?? 0) === 0 && !r.fork);
  const nonemptyOriginal = original.filter((r) => (r.size ?? 0) > 0);

  const totalStars = original.reduce((a, r) => a + (r.stargazers_count ?? 0), 0);
  const maxStars = original.reduce(
    (a, r) => Math.max(a, r.stargazers_count ?? 0),
    0,
  );

  // PR / issue counts + contribution signals in a single GraphQL call.
  // Counts come from `pullRequests`/`issues` totalCount (5000-point/hr GraphQL
  // bucket) rather than the REST Search API (30/min) — Search was the binding
  // rate-limit bottleneck, so moving these off it raises sustained throughput.
  const contrib = await graphql<{
    user: {
      mergedPRs: { totalCount: number };
      allPRs: { totalCount: number };
      closedPRs: { totalCount: number; nodes: ClosedPrNode[] };
      issues: { totalCount: number };
      contributionsCollection: {
        totalCommitContributions: number;
        totalPullRequestContributions: number;
        totalIssueContributions: number;
        totalPullRequestReviewContributions: number;
        restrictedContributionsCount: number;
        contributionCalendar: { totalContributions: number };
      };
      contributionYears: { contributionYears: number[] };
    } | null;
  }>(
    `query($login: String!) {
      user(login: $login) {
        mergedPRs: pullRequests(states: MERGED) { totalCount }
        allPRs: pullRequests { totalCount }
        closedPRs: pullRequests(states: CLOSED, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
          totalCount
          nodes {
            author { login }
            repository { owner { login } }
            timelineItems(last: 1, itemTypes: CLOSED_EVENT) {
              nodes {
                ... on ClosedEvent {
                  actor { login }
                }
              }
            }
          }
        }
        issues { totalCount }
        contributionsCollection {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
          contributionCalendar { totalContributions }
        }
        contributionYears: contributionsCollection { contributionYears }
      }
    }`,
    { login: username },
  );
  const cc = contrib?.user?.contributionsCollection;
  const contributionYears = contrib?.user?.contributionYears?.contributionYears ?? [];
  const mergedPrCount = contrib?.user?.mergedPRs?.totalCount ?? 0;
  const totalPrCount = contrib?.user?.allPRs?.totalCount ?? 0;
  const closedPrBreakdown = computeClosedPrBreakdown(
    contrib?.user?.closedPRs?.nodes ?? [],
    contrib?.user?.closedPRs?.totalCount ?? 0,
    loginLower,
  );
  const issuesCreated = contrib?.user?.issues?.totalCount ?? 0;
  const decidedPrCount = mergedPrCount + closedPrBreakdown.maintainer_closed_unmerged_pr_count;
  const prRejectionRate =
    decidedPrCount > 0
      ? Math.round(
          (closedPrBreakdown.maintainer_closed_unmerged_pr_count / decidedPrCount) * 100,
        ) / 100
      : 0;

  const created = parseTs(user.created_at);
  const dayMs = 1000 * 60 * 60 * 24;
  const accountAgeYears = created
    ? Math.round(((now.getTime() - created.getTime()) / dayMs / 365.25) * 100) / 100
    : 0.0;

  // Most recent push across repos
  let lastPush: Date | null = null;
  for (const r of repos) {
    const ts = parseTs(r.pushed_at);
    if (ts && (lastPush === null || ts > lastPush)) lastPush = ts;
  }
  const daysSinceActive = lastPush
    ? Math.floor((now.getTime() - lastPush.getTime()) / dayMs)
    : null;

  const followers = user.followers ?? 0;
  const following = user.following ?? 0;

  const lastYearContributions = cc?.contributionCalendar?.totalContributions ?? 0;
  const activityTypes = cc
    ? (["totalCommitContributions", "totalPullRequestContributions", "totalIssueContributions", "totalPullRequestReviewContributions"] as const).filter(
        (k) => (cc[k] ?? 0) > 0,
      ).length
    : 0;

  const topRepos: TopRepo[] = original
    .map((r) => ({
      name: r.name,
      stars: r.stargazers_count ?? 0,
      forks: r.forks_count ?? 0,
      open_issues: r.open_issues_count ?? 0,
      language: r.language,
      description: r.description,
    }))
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 10);

  // README excerpts for the top original repos (capped to limit API calls)
  await Promise.all(
    topRepos.slice(0, 4).map(async (repo) => {
      if (repo.stars > 0 || repo.name) {
        repo.readme_excerpt = await fetchReadmeExcerpt(login, repo.name);
      }
    }),
  );

  // Recent merged PRs (titles + diff size + target-repo stars). Keep the public
  // report sample at 50, but use a wider window to verify older popular-repo PRs
  // before applying impact-quality caps.
  const recentPrWindow = await fetchRecentPrs(login, 100);
  const recentPrs = recentPrWindow.slice(0, 50);
  const trivialPrs = recentPrs.filter((p) => p.trivial).length;
  const docLikePrCount = recentPrs.filter(isDocLikeImpactPr).length;
  const docLikePrRatio =
    recentPrs.length > 0 ? Math.round((docLikePrCount / recentPrs.length) * 100) / 100 : 0;

  // Templated-PR flooding signal (recent PRs across all states) — only flags
  // flooding of OTHER people's repos (own-repo floods are normal solo work).
  const flood = computeFloodSignals(await fetchRecentAllPrs(login), loginLower);

  // Ecosystem & maintainer impact: substantial work (PRs + landed commits) into
  // popular repos — others' projects (≥200★) or the user's own genuinely popular
  // repos (≥1000★). Computed from all-time per-repo contribution aggregates so
  // old high-value work (e.g. apache/flink commits) still counts; falls back to
  // the recent-PR window when unauthenticated (no GraphQL).
  const contribRepos = await fetchContribReposByYear(login, contributionYears);
  let impact: ImpactMetrics;
  if (contribRepos) {
    impact = computeImpactFromContribMap(contribRepos, loginLower);
  } else {
    const impactPrs = recentPrs.filter((p) => isEcosystemImpactPr(p, loginLower));
    impact = {
      max_impact_repo_stars: impactPrs.reduce((a, p) => Math.max(a, p.repo_stars), 0),
      impact_depth_raw:
        Math.round(
          impactPrs.reduce((a, p) => a + logRatio(p.repo_stars, 5000), 0) * 100,
        ) / 100,
      impact_repo_count: impactPrs.length,
      impact_commit_count: 0,
      impact_pr_count: impactPrs.length,
      impact_repos: [],
    };
  }
  const impactQuality = computeImpactQualitySignals(
    recentPrWindow,
    impact.impact_pr_count,
    loginLower,
  );
  const verifiedImpactPrs = recentPrWindow
    .filter((p) => isEcosystemImpactPr(p, loginLower))
    .slice(0, 12)
    .map((p) => ({
      ...p,
      title: p.title?.slice(0, 200) ?? null,
      files: (p.files ?? []).slice(0, 20),
    }));
  impact = { ...impact, ...impactQuality };
  const maxImpactRepoStars = impact.max_impact_repo_stars;
  const impactDepthRaw = impact.impact_depth_raw;

  // Garbage farming into popular community projects: trivial PRs into others'
  // ≥200★ repos. (PRs into one's OWN repos are never penalized.)
  const externalTrivialPrCount = recentPrs.filter((p) =>
    isExternalTrivialFarmPr(p, loginLower),
  ).length;

  // Star-inflation signal: notable stars but almost no forks/issues engagement
  let starInflationSuspect = false;
  if (topRepos.length > 0 && topRepos[0].stars >= 100) {
    const top = topRepos[0];
    const forksPer100 = top.forks / (top.stars / 100);
    if (forksPer100 < 1.0 && top.open_issues <= 1) starInflationSuspect = true;
  }

  const metrics: RawMetrics = {
    username: login,
    profile_url: user.html_url,
    avatar_url: user.avatar_url,
    name: user.name,
    bio: user.bio,
    company: user.company,
    account_age_years: accountAgeYears,
    created_at: user.created_at,
    followers,
    following,
    public_repos: user.public_repos ?? 0,
    fetched_repo_count: repos.length,
    original_repo_count: original.length,
    nonempty_original_repo_count: nonemptyOriginal.length,
    fork_repo_count: forks.length,
    empty_original_repo_count: empty.length,
    total_stars: totalStars,
    max_stars: maxStars,
    merged_pr_count: mergedPrCount,
    total_pr_count: totalPrCount,
    issues_created: issuesCreated,
    last_year_contributions: lastYearContributions,
    activity_type_count: activityTypes,
    contribution_years_active: contributionYears.length,
    days_since_last_activity: daysSinceActive,
    recent_merged_pr_sample: recentPrs.length,
    recent_trivial_pr_count: trivialPrs,
    recent_doc_like_pr_count: docLikePrCount,
    recent_doc_like_pr_ratio: docLikePrRatio,
    max_impact_repo_stars: maxImpactRepoStars,
    impact_pr_count: impact.impact_pr_count,
    impact_depth_raw: impactDepthRaw,
    impact_quality_cap: impact.impact_quality_cap,
    verified_impact_pr_count: impact.verified_impact_pr_count,
    core_impact_pr_count: impact.core_impact_pr_count,
    doc_like_impact_pr_count: impact.doc_like_impact_pr_count,
    unverified_impact_pr_count: impact.unverified_impact_pr_count,
    impact_repo_count: impact.impact_repo_count,
    impact_commit_count: impact.impact_commit_count,
    external_trivial_pr_count: externalTrivialPrCount,
    star_inflation_suspect: starInflationSuspect,
    closed_unmerged_pr_count: closedPrBreakdown.closed_unmerged_pr_count,
    maintainer_closed_unmerged_pr_count:
      closedPrBreakdown.maintainer_closed_unmerged_pr_count,
    self_closed_external_pr_count: closedPrBreakdown.self_closed_external_pr_count,
    self_closed_own_repo_pr_count: closedPrBreakdown.self_closed_own_repo_pr_count,
    unknown_closed_unmerged_pr_count: closedPrBreakdown.unknown_closed_unmerged_pr_count,
    pr_rejection_rate: prRejectionRate,
    recent_pr_sample: flood.recent_pr_sample,
    top_repo_pr_target: flood.top_repo_pr_target,
    top_repo_pr_share: flood.top_repo_pr_share,
    templated_pr_ratio: flood.templated_pr_ratio,
    pr_flood_suspect: flood.pr_flood_suspect,
  };

  return {
    metrics,
    top_repos: topRepos,
    recent_prs: recentPrs,
    flood_pr_titles: flood.flood_pr_titles,
    impact_repos: impact.impact_repos,
    verified_impact_prs: verifiedImpactPrs,
  };
}
