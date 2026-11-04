import { presentationSignals, prPresentationShare } from "./presentation-concentration";
import { coCreatorShare, projectShare, budgetCoCreatorShares, summarizeContributors, weightedCoreChurn, RECENT_MAINTENANCE_DAYS, type CoCreatorFacts, type ContributorRow } from "./co-creator";
/**
 * GitHub public-signal collection.
 *
 * Port of `collect()` from the canonical Python skill, with the `gh` CLI replaced
 * by direct REST + GraphQL `fetch` calls authenticated with an operator PAT
 * (`GITHUB_TOKEN`). Output mirrors the script's `metrics` / `top_repos` /
 * `recent_prs` shape exactly so the scoring port consumes it unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { logRatio, starEngagementMultiplier, originalProjectQuality } from "./score";
import type {
  EstimatedContributionLanguages,
  ImpactRepo,
  OrganizationMaintainedRepo,
  RawMetrics,
  ReadmeFeatures,
  RecentPr,
  RepoReadme,
  TopRepo,
} from "./types";
import type { PublicScanOwnedRepoFact, PublicScanPrFact } from "./scan-run-types";
import { cursorBeforeWatermark, mergeInventoryRepos, type CursorRepo } from "./scan-cursor";
// Pure evidence->metrics derivation lives in the public @ghfind/scoring module.
import { DOC_RESOURCE_IMPACT_MIN_STARS, IMPACT_CODE_SAMPLE_SIZE, addMonth, aggregateMergedPrNodes, applyImpactCodeSamples, applyImpactRepoSignals, applyOwnRepoCommunities, bestOriginalRepoQuality, boundedContributionYearsActive, computeClosedPrBreakdown, computeFloodSignals, computeImpactFromContribMap, computeImpactQualitySignals, computeOrgRepoAttribution, computeOwnRepoCommunityFacts, contentSkillShare, contentSkillSignals, hasAttributedCreatorStarCredit, hasStrongLongTermOrgContribution, highStarPrShare, impactCodeSample, isCommunityBot, isDocLikeImpactPr, isDocLikeRepo, isDocOrResourceRepo, isEcosystemImpactPr, isExternalTrivialFarmPr, isProfileReadmeRepo, isWorkflowLandedPr, ownPrCommunityShare, parseReadmeFeatures, parseTs, passesImpactRepoGates, repoDisplayName, repoOwner, sortedMonths, topStarredOriginalRepoQuality, weightedOriginalStars } from "@ghfind/scoring/extract";
import type { AnyPr, ClosedPrNode, CommunityContributor, CommunityIssueSample, CommunityPrSample, CommunityProfile, ContribRepoAgg, ImpactCodeSample, ImpactRepoSignal, MergedPrRepoNode, OrgRepoAttribution, OwnRepoCommunityFacts, OwnRepoCommunityRaw, WorkflowLandedPrNode } from "@ghfind/scoring/extract";
export { applyOwnRepoCommunities, bestOriginalRepoQuality, boundedContributionYearsActive, computeClosedPrBreakdown, computeImpactFromContribMap, computeImpactQualitySignals, computeOwnRepoCommunityFacts, contentSkillSignals, isEcosystemImpactPr, isProfileReadmeRepo, ownPrCommunityShare, ownRepoCommunity, topStarredOriginalRepoQuality, weightedOriginalStars } from "@ghfind/scoring/extract";
export type { ContribRepoAgg, OwnRepoCommunityContext, OwnRepoCommunityFacts, OwnRepoCommunityRaw } from "@ghfind/scoring/extract";

const GITHUB_API = "https://api.github.com";
const README_FETCH_LIMIT = 1024 * 1024;

/** Raised when the requested account does not exist (404). */
export class AccountNotFoundError extends Error {}
/** Raised when scoring was requested for a GitHub organization, not a person. */
export class OrganizationNotSupportedError extends Error {}
/** Raised when GitHub rate-limits us (403/429 with rate-limit headers). */
export class GitHubRateLimitError extends Error {}
/** Raised when the app cannot collect GraphQL-only scoring dimensions safely. */
export class GitHubAuthRequiredError extends Error {}
export class GitHubDataUnavailableError extends Error {}
/** GitHub rejected the query because resolving it exceeded its per-query
 * resource budget (errors[].type RESOURCE_LIMITS_EXCEEDED). Data-dependent, not
 * transient: hyperactive accounts hit it deterministically, so callers should
 * degrade the query rather than retry it. */
export class GitHubResourceLimitError extends GitHubDataUnavailableError {}

/** An oversized query can hit GitHub's gateway timeout before returning JSON. */
export class GitHubQueryTimeoutError extends GitHubDataUnavailableError {}

/** Interactive collect() hit its wall-clock budget. Distinct from a GitHub
 *  gateway 502/504 so callers must not split/retry the same oversized query. */
export class GitHubCollectDeadlineError extends GitHubDataUnavailableError {}

/** Homepage /api/scan and /api/score live-crawls must finish before Cloudflare's
 *  ~100s 524. Leave room for persist + JSON after this budget. */
export const COLLECT_DEADLINE_MS = 45_000;

const collectSignalContext = new AsyncLocalStorage<AbortSignal>();

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error.name === "AbortError" || error.name === "TimeoutError"),
  );
}

function rethrowIfAborted(error: unknown): void {
  if (isAbortError(error) || error instanceof GitHubCollectDeadlineError) throw error;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

function collectSignal(): AbortSignal | undefined {
  return collectSignalContext.getStore();
}

function githubRequestSignal(init?: RequestInit): AbortSignal {
  const context = collectSignal();
  if (init?.signal && context && init.signal !== context) {
    return AbortSignal.any([init.signal, context]);
  }
  return init?.signal ?? context ?? new AbortController().signal;
}

/** Bound GitHub fetches in this async tree. Used by homepage scoring. */
export async function withCollectDeadline<T>(deadlineMs: number, run: () => Promise<T>): Promise<T> {
  const parent = collectSignalContext.getStore();
  const timeout = AbortSignal.timeout(Math.max(0, deadlineMs));
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
  const deadlineError = () =>
    new GitHubCollectDeadlineError("GitHub collection exceeded the interactive deadline.");
  return collectSignalContext.run(signal, async () => {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<T>((_, reject) => {
      onAbort = () => reject(deadlineError());
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([run(), aborted]);
    } catch (error) {
      if (error instanceof GitHubCollectDeadlineError) throw error;
      if (signal.aborted || isAbortError(error)) throw deadlineError();
      throw error;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  });
}

function swallowUnlessAborted(error: unknown): null {
  rethrowIfAborted(error);
  return null;
}

/** GitHub failed the whole response with `errors[].type = INTERNAL` while
 *  resolving one node (observed on `["user","closedPRs","nodes",N]`). The
 *  offending node is data-dependent and fails deterministically for that
 *  account, so callers must degrade the offending field rather than retry. */
export class GitHubInternalQueryError extends GitHubDataUnavailableError {}

// SDK overrides belong to one async collection, never to the process environment.
const githubTokenContext = new AsyncLocalStorage<string>();

export function withGithubToken<T>(token: string, run: () => T): T {
  return githubTokenContext.run(token, run);
}

/** The GitHub PAT pool. `GITHUB_TOKEN` may hold a single token or a
 *  comma-separated list (`ghp_a,ghp_b,ghp_c`); each token multiplies the
 *  5000-point/hr GraphQL ceiling. Read at call time (not module load) so scripts
 *  populating env via `_env.mjs` and tests mutating `process.env` still work. */
export function githubTokens(): string[] {
  return (githubTokenContext.getStore() ?? process.env.GITHUB_TOKEN ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Whether at least one PAT is configured — replaces the ad-hoc
 *  `process.env.GITHUB_TOKEN` presence guards. */
export function hasGithubToken(): boolean {
  return githubTokens().length > 0;
}

// Round-robin cursor, local to this isolate. Concurrent invocations are the
// backend workers: each one reserves its own offset, and a random start keeps
// a fresh burst from all landing on the first token. Retries of one request
// still walk distinct tokens.
let rrIndex = Math.floor(Math.random() * 1_000_003);
function nextOffset(): number {
  return rrIndex++;
}
/** Next token in round-robin order, or undefined when the pool is empty. Used by
 *  callers that don't rotate on failure (e.g. `authHeaders()` defaults). */
function pickToken(): string | undefined {
  const tokens = githubTokens();
  if (tokens.length === 0) return undefined;
  return tokens[nextOffset() % tokens.length];
}

function authHeaders(token = pickToken()): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ghfind",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** A response a *different* token might serve successfully, so ghFetch should
 *  fail over rather than surface it:
 *   - 429, or 403 with the quota drained / a Retry-After (primary or secondary
 *     rate limit) — another token has its own budget;
 *   - 401 (bad/expired token) — the picked PAT is rejected; another may be live;
 *   - any 5xx (GitHub GraphQL intermittently 502s) — transient.
 *  404 and scope-style 403s (no rate-limit signal) are definitive per-resource,
 *  identical across tokens — never retried. */
function retryable(res: Response): boolean {
  if (res.status === 429 || res.status === 401 || res.status >= 500) return true;
  if (res.status === 403) {
    return (
      res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")
    );
  }
  return false;
}

const RETRY_BACKOFF_MS = [250, 500, 1000];
const MAX_RETRY_AFTER_MS = 2000; // don't stall a serverless invocation waiting

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const ctx = signal ?? collectSignal();
  if (!ctx) return new Promise((resolve) => setTimeout(resolve, ms));
  if (ctx.aborted) throw abortReason(ctx);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ctx.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(ctx));
    };
    ctx.addEventListener("abort", onAbort, { once: true });
  });
}

/** Centralized GitHub fetch: attaches a round-robin token, and on a retryable
 *  response (rate-limit / transient 5xx) fails over to the next token with
 *  backoff. Callers interpret the *final* Response exactly as before, so the
 *  same errors surface — but only once the whole pool is genuinely exhausted. */
export async function ghFetch(
  url: string,
  init: RequestInit = {},
  options: { splitOnTimeout?: boolean } = {},
): Promise<Response> {
  const tokens = githubTokens();
  // Single-token deploys still get one retry (helps transient 502s); multi-token
  // pools rotate through every token, capped so a full outage can't spin.
  const attempts = Math.min(Math.max(tokens.length, 2), 4);
  // Reserve one base offset for this request; attempt i uses tokens[(base+i)%n].
  // This keeps a request's own retries on distinct tokens regardless of what
  // concurrent requests do to the shared cursor.
  const base = nextOffset();
  const signal = githubRequestSignal(init);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const token = tokens.length ? tokens[(base + i) % tokens.length] : undefined;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...authHeaders(token), ...(init.headers ?? {}) },
        cache: "no-store",
        // Next deduplicates GETs by teeing their bodies even with no-store.
        // Cancelling our branch then waits forever for its retained twin.
        // An explicit signal opts this independently managed request out of
        // deduplication, so failed bodies can be fully released before retry.
        signal,
      });
    } catch (e) {
      lastErr = e;
      if (isAbortError(e) || signal.aborted) throw isAbortError(e) ? e : abortReason(signal);
      if (i < attempts - 1) {
        await sleep(RETRY_BACKOFF_MS[i] ?? 1000, signal);
        continue;
      }
      throw e;
    }
    // Failed responses are never consumed by callers. Release their connection
    // before retrying: Workers only allow a small number of in-flight bodies.
    if (!res.ok) await res.body?.cancel().catch(() => undefined);
    if (options.splitOnTimeout && (res.status === 502 || res.status === 504)) return res;
    if (retryable(res) && i < attempts - 1) {
      if (signal.aborted) throw abortReason(signal);
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
          : (RETRY_BACKOFF_MS[i] ?? 1000);
      await sleep(wait, signal);
      continue;
    }
    return res;
  }
  // Unreachable: the loop returns or throws on the last attempt.
  throw lastErr ?? new GitHubDataUnavailableError("GitHub request failed.");
}

interface RestRepo {
  /** GitHub numeric repository id. Present on the GraphQL inventory path. */
  id?: string;
  name: string;
  full_name?: string;
  private?: boolean;
  fork: boolean;
  size: number;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  description: string | null;
  pushed_at: string | null;
  owner?: { login?: string; type?: string } | null;
  // Topics are returned by default on the modern REST repos endpoint; absent on
  // older proxies, so optional. A high-signal official domain label.
  topics?: string[];
}

interface RestRelease {
  author?: { login?: string | null } | null;
  tag_name?: string | null;
}

interface RestTag {
  name?: string;
  commit?: { sha?: string | null } | null;
}

interface RestCommit {
  author?: { login?: string | null } | null;
  committer?: { login?: string | null } | null;
}

interface RestReadme {
  path?: string;
  sha?: string;
  size?: number;
  html_url?: string | null;
  download_url?: string | null;
  content?: string;
  encoding?: string;
}

interface RestUser {
  login: string;
  id: number;
  type?: string;
  node_id?: string;
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

interface RestPublicEvent {
  created_at?: string | null;
}

async function restGet<T>(path: string): Promise<T | null> {
  let res: Response;
  try {
    // Edge/runtime caching is handled by our own Redis layer; skip Next cache
    // (ghFetch already sets cache: "no-store"). ghFetch rotates tokens + retries.
    res = await ghFetch(`${GITHUB_API}/${path}`);
  } catch (error) {
    rethrowIfAborted(error);
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

// The existing quick bounds are shared with escalation, never tuned per user.
export const QUICK_REPO_PAGES = 2;
export const GITHUB_PAGE_SIZE = 100;
export const MERGED_PR_WINDOW = 300;
const WORKFLOW_CANDIDATE_CAP = 25;

interface CollectionScope {
  full?: boolean;
  note: (reason: string) => void;
}

interface OriginalInventoryNode {
  databaseId?: number | null;
  name: string; nameWithOwner: string; isFork: boolean; diskUsage: number;
  stargazerCount: number; forkCount: number; description: string | null; pushedAt: string | null;
  primaryLanguage: { name: string } | null;
  issues: { totalCount: number };
  openPullRequests?: { totalCount: number };
  repositoryTopics: { nodes: { topic: { name: string } }[] };
}

export interface OriginalInventoryOptions {
  /** Full public inventory. Ignores the quick page cap and any watermark. */
  full?: boolean;
  /**
   * Newest stored `pushedAt`. Pages stop once a repo is strictly older.
   * Same-second siblings are kept. GraphQL `endCursor` is not a resume token.
   * Empty means the existing full or quick page.
   */
  since?: string;
}

/** Server-side fork exclusion; owner-only REST still includes forks. */
export async function fetchOriginalInventory(
  username: string,
  fullOrOptions: boolean | OriginalInventoryOptions = false,
): Promise<{
  repos: RestRepo[]; forks: number; incomplete: boolean;
}> {
  const options: OriginalInventoryOptions = typeof fullOrOptions === "boolean"
    ? { full: fullOrOptions }
    : fullOrOptions;
  const full = options.full === true;
  const since = options.since?.trim() ?? "";
  const incremental = since.length > 0 && !full;
  const repos: RestRepo[] = [];
  let after: string | null = null;
  let forks = 0;
  for (let page = 0; full || incremental || page < QUICK_REPO_PAGES; page++) {
    const data: { user: { forks: { totalCount: number }; repositories: {
      nodes: OriginalInventoryNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null };
    } } | null } = await graphql(`query OriginalInventory($login: String!, $after: String, $count: Int!) {
      user(login: $login) {
        forks: repositories(first: 1, privacy: PUBLIC, ownerAffiliations: [OWNER], isFork: true) { totalCount }
        repositories(first: $count, after: $after, privacy: PUBLIC, ownerAffiliations: [OWNER], isFork: false,
          orderBy: {field: PUSHED_AT, direction: DESC}) {
          nodes { databaseId name nameWithOwner isFork diskUsage stargazerCount forkCount description pushedAt
            primaryLanguage { name } issues(states: OPEN) { totalCount }
            openPullRequests: pullRequests(states: OPEN) { totalCount }
            repositoryTopics(first: 20) { nodes { topic { name } } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`, { login: username, after, count: GITHUB_PAGE_SIZE });
    if (!data.user?.repositories || !data.user.forks) throw new GitHubDataUnavailableError("GitHub original inventory unavailable.");
    forks = data.user.forks.totalCount;
    const connection = data.user.repositories;
    const pageRepos: RestRepo[] = [];
    for (const node of connection.nodes) {
      if (node.isFork) continue;
      pageRepos.push({
        id: node.databaseId != null && Number.isFinite(node.databaseId) ? String(node.databaseId) : undefined,
        name: node.name, full_name: node.nameWithOwner, fork: false, size: node.diskUsage,
        stargazers_count: node.stargazerCount, forks_count: node.forkCount, description: node.description,
        pushed_at: node.pushedAt, language: node.primaryLanguage?.name ?? null,
        // Match REST open_issues_count, which includes open PRs.
        open_issues_count: node.issues.totalCount + (node.openPullRequests?.totalCount ?? 0), topics: node.repositoryTopics.nodes.map(n => n.topic.name) });
    }
    if (incremental) {
      // Equal timestamps stay. The merge dedupes by repo id, so a second
      // item pushed in the same second is not dropped.
      let stopped = false;
      for (const repo of pageRepos) {
        if (cursorBeforeWatermark(repo.pushed_at, since)) {
          stopped = true;
          continue;
        }
        repos.push(repo);
      }
      if (stopped || !connection.pageInfo.hasNextPage) return { repos, forks, incomplete: false };
    } else {
      repos.push(...pageRepos);
      if (!connection.pageInfo.hasNextPage) return { repos, forks, incomplete: false };
    }
    const cursor = connection.pageInfo.endCursor;
    if (!connection.nodes.length || !cursor || cursor === after) throw new GitHubDataUnavailableError("GitHub original inventory cursor made no progress.");
    after = cursor;
  }
  return { repos, forks, incomplete: true };
}

function restRepoToCursor(repo: RestRepo): CursorRepo | null {
  const fullName = repo.full_name?.trim() || repo.name;
  if (!repo.id?.trim() && !fullName) return null;
  return {
    id: repo.id?.trim() ?? "",
    name: repo.name,
    fullName,
    size: repo.size ?? 0,
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    openIssues: repo.open_issues_count ?? 0,
    description: repo.description ?? null,
    pushedAt: repo.pushed_at ?? null,
    language: repo.language ?? null,
    topics: repo.topics ?? [],
  };
}

function cursorRepoToRest(repo: CursorRepo): RestRepo {
  return {
    id: repo.id || undefined,
    name: repo.name,
    full_name: repo.fullName,
    fork: false,
    size: repo.size,
    stargazers_count: repo.stars,
    forks_count: repo.forks,
    open_issues_count: repo.openIssues,
    language: repo.language,
    description: repo.description,
    pushed_at: repo.pushedAt,
    topics: repo.topics,
  };
}

/**
 * Incremental inventory upserts the delta into the previous page and keeps
 * the last full fork total. A full or unwatermarked pull uses the page as-is.
 * Deletes wait for the next full reconcile.
 */
function mergeInventoryBaseline(
  page: { repos: RestRepo[]; forks: number },
  baseline: { repos: CursorRepo[]; forkCount: number } | undefined,
  since: string,
): { repos: RestRepo[]; forks: number } {
  if (!since || !baseline) return page;
  const delta = page.repos.flatMap((repo) => {
    const cursor = restRepoToCursor(repo);
    return cursor ? [cursor] : [];
  });
  const merged = mergeInventoryRepos(baseline.repos, delta);
  return {
    repos: merged.map(cursorRepoToRest),
    forks: baseline.forkCount > 0 ? baseline.forkCount : page.forks,
  };
}

export interface DurableOwnedRepositoryPage {
  facts: PublicScanOwnedRepoFact[];
  hasNextPage: boolean;
}

/**
 * REST owns the user's public repository inventory and is cursor-like through
 * page numbers. The quick scan intentionally reads only two pages; durable
 * jobs continue until an empty/short page so project quality cannot silently
 * depend on repository count.
 */
export async function fetchDurableOwnedRepositoryPage(input: {
  username: string;
  page: number;
}): Promise<DurableOwnedRepositoryPage> {
  const page = Math.max(1, Math.floor(input.page));
  const repos = await restGet<RestRepo[]>(
    `users/${encodeURIComponent(input.username)}/repos?type=owner&per_page=100&sort=pushed&page=${page}`,
  );
  if (repos === null) {
    throw new GitHubDataUnavailableError("GitHub repository inventory is unavailable.");
  }
  return {
    facts: repos
      .filter((repo) => !repo.fork)
      .map((repo) => {
        const owner = repo.owner?.login ?? repo.full_name?.split("/", 1)[0] ?? input.username;
        return {
          repoKey: repo.full_name ?? `${owner}/${repo.name}`,
          name: repo.name,
          ownerLogin: owner,
          stars: repo.stargazers_count ?? 0,
          forks: repo.forks_count ?? 0,
          openIssues: repo.open_issues_count ?? 0,
          size: repo.size ?? 0,
          language: repo.language ?? null,
          description: repo.description ?? null,
          pushedAt: repo.pushed_at ?? null,
          topics: repo.topics ?? [],
        };
      }),
    hasNextPage: repos.length === 100,
  };
}

export interface PublicCommitSearchPage {
  totalCount: number;
  incompleteResults: boolean;
  candidates: {
    sha: string;
    repoKey: string;
    ownerLogin: string | null;
    stars: number;
    isPrivate: boolean;
    isFork: boolean;
    authoredAt: string | null;
  }[];
}

interface RestCommitSearchResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items?: {
    sha?: string | null;
    repository?: {
      full_name?: string | null;
      stargazers_count?: number | null;
      private?: boolean | null;
      fork?: boolean | null;
      owner?: { login?: string | null } | null;
    } | null;
    commit?: { author?: { date?: string | null } | null } | null;
  }[];
}

/**
 * Search only discovers candidate public commits. Callers must follow it with
 * {@link listPublicDefaultBranchCommits} before treating a result as impact.
 */
export async function searchPublicCommitCandidates(input: {
  username: string;
  from: string;
  to: string;
  page?: number;
  perPage?: number;
}): Promise<PublicCommitSearchPage> {
  const page = Math.max(1, input.page ?? 1);
  const perPage = Math.max(1, Math.min(input.perPage ?? 100, 100));
  const query = `author:${input.username} author-date:${input.from}..${input.to}`;
  let res: Response;
  try {
    res = await ghFetch(
      `${GITHUB_API}/search/commits?${new URLSearchParams({
        q: query,
        page: String(page),
        per_page: String(perPage),
      }).toString()}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
        },
      },
    );
  } catch (error) {
    rethrowIfAborted(error);
    throw new GitHubDataUnavailableError("GitHub commit search failed.");
  }
  if (res.status === 403 || res.status === 429) throw new GitHubRateLimitError();
  if (!res.ok) {
    throw new GitHubDataUnavailableError(`GitHub commit search HTTP ${res.status}.`);
  }
  let data: RestCommitSearchResponse;
  try {
    data = (await res.json()) as RestCommitSearchResponse;
  } catch {
    throw new GitHubDataUnavailableError("GitHub commit search returned invalid JSON.");
  }
  return {
    totalCount: Math.max(0, Number(data.total_count) || 0),
    incompleteResults: Boolean(data.incomplete_results),
    candidates: (data.items ?? [])
      .map((item) => {
        const repo = item.repository?.full_name?.trim();
        const sha = item.sha?.trim();
        if (!repo || !sha) return null;
        return {
          sha,
          repoKey: repo,
          ownerLogin: item.repository?.owner?.login ?? null,
          stars: Math.max(0, Number(item.repository?.stargazers_count) || 0),
          isPrivate: Boolean(item.repository?.private),
          isFork: Boolean(item.repository?.fork),
          authoredAt: item.commit?.author?.date ?? null,
        };
      })
      .filter(
        (candidate): candidate is PublicCommitSearchPage["candidates"][number] => candidate !== null,
      ),
  };
}

export interface PublicDefaultBranchCommitPage {
  commits: { sha: string; committedAt: string | null }[];
  hasNextPage: boolean;
}

interface RestDefaultBranchCommit {
  sha?: string | null;
  commit?: { committer?: { date?: string | null } | null } | null;
}

/**
 * The REST list-commits endpoint starts from the repository default branch when
 * `sha` is omitted. This is the verification step that makes discovered commit
 * candidates eligible for ecosystem-impact aggregation.
 */
export async function listPublicDefaultBranchCommits(input: {
  repoKey: string;
  username: string;
  from: string;
  to: string;
  page: number;
}): Promise<PublicDefaultBranchCommitPage> {
  const [owner, repo] = input.repoKey.split("/", 2);
  if (!owner || !repo) {
    throw new GitHubDataUnavailableError("Invalid repository key for commit verification.");
  }
  const params = new URLSearchParams({
    author: input.username,
    since: input.from,
    until: input.to,
    page: String(Math.max(1, input.page)),
    per_page: "100",
  });
  let res: Response;
  try {
    res = await ghFetch(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${params.toString()}`,
    );
  } catch (error) {
    rethrowIfAborted(error);
    throw new GitHubDataUnavailableError("GitHub default-branch commit lookup failed.");
  }
  if (res.status === 403 || res.status === 429) throw new GitHubRateLimitError();
  if (!res.ok) {
    throw new GitHubDataUnavailableError(`GitHub default-branch commits HTTP ${res.status}.`);
  }
  let data: RestDefaultBranchCommit[];
  try {
    data = (await res.json()) as RestDefaultBranchCommit[];
  } catch {
    throw new GitHubDataUnavailableError("GitHub default-branch commits returned invalid JSON.");
  }
  const hasNextPage = /<[^>]+>;\s*rel="next"/i.test(res.headers.get("link") ?? "");
  return {
    commits: (data ?? [])
      .map((commit) => {
        const sha = commit.sha?.trim();
        return sha ? { sha, committedAt: commit.commit?.committer?.date ?? null } : null;
      })
      .filter((commit): commit is { sha: string; committedAt: string | null } => commit !== null),
    hasNextPage,
  };
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  options: { splitOnTimeout?: boolean; allowNotFound?: boolean } = {},
): Promise<T> {
  if (!hasGithubToken()) throw new GitHubAuthRequiredError("GITHUB_TOKEN is required.");
  let res: Response;
  try {
    res = await ghFetch(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }, options);
  } catch (error) {
    if (error instanceof GitHubCollectDeadlineError) throw error;
    if (isAbortError(error)) {
      throw new GitHubCollectDeadlineError("GitHub GraphQL request aborted.");
    }
    throw new GitHubDataUnavailableError("GitHub GraphQL request failed.");
  }
  if (res.status === 403 || res.status === 429) {
    throw new GitHubRateLimitError();
  }
  if (!res.ok) {
    if (res.status === 502 || res.status === 504) {
      throw new GitHubQueryTimeoutError(`GitHub GraphQL HTTP ${res.status}.`);
    }
    throw new GitHubDataUnavailableError(`GitHub GraphQL HTTP ${res.status}.`);
  }
  let json: { data?: T; errors?: { message?: string; type?: string }[] };
  try {
    json = (await res.json()) as { data?: T; errors?: { message?: string; type?: string }[] };
  } catch {
    throw new GitHubDataUnavailableError("GitHub GraphQL returned invalid JSON.");
  }
  if (
    options.allowNotFound &&
    json.data &&
    json.errors?.every((e) => e.type === "NOT_FOUND")
  ) {
    return json.data;
  }
  if (json.errors?.length) {
    const first = json.errors[0];
    const message = first?.message ?? "GitHub GraphQL error.";
    if (first?.type === "RESOURCE_LIMITS_EXCEEDED") {
      throw new GitHubResourceLimitError(message);
    }
    if (first?.type === "INTERNAL") {
      throw new GitHubInternalQueryError(message);
    }
    throw /rate.?limit/i.test(message)
      ? new GitHubRateLimitError(message)
      : new GitHubDataUnavailableError(message);
  }
  if (!json.data) throw new GitHubDataUnavailableError("GitHub GraphQL returned no data.");
  return json.data;
}

async function fetchOrganizations(username: string): Promise<string[]> {
  if (!hasGithubToken()) return [];

  let res: Response;
  try {
    res = await ghFetch(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($login: String!) {
          user(login: $login) {
            organizations(first: 20) { nodes { login } }
          }
        }`,
        variables: { login: username },
      }),
    });
  } catch (error) {
    rethrowIfAborted(error);
    return [];
  }

  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") throw new GitHubRateLimitError();
    return [];
  }
  if (!res.ok) return [];

  let json:
    | {
        data?: {
          user?: {
            organizations?: { nodes?: ({ login?: string | null } | null)[] | null } | null;
          } | null;
        };
        errors?: { type?: string; message?: string }[];
      }
    | undefined;
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return [];
  }

  if (json?.errors?.length) {
    const insufficientScopes = json.errors.some(
      (error) =>
        error.type === "INSUFFICIENT_SCOPES" ||
        /read:org|insufficient scopes|organizations/i.test(error.message ?? ""),
    );
    if (insufficientScopes) return [];
    return [];
  }

  return (json?.data?.user?.organizations?.nodes ?? [])
    .map((node) => node?.login)
    .filter((login): login is string => typeof login === "string");
}

async function fetchLatestPublicEvent(username: string): Promise<Date | null> {
  try {
    const events = await restGet<RestPublicEvent[]>(
      `users/${encodeURIComponent(username)}/events/public?per_page=30`,
    );
    if (!events) return null;
    let latest: Date | null = null;
    for (const event of events) {
      const ts = parseTs(event.created_at);
      if (ts && (latest === null || ts > latest)) latest = ts;
    }
    return latest;
  } catch (error) {
    rethrowIfAborted(error);
    return null;
  }
}

async function readTextWithLimit(
  url: string,
  limit: number,
): Promise<{ text: string; truncated: boolean } | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "github-roast", Range: `bytes=0-${limit - 1}` },
      cache: "no-store",
      // The bounded reader cancels truncated bodies; avoid Next's retained tee.
      signal: githubRequestSignal(),
    });
  } catch (error) {
    rethrowIfAborted(error);
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > limit) {
        chunks.push(value.slice(0, limit - total));
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    if (total >= limit) truncated = true;
    if (truncated) await reader.cancel().catch(() => undefined);
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  return {
    text: Buffer.concat(chunks).toString("utf-8"),
    truncated,
  };
}

async function fetchReadmeDocument(owner: string, repo: string): Promise<RepoReadme | null> {
  const data = await restGet<RestReadme>(
    `repos/${owner}/${repo}/readme`,
  ).catch(swallowUnlessAborted);
  if (!data) return null;

  let markdown: string | null = null;
  let truncated = (data.size ?? 0) > README_FETCH_LIMIT;
  try {
    if (data.content && data.encoding === "base64" && (data.size ?? 0) <= README_FETCH_LIMIT) {
      markdown = Buffer.from(data.content.replace(/\s+/g, ""), "base64").toString("utf-8");
    } else if (data.download_url) {
      const raw = await readTextWithLimit(data.download_url, README_FETCH_LIMIT);
      markdown = raw?.text ?? null;
      truncated = truncated || (raw?.truncated ?? false);
    }
  } catch (error) {
    rethrowIfAborted(error);
    return null;
  }
  if (markdown === null) return null;
  const features = parseReadmeFeatures(markdown);
  return {
    path: data.path ?? "README",
    sha: data.sha ?? null,
    size: data.size ?? markdown.length,
    html_url: data.html_url ?? null,
    truncated,
    features,
  };
}

/** Per-language byte breakdown for one repo (e.g. {Python: 12000, Cuda: 4000}),
 * mapped to a sorted {name,size}[] (largest first). Fetched only for top repos —
 * one REST call each, mirroring the README excerpt cap. Returns [] on any error
 * (404 / rate-limit are swallowed like fetchReadmeExcerpt). */
async function fetchRepoLanguages(
  owner: string,
  repo: string,
): Promise<{ name: string; size: number }[]> {
  const data = await restGet<Record<string, number>>(
    `repos/${owner}/${repo}/languages`,
  ).catch(swallowUnlessAborted);
  if (!data) return [];
  return Object.entries(data)
    .map(([name, size]) => ({ name, size: size ?? 0 }))
    .sort((a, b) => b.size - a.size);
}

/** One bounded root listing; failure adds no negative evidence. No recursive tree. */
async function fetchRepoRootPaths(owner: string, repo: string): Promise<string[] | undefined> {
  const data = await restGet<{name: string}[]>(`repos/${owner}/${repo}/contents`).catch(swallowUnlessAborted);
  return Array.isArray(data) ? data.slice(0, 1000).map(entry => entry.name) : undefined;
}

/** Hydrate bounded README/language evidence after a durable repo inventory. */
export async function hydrateTopRepoEvidence(
  repos: TopRepo[],
  fallbackOwner: string,
  limit = 12,
): Promise<TopRepo[]> {
  const selected = repos.slice(0, Math.max(0, limit));
  await Promise.all(
    selected.map(async (repo) => {
      const owner = repo.owner_login ?? fallbackOwner;
      const [readme, languages, rootPaths] = await Promise.all([
        fetchReadmeDocument(owner, repo.name),
        fetchRepoLanguages(owner, repo.name),
        fetchRepoRootPaths(owner, repo.name),
      ]);
      repo.readme = readme ?? undefined;
      repo.readme_excerpt = readme?.features.prompt_summary ?? null;
      repo.languages = languages;
      repo.root_paths = rootPaths;
      repo.content_skill_share = contentSkillShare(repo);
    }),
  );
  return repos;
}

async function fetchRepoDetails(owner: string, repo: string): Promise<RestRepo | null> {
  return restGet<RestRepo>(`repos/${owner}/${repo}`).catch(swallowUnlessAborted);
}

async function hasReleaseOrTagAuthor(owner: string, repo: string, loginLower: string): Promise<boolean> {
  const releases = await restGet<RestRelease[]>(
    `repos/${owner}/${repo}/releases?per_page=10`,
  ).catch(swallowUnlessAborted);
  if (
    releases?.some((r) => r.author?.login?.toLowerCase() === loginLower)
  ) {
    return true;
  }

  const tags = await restGet<RestTag[]>(`repos/${owner}/${repo}/tags?per_page=5`).catch(
    swallowUnlessAborted,
  );
  if (!tags?.length) return false;

  const commits = await Promise.all(
    tags
      .map((t) => t.commit?.sha)
      .filter((sha): sha is string => typeof sha === "string" && sha.length > 0)
      .slice(0, 5)
      .map((sha) =>
        restGet<RestCommit>(`repos/${owner}/${repo}/commits/${sha}`).catch(swallowUnlessAborted),
      ),
  );
  return commits.some(
    (c) =>
      c?.author?.login?.toLowerCase() === loginLower ||
      c?.committer?.login?.toLowerCase() === loginLower,
  );
}

const MAINTAINER_FILE_PATHS = [
  "MAINTAINERS",
  "MAINTAINERS.md",
  "CODEOWNERS",
  ".github/CODEOWNERS",
  "docs/MAINTAINERS.md",
  "docs/maintainers.md",
];

function maintainerTextMatchesUser(text: string, loginLower: string, profileUrl: string | null): boolean {
  const lower = text.toLowerCase();
  if (new RegExp(`(^|[^a-z0-9-])@?${loginLower}([^a-z0-9-]|$)`).test(lower)) {
    return true;
  }
  if (profileUrl && lower.includes(profileUrl.toLowerCase())) return true;
  return lower.includes(`github.com/${loginLower}`);
}

async function hasMaintainerFileHit(
  owner: string,
  repo: string,
  loginLower: string,
  profileUrl: string | null,
): Promise<boolean> {
  for (const path of MAINTAINER_FILE_PATHS) {
    const data = await restGet<RestReadme>(
      `repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
    ).catch(swallowUnlessAborted);
    if (!data?.content || data.encoding !== "base64") continue;
    try {
      const text = Buffer.from(data.content.replace(/\s+/g, ""), "base64").toString("utf-8");
      if (maintainerTextMatchesUser(text, loginLower, profileUrl)) return true;
    } catch {
      // Try the next known maintainer path.
    }
  }
  return false;
}

function repoToTopRepo(
  repo: RestRepo,
  fallbackOwner: string,
  attribution?: OrgRepoAttribution,
): TopRepo {
  const owner = repo.owner?.login ?? repo.full_name?.split("/", 1)[0] ?? fallbackOwner;
  return {
    name: repo.name,
    owner_login: owner,
    name_with_owner: repo.full_name ?? `${owner}/${repo.name}`,
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    open_issues: repo.open_issues_count ?? 0,
    size: repo.size ?? 0,
    language: repo.language,
    description: repo.description,
    pushed_at: repo.pushed_at,
    topics: repo.topics ?? [],
    attributed_original: attribution !== undefined,
    attribution_evidence: attribution?.evidence,
    attribution_share: attribution?.share,
    co_creator_facts: attribution?.facts,
  };
}

/**
 * `open_issues_count` from GitHub's REST repository payload includes pull
 * requests. Fetch the real open-Issue count only for the bounded top-repo
 * prompt surface; on a best-effort failure we leave the value absent rather
 * than turning the REST aggregate into false Issue evidence.
 */
async function hydrateOpenIssueCounts(repos: TopRepo[]): Promise<void> {
  const selected = repos
    .slice(0, 10)
    .map((repo, index) => ({
      repo,
      index,
      owner: repo.owner_login,
      name: repo.name,
    }))
    .filter((entry): entry is typeof entry & { owner: string } => Boolean(entry.owner && entry.name));
  if (selected.length === 0) return;

  const variables: Record<string, string> = {};
  const declarations: string[] = [];
  const selections: string[] = [];
  for (const entry of selected) {
    const ownerKey = `owner${entry.index}`;
    const nameKey = `name${entry.index}`;
    variables[ownerKey] = entry.owner;
    variables[nameKey] = entry.name;
    declarations.push(`$${ownerKey}: String!, $${nameKey}: String!`);
    selections.push(
      `r${entry.index}: repository(owner: $${ownerKey}, name: $${nameKey}) { issues(states: OPEN) { totalCount } }`,
    );
  }

  try {
    const data = await graphql<Record<string, { issues?: { totalCount?: number } | null } | null>>(
      `query(${declarations.join(", ")}) { ${selections.join(" ")} }`,
      variables,
    );
    for (const entry of selected) {
      const count = data[`r${entry.index}`]?.issues?.totalCount;
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
        entry.repo.open_issue_count = Math.floor(count);
      }
    }
  } catch {
    // Issue counts are copy-only enrichment. A GraphQL hiccup must not block a
    // deterministic scan or encourage the writer to guess from REST's PR mix.
  }
}

function hasDocLikeTopic(repo: RestRepo): boolean {
  return (repo.topics ?? []).some((topic) =>
    /^(docs?|documentation|website|blog|examples?|templates?|tutorials?|guides?|manual)$/i.test(
      topic,
    ),
  );
}

const MAX_ATTRIBUTED_ORIGINAL_REPOS = 8;

const FIRST_COMMIT_META_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    isFork
    defaultBranchRef {
      name
      target {
        ... on Commit {
          oid
          history(first: 1) { totalCount }
        }
      }
    }
  }
}`;

const FIRST_COMMIT_HISTORY_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 1, after: $after) {
            nodes {
              oid
              url
              authoredDate
              messageHeadline
              author { name email user { login databaseId } }
              committer { name email user { login databaseId } }
            }
          }
        }
      }
    }
  }
}`;

type FirstCommitAccountSource =
  | "author.user"
  | "committer.user"
  | "noreply-email"
  | "none";

interface FirstCommitGithubAccount {
  login: string | null;
  source: FirstCommitAccountSource;
  isFork: boolean;
  oid: string | null;
}

interface FirstCommitActor {
  name?: string | null;
  email?: string | null;
  user?: { login?: string | null } | null;
}

interface FirstCommitNode {
  oid: string;
  url: string;
  authoredDate: string;
  messageHeadline: string;
  author: FirstCommitActor | null;
  committer: FirstCommitActor | null;
}

export function firstCommitHistoryAfter(tipOid: string, totalCount: number): string | null {
  if (totalCount < 2 || !tipOid) return null;
  return `${tipOid} ${totalCount - 2}`;
}

export function parseGithubNoreplyLogin(email: string | null | undefined): string | null {
  if (!email) return null;
  const plus = email.match(/^(\d+)\+([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i);
  if (plus) return plus[2];
  const plain = email.match(/^([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i);
  return plain?.[1] ?? null;
}

export function resolveFirstCommitGithubLogin(input: {
  authorLogin?: string | null;
  committerLogin?: string | null;
  authorEmail?: string | null;
  committerEmail?: string | null;
}): { login: string | null; source: FirstCommitAccountSource } {
  const authorLogin = input.authorLogin?.trim() || null;
  if (authorLogin) return { login: authorLogin, source: "author.user" };
  const committerLogin = input.committerLogin?.trim() || null;
  if (committerLogin) return { login: committerLogin, source: "committer.user" };
  const fromEmail =
    parseGithubNoreplyLogin(input.authorEmail) ?? parseGithubNoreplyLogin(input.committerEmail);
  if (fromEmail) return { login: fromEmail, source: "noreply-email" };
  return { login: null, source: "none" };
}

async function restAuthorLoginForCommit(
  owner: string,
  name: string,
  sha: string,
): Promise<string | null> {
  const commit = await restGet<RestCommit>(`repos/${owner}/${name}/commits/${sha}`).catch(
    swallowUnlessAborted,
  );
  return commit?.author?.login?.trim() || null;
}

async function fetchDefaultBranchFirstCommit(
  owner: string,
  name: string,
): Promise<FirstCommitGithubAccount> {
  const empty: FirstCommitGithubAccount = {
    login: null,
    source: "none",
    isFork: false,
    oid: null,
  };
  try {
    const meta = await graphql<{
      repository: {
        isFork: boolean;
        defaultBranchRef: {
          name: string;
          target: { oid: string; history: { totalCount: number } } | null;
        } | null;
      } | null;
    }>(FIRST_COMMIT_META_QUERY, { owner, name });
    const repository = meta.repository;
    if (!repository) return empty;
    const target = repository.defaultBranchRef?.target;
    const totalCount = target?.history.totalCount ?? 0;
    if (!target || totalCount <= 0) {
      return { ...empty, isFork: repository.isFork };
    }

    const after = firstCommitHistoryAfter(target.oid, totalCount);
    const history = await graphql<{
      repository: {
        defaultBranchRef: { target: { history: { nodes: FirstCommitNode[] } } | null } | null;
      } | null;
    }>(FIRST_COMMIT_HISTORY_QUERY, { owner, name, after });
    const commit = history.repository?.defaultBranchRef?.target?.history.nodes[0];
    if (!commit) {
      return { ...empty, isFork: repository.isFork };
    }

    let authorLogin = commit.author?.user?.login ?? null;
    if (!authorLogin) {
      authorLogin = await restAuthorLoginForCommit(owner, name, commit.oid);
    }
    const resolved = resolveFirstCommitGithubLogin({
      authorLogin,
      committerLogin: commit.committer?.user?.login ?? null,
      authorEmail: commit.author?.email ?? null,
      committerEmail: commit.committer?.email ?? null,
    });
    return {
      login: resolved.login,
      source: resolved.source,
      isFork: repository.isFork,
      oid: commit.oid,
    };
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    return empty;
  }
}

function isOrgOwnedLongTermCandidate(repo: ContribRepoAgg, loginLower: string): boolean {
  if (repo.is_private || repo.is_fork) return false;
  if (repo.owner_login.toLowerCase() === loginLower) return false;
  if (isDocLikeRepo(repo.repo)) return false;
  return repo.commits + repo.prs > 0;
}

export const CONTRIBUTOR_PAGE_LIMIT = 3;

async function collectCoCreatorFacts(repo: ContribRepoAgg, login: string, now = new Date()): Promise<CoCreatorFacts> {
  const [owner, name] = repo.repo.split("/");
  // Page the contributor list until the user appears (bounded): large repos
  // otherwise report 0 commits for anyone ranked past the first 100.
  const rows: ContributorRow[] = [];
  let truncated = false;
  for (let page = 1; page <= CONTRIBUTOR_PAGE_LIMIT; page++) {
    const batch = await restGet<ContributorRow[]>(
      `repos/${owner}/${name}/contributors?per_page=100&page=${page}`,
    ).catch(swallowUnlessAborted) ?? [];
    rows.push(...batch);
    truncated = batch.length >= 100;
    if (!truncated || batch.some(c => c.login?.toLowerCase() === login)) break;
  }
  const since = new Date(now.getTime() - RECENT_MAINTENANCE_DAYS*86_400_000);
  const sinceIso = since.toISOString();
  const sinceDay = sinceIso.slice(0, 10);
  const query = `query($owner: String!, $name: String!, $q: String!, $since: GitTimestamp!, $recentAll: String!, $recentMine: String!, $reviewed: String!, $login: String!) {
    user(login: $login) { id }
    repository(owner: $owner, name: $name) {
      pullRequests(states: MERGED) { totalCount }
      defaultBranchRef { target { ... on Commit {
        history(first: 1) { totalCount }
        recent: history(since: $since) { totalCount }
      } } }
    }
    search(query: $q, type: ISSUE, first: 10) {
      issueCount
      nodes { ... on PullRequest {
        authorAssociation changedFiles
        files(first: 100) { nodes { path additions deletions } }
      } }
    }
    recentAll: search(query: $recentAll, type: ISSUE) { issueCount }
    recentMine: search(query: $recentMine, type: ISSUE) { issueCount }
    reviewed: search(query: $reviewed, type: ISSUE) { issueCount }
  }`;
  type File = {path: string; additions: number; deletions: number};
  const data = await graphql<{
    user?: {id: string} | null;
    repository?: {pullRequests: {totalCount: number}; defaultBranchRef?: {target?: {history?: {totalCount: number}; recent?: {totalCount: number}}}};
    search?: {issueCount: number; nodes: {authorAssociation: string; changedFiles: number; files?: {nodes: File[]}}[]};
    recentAll?: {issueCount: number}; recentMine?: {issueCount: number}; reviewed?: {issueCount: number};
  }>(query, {owner, name, login, since: sinceIso,
    q: `repo:${repo.repo} is:pr is:merged author:${login} sort:created-desc`,
    recentAll: `repo:${repo.repo} is:pr is:merged merged:>=${sinceDay}`,
    recentMine: `repo:${repo.repo} is:pr is:merged merged:>=${sinceDay} author:${login}`,
    reviewed: `repo:${repo.repo} is:pr reviewed-by:${login} -author:${login}`,
  }).catch(swallowUnlessAborted);
  const counts = summarizeContributors(rows, login, {
    truncated,
    historyTotal: data?.repository?.defaultBranchRef?.target?.history?.totalCount ?? 0,
    fallbackUserCommits: repo.commits,
  });
  const f: CoCreatorFacts = {
    ...counts,
    user_merged_prs: data?.search?.issueCount ?? 0,
    total_merged_prs: data?.repository?.pullRequests.totalCount ?? 0,
    active_years: repo.active_years, core_churn: 0, sampled_churn: 0, substantive_samples: 0, samples: 0,
  };
  const recentTotal = data?.repository?.defaultBranchRef?.target?.recent?.totalCount;
  if (data?.user?.id && recentTotal !== undefined) {
    const mine = await graphql<{repository?: {defaultBranchRef?: {target?: {history?: {totalCount: number}}}}}>(
      `query($owner: String!, $name: String!, $since: GitTimestamp!, $id: ID!) { repository(owner: $owner, name: $name) {
        defaultBranchRef { target { ... on Commit { history(since: $since, author: {id: $id}) { totalCount } } } } } }`,
      {owner, name, since: sinceIso, id: data.user.id},
    ).catch(swallowUnlessAborted);
    const recentMine = mine?.repository?.defaultBranchRef?.target?.history?.totalCount;
    if (recentMine !== undefined) {
      f.recent_user_commits = recentMine;
      f.recent_total_commits = Math.max(recentTotal, recentMine);
    }
  }
  if (data?.recentAll && data.recentMine) {
    f.recent_user_merged_prs = data.recentMine.issueCount;
    f.recent_total_merged_prs = Math.max(data.recentAll.issueCount, data.recentMine.issueCount);
  }
  if (data?.reviewed) f.reviewed_prs = data.reviewed.issueCount;
  const add = (files: File[]) => {
    const {core, total, fresh} = weightedCoreChurn(files, repo.repo);
    f.samples++; f.core_churn += core; f.sampled_churn += total;
    if (fresh > 5) f.substantive_samples++;
  };
  for (const pr of data?.search?.nodes ?? []) {
    if (/^(OWNER|MEMBER|COLLABORATOR)$/.test(pr.authorAssociation)) f.association = pr.authorAssociation;
    if (pr.files?.nodes.length && pr.files.nodes.length >= pr.changedFiles) add(pr.files.nodes);
  }
  // Direct-push maintainers may have no PR sample. Three full commit diffs are
  // bounded evidence; merge-only and truncated diffs never establish substance.
  if (f.samples < 3) {
    const commits = await restGet<{sha: string; parents?: unknown[]}[]>(
      `repos/${owner}/${name}/commits?author=${encodeURIComponent(login)}&per_page=3`,
    ).catch(swallowUnlessAborted) ?? [];
    for (const commit of commits) {
      if ((commit.parents?.length ?? 0)>1) continue;
      const detail = await restGet<{files?: {filename: string; additions: number; deletions: number}[]; stats?: {total: number}}>(
        `repos/${owner}/${name}/commits/${commit.sha}`,
      ).catch(swallowUnlessAborted);
      const files = detail?.files?.map(x=>({path:x.filename,additions:x.additions,deletions:x.deletions})) ?? [];
      if (files.length && files.reduce((s,x)=>s+x.additions+x.deletions,0)===(detail?.stats?.total ?? -1)) add(files);
    }
  }
  return f;
}

async function collectAttributedOriginalRepos(input: {
  contribRepos: ContribRepoAgg[];
  organizations: string[];
  pinnedRepos: string[];
  loginLower: string;
  profileUrl: string | null;
}): Promise<TopRepo[]> {
  const structural = input.contribRepos.filter((repo) =>
    isOrgOwnedLongTermCandidate(repo, input.loginLower),
  );
  if (structural.length === 0) return [];

  const candidates = [...structural]
    .sort((a, b) => b.commits + 4*b.prs - (a.commits + 4*a.prs) || b.stars - a.stars)
    .slice(0, MAX_ATTRIBUTED_ORIGINAL_REPOS);

  const repos = await Promise.all(
    candidates.map(async (candidate) => {
      const [owner, name] = candidate.repo.split("/");
      if (!owner || !name) return null;
      const detail = await fetchRepoDetails(owner, name);
      if (!detail || detail.private || detail.fork) return null;
      if (isDocLikeRepo(candidate.repo) || hasDocLikeTopic(detail)) return null;

      const facts = await collectCoCreatorFacts(candidate, input.loginLower);
      if (facts.substantive_samples <= 0 || facts.core_churn <= 0) return null;
      // Membership must not hide founding evidence after an organization transfer.
      const first = await fetchDefaultBranchFirstCommit(owner, name);
      if (first.isFork) return null;
      const firstCommitLogin = first.login;

      const [releaseOrTagAuthorHit, maintainerFileHit] = await Promise.all([
        hasReleaseOrTagAuthor(owner, name, input.loginLower),
        hasMaintainerFileHit(owner, name, input.loginLower, input.profileUrl),
      ]);
      facts.inflation_severity = candidate.stars/(candidate.stars+100) /
        (1+(detail.forks_count??0))**2 / (1+6*Math.max(0,facts.total_merged_prs-facts.user_merged_prs))**2;
      const attribution = computeOrgRepoAttribution({
        repo: candidate,
        organizations: input.organizations,
        pinnedRepos: input.pinnedRepos,
        releaseOrTagAuthorHit,
        maintainerFileHit,
        scoredLogin: input.loginLower,
        firstCommitLogin,
        facts,
      });
      if (!attribution) return null;
      return repoToTopRepo(detail, owner, attribution);
    }),
  );

  return budgetCoCreatorShares(repos.filter((repo): repo is TopRepo => repo !== null));
}

const MAX_ORGANIZATION_MAINTAINED_REPOS = 6;

/**
 * Public organization-owned repositories the user demonstrably maintains.
 * Presentation/prompt only — never a score input. A candidate needs the
 * long-term contribution threshold plus repository-local proof (release/tag
 * author or an explicit maintainer/CODEOWNERS entry), so mere contributors do
 * not inherit an organization's portfolio. (Ported from the Go backend's
 * collectOrganizationMaintainedRepos during the Workers repatriation.)
 */
async function collectOrganizationMaintainedRepos(
  contributions: ContribRepoAgg[],
  loginLower: string,
  profileUrl: string | null,
): Promise<OrganizationMaintainedRepo[]> {
  const candidates = contributions
    .filter(
      (c) =>
        !c.is_private &&
        !c.is_fork &&
        c.owner_login.toLowerCase() !== loginLower &&
        hasStrongLongTermOrgContribution(c),
    )
    .sort((a, b) => {
      const aWork = a.commits + a.prs * 4;
      const bWork = b.commits + b.prs * 4;
      return bWork - aWork || b.stars - a.stars;
    })
    .slice(0, MAX_ORGANIZATION_MAINTAINED_REPOS);

  const result: OrganizationMaintainedRepo[] = [];
  // Bound the display-only repository fan-out and preserve candidate order.
  // A long maintainer-file chain must not serialize all six repositories.
  for (let offset = 0; offset < candidates.length; offset += 2) {
    const batch = await Promise.all(candidates.slice(offset, offset + 2).map(async (candidate): Promise<OrganizationMaintainedRepo | null> => {
      const [owner, name] = candidate.repo.split("/");
      if (!owner || !name) return null;
      const detail = await fetchRepoDetails(owner, name);
      if (
        !detail ||
        detail.private ||
        detail.fork ||
        detail.owner?.type?.toLowerCase() !== "organization"
      ) {
        return null;
      }
      const [releaseOrTagAuthor, maintainerFileHit] = await Promise.all([
        hasReleaseOrTagAuthor(owner, name, loginLower),
        hasMaintainerFileHit(owner, name, loginLower, profileUrl),
      ]);
      if (!releaseOrTagAuthor && !maintainerFileHit) return null;
      const evidence = [
        `${candidate.commits} commits + ${candidate.prs} PRs across ${candidate.active_years} years`,
      ];
      if (releaseOrTagAuthor) evidence.push("release/tag author");
      if (maintainerFileHit) evidence.push("listed in maintainer/codeowner docs");
      const repository = repoToTopRepo(detail, owner);
      const languages = await fetchRepoLanguages(owner, name).catch(() => []);
      if (languages.length) repository.languages = languages;
      return {
        repository,
        commits: candidate.commits,
        prs: candidate.prs,
        active_years: candidate.active_years,
        evidence,
      };
    }));
    result.push(...batch.filter((repo): repo is OrganizationMaintainedRepo => repo !== null));
  }
  return result;
}

const MAX_CONTRIBUTION_LANGUAGE_REPOS = 50;

function contributionLanguageWorkUnits(c: ContribRepoAgg): number {
  return Math.max(0, c.commits) + Math.max(0, c.prs) * 4;
}

/**
 * Contribution-weighted language estimate from the public commit/landed-PR
 * aggregation. Presentation-only side channel: repository language bytes
 * describe the repository, log-scaled user work units decide its influence.
 * (Ported from the Go backend's collectEstimatedContributionLanguages.)
 */
export async function collectEstimatedContributionLanguages(
  contributions: ContribRepoAgg[],
): Promise<EstimatedContributionLanguages | null> {
  const candidates = contributions
    .filter(
      (c) => c.repo && !c.is_private && !c.is_fork && contributionLanguageWorkUnits(c) > 0,
    )
    .sort(
      (a, b) =>
        contributionLanguageWorkUnits(b) - contributionLanguageWorkUnits(a) ||
        b.commits - a.commits ||
        b.prs - a.prs ||
        a.repo.toLowerCase().localeCompare(b.repo.toLowerCase()),
    );

  const candidateRepoCount = candidates.length;
  const selected = candidates.slice(0, MAX_CONTRIBUTION_LANGUAGE_REPOS);

  // Fetch in bounded batches, then accumulate in the original order so neither
  // floating-point sums nor tie ordering depend on network completion order.
  const sampledLanguages: Awaited<ReturnType<typeof fetchRepoLanguages>>[] = [];
  for (let offset = 0; offset < selected.length; offset += 4) {
    sampledLanguages.push(...await Promise.all(selected.slice(offset, offset + 4).map((candidate) => {
      const [owner, name] = candidate.repo.split("/");
      // Language display must never fail or alter a scored scan.
      return owner && name ? fetchRepoLanguages(owner, name).catch(() => []) : Promise.resolve([]);
    })));
  }
  const weights = new Map<string, number>();
  let sampledRepoCount = 0;
  for (const [index, candidate] of selected.entries()) {
    const languages = sampledLanguages[index];
    const languageBytes = languages.reduce((a, l) => a + Math.max(0, l.size), 0);
    if (languageBytes === 0) continue;
    const repoWeight = Math.log1p(contributionLanguageWorkUnits(candidate));
    for (const language of languages) {
      if (!language.name || language.size <= 0) continue;
      weights.set(
        language.name,
        (weights.get(language.name) ?? 0) + (repoWeight * language.size) / languageBytes,
      );
    }
    sampledRepoCount++;
  }

  const totalWeight = [...weights.values()].reduce((a, w) => a + w, 0);
  if (totalWeight === 0) return null;
  const languages = [...weights.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, weight]) => ({
      name,
      pct: Math.round((weight / totalWeight) * 100),
    }));
  return {
    languages,
    candidate_repo_count: candidateRepoCount,
    selected_repo_count: selected.length,
    sampled_repo_count: sampledRepoCount,
  };
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
  files?: { nodes: { path: string | null; additions?: number; deletions?: number }[] | null } | null;
}

type DurablePrState = "MERGED" | "CLOSED";

interface DurablePrPageNode {
  id: string;
  title: string | null;
  createdAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  labels?: { nodes: ({ name: string | null } | null)[] } | null;
  repository: {
    nameWithOwner: string;
    stargazerCount: number;
    isPrivate: boolean;
    isFork: boolean;
    owner: { login: string } | null;
  } | null;
}

export interface DurablePullRequestPage {
  facts: PublicScanPrFact[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * Fetch one deliberately small, cursor-addressable contribution page.
 * This is separate from the UI's recent-PR sample: its records are persisted and
 * eventually form the all-history native merge / workflow landing aggregate.
 */
export async function fetchDurablePullRequestPage(input: {
  username: string;
  state: DurablePrState;
  after?: string | null;
  includeLabels?: boolean;
  first?: number;
}): Promise<DurablePullRequestPage> {
  const count = Math.max(1, Math.min(input.first ?? (input.includeLabels ? 50 : 100), 100));
  const data = await graphql<{
    user: {
      pullRequests: {
        nodes: DurablePrPageNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  }>(
    `query($login: String!, $state: PullRequestState!, $after: String, $count: Int!, $includeLabels: Boolean!) {
      user(login: $login) {
        pullRequests(first: $count, states: [$state], after: $after,
                     orderBy: {field: CREATED_AT, direction: DESC}) {
          nodes {
            id title createdAt mergedAt closedAt additions deletions changedFiles
            labels(first: 20) @include(if: $includeLabels) { nodes { name } }
            repository {
              nameWithOwner stargazerCount isPrivate isFork owner { login }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`,
    {
      login: input.username,
      state: input.state,
      after: input.after ?? null,
      count,
      includeLabels: Boolean(input.includeLabels),
    },
  );
  const pullRequests = data.user?.pullRequests;
  if (!pullRequests) {
    throw new GitHubDataUnavailableError("GitHub GraphQL returned no durable pull request page.");
  }
  return {
    facts: (pullRequests.nodes ?? []).map((node) => {
      const repo = node.repository;
      return {
        pullRequestId: node.id,
        source: input.state === "MERGED" ? "native_merged" : "closed",
        repoKey: repo?.nameWithOwner ?? null,
        ownerLogin: repo?.owner?.login ?? null,
        stars: repo?.stargazerCount ?? 0,
        isPrivate: Boolean(repo?.isPrivate),
        isFork: Boolean(repo?.isFork),
        createdAt: node.createdAt ?? null,
        mergedAt: node.mergedAt ?? null,
        closedAt: node.closedAt ?? null,
        title: node.title ?? null,
        additions: node.additions ?? null,
        deletions: node.deletions ?? null,
        changedFiles: node.changedFiles ?? null,
        labels: (node.labels?.nodes ?? [])
          .map((label) => label?.name?.trim())
          .filter((label): label is string => Boolean(label)),
      };
    }),
    hasNextPage: pullRequests.pageInfo.hasNextPage,
    endCursor: pullRequests.pageInfo.endCursor,
  };
}

export async function fetchRecentPrs(username: string, count = 50): Promise<RecentPr[]> {
  const nodes: PrNode[] = [];
  let after: string | null = null;
  while (nodes.length < count) {
    const data: { user: { pullRequests: { nodes: PrNode[]; pageInfo: MergedPrPageInfo } } | null } = await graphql(
      `query($login: String!, $count: Int!, $after: String) {
        user(login: $login) {
          pullRequests(first: $count, states: MERGED, after: $after,
                       orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes {
              title additions deletions changedFiles
              repository { nameWithOwner stargazerCount isPrivate }
              files(first: 100) { nodes { path additions deletions } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { login: username, count: Math.min(25, count - nodes.length), after },
    );
    if (!data.user) throw new GitHubDataUnavailableError("GitHub GraphQL returned no PR data.");
    const page = data.user.pullRequests;
    nodes.push(...(page.nodes ?? []));
    if (!page.pageInfo?.hasNextPage) break;
    if (!page.nodes?.length || !page.pageInfo.endCursor || page.pageInfo.endCursor === after) {
      throw new GitHubDataUnavailableError("GitHub PR pagination made no progress.");
    }
    after = page.pageInfo.endCursor;
  }
  return nodes.map(toRecentPr);
}

function toRecentPr(n: PrNode): RecentPr {
  const repo = n.repository;
  const churn = (n.additions ?? 0) + (n.deletions ?? 0);
  const pr: RecentPr = {
    title: n.title,
    repo: repo?.nameWithOwner ?? null,
    repo_stars: repo?.stargazerCount ?? 0,
    churn,
    changed_files: n.changedFiles ?? 0,
    trivial: churn <= 5,
    files: (n.files?.nodes ?? []).map((f) => f.path).filter((p): p is string => Boolean(p)),
    file_changes: (n.files?.nodes ?? []).filter(f => f.path && f.additions !== undefined && f.deletions !== undefined).map(f => ({path: f.path!, additions: f.additions!, deletions: f.deletions!})),
  };
  pr.presentation_share = prPresentationShare(pr);
  return pr;
}

export interface WorkflowLandedPr {
  id: string;
  repo: string;
  stars: number;
  owner_login: string;
}

/**
 * Verify candidate closed PR ids from the durable label crawl. A `Merged` label
 * alone is deliberately insufficient: the same official bot must apply it and
 * later close the PR. The returned facts replace the candidate's `closed`
 * source, while native merges remain a separate source.
 */
export async function verifyWorkflowLandedPublicScanFacts(
  ids: string[],
): Promise<PublicScanPrFact[]> {
  const unique = [...new Set(ids)].filter(Boolean).slice(0, 25);
  if (unique.length === 0) return [];
  const data = await graphql<{
    nodes: (WorkflowLandedPrNode | { __typename: string } | null)[];
  }>(
    `query($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on PullRequest {
          __typename id title createdAt closedAt mergedAt additions deletions changedFiles
          repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
          timelineItems(last: 20, itemTypes: [LABELED_EVENT, CLOSED_EVENT]) {
            nodes {
              __typename
              ... on LabeledEvent { createdAt actor { login __typename } label { name } }
              ... on ClosedEvent { createdAt actor { login __typename } }
            }
          }
        }
      }
    }`,
    { ids: unique },
  );
  return data.nodes
    .filter((node): node is WorkflowLandedPrNode & {
      title?: string | null;
      createdAt?: string | null;
      closedAt?: string | null;
    } => node?.__typename === "PullRequest")
    .filter(isWorkflowLandedPr)
    .map((node) => ({
      pullRequestId: node.id,
      source: "workflow_landed" as const,
      repoKey: node.repository!.nameWithOwner,
      ownerLogin: node.repository!.owner?.login ?? null,
      stars: node.repository!.stargazerCount ?? 0,
      isPrivate: node.repository!.isPrivate,
      isFork: node.repository!.isFork,
      createdAt: node.createdAt ?? null,
      mergedAt: node.mergedAt ?? null,
      closedAt: node.closedAt ?? null,
      title: node.title ?? null,
      additions: node.additions ?? null,
      deletions: node.deletions ?? null,
      changedFiles: node.changedFiles ?? null,
      labels: ["Merged"],
    }));
}

async function fetchWorkflowLandedPrs(
  username: string,
  closedPrCount: number,
  scope?: CollectionScope,
): Promise<WorkflowLandedPr[]> {
  if (closedPrCount === 0) return [];
  try {
    if (scope?.full) {
      const landed: WorkflowLandedPr[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await fetchDurablePullRequestPage({ username, state: "CLOSED", after, includeLabels: true });
        const ids = page.facts.filter(f => f.labels.some(l => l.trim().toLowerCase() === "merged")).map(f => f.pullRequestId);
        for (let start = 0; start < ids.length; start += WORKFLOW_CANDIDATE_CAP) {
          const facts = await verifyWorkflowLandedPublicScanFacts(ids.slice(start, start + WORKFLOW_CANDIDATE_CAP));
          landed.push(...facts.filter(f => f.repoKey).map(f => ({ id: f.pullRequestId, repo: f.repoKey!, stars: f.stars, owner_login: f.ownerLogin ?? f.repoKey!.split("/", 1)[0] })));
        }
        if (!page.hasNextPage) return landed;
        if (!page.facts.length || !page.endCursor || page.endCursor === after) throw new GitHubDataUnavailableError("Workflow cursor made no progress.");
        after = page.endCursor;
      }
    }
    if (closedPrCount > GITHUB_PAGE_SIZE) scope?.note("workflow_page_limit");
    // Keep labels out of collect()'s already dense contribution query. A 100 ×
    // 20 nested label selection can exceed GitHub's GraphQL resource budget for
    // active accounts, making the *baseline* score unavailable. This optional
    // side query may fail closed without changing native merge behavior.
    const candidates = await graphql<{
      user: {
        pullRequests: {
          nodes: ({
            id: string;
            labels: { nodes: ({ name: string | null } | null)[] } | null;
          } | null)[];
        } | null;
      } | null;
    }>(
      `query($login: String!) {
        user(login: $login) {
          pullRequests(first: 100, states: CLOSED, orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes { id labels(first: 20) { nodes { name } } }
          }
        }
      }`,
      { login: username },
    );
    const ids = (candidates.user?.pullRequests?.nodes ?? [])
      .filter((node): node is { id: string; labels: { nodes: ({ name: string | null } | null)[] } | null } => node !== null)
      .filter((node) =>
        (node.labels?.nodes ?? []).some(
          (label) => label?.name?.trim().toLowerCase() === "merged",
        ),
      )
      .map((node) => node.id)
      .slice(0, WORKFLOW_CANDIDATE_CAP);
    if (ids.length >= WORKFLOW_CANDIDATE_CAP) scope?.note("workflow_candidate_cap");
    if (ids.length === 0) return [];

    const data = await graphql<{
      nodes: (WorkflowLandedPrNode | { __typename: string } | null)[];
    }>(
      `query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on PullRequest {
            __typename id mergedAt additions deletions changedFiles
            repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
            timelineItems(last: 20, itemTypes: [LABELED_EVENT, CLOSED_EVENT]) {
              nodes {
                __typename
                ... on LabeledEvent { createdAt actor { login __typename } label { name } }
                ... on ClosedEvent { createdAt actor { login __typename } }
              }
            }
          }
        }
      }`,
      { ids },
    );
    return data.nodes
      .filter((node): node is WorkflowLandedPrNode => node?.__typename === "PullRequest")
      .filter(isWorkflowLandedPr)
      .map((node) => ({
        id: node.id,
        repo: node.repository!.nameWithOwner,
        stars: node.repository!.stargazerCount,
        owner_login: node.repository!.owner?.login ?? node.repository!.nameWithOwner.split("/", 1)[0],
      }));
  } catch (error) {
    rethrowIfAborted(error);
    scope?.note("workflow_unavailable");
    // This is an optional enrichment. Preserve the established native-merge
    // scan when GitHub declines timeline access or a transient error occurs.
    return [];
  }
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
  if (!data.user) throw new GitHubDataUnavailableError("GitHub GraphQL returned no PR data.");
  const nodes = data.user.pullRequests?.nodes ?? [];
  return nodes
    .filter((n) => n.title && n.repository)
    .map((n) => ({ title: n.title as string, repo: n.repository!.nameWithOwner }));
}

function isOwnRepoName(nameWithOwner: string | null | undefined, loginLower: string): boolean {
  return repoOwner(nameWithOwner) === loginLower;
}

/** Cap how many recent years of the contribution graph we aggregate (latency). */
export const IMPACT_YEAR_CAP = 6;

interface ContribByRepoNode {
  contributions: { totalCount: number; nodes?: ({ occurredAt: string | null } | null)[] | null };
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
}

/** One aliased `contributionsCollection(from,to)` query per entry in `years`;
 * returns the per-year results aligned to the input order. */
async function fetchYearContribsBatch(
  username: string,
  years: number[],
  windows?: [string, string][],
): Promise<(YearContribs | null)[]> {
  const fragment = `fragment RepoContribs on ContributionsCollection {
    commitContributionsByRepository(maxRepositories: 100) {
      contributions(first: 100) { totalCount nodes { occurredAt } }
      repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
    }
  }`;
  const varDecls = years
    .map((_, i) => `$from${i}: DateTime!, $to${i}: DateTime!`)
    .join(", ");
  const aliases = years
    .map((_, i) => `y${i}: contributionsCollection(from: $from${i}, to: $to${i}) { ...RepoContribs }`)
    .join("\n        ");
  const query = `query($login: String!, ${varDecls}) {
      user(login: $login) {
        ${aliases}
      }
    }
    ${fragment}`;

  const variables: Record<string, unknown> = { login: username };
  for (let i = 0; i < years.length; i++) {
    variables[`from${i}`] = `${years[i]}-01-01T00:00:00Z`;
    variables[`to${i}`] = `${years[i]}-12-31T23:59:59Z`;
    if (windows?.[i]) { variables[`from${i}`] = windows[i][0]; variables[`to${i}`] = windows[i][1]; }
  }

  const data = await graphql<{ user: Record<string, YearContribs> | null }>(
    query,
    variables,
    { splitOnTimeout: true },
  );
  if (!data.user) throw new GitHubDataUnavailableError("GitHub GraphQL returned no contribution data.");
  const user = data.user;
  return years.map((_, i) => user[`y${i}`] ?? null);
}

/**
 * Fetch all-time per-repo commit contributions by aliasing one
 * `contributionsCollection(from,to)` per year (GraphQL caps each to a 1-year
 * span), capped to the most recent {@link IMPACT_YEAR_CAP} years.
 *
 * Hyperactive accounts can trip GitHub's per-query resource budget on the
 * batched query (same failure mode as {@link fetchContribOverview}); the
 * fallback re-runs one year per query. Quick mode notes and skips any single
 * year that is still unqueryable (escalating to fullscan). Full mode subdivides
 * that year through fetchCompleteCommitWindow so a pathological year degrades
 * only when the finest window still saturates, instead of silently dropping
 * every commit in the year. Gateway timeouts and INTERNAL errors also split the
 * batch and use the same recovery path as resource-limit years (no fabricated
 * data). If every year still fails after recovery, the original error is
 * rethrown so the collect does not publish an empty contribution set as a
 * successful fresh result.
 */
export async function fetchCommitContribReposByYear(
  username: string,
  years: number[],
  scope?: CollectionScope,
): Promise<ContribRepoAgg[] | null> {
  if (!scope?.full && years.length > IMPACT_YEAR_CAP) scope?.note("commit_year_cap");
  const capped = [...years].sort((a, b) => b - a).slice(0, scope?.full ? undefined : IMPACT_YEAR_CAP);
  if (capped.length === 0) return null;

  const completeYear = (year: number) =>
    fetchCompleteCommitWindow(username, Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1) - 1000);

  /** Years already recovered via fetchCompleteCommitWindow; skip re-split. */
  const completedYears = new Set<number>();
  /** Years noted+skipped by recovery; avoid mislabeling them in the merge loop. */
  const degradedYears = new Set<number>();

  function degradeNote(error: unknown): string {
    if (error instanceof GitHubInternalQueryError) return "commit_year_internal";
    if (error instanceof GitHubQueryTimeoutError) return "commit_year_timeout";
    return "commit_resource_limit";
  }

  function isDegradableYearError(error: unknown): boolean {
    return (
      error instanceof GitHubResourceLimitError ||
      error instanceof GitHubInternalQueryError ||
      error instanceof GitHubQueryTimeoutError
    );
  }

  async function recoverUnqueryableYear(year: number, error: unknown): Promise<YearContribs | null> {
    const note = degradeNote(error);
    // Quick mode notes and escalates. Full mode subdivides silently on success;
    // note only when the year still cannot be recovered.
    if (!scope?.full) {
      scope?.note(note);
      degradedYears.add(year);
      return null;
    }
    try {
      const nodes = await completeYear(year);
      completedYears.add(year);
      return { commitContributionsByRepository: nodes };
    } catch (caught) {
      if (isDegradableYearError(caught)) {
        scope.note(note);
        degradedYears.add(year);
        return null;
      }
      throw caught;
    }
  }

  let perYear: (YearContribs | null)[];
  try {
    perYear = await fetchYearContribsBatch(username, capped);
  } catch (e) {
    if (!canSplitContribQuery(e)) throw e;
    // Single-year resource-limit recovers via subdivision; single-year
    // INTERNAL/timeout still fail closed (avoid recursive same-query retry).
    if (!(e instanceof GitHubResourceLimitError) && capped.length <= 1) throw e;
    perYear = await Promise.all(
      capped.map(async (year) => {
        if (capped.length === 1 && e instanceof GitHubResourceLimitError) {
          return recoverUnqueryableYear(year, e);
        }
        try {
          return (await fetchYearContribsBatch(username, [year]))[0];
        } catch (e2) {
          if (isDegradableYearError(e2)) return recoverUnqueryableYear(year, e2);
          throw e2;
        }
      }),
    );
    // Resource-limit quick degrade is note+empty (escalate via note). INTERNAL /
    // timeout with every year skipped must not look like a successful empty collect.
    if (
      perYear.every((year) => year === null) &&
      !(e instanceof GitHubResourceLimitError)
    ) {
      throw e;
    }
  }

  // Merge per-year per-repo aggregates: sum commits/prs, take max stars.
  const map = new Map<string, ContribRepoAgg>();
  const yearsByRepo = new Map<string, Set<number>>();
  const monthsByRepo = new Map<string, Set<string>>();
  const ingest = (node: ContribByRepoNode, year: number): void => {
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
        active_years: 0,
      };
    entry.stars = Math.max(entry.stars, repo.stargazerCount ?? 0);
    entry.commits += node.contributions?.totalCount ?? 0;
    map.set(key, entry);
    const years = yearsByRepo.get(key) ?? new Set<number>();
    years.add(year);
    yearsByRepo.set(key, years);
    for (const contribution of node.contributions?.nodes ?? []) {
      addMonth(monthsByRepo, key, contribution?.occurredAt);
    }
  };
  for (let i = 0; i < capped.length; i++) {
    let yc = perYear[i];
    if (!yc) {
      if (!degradedYears.has(capped[i])) scope?.note("commit_resource_limit");
      continue;
    }
    if (
      !completedYears.has(capped[i]) &&
      (yc.commitContributionsByRepository?.length ?? 0) >= GITHUB_PAGE_SIZE
    ) {
      if (scope?.full) {
        yc = { commitContributionsByRepository: await completeYear(capped[i]) };
        completedYears.add(capped[i]);
      } else scope?.note("commit_repository_cap");
    }
    for (const n of yc.commitContributionsByRepository ?? []) ingest(n, capped[i]);
  }
  return [...map.entries()].map(([key, value]) => ({
    ...value,
    active_years: yearsByRepo.get(key)?.size ?? 0,
    months: sortedMonths(monthsByRepo.get(key)),
  }));
}

async function fetchCompleteCommitWindow(username: string, from: number, to: number): Promise<ContribByRepoNode[]> {
  if (to <= from) throw new GitHubResourceLimitError("Commit window remains saturated.");
  const mid = from + Math.floor((to - from) / 2000) * 1000;
  const nodes: ContribByRepoNode[] = [];
  for (const [start, end] of [[from, mid], [mid + 1000, to]]) {
    if (start > end) continue;
    let batch: YearContribs | null;
    try { batch = (await fetchYearContribsBatch(username, [new Date(start).getUTCFullYear()], [[new Date(start).toISOString(), new Date(end).toISOString()]]))[0]; }
    catch (error) {
      if (
        !(error instanceof GitHubResourceLimitError) &&
        !(error instanceof GitHubInternalQueryError) &&
        !(error instanceof GitHubQueryTimeoutError)
      ) throw error;
      batch = null;
    }
    const chunk = batch?.commitContributionsByRepository;
    nodes.push(...(!chunk || chunk.length >= GITHUB_PAGE_SIZE ? await fetchCompleteCommitWindow(username, start, end) : chunk));
  }
  return nodes;
}

type MergedPrPageInfo = { hasNextPage: boolean; endCursor: string | null };

interface MergedPrReposResponse {
  user: {
    pullRequests: {
      nodes: MergedPrRepoNode[];
      pageInfo: MergedPrPageInfo;
    };
  } | null;
}

/** Newest merged PRs (all repos), bounded to `maxPrs`. */
async function fetchMergedPrNodes(
  username: string,
  maxPrs = MERGED_PR_WINDOW,
): Promise<MergedPrRepoNode[]> {
  const nodes: MergedPrRepoNode[] = [];
  let after: string | null = null;

  while (nodes.length < maxPrs) {
    const count = Math.min(100, maxPrs - nodes.length);
    const data: MergedPrReposResponse = await graphql<MergedPrReposResponse>(
      `query($login: String!, $count: Int!, $after: String) {
        user(login: $login) {
          pullRequests(first: $count, states: MERGED, after: $after,
                       orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes {
              id mergedAt
              repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { login: username, count, after },
    );
    if (!data.user) throw new GitHubDataUnavailableError("GitHub GraphQL returned no merged PR data.");

    const pullRequests = data.user.pullRequests;
    nodes.push(...(pullRequests.nodes ?? []));
    const pageInfo: MergedPrPageInfo = pullRequests.pageInfo;
    if (!pageInfo) throw new GitHubDataUnavailableError("GitHub merged history page info unavailable.");
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor || !pullRequests.nodes?.length || pageInfo.endCursor === after) throw new GitHubDataUnavailableError("GitHub merged history cursor made no progress.");
    after = pageInfo.endCursor;
  }
  return nodes;
}

/** Most external merged PRs fetched per scan (search pages of 100). */
export const EXTERNAL_MERGED_PR_CAP = 300;

export interface ExternalMergedPrs {
  /** All public merged PRs into repos the user does not own. */
  total: number;
  /** The newest of them, up to {@link EXTERNAL_MERGED_PR_CAP}. */
  nodes: MergedPrRepoNode[];
}

interface ExternalMergedPrSearchResponse {
  search: {
    issueCount: number;
    nodes: (MergedPrRepoNode | Record<string, never> | null)[];
    pageInfo: MergedPrPageInfo;
  };
}

/**
 * Public merged PRs into repos the user does not own, queried on their own so
 * heavy own-repo PR traffic cannot crowd older external work out of the
 * newest-300 window. Uses GraphQL search (the GraphQL point budget), not the
 * 30/min REST search API. Best-effort: only a rate limit fails the scan; on
 * other errors this returns null and Contribution Quality keeps the
 * single-pool formula.
 */
export async function fetchExternalMergedPrs(
  username: string,
  maxPrs = EXTERNAL_MERGED_PR_CAP,
): Promise<ExternalMergedPrs | null> {
  try {
    return await searchExternalMergedPrs(username, maxPrs);
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    return null;
  }
}

async function searchExternalMergedPrs(
  username: string,
  maxPrs: number,
): Promise<ExternalMergedPrs> {
  const query = `is:pr is:merged is:public author:${username} -user:${username} sort:created-desc`;
  const nodes: MergedPrRepoNode[] = [];
  let total = 0;
  let after: string | null = null;
  while (nodes.length < maxPrs) {
    const data: ExternalMergedPrSearchResponse = await graphql<ExternalMergedPrSearchResponse>(
      `query($q: String!, $count: Int!, $after: String) {
        search(query: $q, type: ISSUE, first: $count, after: $after) {
          issueCount
          nodes {
            ... on PullRequest {
              id mergedAt
              repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { q: query, count: Math.min(100, maxPrs - nodes.length), after },
    );
    const search = data.search;
    total = search?.issueCount ?? 0;
    const page = (search?.nodes ?? []).filter(
      (n): n is MergedPrRepoNode => Boolean(n && "repository" in n && n.repository),
    );
    nodes.push(...page);
    if (!search?.pageInfo?.hasNextPage || !search.pageInfo.endCursor || page.length === 0) break;
    after = search.pageInfo.endCursor;
  }
  return { total: Math.max(total, nodes.length), nodes };
}

export function mergeContribRepoAggs(groups: ContribRepoAgg[][]): ContribRepoAgg[] {
  const map = new Map<string, ContribRepoAgg>();
  for (const group of groups) {
    for (const repo of group) {
      const entry =
        map.get(repo.repo) ??
        {
          ...repo,
          stars: 0,
          commits: 0,
          prs: 0,
          active_years: 0,
        };
      entry.stars = Math.max(entry.stars, repo.stars);
      entry.is_private = entry.is_private || repo.is_private;
      entry.is_fork = entry.is_fork || repo.is_fork;
      entry.commits += repo.commits;
      entry.prs += repo.prs;
      entry.active_years = Math.max(entry.active_years, repo.active_years);
      if (repo.months?.length) {
        entry.months = [...new Set([...(entry.months ?? []), ...repo.months])].sort();
      }
      map.set(repo.repo, entry);
    }
  }
  return [...map.values()];
}

/** Repos (by stars) whose topics and merge-commit share are fetched per scan. */
const IMPACT_SIGNAL_REPO_CAP = 20;
/** Most recent commits by the user sampled per repo to estimate merge share. */
const MERGE_COMMIT_SAMPLE = 100;

interface RepoEngagementFields {
  stargazerCount: number;
  hasIssuesEnabled: boolean;
  isMirror: boolean;
  watchers: { totalCount: number } | null;
  issues: { totalCount: number } | null;
  pullRequests: { totalCount: number } | null;
}

/** (watchers + issues ever + PRs ever) / stars, rounded to 4 decimals.
 * Mirrors and issues-disabled repos (e.g. torvalds/linux) suppress engagement
 * by POLICY, not by lack of community — not measurable fairly. */
function engagementRatio(repo: RepoEngagementFields | null | undefined): number | undefined {
  if (!repo || !repo.stargazerCount) return undefined;
  if (repo.isMirror || !repo.hasIssuesEnabled) return undefined;
  const engaged =
    (repo.watchers?.totalCount ?? 0) +
    (repo.issues?.totalCount ?? 0) +
    (repo.pullRequests?.totalCount ?? 0);
  return Math.round((engaged / repo.stargazerCount) * 10000) / 10000;
}

interface ImpactRepoSignalNode extends Partial<RepoEngagementFields> {
  repositoryTopics: { nodes: ({ topic: { name: string } | null } | null)[] | null } | null;
  defaultBranchRef: {
    target: {
      history?: { nodes: ({ parents: { totalCount: number } | null } | null)[] | null } | null;
    } | null;
  } | null;
}

/**
 * One aliased GraphQL request for the repos that can earn ecosystem impact:
 * topics plus the user's latest {@link MERGE_COMMIT_SAMPLE} default-branch
 * commits with parent counts. Best-effort: without signals, impact falls back
 * to name-only doc detection and counts every commit as work.
 */
export async function fetchImpactRepoSignals(
  repos: ContribRepoAgg[],
  loginLower: string,
  authorNodeId: string | undefined,
): Promise<Map<string, ImpactRepoSignal>> {
  const signals = new Map<string, ImpactRepoSignal>();
  const candidates = repos
    .filter((r) => passesImpactRepoGates(r, loginLower) && r.repo.includes("/"))
    // Code-unit tie-break so Go (byte order) selects the same repos.
    .sort((a, b) => b.stars - a.stars || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
    .slice(0, IMPACT_SIGNAL_REPO_CAP);
  if (!authorNodeId || candidates.length === 0) return signals;

  const varDecls = candidates.map((_, i) => `$o${i}: String!, $n${i}: String!`).join(", ");
  const aliases = candidates
    .map((_, i) => `r${i}: repository(owner: $o${i}, name: $n${i}) { ...ImpactRepoSignals }`)
    .join("\n        ");
  const query = `query($author: ID!, ${varDecls}) {
        ${aliases}
      }
      fragment ImpactRepoSignals on Repository {
        repositoryTopics(first: 20) { nodes { topic { name } } }
        stargazerCount hasIssuesEnabled isMirror
        watchers { totalCount } issues { totalCount } pullRequests { totalCount }
        defaultBranchRef {
          target {
            ... on Commit {
              history(first: ${MERGE_COMMIT_SAMPLE}, author: { id: $author }) {
                nodes { parents(first: 2) { totalCount } }
              }
            }
          }
        }
      }`;
  const variables: Record<string, unknown> = { author: authorNodeId };
  candidates.forEach((r, i) => {
    const [owner, ...name] = r.repo.split("/");
    variables[`o${i}`] = owner;
    variables[`n${i}`] = name.join("/");
  });

  let data: Record<string, ImpactRepoSignalNode | null>;
  try {
    data = await graphql<Record<string, ImpactRepoSignalNode | null>>(query, variables);
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    return signals;
  }
  candidates.forEach((r, i) => {
    const node = data[`r${i}`];
    if (!node) return;
    const commits = node.defaultBranchRef?.target?.history?.nodes ?? [];
    const engagement = engagementRatio(node as RepoEngagementFields);
    signals.set(r.repo.toLowerCase(), {
      topics: (node.repositoryTopics?.nodes ?? [])
        .map((n) => n?.topic?.name)
        .filter((t): t is string => typeof t === "string"),
      sampled_commits: commits.length,
      merge_commits: commits.filter((c) => (c?.parents?.totalCount ?? 0) > 1).length,
      ...(engagement !== undefined ? { engagement } : {}),
    });
  });
  return signals;
}
/** Repos (by stars) whose PR sample is fetched when the recent window lacks it. */
const IMPACT_CODE_SAMPLE_REPO_CAP = 12;

/**
 * Per-repo code-share samples for impact repos. The recent merged-PR window
 * (with file lists) is used first; the top {@link IMPACT_CODE_SAMPLE_REPO_CAP}
 * qualifying repos it under-covers get one aliased GraphQL search for the
 * user's newest merged PRs there. Best-effort: only a rate limit fails the
 * scan; otherwise repos without a sample use the code-share prior.
 */
export async function collectImpactCodeSamples(
  repos: ContribRepoAgg[],
  login: string,
  recentPrWindow: RecentPr[],
): Promise<Map<string, ImpactCodeSample>> {
  const loginLower = login.toLowerCase();
  const windowByRepo = new Map<string, RecentPr[]>();
  for (const pr of recentPrWindow) {
    if (!pr.repo) continue;
    const key = pr.repo.toLowerCase();
    windowByRepo.set(key, [...(windowByRepo.get(key) ?? []), pr]);
  }
  const samples = new Map<string, ImpactCodeSample>();
  for (const [key, prs] of windowByRepo) samples.set(key, impactCodeSample(prs));

  const candidates = repos
    .filter(
      (r) =>
        r.prs > 0 &&
        r.repo.includes("/") &&
        passesImpactRepoGates(r, loginLower) &&
        (r.stars >= DOC_RESOURCE_IMPACT_MIN_STARS || !isDocOrResourceRepo(r)),
    )
    // Code-unit tie-break so Go (byte order) selects the same repos.
    .sort((a, b) => b.stars - a.stars || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
    .slice(0, IMPACT_CODE_SAMPLE_REPO_CAP)
    .filter(
      (r) =>
        (windowByRepo.get(r.repo.toLowerCase())?.length ?? 0) <
        Math.min(IMPACT_CODE_SAMPLE_SIZE, r.prs),
    );
  if (candidates.length === 0) return samples;

  const varDecls = candidates.map((_, i) => `$q${i}: String!`).join(", ");
  const aliases = candidates
    .map(
      (_, i) =>
        `s${i}: search(query: $q${i}, type: ISSUE, first: ${IMPACT_CODE_SAMPLE_SIZE}) { nodes { ...CodeSamplePr } }`,
    )
    .join("\n        ");
  const query = `query(${varDecls}) {
        ${aliases}
      }
      fragment CodeSamplePr on PullRequest {
        title additions deletions changedFiles
        repository { nameWithOwner stargazerCount isPrivate }
        files(first: 100) { nodes { path additions deletions } }
      }`;
  const variables: Record<string, unknown> = {};
  candidates.forEach((r, i) => {
    variables[`q${i}`] = `repo:${r.repo} is:pr is:merged author:${login} sort:created-desc`;
  });

  let data: Record<string, { nodes: (PrNode | Record<string, never> | null)[] } | null>;
  try {
    data = await graphql(query, variables);
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    return samples;
  }
  candidates.forEach((r, i) => {
    const prs = (data[`s${i}`]?.nodes ?? [])
      .filter((n): n is PrNode => Boolean(n && "repository" in n && n.repository))
      .map(toRecentPr);
    if (prs.length > 0) samples.set(r.repo.toLowerCase(), impactCodeSample(prs));
  });
  return samples;
}

/** Best-effort key/value cache for collector facts (KV or Redis in
 * production, none in tests and fixture recording). */
export interface CollectCache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/** Own repos whose community is measured per scan (by outside merged PRs). */
const COMMUNITY_REPO_CAP = 3;
const COMMUNITY_PR_SAMPLE_PAGES = 3;
const COMMUNITY_PR_PAGE = 20;
const COMMUNITY_ISSUE_SAMPLE = 30;
const COMMUNITY_PROFILE_BATCH = 15;
const COMMUNITY_PROFILE_CONCURRENCY = 4;
/** Stop community collection when a real response shows less quota left. */
const COMMUNITY_REST_FLOOR = 300;
const COMMUNITY_GRAPHQL_FLOOR = 500;
const COMMUNITY_PROFILE_TTL = 30 * 24 * 60 * 60;
const COMMUNITY_FACTS_TTL = 7 * 24 * 60 * 60;
const COMMUNITY_COUNTS_TTL = 24 * 60 * 60;
const COMMUNITY_CACHE_VERSION = "v2";

class CommunityBudgetExhausted extends Error {}

/** Own-account repos and attributed originals that can carry a community. */
function communityCandidates(repos: ContribRepoAgg[], loginLower: string): ContribRepoAgg[] {
  return repos.filter(
    (r) =>
      !r.is_private &&
      !r.is_fork &&
      r.repo.includes("/") &&
      r.stars >= 200 &&
      r.commits + r.prs > 0 &&
      (r.attributed_original === true || r.owner_login.toLowerCase() === loginLower),
  );
}

/** Owners of the repos the user contributes to (mutual-contribution check). */
function contributedRepoOwners(repos: ContribRepoAgg[], loginLower: string): string[] {
  return [
    ...new Set(
      repos
        .filter(
          (r) =>
            r.commits + r.prs > 0 &&
            !r.attributed_original &&
            r.owner_login.toLowerCase() !== loginLower,
        )
        .map((r) => r.owner_login.toLowerCase()),
    ),
  ].sort();
}

async function cacheGet<T>(cache: CollectCache | undefined, key: string): Promise<T | null> {
  if (!cache) return null;
  try {
    return await cache.get<T>(key);
  } catch {
    return null;
  }
}

async function cacheSet(
  cache: CollectCache | undefined,
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.set(key, value, ttlSeconds);
  } catch {
    // best-effort cache
  }
}

function checkGraphqlBudget(rateLimit: { remaining?: number } | null | undefined): void {
  if (typeof rateLimit?.remaining === "number" && rateLimit.remaining < COMMUNITY_GRAPHQL_FLOOR) {
    throw new CommunityBudgetExhausted();
  }
}

/** Attempts per community GraphQL query. One failed sample would otherwise
 * leave a repo's community unmeasured and swing the score between scans. */
const COMMUNITY_GRAPHQL_ATTEMPTS = 3;

/** GraphQL with retries for transient failures (502s, timeouts); rate limits
 * and missing auth are not retried. */
async function communityGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await graphql<T>(query, variables);
    } catch (error) {
      if (
        attempt >= COMMUNITY_GRAPHQL_ATTEMPTS ||
        error instanceof GitHubRateLimitError ||
        error instanceof GitHubAuthRequiredError ||
        error instanceof GitHubCollectDeadlineError ||
        isAbortError(error)
      ) {
        throw error;
      }
      await sleep(1000 * attempt);
    }
  }
}

/** Outside merged PR counts per candidate repo (aliased, 10 per query). */
async function fetchCommunityCounts(
  candidates: ContribRepoAgg[],
  login: string,
  cache: CollectCache | undefined,
): Promise<Record<string, number>> {
  const key = `community:counts:${COMMUNITY_CACHE_VERSION}:${login.toLowerCase()}`;
  const cached = await cacheGet<Record<string, number>>(cache, key);
  if (cached && candidates.every((r) => r.repo.toLowerCase() in cached)) return cached;
  const counts: Record<string, number> = {};
  for (let i = 0; i < candidates.length; i += 10) {
    const chunk = candidates.slice(i, i + 10);
    const varDecls = chunk.map((_, j) => `$q${j}: String!`).join(", ");
    const aliases = chunk
      .map((_, j) => `c${j}: search(query: $q${j}, type: ISSUE, first: 0) { issueCount }`)
      .join("\n        ");
    const variables: Record<string, unknown> = {};
    chunk.forEach((r, j) => {
      variables[`q${j}`] = `repo:${r.repo} is:pr is:merged -author:${login}`;
    });
    const data = await communityGraphql<Record<string, { issueCount: number } | null> & {
      rateLimit: { remaining: number } | null;
    }>(`query(${varDecls}) {
        rateLimit { remaining }
        ${aliases}
      }`, variables);
    checkGraphqlBudget(data.rateLimit);
    chunk.forEach((r, j) => {
      counts[r.repo.toLowerCase()] = (data[`c${j}`] as { issueCount: number } | null)?.issueCount ?? 0;
    });
  }
  await cacheSet(cache, key, counts, COMMUNITY_COUNTS_TTL);
  return counts;
}

interface CommunityAuthorNode {
  __typename?: string;
  login?: string;
}

/** Raw community samples for one repo: contributor list (REST) plus outside
 * merged PRs, outside issues and counts (GraphQL). */
async function fetchOwnRepoCommunityRaw(repo: string, login: string): Promise<OwnRepoCommunityRaw> {
  const res = await ghFetch(`${GITHUB_API}/repos/${repo}/contributors?per_page=100`);
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  if (res.status === 403 || res.status === 429) {
    if (remaining === 0) throw new GitHubRateLimitError();
    throw new GitHubDataUnavailableError("GitHub contributors unavailable.");
  }
  if (Number.isFinite(remaining) && res.headers.has("x-ratelimit-remaining") && remaining < COMMUNITY_REST_FLOOR) {
    await res.body?.cancel().catch(() => undefined);
    throw new CommunityBudgetExhausted();
  }
  const contributors: CommunityContributor[] = res.ok
    ? ((await res.json().catch(() => [])) as { login?: string; type?: string; contributions?: number }[])
        .filter((c) => typeof c.login === "string")
        .map((c) => ({ login: c.login!, type: c.type ?? "User", contributions: c.contributions ?? 0 }))
    : [];

  const [owner, ...nameParts] = repo.split("/");
  const q = (filter: string) => `repo:${repo} ${filter} -author:${login}`;
  const counts = await communityGraphql<{
    rateLimit: { remaining: number } | null;
    repository: { forkCount: number } | null;
    closed: { issueCount: number };
    opened: { issueCount: number };
  }>(
    `query($o: String!, $n: String!, $c: String!, $p: String!) {
      rateLimit { remaining }
      repository(owner: $o, name: $n) { forkCount }
      closed: search(query: $c, type: ISSUE, first: 0) { issueCount }
      opened: search(query: $p, type: ISSUE, first: 0) { issueCount }
    }`,
    { o: owner, n: nameParts.join("/"), c: q("is:pr is:closed is:unmerged"), p: q("is:pr") },
  );
  checkGraphqlBudget(counts.rateLimit);

  const merged: CommunityPrSample[] = [];
  let mergedTotal = 0;
  let after: string | null = null;
  for (let page = 0; page < COMMUNITY_PR_SAMPLE_PAGES; page++) {
    const data: {
      search: {
        issueCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ({
          createdAt?: string;
          mergedAt?: string | null;
          additions?: number;
          deletions?: number;
          title?: string | null;
          files?: { nodes: { path: string }[] } | null;
          author?: CommunityAuthorNode | null;
        } | null)[];
      };
    } = await communityGraphql(
      `query($q: String!, $after: String) {
        search(query: $q, type: ISSUE, first: ${COMMUNITY_PR_PAGE}, after: $after) {
          issueCount
          pageInfo { hasNextPage endCursor }
          nodes { ... on PullRequest {
            createdAt mergedAt additions deletions title
            files(first: 15) { nodes { path } }
            author { __typename login }
          } }
        }
      }`,
      { q: q("is:pr is:merged sort:created-desc"), after },
    );
    mergedTotal = data.search.issueCount;
    for (const n of data.search.nodes) {
      if (!n?.createdAt || !n.mergedAt) continue;
      merged.push({
        author: n.author?.login ?? null,
        author_type: n.author?.__typename ?? null,
        created_at: n.createdAt,
        merged_at: n.mergedAt,
        title: n.title ?? null,
        churn: (n.additions ?? 0) + (n.deletions ?? 0),
        files: (n.files?.nodes ?? []).map((f) => f.path),
      });
    }
    if (!data.search.pageInfo.hasNextPage || !data.search.pageInfo.endCursor) break;
    after = data.search.pageInfo.endCursor;
  }

  const issueData = await communityGraphql<{
    search: {
      issueCount: number;
      nodes: ({
        createdAt?: string;
        author?: CommunityAuthorNode | null;
        comments?: { nodes: ({ author: { login: string } | null } | null)[] } | null;
      } | null)[];
    };
  }>(
    `query($q: String!) {
      search(query: $q, type: ISSUE, first: ${COMMUNITY_ISSUE_SAMPLE}) {
        issueCount
        nodes { ... on Issue {
          createdAt
          author { __typename login }
          comments(first: 5) { nodes { author { login } } }
        } }
      }
    }`,
    { q: q("is:issue sort:created-desc") },
  );
  const issues: CommunityIssueSample[] = issueData.search.nodes
    .filter((n): n is NonNullable<typeof n> & { createdAt: string } => Boolean(n?.createdAt))
    .map((n) => ({
      author: n.author?.login ?? null,
      author_type: n.author?.__typename ?? null,
      created_at: n.createdAt,
      commenters: (n.comments?.nodes ?? [])
        .map((c) => c?.author?.login)
        .filter((l): l is string => typeof l === "string"),
    }));

  return {
    repo,
    forks: counts.repository?.forkCount ?? 0,
    merged_total: mergedTotal,
    closed_unmerged_total: counts.closed.issueCount,
    prs_opened_total: counts.opened.issueCount,
    issues_total: issueData.search.issueCount,
    contributors,
    merged,
    issues,
  };
}

interface CommunityProfileNode {
  login: string;
  createdAt: string | null;
  followers: { totalCount: number } | null;
  pullRequests: { totalCount: number } | null;
  organizations: { nodes: ({ login: string } | null)[] } | null;
}

/** Profile facts for outside accounts, cached per login for 30 days. A
 * missing or unresolvable account gets no profile (never established). */
async function fetchCommunityProfiles(
  logins: string[],
  cache: CollectCache | undefined,
): Promise<Record<string, CommunityProfile>> {
  const profiles: Record<string, CommunityProfile> = {};
  const missing: string[] = [];
  for (const login of logins) {
    const cached = await cacheGet<CommunityProfile>(
      cache,
      `community:profile:${COMMUNITY_CACHE_VERSION}:${login}`,
    );
    if (cached) profiles[login] = cached;
    else missing.push(login);
  }
  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += COMMUNITY_PROFILE_BATCH) {
    batches.push(missing.slice(i, i + COMMUNITY_PROFILE_BATCH));
  }
  const runBatch = async (batch: string[]) => {
    const varDecls = batch.map((_, j) => `$l${j}: String!`).join(", ");
    const aliases = batch
      .map(
        (_, j) =>
          `u${j}: user(login: $l${j}) { login createdAt followers { totalCount } pullRequests(states: MERGED) { totalCount } organizations(first: 10) { nodes { login } } }`,
      )
      .join("\n        ");
    const variables: Record<string, unknown> = {};
    batch.forEach((l, j) => {
      variables[`l${j}`] = l;
    });
    let data: Record<string, CommunityProfileNode | null> | null = null;
    for (let attempt = 0; attempt < 3 && !data; attempt++) {
      try {
        data = await graphql<Record<string, CommunityProfileNode | null>>(
          `query(${varDecls}) {
        ${aliases}
      }`,
          variables,
          { allowNotFound: true },
        );
      } catch (error) {
        if (error instanceof GitHubRateLimitError) throw error;
        await sleep(1000 * (attempt + 1));
      }
    }
    for (const [j, login] of batch.entries()) {
      const node = data?.[`u${j}`];
      if (!node) continue;
      const profile: CommunityProfile = {
        login,
        created_at: node.createdAt,
        followers: node.followers?.totalCount ?? 0,
        merged_prs: node.pullRequests?.totalCount ?? 0,
        orgs: (node.organizations?.nodes ?? [])
          .map((o) => o?.login?.toLowerCase())
          .filter((o): o is string => typeof o === "string")
          .sort(),
      };
      profiles[login] = profile;
      await cacheSet(cache, `community:profile:${COMMUNITY_CACHE_VERSION}:${login}`, profile, COMMUNITY_PROFILE_TTL);
    }
  };
  for (let i = 0; i < batches.length; i += COMMUNITY_PROFILE_CONCURRENCY) {
    await Promise.all(batches.slice(i, i + COMMUNITY_PROFILE_CONCURRENCY).map(runBatch));
  }
  return profiles;
}

/**
 * Own-project community facts for the user's top {@link COMMUNITY_REPO_CAP}
 * own repos by outside merged PRs (own-account repos and attributed org
 * originals). Facts are cached per user and repo for 7 days, outside-PR counts
 * for 1 day, account profiles for 30 days. Best-effort: only a GitHub rate
 * limit fails the scan; a repo that cannot be measured, or a real response
 * showing the quota near its floor, leaves the remaining repos unmeasured.
 */
export async function collectOwnRepoCommunities(input: {
  repos: ContribRepoAgg[];
  login: string;
  ownerOrgs: string[];
  now: Date;
  cache?: CollectCache;
}): Promise<Map<string, OwnRepoCommunityFacts>> {
  const loginLower = input.login.toLowerCase();
  const facts = new Map<string, OwnRepoCommunityFacts>();
  const candidates = communityCandidates(input.repos, loginLower);
  if (candidates.length === 0) return facts;
  try {
    const counts = await fetchCommunityCounts(candidates, input.login, input.cache);
    const established = (r: ContribRepoAgg) => r.attribution_share===undefined || r.co_creator_facts?.first_author===true;
    const ranked = candidates.filter(r=>(counts[r.repo.toLowerCase()]??0)>0).sort((a,b)=>
      (counts[b.repo.toLowerCase()]??0)*projectShare(b)-(counts[a.repo.toLowerCase()]??0)*projectShare(a) || b.stars-a.stars || (a.repo<b.repo?-1:a.repo>b.repo?1:0));
    const picked = [...ranked.filter(established).slice(0,COMMUNITY_REPO_CAP),
      ...ranked.filter(r=>!established(r)).slice(0,COMMUNITY_REPO_CAP)];
    const mutualOwners = contributedRepoOwners(input.repos, loginLower);
    const ownerOrgs = input.ownerOrgs.map((o) => o.toLowerCase());
    const factsKey = (r: ContribRepoAgg) =>
      `community:facts:${COMMUNITY_CACHE_VERSION}:${loginLower}:${r.repo.toLowerCase()}`;
    const uncached: ContribRepoAgg[] = [];
    for (const r of picked) {
      const cached = await cacheGet<OwnRepoCommunityFacts>(input.cache, factsKey(r));
      if (cached) facts.set(r.repo.toLowerCase(), cached);
      else uncached.push(r);
    }
    // Raw samples for every uncached repo in parallel, then ONE deduplicated
    // profile lookup: contributors overlap heavily across a user's projects.
    const raws = await Promise.all(
      uncached.map(async (r) => {
        try {
          return await fetchOwnRepoCommunityRaw(r.repo, input.login);
        } catch (error) {
          if (error instanceof GitHubRateLimitError || error instanceof CommunityBudgetExhausted) throw error;
          return null;
        }
      }),
    );
    const logins = [
      ...new Set(
        raws.flatMap((raw) =>
          raw
            ? [
                ...raw.contributors.filter((c) => !isCommunityBot(c.login, c.type)).map((c) => c.login),
                ...raw.merged.filter((p) => !isCommunityBot(p.author, p.author_type)).map((p) => p.author!),
                ...raw.issues.filter((i) => !isCommunityBot(i.author, i.author_type)).map((i) => i.author!),
              ]
            : [],
        )
          .map((l) => l.toLowerCase())
          .filter((l) => l !== loginLower),
      ),
    ].sort();
    const profiles = logins.length ? await fetchCommunityProfiles(logins, input.cache) : {};
    for (const [i, r] of uncached.entries()) {
      const raw = raws[i];
      if (!raw) continue;
      const repoFacts = computeOwnRepoCommunityFacts(raw, {
        login: input.login,
        owner_orgs: ownerOrgs,
        attributed: r.attributed_original === true,
        mutual_owners: mutualOwners,
        profiles,
        now: input.now.toISOString(),
      });
      facts.set(r.repo.toLowerCase(), repoFacts);
      await cacheSet(input.cache, factsKey(r), repoFacts, COMMUNITY_FACTS_TTL);
    }
  } catch (error) {
    if (error instanceof GitHubRateLimitError) throw error;
    if (!(error instanceof CommunityBudgetExhausted) && !(error instanceof GitHubDataUnavailableError)) {
      throw error;
    }
  }
  return facts;
}

/** Stars at which a repo is popular enough for the engagement gate to apply. */
export const ENGAGEMENT_MIN_STARS = 500;

/**
 * Community-engagement ratio of a repo: (watchers + issues ever + PRs ever) /
 * stars. Viral-but-hollow repos (trending listicles, agent-skill drops) show
 * <1% — thousands of bookmark-stars, near-zero people filing issues or PRs —
 * while genuinely used projects run ≥5% (2026-07 top-30 regression: every
 * heavyweight flagship scored 0.05–1.39). Best-effort: any failure returns
 * undefined, which the scorer treats as "no data, no penalty" — a GitHub
 * hiccup must not tank a score.
 */
async function fetchRepoEngagementRatio(
  owner: string,
  name: string,
): Promise<number | undefined> {
  try {
    const data = await graphql<{ repository: RepoEngagementFields | null }>(
      `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          stargazerCount
          hasIssuesEnabled
          isMirror
          watchers { totalCount }
          issues { totalCount }
          pullRequests { totalCount }
        }
      }`,
      { owner, name },
    );
    return engagementRatio(data.repository);
  } catch (error) {
    rethrowIfAborted(error);
    return undefined;
  }
}

interface ContribStatTotals {
  totalCommitContributions: number;
  totalPullRequestContributions: number;
  totalIssueContributions: number;
  totalPullRequestReviewContributions: number;
}

interface ContribOverview {
  pronouns?: string | null;
  pinnedItems: { nodes: ({ nameWithOwner?: string } | null)[] };
  mergedPRs: { totalCount: number };
  allPRs: { totalCount: number };
  closedPRs: { totalCount: number; nodes: ClosedPrNode[] };
  issues: { totalCount: number };
  contributionYears: { contributionYears: number[] };
}

const CLOSED_PR_OVERVIEW_FIELDS = `closedPRs: pullRequests(states: CLOSED, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
          totalCount
          nodes {
            id
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
        }`;

const CONTRIB_OVERVIEW_FIELDS = `pronouns
        pinnedItems(first: 6, types: REPOSITORY) {
          nodes { ... on Repository { nameWithOwner } }
        }
        mergedPRs: pullRequests(states: MERGED) { totalCount }
        allPRs: pullRequests { totalCount }
        ${CLOSED_PR_OVERVIEW_FIELDS}
        issues { totalCount }
        contributionYears: contributionsCollection { contributionYears }`;

function canSplitContribQuery(error: unknown): boolean {
  return error instanceof GitHubInternalQueryError ||
    error instanceof GitHubResourceLimitError || error instanceof GitHubQueryTimeoutError;
}

async function fetchContribStats(username: string): Promise<{
  statTotals: ContribStatTotals | null;
  lastYearContributions: number;
}> {
  try {
    const data = await graphql<{ user: { contributionsCollection: ContribStatTotals & {
      contributionCalendar: { totalContributions: number };
    } } | null }>(
      `query($login: String!) { user(login: $login) { contributionsCollection {
        totalCommitContributions totalPullRequestContributions
        totalIssueContributions totalPullRequestReviewContributions
        contributionCalendar { totalContributions }
      } } }`, { login: username }, { splitOnTimeout: true },
    );
    if (!data.user?.contributionsCollection) {
      throw new GitHubDataUnavailableError("GitHub returned no contribution stats.");
    }
    const cc = data.user.contributionsCollection;
    return { statTotals: cc, lastYearContributions: cc.contributionCalendar.totalContributions };
  } catch (error) {
    if (!canSplitContribQuery(error)) throw error;
  }
  const data = await graphql<{ user: { contributionsCollection: {
    contributionCalendar: { totalContributions: number };
  } } | null }>(
    `query($login: String!) { user(login: $login) {
      contributionsCollection { contributionCalendar { totalContributions } }
    } }`, { login: username }, { splitOnTimeout: true },
  );
  const total = data.user?.contributionsCollection?.contributionCalendar?.totalContributions;
  if (typeof total !== "number") throw new GitHubDataUnavailableError("GitHub returned no contribution calendar.");
  return { statTotals: null, lastYearContributions: total };
}

/** Isolate costly stats and closed-PR nodes so their fallbacks compose. */
async function fetchSplitContribOverview(username: string): Promise<{
  overview: ContribOverview;
  statTotals: ContribStatTotals | null;
  lastYearContributions: number;
}> {
  const basicFields = CONTRIB_OVERVIEW_FIELDS.replace(CLOSED_PR_OVERVIEW_FIELDS, "");
  const [basic, stats, closedPRs] = await Promise.all([
    graphql<{ user: ContribOverview | null }>(
      `query($login: String!) { user(login: $login) { ${basicFields} } }`,
      { login: username },
    ),
    fetchContribStats(username),
    fetchClosedPrOverview(username),
  ]);
  if (!basic.user) {
    throw new GitHubDataUnavailableError("GitHub returned no split contribution data.");
  }
  return { overview: { ...basic.user, closedPRs }, ...stats };
}

/**
 * Paginated closed-PR overview (counts + who closed each one), degrading to a
 * count-only result.
 *
 * The node list is not always resolvable: GitHub can fail the entire response
 * with `errors[].type = INTERNAL` while resolving one node in the connection
 * (observed on `["user","closedPRs","nodes",2]`), and it fails the same way on
 * every retry because the offending node is data-dependent. `totalCount` alone
 * resolves fine. A failed node list is therefore worth only the "who closed it"
 * breakdown — the score itself must not go missing, so fall back to the count.
 * An empty node list is the same signal `collect()` already handles when the
 * connection is unavailable: the breakdown degrades to `unknown_closed`, never
 * to a fabricated maintainer rejection.
 */
async function fetchClosedPrOverview(
  username: string,
): Promise<{ totalCount: number; nodes: ClosedPrNode[] }> {
  try {
    const nodes: ClosedPrNode[] = [];
    let after: string | null = null;
    let totalCount = 0;
    for (let pageNumber = 0; pageNumber < 4 && nodes.length < 100; pageNumber++) {
      const fields = CLOSED_PR_OVERVIEW_FIELDS.replace("first: 100,", "first: 25, after: $after,")
        .replace("totalCount", "totalCount pageInfo { hasNextPage endCursor }");
      const data: { user: { closedPRs: { totalCount: number; nodes: ClosedPrNode[]; pageInfo: MergedPrPageInfo } } | null } = await graphql(
        `query($login: String!, $after: String) { user(login: $login) { ${fields} } }`,
        { login: username, after },
        { splitOnTimeout: true },
      );
      if (!data.user) throw new GitHubDataUnavailableError("GitHub returned no closed PR data.");
      const page = data.user.closedPRs;
      totalCount = page.totalCount;
      nodes.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) break;
      if (!page.nodes.length || !page.pageInfo.endCursor || page.pageInfo.endCursor === after) {
        throw new GitHubDataUnavailableError("GitHub closed PR pagination made no progress.");
      }
      after = page.pageInfo.endCursor;
    }
    return { totalCount, nodes };
  } catch (error) {
    if (
      !(error instanceof GitHubInternalQueryError) &&
      !(error instanceof GitHubResourceLimitError) &&
      !(error instanceof GitHubQueryTimeoutError)
    ) {
      throw error;
    }
    const countOnly = await graphql<{ user: { closedPRs: { totalCount: number } } | null }>(
      `query($login: String!) {
        user(login: $login) { closedPRs: pullRequests(states: CLOSED) { totalCount } }
      }`,
      { login: username },
    );
    if (typeof countOnly.user?.closedPRs?.totalCount !== "number") {
      throw new GitHubDataUnavailableError("GitHub returned no closed PR data.");
    }
    return { totalCount: countOnly.user.closedPRs.totalCount, nodes: [] };
  }
}

/**
 * PR / issue counts + contribution signals, normally in a single GraphQL call.
 * Counts come from `pullRequests`/`issues` totalCount (5000-point/hr GraphQL
 * bucket) rather than the REST Search API (30/min) — Search was the binding
 * rate-limit bottleneck, so moving these off it raises sustained throughput.
 *
 * Degraded fallback: GitHub prices the contributionsCollection stat
 * aggregations per account, and for hyperactive accounts (~10k+ contributions
 * in the trailing year) combining ANY two stat fields in one query trips its
 * per-query resource budget even though each field resolves fine alone
 * (observed 2026-07 on tt-a1i). On RESOURCE_LIMITS_EXCEEDED, refetch the
 * overview without the stats block, plus the calendar total — the one stat
 * scoring depends on — in its own call. The per-type totals stay null and
 * activity diversity is approximated by the caller.
 *
 * `INTERNAL` responses are handled the same way as gateway timeouts: GitHub can
 * fail a whole response while resolving one node, so the fields are re-fetched
 * in smaller pieces where the offending connection can degrade on its own.
 */
export async function fetchContribOverview(username: string): Promise<{
  overview: ContribOverview;
  statTotals: ContribStatTotals | null;
  lastYearContributions: number;
}> {
  try {
    const data = await graphql<{
      user:
        | (ContribOverview & {
            contributionsCollection: ContribStatTotals & {
              contributionCalendar: { totalContributions: number };
            };
          })
        | null;
    }>(
      `query($login: String!) {
      user(login: $login) {
        ${CONTRIB_OVERVIEW_FIELDS}
        contributionsCollection {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalPullRequestReviewContributions
          contributionCalendar { totalContributions }
        }
      }
    }`,
      { login: username },
      { splitOnTimeout: true },
    );
    if (!data.user) {
      throw new GitHubDataUnavailableError("GitHub GraphQL returned no contribution data.");
    }
    const cc = data.user.contributionsCollection;
    return {
      overview: data.user,
      statTotals: cc ?? null,
      lastYearContributions: cc?.contributionCalendar?.totalContributions ?? 0,
    };
  } catch (e) {
    if (e instanceof GitHubQueryTimeoutError) return fetchSplitContribOverview(username);
    if (e instanceof GitHubInternalQueryError) return fetchSplitContribOverview(username);
    if (!(e instanceof GitHubResourceLimitError)) throw e;
  }

  const [rest, calendar] = await Promise.all([
    graphql<{ user: ContribOverview | null }>(
      `query($login: String!) {
      user(login: $login) {
        ${CONTRIB_OVERVIEW_FIELDS}
      }
    }`,
      { login: username },
      { splitOnTimeout: true },
    ).catch(async (error) => {
      if (!canSplitContribQuery(error)) throw error;
      const [basic, closedPRs] = await Promise.all([
        graphql<{ user: ContribOverview | null }>(
          `query($login: String!) { user(login: $login) {
            ${CONTRIB_OVERVIEW_FIELDS.replace(CLOSED_PR_OVERVIEW_FIELDS, "")}
          } }`, { login: username }, { splitOnTimeout: true },
        ),
        fetchClosedPrOverview(username),
      ]);
      if (!basic.user) throw new GitHubDataUnavailableError("GitHub returned no contribution data.");
      return { user: { ...basic.user, closedPRs } };
    }),
    graphql<{
      user: {
        contributionsCollection: { contributionCalendar: { totalContributions: number } } | null;
      } | null;
    }>(
      `query($login: String!) {
      user(login: $login) {
        contributionsCollection { contributionCalendar { totalContributions } }
      }
    }`,
      { login: username },
    ),
  ]);
  if (!rest.user) {
    throw new GitHubDataUnavailableError("GitHub GraphQL returned no contribution data.");
  }
  return {
    overview: rest.user,
    statTotals: null,
    lastYearContributions:
      calendar.user?.contributionsCollection?.contributionCalendar?.totalContributions ?? 0,
  };
}

/** Pure-pipeline inputs behind a scan's score, for recorded regression
 * fixtures: impact, quality signals and weighted stars can be recomputed from
 * these without network access. */
interface ScoreInputsRecord {
  now: string;
  contrib_repos: ContribRepoAgg[];
  recent_pr_window: RecentPr[];
  star_repos: TopRepo[];
}

export interface CollectOptions {
  /** Clock override (recording fixtures). Defaults to the current time. */
  now?: Date;
  /** Receives the score inputs once collection is complete. */
  recordScoreInputs?: (inputs: ScoreInputsRecord) => void;
  /** Cache for slow-moving community facts (profiles, per-repo facts,
   * outside-PR counts). Omitted = always fetch. */
  cache?: CollectCache;
  /** Full public inventory/history; only run inside an admitted background owner. */
  full?: boolean;
  /**
   * Inventory watermark (`pushedAt`). Set only when incremental scan is on
   * and this run is not a full reconcile. PR, commit-year, and workflow
   * pulls ignore it and stay full.
   */
  inventorySince?: string;
  /**
   * Previous inventory page to merge a delta into. Incremental pulls upsert
   * by repo id and do not delete. Fork total is kept from the last full read
   * when the caller passes one.
   */
  inventoryBaseline?: { repos: CursorRepo[]; forkCount: number };
  /** Wall-clock budget for this collect. Homepage scoring sets this so the
   *  Worker can fail and serve a legacy fallback before Cloudflare's ~100s 524. */
  deadlineMs?: number;
  /** Extra abort signal combined with `deadlineMs` when both are set. */
  signal?: AbortSignal;
  /**
   * Receives the inventory page this collect scored, after an incremental
   * merge when one was applied. The cursor writer uses it. Scoring ignores it.
   */
  captureInventory?: (page: { repos: CursorRepo[]; forkCount: number }) => void;
}

export async function collect(username: string, options: CollectOptions = {}): Promise<{
  metrics: RawMetrics;
  top_repos: TopRepo[];
  recent_prs: RecentPr[];
  flood_pr_titles: string[];
  impact_repos: ImpactRepo[];
  verified_impact_prs: RecentPr[];
  pinned_repos: string[];
  organizations: string[];
  organization_maintained_repos?: OrganizationMaintainedRepo[];
  estimated_contribution_languages?: EstimatedContributionLanguages;
  collection: import("./scan-coverage").CollectionCoverage;
}> {
  if (options.deadlineMs != null || options.signal) {
    const deadlineMs = options.deadlineMs;
    const signal = options.signal;
    const rest = { ...options, deadlineMs: undefined, signal: undefined };
    const run = () => collect(username, rest);
    if (signal && deadlineMs != null) {
      return collectSignalContext.run(signal, () => withCollectDeadline(deadlineMs, run));
    }
    if (deadlineMs != null) return withCollectDeadline(deadlineMs, run);
    return collectSignalContext.run(signal!, run);
  }
  const captureInventory = options.captureInventory;
  if (!hasGithubToken()) {
    throw new GitHubAuthRequiredError("GITHUB_TOKEN is required for accurate scoring.");
  }

  const now = options.now ?? new Date();

  const user = await restGet<RestUser>(`users/${username}`);
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new AccountNotFoundError();
  }
  // REST /users/:login resolves both users and orgs. GraphQL user(login:) does not.
  if (user.type === "Organization") {
    throw new OrganizationNotSupportedError();
  }
  const login = user.login ?? username;
  const loginLower = login.toLowerCase();

  const reasons = new Set<string>();
  const scope: CollectionScope = { full: options.full, note: reason => { reasons.add(reason); } };
  const since = options.full ? "" : options.inventorySince?.trim() ?? "";
  const inventory = await fetchOriginalInventory(login, { full: options.full, since });
  const mergedInventory = mergeInventoryBaseline(inventory, options.inventoryBaseline, since);
  const repos = mergedInventory.repos;
  const inventoryForks = mergedInventory.forks;
  if (captureInventory) {
    captureInventory({
      repos: repos.flatMap((repo) => {
        const cursor = restRepoToCursor(repo);
        return cursor ? [cursor] : [];
      }),
      forkCount: inventoryForks,
    });
  }
  if (inventory.incomplete) scope.note("original_repos_page_limit");
  if (!options.full && user.public_repos > QUICK_REPO_PAGES * GITHUB_PAGE_SIZE) scope.note("public_repos_quick_limit");

  const original = repos.filter((r) => !r.fork);

  const empty = repos.filter((r) => (r.size ?? 0) === 0 && !r.fork);
  const nonemptyOriginal = original.filter((r) => (r.size ?? 0) > 0);

  const [{ overview, statTotals, lastYearContributions }, latestPublicEvent] =
    await Promise.all([fetchContribOverview(username), fetchLatestPublicEvent(username)]);
  const contributionYears = overview.contributionYears?.contributionYears ?? [];
  const pinnedRepos = (overview.pinnedItems?.nodes ?? [])
    .map((n) => n?.nameWithOwner)
    .filter((s): s is string => typeof s === "string");
  const closedPrNodes = overview.closedPRs?.nodes ?? [];
  const mergedPrCount = overview.mergedPRs?.totalCount ?? 0;
  let mergedPrContribRepos: ContribRepoAgg[] = [];
  let mergedPrContributionAggregationIncomplete = !options.full && mergedPrCount > MERGED_PR_WINDOW;
  const [commitContribRepos, workflowLandedPrs, quickExternal] = await Promise.all([
    fetchCommitContribReposByYear(login, contributionYears, scope),
    fetchWorkflowLandedPrs(login, overview.closedPRs?.totalCount ?? 0, scope),
    options.full ? Promise.resolve(null) : fetchExternalMergedPrs(login),
  ]);
  let externalMergedPrs = quickExternal;
  try {
    // The newest-300 window plus the separately queried external PRs, so own
    // PR traffic cannot crowd older external work out of the aggregate.
    const window = await fetchMergedPrNodes(login, options.full ? Infinity : MERGED_PR_WINDOW);
    if (options.full) {
      const nodes = window.filter(n => n.repository && !n.repository.isPrivate &&
        (n.repository.owner?.login ?? n.repository.nameWithOwner.split("/", 1)[0]).toLowerCase() !== loginLower);
      externalMergedPrs = { nodes, total: nodes.length };
    }
    mergedPrContribRepos = aggregateMergedPrNodes([...window, ...(externalMergedPrs?.nodes ?? [])]);
  } catch (error) {
    if (!(error instanceof GitHubResourceLimitError)) throw error;
    mergedPrContributionAggregationIncomplete = true;
    mergedPrContribRepos = aggregateMergedPrNodes(externalMergedPrs?.nodes ?? []);
  }
  const commitContributionAggregationUnavailable =
    contributionYears.length > 0 && commitContribRepos === null;
  if (mergedPrContributionAggregationIncomplete) scope.note("merged_pr_window");
  if (commitContributionAggregationUnavailable) scope.note("commit_aggregation_unavailable");
  if (!externalMergedPrs) scope.note("external_merged_unavailable");
  if (!options.full && externalMergedPrs && (externalMergedPrs.total >= EXTERNAL_MERGED_PR_CAP || externalMergedPrs.nodes.length >= EXTERNAL_MERGED_PR_CAP)) scope.note("external_merged_pr_cap");
  const workflowLandedContribRepos: ContribRepoAgg[] = workflowLandedPrs.map((pr) => ({
    repo: pr.repo,
    stars: pr.stars,
    is_private: false,
    is_fork: false,
    owner_login: pr.owner_login,
    commits: 0,
    prs: 1,
    active_years: 0,
  }));
  const mergedContribRepos = mergeContribRepoAggs([
    commitContribRepos ?? [],
    mergedPrContribRepos,
    workflowLandedContribRepos,
  ]);
  const signaledContribRepos = applyImpactRepoSignals(
    mergedContribRepos,
    await fetchImpactRepoSignals(mergedContribRepos, loginLower, user.node_id),
  );
  const organizations = await fetchOrganizations(login);
  const totalPrCount = overview.allPRs?.totalCount ?? 0;
  const closedPrBreakdown = computeClosedPrBreakdown(
    closedPrNodes,
    overview.closedPRs?.totalCount ?? 0,
    loginLower,
    new Set(workflowLandedPrs.map((pr) => pr.id)),
  );
  const issuesCreated = overview.issues?.totalCount ?? 0;
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

  // Most recent public activity. Repository pushes cover owned repos, while
  // public events cover org/external contributions and issue/comment activity.
  let lastActivity: Date | null = latestPublicEvent;
  for (const r of repos) {
    const ts = parseTs(r.pushed_at);
    if (ts && (lastActivity === null || ts > lastActivity)) lastActivity = ts;
  }
  const daysSinceActive = lastActivity
    ? Math.max(0, Math.floor((now.getTime() - lastActivity.getTime()) / dayMs))
    : null;

  const followers = user.followers ?? 0;
  const following = user.following ?? 0;

  const activityTypes = statTotals
    ? (["totalCommitContributions", "totalPullRequestContributions", "totalIssueContributions", "totalPullRequestReviewContributions"] as const).filter(
        (k) => (statTotals[k] ?? 0) > 0,
      ).length
    : // Degraded contrib fetch: per-type totals were unqueryable, so approximate
      // diversity from signals already in hand. Review activity is unknowable
      // here, so a hyperactive reviewer loses at most that one type (≤1.125 pts).
      [lastYearContributions > 0, totalPrCount > 0, issuesCreated > 0].filter(Boolean).length;

  const personalOriginalRepos = original.map((r) => repoToTopRepo(r, login));
  const attributedOriginalRepos = await collectAttributedOriginalRepos({
    contribRepos: signaledContribRepos,
    organizations,
    pinnedRepos,
    loginLower,
    profileUrl: user.html_url,
  });
  const attributedNames = new Set(
    attributedOriginalRepos.map((r) => repoDisplayName(r).toLowerCase()),
  );

  // Recent merged PRs (titles + diff size + target-repo stars). Keep the public
  // report sample at 50, but use a wider window to verify older popular-repo PRs
  // and to classify per-repo code share for ecosystem impact.
  const recentPrWindow = await fetchRecentPrs(login, 100);
  const ownedContribRepos = signaledContribRepos.map((r) =>
    attributedNames.has(r.repo.toLowerCase()) ? {
      ...r, attributed_original: true,
      attribution_share: attributedOriginalRepos.find(a=>repoDisplayName(a).toLowerCase()===r.repo.toLowerCase())?.attribution_share,
      co_creator_facts: attributedOriginalRepos.find(a=>repoDisplayName(a).toLowerCase()===r.repo.toLowerCase())?.co_creator_facts,
      attribution_evidence: attributedOriginalRepos.find((a) => repoDisplayName(a).toLowerCase() === r.repo.toLowerCase())?.attribution_evidence,
      forks: attributedOriginalRepos.find((a) => repoDisplayName(a).toLowerCase() === r.repo.toLowerCase())?.forks,
    } : { ...r, forks: personalOriginalRepos.find(a => repoDisplayName(a).toLowerCase() === r.repo.toLowerCase())?.forks ?? r.forks },
  );
  const scoredOriginalRepos = [
    ...new Map(
      [...personalOriginalRepos, ...attributedOriginalRepos].map((repo) => [
        repo.name_with_owner ?? `${repo.owner_login ?? login}/${repo.name}`,
        repo,
      ]),
    ).values(),
  ];
  // Display-only side channels (never score inputs), ported from Go:
  // independently proven org maintenance + contribution-weighted languages.
  const [organizationMaintainedRepos, estimatedContributionLanguages] = await Promise.all([
    collectOrganizationMaintainedRepos(ownedContribRepos, loginLower, user.html_url ?? null),
    collectEstimatedContributionLanguages(ownedContribRepos),
  ]);
  const attributedOriginalRepoNames = attributedOriginalRepos.map((r) => repoDisplayName(r));
  const attributedShares = Object.fromEntries(attributedOriginalRepos.map(r=>[repoDisplayName(r).toLowerCase(),projectShare(r)]));
  const attributedOriginalRepoStars = attributedOriginalRepos.reduce(
    (a, r) => a + (r.stars ?? 0)*projectShare(r),
    0,
  );
  const scoredNonemptyOriginalRepos = scoredOriginalRepos.filter((r) => (r.size ?? 0) > 0);

  const topRepos: TopRepo[] = scoredOriginalRepos
    .sort((a, b) => b.stars*projectShare(b) - a.stars*projectShare(a))
    .slice(0, 10);

  // The profile README repo (<login>/<login>) is a profile page: it never
  // counts toward star totals or stands in as the top-starred project.
  const starRepos = scoredOriginalRepos.filter((r) => !isProfileReadmeRepo(r, loginLower));
  const starTopRepos = topRepos.filter((r) => !isProfileReadmeRepo(r, loginLower));

  // README excerpts + language breakdown for the top original repos (capped to
  // limit API calls — same top-6 budget as the README fetch). The engagement
  // ratio of the top-starred repo (gates star points in score.ts) rides along
  // in the same parallel batch.
  const topStarred = starTopRepos[0];
  const [topRepoEngagementRatio] = await Promise.all([
    topStarred && topStarred.stars >= ENGAGEMENT_MIN_STARS
      ? fetchRepoEngagementRatio(topStarred.owner_login ?? login, topStarred.name)
      : Promise.resolve(undefined),
    hydrateOpenIssueCounts(topRepos),
    ...Array.from(new Map([...topRepos.slice(0,6), ...personalOriginalRepos.sort((a,b)=>b.stars-a.stars).slice(0,6)].map(r=>[repoDisplayName(r),r])).values()).map(async (repo) => {
      const owner = repo.owner_login ?? login;
      const [readme, languages, rootPaths] = await Promise.all([
        fetchReadmeDocument(owner, repo.name),
        fetchRepoLanguages(owner, repo.name),
        fetchRepoRootPaths(owner, repo.name),
      ]);
      repo.readme = readme ?? undefined;
      repo.readme_excerpt = readme?.features.prompt_summary ?? null;
      repo.languages = languages;
      repo.root_paths = rootPaths;
      repo.content_skill_share = contentSkillShare(repo);
    }),
  ]);
  const personalStarRepos=personalOriginalRepos.filter(r=>!isProfileReadmeRepo(r,loginLower));
  const personalQuality=originalProjectQuality({
    ...weightedOriginalStars(personalStarRepos, now),
    ...contentSkillSignals(personalStarRepos),
    nonempty_original_repo_count: personalOriginalRepos.filter(r=>r.size>0).length,
    total_stars: personalStarRepos.reduce((sum,r)=>sum+r.stars,0),
    max_stars: personalStarRepos.reduce((best,r)=>Math.max(best,r.stars),0),
    best_original_repo_quality_score: bestOriginalRepoQuality(personalOriginalRepos.slice(0,10),loginLower,now).score,
    top_starred_original_repo_quality_score: topStarredOriginalRepoQuality(personalStarRepos,loginLower,now).score,
    top_repo_engagement_ratio: personalStarRepos[0]?.stars>=ENGAGEMENT_MIN_STARS ? await fetchRepoEngagementRatio(personalStarRepos[0].owner_login??login,personalStarRepos[0].name) : undefined,
  } as RawMetrics);
  const bestOriginalQuality = bestOriginalRepoQuality(topRepos, loginLower, now);
  const topStarredOriginalQuality = topStarredOriginalRepoQuality(starTopRepos, loginLower, now);
  const weightedStars = { ...weightedOriginalStars(starRepos, now), ...contentSkillSignals(starRepos) };

  // Star-inflation signal: notable stars but almost no forks/issues engagement
  let starInflationSuspect = false;
  if (topStarred && topStarred.stars >= 100) {
    const top = topStarred;
    const forksPer100 = top.forks / (top.stars / 100);
    if (forksPer100 < 1.0 && top.open_issues <= 1) starInflationSuspect = true;
  }

  // Own-project community: outside people building in the user's own repos.
  // Star-inflation suspects get none. Own repos that now qualify through their
  // community (200–999★) get the merge/topic signals the first pass skipped.
  for (const repo of ownedContribRepos) {
    const original = starRepos.find(r => repoDisplayName(r).toLowerCase() === repo.repo.toLowerCase());
    if (original) repo.content_skill_share = contentSkillShare(original);
  }
  const communityRepos = applyOwnRepoCommunities(
    ownedContribRepos,
    await collectOwnRepoCommunities({
      repos: ownedContribRepos,
      login,
      ownerOrgs: organizations,
      now,
      cache: options.cache,
    }),
    starInflationSuspect,
  );
  const unsignaledCommunityRepos = communityRepos.filter(
    (r) => ((r.community ?? 0) > 0 || hasAttributedCreatorStarCredit(r, loginLower)) && r.topics === undefined,
  );
  const signaledCommunityRepos = unsignaledCommunityRepos.length
    ? applyImpactRepoSignals(
        communityRepos,
        await fetchImpactRepoSignals(unsignaledCommunityRepos, loginLower, user.node_id),
      )
    : communityRepos;
  const contribRepos = applyImpactCodeSamples(
    signaledCommunityRepos,
    await collectImpactCodeSamples(signaledCommunityRepos, login, recentPrWindow),
  );

  const recentPrs = recentPrWindow.slice(0, 50);
  const trivialPrs = recentPrs.filter((p) => p.trivial).length;
  const docLikePrCount = recentPrs.filter(isDocLikeImpactPr).length;
  const docLikePrRatio =
    recentPrs.length > 0 ? Math.round((docLikePrCount / recentPrs.length) * 100) / 100 : 0;
  const recentExternalPrs = recentPrs.filter((p) => !isOwnRepoName(p.repo, loginLower));
  const externalDocLikePrCount = recentExternalPrs.filter(isDocLikeImpactPr).length;
  const externalDocLikePrRatio =
    recentExternalPrs.length > 0
      ? Math.round((externalDocLikePrCount / recentExternalPrs.length) * 100) / 100
      : 0;

  // Templated-PR flooding signal (recent PRs across all states) — only flags
  // flooding of OTHER people's repos (own-repo floods are normal solo work).
  const flood = computeFloodSignals(await fetchRecentAllPrs(login), loginLower);

  // Ecosystem & maintainer impact: substantial work (PRs + landed commits) into
  // popular repos — others' projects (≥200★) or the user's own genuinely popular
  // repos (≥1000★). Computed from all-time per-repo contribution aggregates so
  // old high-value work (e.g. apache/flink commits) still counts. PR impact is
  // sourced from states: MERGED plus the narrowly verified official-workflow
  // path above; contribution-graph PR entries are never treated as landed work
  // because closed/unmerged PRs can appear there.
  let impact = computeImpactFromContribMap(contribRepos, loginLower);
  const workflowLandedImpactPrCount = workflowLandedPrs.filter((pr) => {
    const isExternal = pr.owner_login.toLowerCase() !== loginLower;
    return pr.stars >= (isExternal ? 200 : 1000);
  }).length;
  const impactQuality = computeImpactQualitySignals(
    recentPrWindow,
    impact.impact_pr_count,
    loginLower,
    workflowLandedImpactPrCount,
    contribRepos,
  );
  const verifiedImpactPrs = recentPrWindow
    .filter((p) => isEcosystemImpactPr(p, loginLower, contribRepos))
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

  const attributedPrs = contribRepos.reduce((sum, r) => sum +
    (r.attributed_original && r.owner_login.toLowerCase() !== loginLower ? r.prs*projectShare(r) : 0), 0);
  const externalPrCount = externalMergedPrs
    ? Math.max(0, Math.min(externalMergedPrs.total, mergedPrCount) - attributedPrs) : 0;
  const metrics: RawMetrics = {
    username: login,
    github_user_id: String(user.id),
    profile_url: user.html_url,
    avatar_url: user.avatar_url,
    name: user.name,
    bio: user.bio,
    pronouns: overview.pronouns?.trim() || null,
    company: user.company,
    account_age_years: accountAgeYears,
    created_at: user.created_at,
    followers,
    following,
    public_repos: user.public_repos ?? 0,
    fetched_repo_count: repos.length + inventoryForks,
    original_repo_count: original.length + attributedOriginalRepos.length,
    nonempty_original_repo_count:
      nonemptyOriginal.length + scoredNonemptyOriginalRepos.filter((r) => r.attributed_original).length,
    fork_repo_count: inventoryForks,
    empty_original_repo_count: empty.length,
    total_stars: starRepos.reduce((a, r) => a + (r.stars ?? 0)*projectShare(r), 0),
    max_stars: starRepos.reduce((a, r) => Math.max(a, (r.stars ?? 0)*projectShare(r)), 0),
    ...weightedStars,
    top_repo_engagement_ratio: topRepoEngagementRatio,
    personal_original_project_quality_score: personalQuality,
    attributed_original_repo_count: attributedOriginalRepos.length,
    attributed_original_repo_stars: attributedOriginalRepoStars,
    attributed_original_repos: attributedOriginalRepoNames,
    attributed_original_repo_shares: attributedShares,
    best_original_repo_quality_score: bestOriginalQuality.score,
    best_original_repo_quality_repo: bestOriginalQuality.repo,
    top_starred_original_repo_quality_score: topStarredOriginalQuality.score,
    top_starred_original_repo_quality_repo: topStarredOriginalQuality.repo,
    merged_pr_count: mergedPrCount,
    ...(externalMergedPrs
      ? {
          external_merged_pr_count: externalPrCount,
          external_high_star_pr_share: highStarPrShare(externalMergedPrs.nodes.filter((p) => !attributedNames.has((p.repository?.nameWithOwner ?? "").toLowerCase()))),
          own_pr_community: ownPrCommunityShare(
            contribRepos,
            loginLower,
            mergedPrCount - externalPrCount,
          ),
        }
      : {}),
    workflow_landed_pr_count: workflowLandedPrs.length,
    total_pr_count: totalPrCount,
    issues_created: issuesCreated,
    last_year_contributions: lastYearContributions,
    activity_type_count: activityTypes,
    contribution_years_active: boundedContributionYearsActive(
      contributionYears,
      user.created_at,
      now,
    ),
    days_since_last_activity: daysSinceActive,
    recent_merged_pr_sample: recentPrs.length,
    recent_trivial_pr_count: trivialPrs,
    recent_doc_like_pr_count: docLikePrCount,
    recent_doc_like_pr_ratio: docLikePrRatio,
    ...presentationSignals(recentPrs, loginLower, attributedOriginalRepoNames, attributedShares),
    recent_external_pr_sample: recentExternalPrs.length,
    recent_external_doc_like_pr_count: externalDocLikePrCount,
    recent_external_doc_like_pr_ratio: externalDocLikePrRatio,
    max_impact_repo_stars: maxImpactRepoStars,
    impact_prestige_score: impact.impact_prestige_score,
    impact_pr_count: impact.impact_pr_count,
    workflow_landed_impact_pr_count: workflowLandedImpactPrCount,
    impact_depth_raw: impactDepthRaw,
    verified_impact_pr_count: impact.verified_impact_pr_count,
    core_impact_pr_count: impact.core_impact_pr_count,
    doc_like_impact_pr_count: impact.doc_like_impact_pr_count,
    unverified_impact_pr_count: impact.unverified_impact_pr_count,
    impact_repo_count: impact.impact_repo_count,
    impact_repos: impact.impact_repos,
    impact_commit_count: impact.impact_commit_count,
    commit_contribution_aggregation_unavailable: commitContributionAggregationUnavailable,
    merged_pr_contribution_aggregation_incomplete: mergedPrContributionAggregationIncomplete,
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

  options.recordScoreInputs?.({
    now: now.toISOString(),
    contrib_repos: contribRepos,
    recent_pr_window: recentPrWindow,
    star_repos: starRepos,
  });

  return {
    collection: { mode: options.full ? "full" : "quick", coverage: reasons.size ? "partial_public" : "complete_public", truncation_reasons: [...reasons] },
    metrics,
    top_repos: topRepos,
    recent_prs: recentPrs,
    flood_pr_titles: flood.flood_pr_titles,
    impact_repos: impact.impact_repos,
    verified_impact_prs: verifiedImpactPrs,
    pinned_repos: pinnedRepos,
    organizations,
    ...(organizationMaintainedRepos.length
      ? { organization_maintained_repos: organizationMaintainedRepos }
      : {}),
    ...(estimatedContributionLanguages
      ? { estimated_contribution_languages: estimatedContributionLanguages }
      : {}),
  };
}
