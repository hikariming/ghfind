/**
 * GitHub public-signal collection.
 *
 * Port of `collect()` from the canonical Python skill, with the `gh` CLI replaced
 * by direct REST + GraphQL `fetch` calls authenticated with an operator PAT
 * (`GITHUB_TOKEN`). Output mirrors the script's `metrics` / `top_repos` /
 * `recent_prs` shape exactly so the scoring port consumes it unchanged.
 */

import { logRatio } from "./score";
import type {
  ImpactRepo,
  RawMetrics,
  ReadmeFeatures,
  RecentPr,
  RepoReadme,
  TopRepo,
} from "./types";

const GITHUB_API = "https://api.github.com";
const README_FETCH_LIMIT = 1024 * 1024;
const README_PROMPT_SUMMARY_LIMIT = 1500;

/** Raised when the requested account does not exist (404). */
export class AccountNotFoundError extends Error {}
/** Raised when GitHub rate-limits us (403/429 with rate-limit headers). */
export class GitHubRateLimitError extends Error {}
/** Raised when the app cannot collect GraphQL-only scoring dimensions safely. */
export class GitHubAuthRequiredError extends Error {}
export class GitHubDataUnavailableError extends Error {}

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ghfind",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

interface RestRepo {
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
  owner?: { login?: string } | null;
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
): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new GitHubAuthRequiredError("GITHUB_TOKEN is required.");
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
  } catch {
    throw new GitHubDataUnavailableError("GitHub GraphQL request failed.");
  }
  if (res.status === 403 || res.status === 429) {
    throw new GitHubRateLimitError();
  }
  if (!res.ok) {
    throw new GitHubDataUnavailableError(`GitHub GraphQL HTTP ${res.status}.`);
  }
  let json: { data?: T; errors?: { message?: string }[] };
  try {
    json = (await res.json()) as { data?: T; errors?: { message?: string }[] };
  } catch {
    throw new GitHubDataUnavailableError("GitHub GraphQL returned invalid JSON.");
  }
  if (json.errors?.length) {
    const message = json.errors[0]?.message ?? "GitHub GraphQL error.";
    throw /rate.?limit/i.test(message)
      ? new GitHubRateLimitError(message)
      : new GitHubDataUnavailableError(message);
  }
  if (!json.data) throw new GitHubDataUnavailableError("GitHub GraphQL returned no data.");
  return json.data;
}

async function fetchOrganizations(username: string): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];

  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($login: String!) {
          user(login: $login) {
            organizations(first: 20) { nodes { login } }
          }
        }`,
        variables: { login: username },
      }),
      cache: "no-store",
    });
  } catch {
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

function parseTs(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function boundedContributionYearsActive(
  contributionYears: number[],
  createdAt: string | null | undefined,
  now = new Date(),
): number {
  const activeYears = new Set(contributionYears.filter((year) => Number.isInteger(year)));
  if (activeYears.size === 0) return 0;

  const created = parseTs(createdAt);
  if (!created) return activeYears.size;

  const createdYear = created.getUTCFullYear();
  const currentYear = now.getUTCFullYear();
  if (currentYear < createdYear) return 0;

  let bounded = 0;
  for (const year of activeYears) {
    if (year >= createdYear && year <= currentYear) bounded += 1;
  }
  return bounded;
}

function meaningfulText(value: string | null | undefined): string {
  return (value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function repoDisplayName(repo: TopRepo): string {
  return repo.name_with_owner ?? repo.name;
}

function isLikelyPlaceholderProject(repo: TopRepo, loginLower: string): boolean {
  const name = repo.name.toLowerCase();
  if (!repo.attributed_original && name === loginLower) {
    return true; // profile README repo, not a product/project.
  }
  const nameAndDesc = `${name} ${repo.description ?? ""}`.toLowerCase();
  if (/\b(wip|todo|tmp|temp|scratch|playground|practice|learning|notes?|leetcode|algorithm|blog|profile)\b/.test(nameAndDesc)) {
    return true;
  }
  const readme = (repo.readme_excerpt ?? "").toLowerCase();
  return (
    (repo.readme?.features.placeholder_score ?? 0) >= 0.6 ||
    /\b(wip|todo|scratch project|playground only|learning notes)\b/.test(readme)
  );
}

/**
 * 0..1 project substance signal for original repos. Stars are scored separately;
 * this captures whether at least one original repo looks usable and maintained.
 */
export function originalRepoQualityScore(
  repo: TopRepo,
  loginLower: string,
  now = new Date(),
): number {
  if (repo.size <= 0) return 0;

  const readme = repo.readme?.features;
  const readmeLen = readme?.length ?? meaningfulText(repo.readme_excerpt).length;
  const desc = meaningfulText(repo.description);
  const pushed = parseTs(repo.pushed_at);
  const ageDays = pushed
    ? Math.floor((now.getTime() - pushed.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  let s = 0;
  if (repo.size >= 1000) s += 0.25;
  else if (repo.size >= 200) s += 0.2;
  else if (repo.size >= 50) s += 0.15;
  else if (repo.size >= 10) s += 0.08;

  if (repo.language) s += 0.15;
  if (desc.length >= 20) s += 0.15;

  if (readmeLen >= 800) s += 0.25;
  else if (readmeLen >= 300) s += 0.2;
  else if (readmeLen >= 120) s += 0.12;

  if (
    readme
      ? readme.has_install ||
        readme.has_usage ||
        readme.has_api ||
        readme.has_demo ||
        readme.has_features ||
        readme.has_deploy ||
        readme.has_test ||
        readme.has_architecture ||
        readme.has_screenshot
      : /\b(install|usage|quickstart|quick start|api|demo|features?|deploy|architecture|test|screenshot)\b/i.test(
          repo.readme_excerpt ?? "",
        )
  ) {
    s += 0.1;
  }

  if (ageDays !== null) {
    if (ageDays <= 180) s += 0.1;
    else if (ageDays <= 365) s += 0.07;
    else if (ageDays <= 730) s += 0.04;
  }

  if (isLikelyPlaceholderProject(repo, loginLower)) {
    s *= readmeLen >= 600 && repo.size >= 200 ? 0.55 : 0.25;
  }

  return Math.round(Math.max(0, Math.min(s, 1)) * 100) / 100;
}

export function bestOriginalRepoQuality(
  repos: TopRepo[],
  loginLower: string,
  now = new Date(),
): { score: number; repo: string | null } {
  let best = { score: 0, repo: null as string | null };
  for (const repo of repos) {
    const score = originalRepoQualityScore(repo, loginLower, now);
    if (score > best.score) best = { score, repo: repoDisplayName(repo) };
  }
  return best;
}

export function topStarredOriginalRepoQuality(
  repos: TopRepo[],
  loginLower: string,
  now = new Date(),
): { score: number; repo: string | null } {
  const topStarred = repos
    .filter((repo) => repo.stars > 0)
    .sort((a, b) => b.stars - a.stars)[0];
  if (!topStarred) return { score: 0, repo: null };
  return {
    score: originalRepoQualityScore(topStarred, loginLower, now),
    repo: repoDisplayName(topStarred),
  };
}

function cleanReadmeLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || /^(\[!\[|!\[)/.test(trimmed)) return "";
  return trimmed
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>|#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textMatches(text: string, words: string[]): boolean {
  return words.some((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
}

function clampText(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export function parseReadmeFeatures(markdown: string): ReadmeFeatures {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "\n").split("\n");
  const headings: { level: number; title: string }[] = [];
  const sections: { title: string; text: string }[] = [];
  let currentTitle = "intro";
  let currentLines: string[] = [];
  let inCode = false;
  let hasScreenshotImage = false;

  const pushSection = () => {
    const text = currentLines.map(cleanReadmeLine).filter(Boolean).join(" ");
    sections.push({ title: currentTitle, text });
    currentLines = [];
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const imageText = [...line.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)]
      .map(([, alt, url]) => `${alt} ${url}`)
      .join(" ");
    if (
      imageText &&
      textMatches(`${cleanReadmeLine(line)} ${imageText}`, [
        "screenshot",
        "screenshots",
        "screen",
        "demo",
        "preview",
      ])
    ) {
      hasScreenshotImage = true;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      pushSection();
      currentTitle = cleanReadmeLine(heading[2]);
      headings.push({ level: heading[1].length, title: currentTitle });
      continue;
    }
    currentLines.push(line);
  }
  pushSection();

  const usefulText = sections.map((s) => `${s.title} ${s.text}`).join(" ");
  const length = meaningfulText(usefulText).length;
  const signals = {
    install: textMatches(usefulText, ["install", "installation", "setup"]),
    usage: textMatches(usefulText, ["usage", "quickstart", "quick start", "examples?", "guide"]),
    api: textMatches(usefulText, ["api", "sdk", "reference"]),
    demo: textMatches(usefulText, ["demo", "preview", "playground"]),
    features: textMatches(usefulText, ["features?"]),
    deploy: textMatches(usefulText, ["deploy", "deployment"]),
    test: textMatches(usefulText, ["test", "testing", "tests"]),
    architecture: textMatches(usefulText, ["architecture", "design", "internals"]),
    screenshot:
      hasScreenshotImage || textMatches(usefulText, ["screenshot", "screenshots", "screen"]),
  };
  const placeholderHits = [
    /\bwip\b/i,
    /\btodo\b/i,
    /\bscratch\b/i,
    /\bplayground only\b/i,
    /\blearning notes?\b/i,
  ].filter((pattern) => pattern.test(usefulText)).length;
  const signalCount = Object.values(signals).filter(Boolean).length;
  const placeholder_score = Math.min(
    1,
    placeholderHits * 0.35 + (length < 300 && placeholderHits > 0 ? 0.3 : 0),
  );
  const content_depth_score = Math.min(
    1,
    (length >= 800 ? 0.35 : length >= 300 ? 0.2 : length >= 120 ? 0.1 : 0) +
      Math.min(headings.length, 5) * 0.06 +
      Math.min(signalCount, 5) * 0.07,
  );
  const title = headings.find((h) => h.level === 1)?.title ?? headings[0]?.title ?? null;
  const intro =
    sections.find((s) => s.title === "intro" && s.text)?.text ??
    sections.find((s) => s.text)?.text ??
    "";
  const picked = sections
    .filter((s) =>
      textMatches(s.title, [
        "install",
        "installation",
        "setup",
        "usage",
        "quickstart",
        "quick start",
        "api",
        "architecture",
        "design",
        "test",
        "demo",
        "features?",
        "deploy",
        "deployment",
      ]),
    )
    .slice(0, 4);
  const promptParts = [
    title ? `Title: ${title}` : "",
    intro ? `Intro: ${clampText(intro, 350)}` : "",
    headings.length ? `Sections: ${headings.slice(0, 12).map((h) => h.title).join(", ")}` : "",
    ...picked.map((s) => `${s.title}: ${clampText(s.text, 220)}`),
    signalCount
      ? `Signals: ${Object.entries(signals)
          .filter(([, present]) => present)
          .map(([name]) => name)
          .join(", ")}`
      : "",
  ].filter(Boolean);

  return {
    length,
    heading_count: headings.length,
    has_install: signals.install,
    has_usage: signals.usage,
    has_api: signals.api,
    has_demo: signals.demo,
    has_features: signals.features,
    has_deploy: signals.deploy,
    has_test: signals.test,
    has_architecture: signals.architecture,
    has_screenshot: signals.screenshot,
    placeholder_score: Math.round(placeholder_score * 100) / 100,
    content_depth_score: Math.round(content_depth_score * 100) / 100,
    prompt_summary: clampText(promptParts.join("\n"), README_PROMPT_SUMMARY_LIMIT),
  };
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
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
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
  ).catch(() => null);
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
  } catch {
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
  ).catch(() => null);
  if (!data) return [];
  return Object.entries(data)
    .map(([name, size]) => ({ name, size: size ?? 0 }))
    .sort((a, b) => b.size - a.size);
}

async function fetchRepoDetails(owner: string, repo: string): Promise<RestRepo | null> {
  return restGet<RestRepo>(`repos/${owner}/${repo}`).catch(() => null);
}

async function hasReleaseOrTagAuthor(owner: string, repo: string, loginLower: string): Promise<boolean> {
  const releases = await restGet<RestRelease[]>(
    `repos/${owner}/${repo}/releases?per_page=10`,
  ).catch(() => null);
  if (
    releases?.some((r) => r.author?.login?.toLowerCase() === loginLower)
  ) {
    return true;
  }

  const tags = await restGet<RestTag[]>(`repos/${owner}/${repo}/tags?per_page=5`).catch(
    () => null,
  );
  if (!tags?.length) return false;

  const commits = await Promise.all(
    tags
      .map((t) => t.commit?.sha)
      .filter((sha): sha is string => typeof sha === "string" && sha.length > 0)
      .slice(0, 5)
      .map((sha) =>
        restGet<RestCommit>(`repos/${owner}/${repo}/commits/${sha}`).catch(() => null),
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
    ).catch(() => null);
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
  };
}

function hasDocLikeTopic(repo: RestRepo): boolean {
  return (repo.topics ?? []).some((topic) =>
    /^(docs?|documentation|website|blog|examples?|templates?|tutorials?|guides?|manual)$/i.test(
      topic,
    ),
  );
}

async function collectAttributedOriginalRepos(input: {
  contribRepos: ContribRepoAgg[];
  organizations: string[];
  pinnedRepos: string[];
  loginLower: string;
  profileUrl: string | null;
}): Promise<TopRepo[]> {
  if (input.organizations.length === 0) return [];

  const candidates = input.contribRepos
    .filter((repo) =>
      computeOrgRepoAttribution({
        repo,
        organizations: input.organizations,
        pinnedRepos: input.pinnedRepos,
      }),
    )
    .sort((a, b) => b.stars - a.stars || b.commits + b.prs - (a.commits + a.prs))
    .slice(0, 8);

  const repos = await Promise.all(
    candidates.map(async (candidate) => {
      const [owner, name] = candidate.repo.split("/");
      if (!owner || !name) return null;
      const detail = await fetchRepoDetails(owner, name);
      if (!detail || detail.private || detail.fork) return null;
      if (isDocLikeRepo(candidate.repo) || hasDocLikeTopic(detail)) return null;

      const [releaseOrTagAuthorHit, maintainerFileHit] = await Promise.all([
        hasReleaseOrTagAuthor(owner, name, input.loginLower),
        hasMaintainerFileHit(owner, name, input.loginLower, input.profileUrl),
      ]);
      const attribution = computeOrgRepoAttribution({
        repo: candidate,
        organizations: input.organizations,
        pinnedRepos: input.pinnedRepos,
        releaseOrTagAuthorHit,
        maintainerFileHit,
      });
      if (!attribution) return null;
      return repoToTopRepo(detail, owner, attribution);
    }),
  );

  return repos.filter((repo): repo is TopRepo => repo !== null);
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
  if (!data.user) throw new GitHubDataUnavailableError("GitHub GraphQL returned no PR data.");
  const nodes = data.user.pullRequests?.nodes ?? [];
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
  if (!data.user) throw new GitHubDataUnavailableError("GitHub GraphQL returned no PR data.");
  const nodes = data.user.pullRequests?.nodes ?? [];
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

function repoOwner(nameWithOwner: string | null | undefined): string {
  const repo = nameWithOwner ?? "";
  return repo.includes("/") ? repo.split("/", 1)[0].toLowerCase() : "";
}

function isOwnRepoName(nameWithOwner: string | null | undefined, loginLower: string): boolean {
  return repoOwner(nameWithOwner) === loginLower;
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

/** One repo's all-time contribution aggregate, keyed by `nameWithOwner`.
 * `commits` comes from the contribution graph; `prs` must come from merged PRs
 * only. GitHub's PR contribution graph can include opened-but-unmerged PRs, so
 * it is not safe as a landed-impact source. */
export interface ContribRepoAgg {
  repo: string;
  stars: number;
  is_private: boolean;
  is_fork: boolean;
  owner_login: string;
  commits: number;
  prs: number;
  active_years: number;
}

export interface OrgRepoAttribution {
  repo: string;
  evidence: string[];
  score: number;
}

export const ORG_ATTRIBUTED_MIN_SCORE = 5;
export const ORG_ATTRIBUTED_COMMIT_MIN = 50;
export const ORG_ATTRIBUTED_MIXED_COMMIT_MIN = 20;
export const ORG_ATTRIBUTED_MIXED_PR_MIN = 10;
export const ORG_ATTRIBUTED_ACTIVE_YEAR_MIN = 2;

function repoName(nameWithOwner: string | null | undefined): string {
  const repo = (nameWithOwner ?? "").toLowerCase();
  return repo.includes("/") ? repo.split("/").pop() ?? "" : repo;
}

function isDocLikeRepo(nameWithOwner: string | null | undefined): boolean {
  const name = repoName(nameWithOwner);
  return (
    /(^|[-_.])(docs?|site|website|blog|examples?|templates?|profile|notebook|learning|tutorial|interview|guide|manual)([-_.]|$)/.test(
      name,
    ) || name.endsWith(".github.io")
  );
}

function hasStrongLongTermOrgContribution(repo: ContribRepoAgg): boolean {
  if (repo.active_years >= ORG_ATTRIBUTED_ACTIVE_YEAR_MIN) {
    if (repo.commits >= ORG_ATTRIBUTED_COMMIT_MIN) return true;
    return (
      repo.commits >= ORG_ATTRIBUTED_MIXED_COMMIT_MIN &&
      repo.prs >= ORG_ATTRIBUTED_MIXED_PR_MIN
    );
  }

  // A very high commit count is still strong enough when the public contribution
  // graph only exposes one recent year for the account/repo pair.
  return repo.commits >= ORG_ATTRIBUTED_COMMIT_MIN * 2;
}

export function computeOrgRepoAttribution(input: {
  repo: ContribRepoAgg;
  organizations: string[];
  pinnedRepos?: string[];
  releaseOrTagAuthorHit?: boolean;
  maintainerFileHit?: boolean;
}): OrgRepoAttribution | null {
  const owner = input.repo.owner_login.toLowerCase();
  const organizations = new Set(input.organizations.map((o) => o.toLowerCase()));
  if (!organizations.has(owner)) return null;
  if (input.repo.is_private || input.repo.is_fork) return null;
  if (isDocLikeRepo(input.repo.repo)) return null;
  if (!hasStrongLongTermOrgContribution(input.repo)) return null;

  const evidence = [
    `org member of ${input.repo.owner_login}`,
    `${input.repo.commits} commits + ${input.repo.prs} PRs across ${input.repo.active_years} years`,
  ];
  let score = 1 + 4;

  if ((input.pinnedRepos ?? []).some((r) => r.toLowerCase() === input.repo.repo.toLowerCase())) {
    score += 1;
    evidence.push("pinned by user");
  }
  if (input.releaseOrTagAuthorHit) {
    score += 3;
    evidence.push("release/tag author");
  }
  if (input.maintainerFileHit) {
    score += 3;
    evidence.push("listed in maintainer/codeowner docs");
  }

  return score >= ORG_ATTRIBUTED_MIN_SCORE
    ? { repo: input.repo.repo, evidence, score }
    : null;
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
}

/**
 * Fetch all-time per-repo commit contributions by aliasing one
 * `contributionsCollection(from,to)` per year (GraphQL caps each to a 1-year
 * span), capped to the most recent {@link IMPACT_YEAR_CAP} years.
 */
async function fetchCommitContribReposByYear(
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
  if (!data.user) throw new GitHubDataUnavailableError("GitHub GraphQL returned no contribution data.");

  // Merge per-year per-repo aggregates: sum commits/prs, take max stars.
  const map = new Map<string, ContribRepoAgg>();
  const yearsByRepo = new Map<string, Set<number>>();
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
  };
  for (let i = 0; i < capped.length; i++) {
    const yc = data.user[`y${i}`];
    if (!yc) continue;
    for (const n of yc.commitContributionsByRepository ?? []) ingest(n, capped[i]);
  }
  return [...map.entries()].map(([key, value]) => ({
    ...value,
    active_years: yearsByRepo.get(key)?.size ?? 0,
  }));
}

interface MergedPrRepoNode {
  mergedAt: string | null;
  repository: {
    nameWithOwner: string;
    stargazerCount: number;
    isPrivate: boolean;
    isFork: boolean;
    owner: { login: string } | null;
  } | null;
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

async function fetchMergedPrContribRepos(
  username: string,
  maxPrs = 300,
): Promise<ContribRepoAgg[]> {
  const map = new Map<string, ContribRepoAgg>();
  const yearsByRepo = new Map<string, Set<number>>();
  let after: string | null = null;

  while (map.size < maxPrs) {
    const remaining = Math.max(0, maxPrs - [...map.values()].reduce((a, r) => a + r.prs, 0));
    if (remaining === 0) break;
    const count = Math.min(100, remaining);
    const data: MergedPrReposResponse = await graphql<MergedPrReposResponse>(
      `query($login: String!, $count: Int!, $after: String) {
        user(login: $login) {
          pullRequests(first: $count, states: MERGED, after: $after,
                       orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes {
              mergedAt
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
    for (const node of pullRequests.nodes ?? []) {
      const repo = node.repository;
      if (!repo) continue;
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
      entry.prs += 1;
      map.set(key, entry);
      const year = node.mergedAt ? parseTs(node.mergedAt)?.getUTCFullYear() : null;
      if (year) {
        const years = yearsByRepo.get(key) ?? new Set<number>();
        years.add(year);
        yearsByRepo.set(key, years);
      }
    }

    const pageInfo: MergedPrPageInfo = pullRequests.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }

  return [...map.entries()].map(([key, value]) => ({
    ...value,
    active_years: yearsByRepo.get(key)?.size ?? 0,
  }));
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
      map.set(repo.repo, entry);
    }
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
  pinned_repos: string[];
  organizations: string[];
}> {
  if (!process.env.GITHUB_TOKEN) {
    throw new GitHubAuthRequiredError("GITHUB_TOKEN is required for accurate scoring.");
  }

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
      pinnedItems: { nodes: ({ nameWithOwner?: string } | null)[] };
    } | null;
  }>(
    `query($login: String!) {
      user(login: $login) {
        pinnedItems(first: 6, types: REPOSITORY) {
          nodes { ... on Repository { nameWithOwner } }
        }
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
  if (!contrib.user) {
    throw new GitHubDataUnavailableError("GitHub GraphQL returned no contribution data.");
  }
  const cc = contrib.user.contributionsCollection;
  const contributionYears = contrib.user.contributionYears?.contributionYears ?? [];
  const pinnedRepos = (contrib.user.pinnedItems?.nodes ?? [])
    .map((n) => n?.nameWithOwner)
    .filter((s): s is string => typeof s === "string");
  const [commitContribRepos, mergedPrContribRepos] = await Promise.all([
    fetchCommitContribReposByYear(login, contributionYears),
    fetchMergedPrContribRepos(login),
  ]);
  const contribRepos = mergeContribRepoAggs([
    commitContribRepos ?? [],
    mergedPrContribRepos,
  ]);
  const organizations = await fetchOrganizations(login);
  const mergedPrCount = contrib.user.mergedPRs?.totalCount ?? 0;
  const totalPrCount = contrib.user.allPRs?.totalCount ?? 0;
  const closedPrBreakdown = computeClosedPrBreakdown(
    contrib.user.closedPRs?.nodes ?? [],
    contrib.user.closedPRs?.totalCount ?? 0,
    loginLower,
  );
  const issuesCreated = contrib.user.issues?.totalCount ?? 0;
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

  const personalOriginalRepos = original.map((r) => repoToTopRepo(r, login));
  const attributedOriginalRepos = contribRepos
    ? await collectAttributedOriginalRepos({
        contribRepos,
        organizations,
        pinnedRepos,
        loginLower,
        profileUrl: user.html_url,
      })
    : [];
  const scoredOriginalRepos = [
    ...new Map(
      [...personalOriginalRepos, ...attributedOriginalRepos].map((repo) => [
        repo.name_with_owner ?? `${repo.owner_login ?? login}/${repo.name}`,
        repo,
      ]),
    ).values(),
  ];
  const attributedOriginalRepoNames = attributedOriginalRepos.map((r) => repoDisplayName(r));
  const attributedOriginalRepoStars = attributedOriginalRepos.reduce(
    (a, r) => a + (r.stars ?? 0),
    0,
  );
  const scoredNonemptyOriginalRepos = scoredOriginalRepos.filter((r) => (r.size ?? 0) > 0);

  const topRepos: TopRepo[] = scoredOriginalRepos
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 10);

  // README excerpts + language breakdown for the top original repos (capped to
  // limit API calls — same top-6 budget as the README fetch).
  await Promise.all(
    topRepos.slice(0, 6).map(async (repo) => {
      const owner = repo.owner_login ?? login;
      const [readme, languages] = await Promise.all([
        fetchReadmeDocument(owner, repo.name),
        fetchRepoLanguages(owner, repo.name),
      ]);
      repo.readme = readme ?? undefined;
      repo.readme_excerpt = readme?.features.prompt_summary ?? null;
      repo.languages = languages;
    }),
  );
  const bestOriginalQuality = bestOriginalRepoQuality(topRepos, loginLower, now);
  const topStarredOriginalQuality = topStarredOriginalRepoQuality(topRepos, loginLower, now);

  // Recent merged PRs (titles + diff size + target-repo stars). Keep the public
  // report sample at 50, but use a wider window to verify older popular-repo PRs
  // before applying impact-quality caps.
  const recentPrWindow = await fetchRecentPrs(login, 100);
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
  // sourced from states: MERGED only; contribution-graph PR entries are not
  // treated as landed work because closed/unmerged PRs can appear there.
  let impact = computeImpactFromContribMap(contribRepos, loginLower);
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
    original_repo_count: original.length + attributedOriginalRepos.length,
    nonempty_original_repo_count:
      nonemptyOriginal.length + scoredNonemptyOriginalRepos.filter((r) => r.attributed_original).length,
    fork_repo_count: forks.length,
    empty_original_repo_count: empty.length,
    total_stars: scoredOriginalRepos.reduce((a, r) => a + (r.stars ?? 0), 0),
    max_stars: scoredOriginalRepos.reduce((a, r) => Math.max(a, r.stars ?? 0), 0),
    attributed_original_repo_count: attributedOriginalRepos.length,
    attributed_original_repo_stars: attributedOriginalRepoStars,
    attributed_original_repos: attributedOriginalRepoNames,
    best_original_repo_quality_score: bestOriginalQuality.score,
    best_original_repo_quality_repo: bestOriginalQuality.repo,
    top_starred_original_repo_quality_score: topStarredOriginalQuality.score,
    top_starred_original_repo_quality_repo: topStarredOriginalQuality.repo,
    merged_pr_count: mergedPrCount,
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
    recent_external_pr_sample: recentExternalPrs.length,
    recent_external_doc_like_pr_count: externalDocLikePrCount,
    recent_external_doc_like_pr_ratio: externalDocLikePrRatio,
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
    pinned_repos: pinnedRepos,
    organizations,
  };
}
