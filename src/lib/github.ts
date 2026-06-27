/**
 * GitHub public-signal collection.
 *
 * Port of `collect()` from the canonical Python skill, with the `gh` CLI replaced
 * by direct REST + GraphQL `fetch` calls authenticated with an operator PAT
 * (`GITHUB_TOKEN`). Output mirrors the script's `metrics` / `top_repos` /
 * `recent_prs` shape exactly so the scoring port consumes it unchanged.
 */

import { logRatio } from "./score";
import type { RawMetrics, RecentPr, TopRepo } from "./types";

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
  email: string | null;
  bio: string | null;
  company: string | null;
  created_at: string;
  followers: number;
  following: number;
  public_repos: number;
}

export function normalizePublicEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const withoutScheme = raw.trim().replace(/^mailto:/i, "").split(/[?#]/, 1)[0];
  let email: string;
  try {
    email = decodeURIComponent(withoutScheme).trim().toLowerCase();
  } catch {
    email = withoutScheme.trim().toLowerCase();
  }
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return null;
  if (email.endsWith("@users.noreply.github.com")) return null;
  return email;
}

async function fetchProfileHomeEmail(username: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`https://github.com/${encodeURIComponent(username)}`, {
      headers: { "User-Agent": "github-roast" },
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const html = await res.text().catch(() => "");
  const mailto = html.match(/href=["']mailto:([^"'?#]+)(?:\?[^"']*)?["']/i);
  return normalizePublicEmail(mailto?.[1]);
}

export async function fetchPublicProfileEmail(
  username: string,
  restEmail?: string | null,
): Promise<string | null> {
  return normalizePublicEmail(restEmail) ?? fetchProfileHomeEmail(username);
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
}

async function fetchRecentPrs(username: string, count = 20): Promise<RecentPr[]> {
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
    };
  });
}

interface AnyPr {
  title: string;
  repo: string;
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

export async function collect(username: string): Promise<{
  metrics: RawMetrics;
  top_repos: TopRepo[];
  recent_prs: RecentPr[];
  flood_pr_titles: string[];
  profile_email: string | null;
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
      closedPRs: { totalCount: number };
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
        closedPRs: pullRequests(states: CLOSED) { totalCount }
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
  const closedUnmergedPrCount = contrib?.user?.closedPRs?.totalCount ?? 0;
  const issuesCreated = contrib?.user?.issues?.totalCount ?? 0;
  const decidedPrCount = mergedPrCount + closedUnmergedPrCount;
  const prRejectionRate =
    decidedPrCount > 0 ? Math.round((closedUnmergedPrCount / decidedPrCount) * 100) / 100 : 0;

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

  // Recent merged PRs (titles + diff size + target-repo stars)
  const recentPrs = await fetchRecentPrs(login);
  const trivialPrs = recentPrs.filter((p) => p.trivial).length;

  // Templated-PR flooding signal (recent PRs across all states) — only flags
  // flooding of OTHER people's repos (own-repo floods are normal solo work).
  const flood = computeFloodSignals(await fetchRecentAllPrs(login), loginLower);

  // Ecosystem & maintainer impact: substantial PRs into popular repos — others'
  // projects (≥200★) or the user's own genuinely popular repos (≥1000★).
  const impactPrs = recentPrs.filter((p) => isEcosystemImpactPr(p, loginLower));
  const maxImpactRepoStars = impactPrs.reduce((a, p) => Math.max(a, p.repo_stars), 0);
  const impactDepthRaw =
    Math.round(impactPrs.reduce((a, p) => a + logRatio(p.repo_stars, 5000), 0) * 100) /
    100;

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
    max_impact_repo_stars: maxImpactRepoStars,
    impact_pr_count: impactPrs.length,
    impact_depth_raw: impactDepthRaw,
    external_trivial_pr_count: externalTrivialPrCount,
    star_inflation_suspect: starInflationSuspect,
    closed_unmerged_pr_count: closedUnmergedPrCount,
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
    profile_email: await fetchPublicProfileEmail(login, user.email),
  };
}
