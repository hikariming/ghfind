/**
 * Evidence -> RawMetrics derivation (public, deterministic).
 *
 * Moved verbatim from the website collector (src/lib/github.ts). Everything in
 * this file is a pure function of already-collected public GitHub evidence:
 * no network, environment, token, cache, or clock access beyond an injectable
 * `now` parameter. The collector that fetches the evidence (API calls, token
 * pool, rate limiting, caching) is deliberately NOT part of @ghfind/scoring.
 */
import { prPresentationShare } from "./presentation-concentration";
import { RECENT_MAINTENANCE_DAYS, coCreatorShare, projectShare } from "./co-creator";
import type { CoCreatorFacts } from "./co-creator";
import { logRatio, starEngagementMultiplier } from "./score";
import type { ImpactRepo, ReadmeFeatures, RecentPr, TopRepo } from "./types";

const README_PROMPT_SUMMARY_LIMIT = 1500;

export function parseTs(value: string | null | undefined): Date | null {
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

export function repoDisplayName(repo: TopRepo): string {
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

// A "notes"/"learning" keyword is weak evidence once a substantive repo has
// real organic traction (many stars backed by a healthy fork share). Such repos
// (e.g. widely-used tutorials) keep a lighter discount instead of the 0.55
// placeholder penalty; bought stars rarely come with proportional forks.
export const PLACEHOLDER_TRACTION_MIN_STARS = 500;

export const PLACEHOLDER_TRACTION_MIN_FORK_RATIO = 0.03;

export const PLACEHOLDER_TRACTION_MULTIPLIER = 0.75;

function hasOrganicProjectTraction(repo: TopRepo): boolean {
  return (
    repo.stars >= PLACEHOLDER_TRACTION_MIN_STARS &&
    repo.forks >= repo.stars * PLACEHOLDER_TRACTION_MIN_FORK_RATIO
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
    const substantive = readmeLen >= 600 && repo.size >= 200;
    s *= substantive
      ? hasOrganicProjectTraction(repo)
        ? PLACEHOLDER_TRACTION_MULTIPLIER
        : 0.55
      : 0.25;
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
    const score = originalRepoQualityScore(repo, loginLower, now) * projectShare(repo);
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
    .sort((a, b) => b.stars*projectShare(b) - a.stars*projectShare(a))[0];
  if (!topStarred) return { score: 0, repo: null };
  return {
    // Stars are already weighted by attribution share; multiplying the
    // project-substance score by the share again would make every co-led repo
    // look like a weak profile/config showcase.
    score: originalRepoQualityScore(topStarred, loginLower, now),
    repo: repoDisplayName(topStarred),
  };
}

/** The `<login>/<login>` profile README repo: a profile page, not a project. */
export function isProfileReadmeRepo(repo: TopRepo, loginLower: string): boolean {
  return (
    !repo.attributed_original &&
    repo.name.toLowerCase() === loginLower &&
    (repo.owner_login ?? loginLower).toLowerCase() === loginLower
  );
}

const CONTENT_REPO_NAME = /(^|[-_.])(datasets?|awesome|papers?|books?|cheat-?sheets?|prompts?|skills?|handbooks?|playbooks?)([-_.]|$)/i;

const CONTENT_REPO_TOPIC = /^(datasets?|awesome|awesome-lists?|books?|courses?|tutorials?|notes|docs|documentation|papers?|cheatsheets?|prompts?|skills?|agent-skills?|handbooks?|playbooks?)$/i;

const NON_CODE_LANGUAGES = new Set([
  "asciidoc",
  "html",
  "markdown",
  "mdx",
  "restructuredtext",
  "rst",
  "plain text",
  "rich text format",
  "roff",
  "tex",
  "text",
]);

/** Continuous content evidence; missing language data is neutral. Code bytes
 * suppress naming evidence so a tool that ships skills stays a software repo. */
export function contentSkillShare(repo: TopRepo): number {
  const named = CONTENT_REPO_NAME.test(repo.name) || (repo.topics ?? []).some(t => CONTENT_REPO_TOPIC.test(t));
  const languages = repo.languages ?? [];
  const total = languages.reduce((n, l) => n + Math.max(0, l.size), 0);
  const nonCode = languages.filter(l => NON_CODE_LANGUAGES.has(l.name.toLowerCase())).reduce((n, l) => n + Math.max(0, l.size), 0);
  const prose = total > 0 ? nonCode / total : 0;
  const naming = named ? 0.55 * (total > 0 ? 0.2 + 0.8 * prose : 1) : 0;
  const paths = repo.root_paths?.map(p => p.toLowerCase());
  if (!paths?.length) return 1 - (1 - prose) * (1 - naming);
  const markdown = Math.max(0, paths.filter(p => /\.(md|mdx|rst|adoc|txt)$/.test(p)).length - 1) / paths.length;
  const skill = paths.some(p => /^(skill\.md|skills|prompts|\.claude)$/.test(p));
  const layout = 1 - (1 - 0.75 * markdown) * (1 - (skill ? 0.65 : 0));
  const application = paths.some(p => /^(src|app|lib|cmd|crates|packages|backend|frontend|server|client|api|core|include|sources)$|\.(go|rs|py|ts|tsx|js|jsx|java|kt|cs|cpp|cc|c|swift)$/.test(p));
  const protection = application && total > 0 ? 1 - 0.85 * (1 - prose) : 1;
  return (1 - (1 - prose) * (1 - (named ? 0.55 : 0)) * (1 - layout)) * protection;
}

export function contentSkillSignals(repos: TopRepo[]) {
  let stars = 0, content = 0, evidence = 0;
  for (const repo of repos) {
    const weight = Math.max(0, repo.stars) * projectShare(repo);
    stars += weight;
    content += weight * contentSkillShare(repo);
    evidence += weight * ((repo.root_paths?.length || (repo.languages ?? []).some(l => l.size > 0)) ? 1 : 0.5);
  }
  return { content_skill_star_share: stars > 0 ? content / stars : 0,
    content_skill_confidence: stars > 0 ? evidence / stars : 0 };
}

const STAR_LIVENESS_FULL_MONTHS = 12;

const STAR_LIVENESS_FLOOR_MONTHS = 36;

const STAR_LIVENESS_FLOOR = 0.5;

const MONTH_MS = (365.25 / 12) * 24 * 60 * 60 * 1000;

/** Star weight for Original Project Quality: liveness (1.0 when pushed within
 * 12 months, falling linearly to 0.5 at 36) × continuous content-kind weight (floor 0.25). */
export function originalRepoStarWeight(repo: TopRepo, now: Date): number {
  const pushed = parseTs(repo.pushed_at);
  let liveness = 1;
  if (pushed) {
    const months = Math.max(0, (now.getTime() - pushed.getTime()) / MONTH_MS);
    const stale = Math.min(
      Math.max((months - STAR_LIVENESS_FULL_MONTHS) / (STAR_LIVENESS_FLOOR_MONTHS - STAR_LIVENESS_FULL_MONTHS), 0),
      1,
    );
    liveness = 1 - (1 - STAR_LIVENESS_FLOOR) * stale;
  }
  const share = contentSkillShare(repo);
  return liveness * (1 - 0.75 * share * share * (3 - 2 * share));
}

/** Liveness- and kind-weighted star total / max over the scored originals. */
export function weightedOriginalStars(
  repos: TopRepo[],
  now: Date,
): { weighted_total_stars: number; weighted_max_stars: number } {
  let total = 0;
  let maxStars = 0;
  for (const repo of repos) {
    const weighted = Math.max(0, repo.stars ?? 0) * projectShare(repo) * originalRepoStarWeight(repo, now);
    total += weighted;
    maxStars = Math.max(maxStars, weighted);
  }
  return {
    weighted_total_stars: Math.round(total * 100) / 100,
    weighted_max_stars: Math.round(maxStars * 100) / 100,
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

export interface AnyPr {
  title: string;
  repo: string;
}

export interface ClosedPrNode {
  id?: string | null;
  author: { login: string } | null;
  repository: { owner: { login: string } | null } | null;
  timelineItems: {
    nodes: ({ actor: { login: string } | null } | null)[];
  } | null;
}

interface WorkflowTimelineActor {
  login: string | null;
  __typename: string;
}

export interface WorkflowLandedPrNode {
  __typename: "PullRequest";
  id: string;
  mergedAt: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  repository: {
    nameWithOwner: string;
    stargazerCount: number;
    isPrivate: boolean;
    isFork: boolean;
    owner: { login: string } | null;
  } | null;
  timelineItems: {
    nodes: ({
      __typename: "LabeledEvent";
      createdAt: string;
      actor: WorkflowTimelineActor | null;
      label: { name: string } | null;
    } | {
      __typename: "ClosedEvent";
      createdAt: string;
      actor: WorkflowTimelineActor | null;
    } | null)[];
  } | null;
}

/**
 * A few large projects merge through an official bot, then close the GitHub PR
 * instead of setting `mergedAt`. Do not generalize from the label alone: the
 * same official merge bot must apply the exact Merged label and close the PR in
 * that order. GitHub represents some repository bots (for example
 * `pytorchmergebot`) as User rather than Bot, so a narrow merge/land-bot login
 * pattern is accepted in addition to the Bot actor type.
 */
export function isWorkflowLandedPr(node: WorkflowLandedPrNode): boolean {
  if (node.mergedAt || !node.repository || node.repository.isPrivate || node.repository.isFork) {
    return false;
  }

  const events = node.timelineItems?.nodes ?? [];
  const mergedEvents = events.filter(
    (event): event is Extract<NonNullable<typeof event>, { __typename: "LabeledEvent" }> =>
      event?.__typename === "LabeledEvent" && event.label?.name.trim().toLowerCase() === "merged",
  );
  return mergedEvents.some((merged) => {
    const bot = merged.actor;
    if (!isOfficialMergeBotActor(bot)) return false;
    const botLogin = bot.login.toLowerCase();
    return events.some(
      (event) =>
        event?.__typename === "ClosedEvent" &&
        event.createdAt >= merged.createdAt &&
        event.actor?.login?.toLowerCase() === botLogin &&
        isOfficialMergeBotActor(event.actor),
    );
  });
}

function isOfficialMergeBotActor(actor: WorkflowTimelineActor | null): actor is WorkflowTimelineActor & { login: string } {
  return Boolean(
    actor?.login &&
      (actor.__typename === "Bot" || /(?:merge|land)[-_]?bot$/i.test(actor.login)),
  );
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
  workflowLandedIds: ReadonlySet<string> = new Set(),
): ClosedPrBreakdown {
  let maintainerClosed = 0;
  let selfClosedExternal = 0;
  let selfClosedOwnRepo = 0;
  let unknownClosed = Math.max(0, total - nodes.length);

  for (const node of nodes) {
    if (node.id && workflowLandedIds.has(node.id)) continue;
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
    closed_unmerged_pr_count: Math.max(0, total - workflowLandedIds.size),
    maintainer_closed_unmerged_pr_count: maintainerClosed,
    self_closed_external_pr_count: selfClosedExternal,
    self_closed_own_repo_pr_count: selfClosedOwnRepo,
    unknown_closed_unmerged_pr_count: unknownClosed,
  };
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
 * Whether a merged PR is a verifiable ecosystem PR: a substantial (non-trivial)
 * PR into someone else's repo with ≥200 stars. These samples feed the
 * verified/core impact counts behind the core-PR bonus and newcomer
 * confidence, so they are external only: maintaining one's own popular repo is
 * credited through the contribution aggregates and Original Project Quality,
 * not as "ecosystem" PRs.
 */
export function isEcosystemImpactPr(pr: RecentPr, loginLower: string, repos?: ContribRepoAgg[]): boolean {
  const owner = repoOwner(pr.repo);
  if (!owner || owner === loginLower || pr.trivial) return false;
  const repo = repos?.find((r) => r.repo.toLowerCase() === pr.repo?.toLowerCase());
  if (repo && isOwnImpactRepo(repo, loginLower) && projectShare(repo)>=1) {
    return hasAttributedCreatorStarCredit(repo, loginLower) && passesImpactRepoGates(repo, loginLower) &&
      (repo.stars >= DOC_RESOURCE_IMPACT_MIN_STARS || !isDocOrResourceRepo(repo));
  }
  return pr.repo_stars >= 200;
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

export function repoOwner(nameWithOwner: string | null | undefined): string {
  const repo = nameWithOwner ?? "";
  return repo.includes("/") ? repo.split("/", 1)[0].toLowerCase() : "";
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

const STYLE_FILE = /\.(css|scss|sass|less|styl)$/i;

// UI libraries, design systems and component kits ship their styles: there a
// stylesheet is product code, not presentation (e.g. ant-design/x).
const UI_LIBRARY_REPO = /(^|[-_./])(ui|design|design-system|components?|widgets?|styles?|css|themes?|antd|mui|chakra|shadcn|patternfly|tailwind(css)?)([-_./]|$)/i;

export function isUiLibraryRepo(nameWithOwner: string | null | undefined): boolean {
  return UI_LIBRARY_REPO.test(nameWithOwner ?? "");
}

function isPresentationOnlyPath(path: string, uiLibrary = false): boolean {
  const p = path.toLowerCase();
  if (uiLibrary && STYLE_FILE.test(p)) return false;
  return (
    /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp)$/i.test(p) ||
    /(^|\/)(__snapshots__|demo|demos|examples?|templates?|storybook|screenshots?|assets?|public)(\/|$)/.test(
      p,
    ) ||
    /(^|\/)(site|website|docs?|pages\/home|components\/homepage)(\/|$)/.test(p)
  );
}

function isCoreCodePath(path: string, uiLibrary = false): boolean {
  const p = path.toLowerCase();
  if (isDocLikePath(p) || isPresentationOnlyPath(p, uiLibrary)) return false;
  if (uiLibrary && STYLE_FILE.test(p)) return true;
  return /\.(c|cc|cpp|cs|go|java|js|jsx|kt|m|mm|php|py|rb|rs|scala|swift|ts|tsx)$/i.test(
    p,
  );
}

export function isDocLikeImpactPr(pr: RecentPr): boolean {
  const share = prPresentationShare(pr);
  if (share !== undefined) return share >= 0.6;
  if (isDocLikeRepo(pr.repo)) return true;
  const title = pr.title ?? "";
  if (/\b(docs?|readme|typo|translate|translation|i18n|website|site|blog|examples?|templates?|tutorial|guide)\b/i.test(title)) {
    return true;
  }

  const files = pr.files ?? [];
  if (files.length === 0) return false;
  const uiLibrary = isUiLibraryRepo(pr.repo);
  const docLike = files.filter(
    (file) => isDocLikePath(file) || isPresentationOnlyPath(file, uiLibrary),
  ).length;
  const coreCode = files.filter((file) => isCoreCodePath(file, uiLibrary)).length;
  return docLike > 0 && (coreCode === 0 || docLike / files.length >= 0.6);
}

export interface ImpactQualitySignals {
  verified_impact_pr_count: number;
  core_impact_pr_count: number;
  doc_like_impact_pr_count: number;
  unverified_impact_pr_count: number;
}

/**
 * Verified external ecosystem PRs in the recent file-level window, split into
 * core and doc-like. Doc-heavy work is weighted per repo by code share inside
 * {@link computeImpactFromContribMap}; these counts only feed the core-PR
 * bonus, newcomer confidence and report context.
 */
export function computeImpactQualitySignals(
  recentPrs: RecentPr[],
  impactPrCount: number,
  loginLower: string,
  workflowLandedImpactPrCount = 0,
  repos?: ContribRepoAgg[],
): ImpactQualitySignals {
  const verifiedImpactPrs = recentPrs.filter((p) => isEcosystemImpactPr(p, loginLower, repos));
  const docLikeCount = verifiedImpactPrs.filter(isDocLikeImpactPr).length;
  // Bot-verified workflow landings are valid impact facts, but lack the
  // file-level sample needed to classify them as core/doc-like. Keep them out
  // of the "unverified" bucket without inventing a code-quality label.
  const unverifiedCount = Math.max(
    0,
    impactPrCount - verifiedImpactPrs.length - workflowLandedImpactPrCount,
  );
  return {
    verified_impact_pr_count: verifiedImpactPrs.length,
    core_impact_pr_count: verifiedImpactPrs.length - docLikeCount,
    doc_like_impact_pr_count: docLikeCount,
    unverified_impact_pr_count: unverifiedCount,
  };
}

/** One repo's all-time contribution aggregate, keyed by `nameWithOwner`.
 * `commits` comes from the contribution graph; `prs` come from GitHub-native
 * merges plus separately verified repository-workflow landings. GitHub's PR
 * contribution graph can include opened-but-unmerged PRs, so it is not safe as
 * a landed-impact source. */
export interface ContribRepoAgg {
  content_skill_share?: number;
  repo: string;
  stars: number;
  is_private: boolean;
  is_fork: boolean;
  owner_login: string;
  commits: number;
  prs: number;
  active_years: number;
  /** Estimated share of `commits` that are merge commits (more than one
   * parent). Merging other people's PRs is bookkeeping, not authored work.
   * Absent when the repo signal query was unavailable. */
  merge_commits?: number;
  /** GitHub topics, used to recognise resource collections (awesome lists,
   * courses, notes). Absent when the repo signal query was unavailable. */
  topics?: string[];
  /** Distinct "YYYY-MM" months with a merged PR or an authored commit here.
   * Absent or empty = unknown (no tenure discount). */
  months?: string[];
  /** The user's merged PRs here that were file-classified (≤10), and how many
   * of them were code rather than docs/site/examples. Absent = no sample. */
  pr_sample?: number;
  code_pr_sample?: number;
  /** Community engagement ratio ((watchers + issues + PRs) / stars) for the
   * repo, from the signal query. Absent = not measured. */
  engagement?: number;
  /** An org repo credited as the user's original project: it counts as own. */
  attributed_original?: boolean;
  attribution_share?: number;
  co_creator_facts?: CoCreatorFacts;
  attribution_evidence?: string[];
  forks?: number;
  star_inflation_suspect?: boolean;
  star_inflation_severity?: number;
  /** Own-project community facts (own-account repos and attributed originals
   * with outside contributors). Absent = not measured. */
  community_facts?: OwnRepoCommunityFacts;
  /** 0..1 community score from {@link ownRepoCommunity}; 0 when the account
   * is a star-inflation suspect. Absent = not measured. */
  community?: number;
}

export interface OrgRepoAttribution {
  repo: string;
  evidence: string[];
  score: number;
  share?: number;
  facts?: CoCreatorFacts;
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

// Popular registries/directories where a typical contribution is a personal
// entry rather than shipped software. Keep this exact-match list deliberately
// small: generic names such as "register" can also belong to real codebases.
const LOW_SIGNAL_ENTRY_REPOS = new Set(["is-a-dev/register", "tuna/blogroll"]);

function isLowSignalEntryRepo(nameWithOwner: string | null | undefined): boolean {
  return LOW_SIGNAL_ENTRY_REPOS.has((nameWithOwner ?? "").trim().toLowerCase());
}

// Project websites: "<x>-site", "<x>-website", "<x>-homepage", or a name that
// simply ends in "website". A bare trailing "site" needs a separator so code
// such as "composite" or "parasite" is not swept up. Domain-style names only
// count for GitHub Pages: "socket.io" or "foo.org" are real projects.
const SITE_REPO_NAME = /(^|[-_.])(site|homepage)$|website$/;

export function isDocLikeRepo(nameWithOwner: string | null | undefined): boolean {
  if (isLowSignalEntryRepo(nameWithOwner)) return true;
  const name = repoName(nameWithOwner);
  return (
    /(^|[-_.])(docs?|site|website|blog|examples?|templates?|profile|notebook|learning|tutorial|interview|guide|manual)([-_.]|$)/.test(
      name,
    ) ||
    SITE_REPO_NAME.test(name) ||
    name.endsWith(".github.io")
  );
}

const RESOURCE_REPO_TOPIC = /^(awesome|awesome-lists?|courses?|tutorials?|notes|docs|documentation)$/i;

/** Docs/site repos by name, plus resource collections (awesome lists,
 * courses, tutorials, notes) by GitHub topic. */
export function isDocOrResourceRepo(repo: Pick<ContribRepoAgg, "repo" | "topics">): boolean {
  return isDocLikeRepo(repo.repo) || (repo.topics ?? []).some((t) => RESOURCE_REPO_TOPIC.test(t));
}

export function hasStrongLongTermOrgContribution(repo: ContribRepoAgg): boolean {
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
  scoredLogin?: string;
  firstCommitLogin?: string | null;
  facts?: CoCreatorFacts;
}): OrgRepoAttribution | null {
  const owner = input.repo.owner_login.toLowerCase();
  const organizations = new Set(input.organizations.map((o) => o.toLowerCase()));
  const member = organizations.has(owner);
  const scoredLogin = input.scoredLogin?.trim().toLowerCase() ?? "";
  const firstCommitLogin = input.firstCommitLogin?.trim().toLowerCase() ?? "";
  const firstCommitMatch = scoredLogin.length > 0 && firstCommitLogin === scoredLogin;
  if (input.facts) {
    if (owner === scoredLogin || input.repo.is_private || input.repo.is_fork || isDocOrResourceRepo(input.repo)) return null;
    const facts: CoCreatorFacts = {...input.facts,
      association: input.facts.association ?? (member ? "MEMBER" : undefined),
      first_author: firstCommitMatch, release_author: input.releaseOrTagAuthorHit,
      maintainer_file: input.maintainerFileHit,
      pinned: (input.pinnedRepos ?? []).some(r=>r.toLowerCase()===input.repo.repo.toLowerCase()),
    };
    const share = coCreatorShare(facts);
    if (share <= 0) return null;
    return {repo: input.repo.repo, share, score: share, facts, evidence: [
      `${facts.user_commits}/${facts.total_commits} commits; leader ${facts.leading_commits}`,
      `${facts.user_merged_prs}/${facts.total_merged_prs} merged PRs; ${facts.active_years} active years`,
      `${Math.round(facts.core_churn)} core lines in ${facts.samples} complete samples`,
      ...(facts.recent_total_commits !== undefined ? [`${facts.recent_user_commits ?? 0}/${facts.recent_total_commits} commits in the last ${RECENT_MAINTENANCE_DAYS} days`] : []),
      ...(facts.recent_total_merged_prs !== undefined ? [`${facts.recent_user_merged_prs ?? 0}/${facts.recent_total_merged_prs} merged PRs in the last ${RECENT_MAINTENANCE_DAYS} days`] : []),
      ...(facts.reviewed_prs ? [`reviewed ${facts.reviewed_prs} PRs by others`] : []),
      ...(firstCommitMatch ? [`first commit author is ${scoredLogin}`] : []),
      ...(facts.release_author ? ["release/tag author"] : []),
      ...(facts.maintainer_file ? ["listed in maintainer/codeowner docs"] : []),
      ...(facts.association ? [`author association ${facts.association}`] : []),
    ]};
  }
  if (!member && !firstCommitMatch) return null;
  if (input.repo.is_private || input.repo.is_fork) return null;
  if (isDocLikeRepo(input.repo.repo)) return null;
  if (!hasStrongLongTermOrgContribution(input.repo)) return null;

  const evidence = [
    member
      ? `org member of ${input.repo.owner_login}`
      : `first commit author is ${input.firstCommitLogin}`,
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
  impact_prestige_score: number;
  impact_depth_raw: number;
  verified_impact_pr_count?: number;
  core_impact_pr_count?: number;
  doc_like_impact_pr_count?: number;
  unverified_impact_pr_count?: number;
  impact_repo_count: number;
  impact_commit_count: number;
  impact_pr_count: number;
  impact_repos: ImpactRepo[];
}

/** Min landed commits for a repo to qualify on commits alone (avoids drive-bys). */
export const IMPACT_COMMIT_MIN = 2;

/** Work levels at which a repo gets full prestige credit: prestige needs
 * sustained work, not a handful of PRs. Below these levels, credit follows a
 * concave log curve instead of falling off a cliff. */
export const PRESTIGE_COMMIT_FULL_AT = 40;

export const PRESTIGE_MERGED_PR_FULL_AT = 12;

// GitHub only includes commits in commitContributionsByRepository after they
// land on the upstream default branch (or gh-pages). For canonical projects
// whose official patch flow never marks the corresponding GitHub PR as MERGED,
// that single default-branch contribution is sufficient landing evidence.
const SINGLE_DEFAULT_BRANCH_COMMIT_IMPACT_REPOS = new Set(["git/git"]);

function defaultBranchCommitMin(nameWithOwner: string): number {
  return SINGLE_DEFAULT_BRANCH_COMMIT_IMPACT_REPOS.has(nameWithOwner.trim().toLowerCase())
    ? 1
    : IMPACT_COMMIT_MIN;
}

export function prestigeWorkMultiplier(commits: number, prs: number): number {
  const commitSignal = Math.max(0, commits) / PRESTIGE_COMMIT_FULL_AT;
  const prSignal = Math.max(0, prs) / PRESTIGE_MERGED_PR_FULL_AT;
  const workSignal = Math.max(commitSignal, prSignal);
  if (workSignal <= 0) return 0;
  if (workSignal >= 1) return 1;
  return Math.log10(1 + workSignal * 9) / Math.log10(10);
}

/** Popularity + landed-work gates shared by impact scoring and the repo
 * signal query (which must see every repo that could be scored). */
export function passesImpactRepoGates(r: ContribRepoAgg, loginLower: string): boolean {
  if (r.is_private || r.is_fork) return false;
  // A single merged entry can appear as both one PR and one contribution-graph
  // commit. Do not let that personal registry/directory entry borrow the
  // repository's star count, while preserving credit for actual maintainers.
  if (isLowSignalEntryRepo(r.repo) && r.commits <= 1 && r.prs <= 1) return false;
  if (isOwnImpactRepo(r, loginLower)) {
    if (r.stars <= 0 || ((r.community ?? 0) <= 0 && impactEvidenceWeight(r) <= 0)) return false;
  } else if (r.stars < 200) return false;
  return r.commits >= defaultBranchCommitMin(r.repo) || r.prs >= 1;
}

/** Doc/resource repos below this many stars earn no ecosystem impact. */
export const DOC_RESOURCE_IMPACT_MIN_STARS = 5000;

/** Popular doc/resource repos count at this weight. */
const DOC_RESOURCE_IMPACT_WEIGHT = 0.5;

/** The user's own repos already earn their stars in Original Project Quality;
 * in ecosystem impact they add depth at this weight and never prestige. */
const OWN_REPO_IMPACT_DEPTH_WEIGHT = 0.3;

/** Code share assumed for a repo without a classified PR sample. */
const IMPACT_CODE_SHARE_PRIOR = 0.7;

/** Repo quality weight = floor + (1 - floor) · code share. */
const IMPACT_CODE_SHARE_FLOOR = 0.3;

/** Tenure weight = floor + (1 - floor) · min(active months / full-at, 1). */
const IMPACT_TENURE_FLOOR = 0.7;

const IMPACT_TENURE_FULL_MONTHS = 6;

/** The user's own repos, including org repos credited as their originals. */
function isOwnImpactRepo(r: Pick<ContribRepoAgg, "owner_login" | "attributed_original">, loginLower: string): boolean {
  return r.attributed_original === true || r.owner_login.toLowerCase() === loginLower;
}

/** v15: independent adoption saturates in log space; PRs outweigh forks. */
export function impactEvidenceWeight(r: ContribRepoAgg): number {
  const prs = Math.max(0, r.community_facts?.outside_merged_prs ?? 0);
  const forks = Math.max(0, r.forks ?? 0, r.community_facts?.forks ?? 0);
  return 1 - Math.exp(-2.6 * Math.log1p(prs) - 0.6 * Math.log1p(forks));
}

export function impactStarSeverity(r: ContribRepoAgg): number {
  const prs = Math.max(0, r.community_facts?.outside_merged_prs ?? 0);
  const forks = Math.max(0, r.forks ?? 0, r.community_facts?.forks ?? 0);
  return Math.max(0, r.stars) / (Math.max(0, r.stars) + 100) / ((1 + forks) ** 2 * (1 + 6 * prs) ** 2);
}

export function impactStarDiscount(r: ContribRepoAgg): number {
  // Old serialized boolean-only inputs retain a strong (nonzero) discount.
  const severity = r.star_inflation_severity ?? (r.star_inflation_suspect ? 0.9 : impactStarSeverity(r));
  const share = Math.max(0, Math.min(1, r.content_skill_share ?? 0));
  return Math.exp(-7 * Math.max(0, Math.min(1, severity))) * (1 - 0.75 * share * share * (3 - 2 * share));
}

export function attributedCreatorWeight(r: ContribRepoAgg, loginLower: string): number {
  if (!r.attributed_original) return 0;
  const evidence = r.attribution_evidence ?? [];
  const first = evidence.some(e => e.toLowerCase() === `first commit author is ${loginLower}`);
  const release = evidence.includes("release/tag author");
  const creator = first && release ? 1 : first ? 0.85 : release ? 0.7 : 0;
  return impactEvidenceWeight(r) * creator * impactStarDiscount(r);
}

export function hasAttributedCreatorStarCredit(r: ContribRepoAgg, loginLower: string): boolean {
  return attributedCreatorWeight(r, loginLower) > 0;
}

/** Smooth replacement for the 1000-star own-depth gate: 500=.833, 1000=.909. */
export function ownStarWeight(stars: number): number {
  return 1 - Math.exp(-Math.log1p(Math.max(0, stars) / 100));
}

/**
 * Per-repo quality weight from the share of the user's sampled merged PRs
 * there that changed code rather than docs/site/examples. A sample only
 * speaks for the work it covers: the observed share is blended with the prior
 * by coverage = sample / min(10, max(PRs, authored commits)). Merged PRs also
 * land as commits, so the larger of the two counts the repo's units of work.
 * One sampled PR out of 70 commits barely moves the prior; ten sampled PRs, or
 * every PR of a small contribution, are taken at face value.
 */
export function impactRepoCodeWeight(
  r: Pick<ContribRepoAgg, "pr_sample" | "code_pr_sample" | "prs" | "commits" | "merge_commits">,
): number {
  const sample = r.pr_sample ?? 0;
  let share = IMPACT_CODE_SHARE_PRIOR;
  if (sample > 0) {
    const observed = Math.max(0, Math.min((r.code_pr_sample ?? 0) / sample, 1));
    const work = Math.max(r.prs, authoredCommits(r), 1);
    const coverage = Math.min(1, sample / Math.min(IMPACT_CODE_SAMPLE_SIZE, work));
    share = coverage * observed + (1 - coverage) * IMPACT_CODE_SHARE_PRIOR;
  }
  return IMPACT_CODE_SHARE_FLOOR + (1 - IMPACT_CODE_SHARE_FLOOR) * share;
}

/** Per-repo tenure weight: a burst of work earns less than months of it. */
export function impactRepoTenureWeight(r: Pick<ContribRepoAgg, "months">): number {
  const months = r.months?.length ?? 0;
  if (months === 0) return 1;
  return (
    IMPACT_TENURE_FLOOR +
    (1 - IMPACT_TENURE_FLOOR) * Math.min(months / IMPACT_TENURE_FULL_MONTHS, 1)
  );
}

// ---------------------------------------------------------------------------
// Own-project community score
//
// A per-repo 0..1 signal for the user's own projects built from what OTHER
// people do there: established outside contributors (weighted by activity),
// retention, demand (issues/PRs they open), the maintainer's responsiveness,
// forks and recency. It never uses stars (Original Project Quality already
// credits those). Contributors gate the score: an audience without people
// building with you is not a community.
// ---------------------------------------------------------------------------

/** Outside account profile facts used by the established-account filter. */
export interface CommunityProfile {
  login: string;
  created_at: string | null;
  followers: number;
  merged_prs: number;
  orgs: string[];
}

export interface CommunityContributor {
  login: string;
  type: string;
  contributions: number;
}

export interface CommunityPrSample {
  author: string | null;
  author_type: string | null;
  created_at: string;
  merged_at: string;
  title: string | null;
  churn: number;
  files: string[];
}

export interface CommunityIssueSample {
  author: string | null;
  author_type: string | null;
  created_at: string;
  commenters: string[];
}

/** Raw per-repo community inputs. Every sample excludes the user's own PRs
 * and issues (`-author:` search). */
export interface OwnRepoCommunityRaw {
  repo: string;
  forks: number;
  merged_total: number;
  closed_unmerged_total: number;
  prs_opened_total: number;
  issues_total: number;
  contributors: CommunityContributor[];
  merged: CommunityPrSample[];
  issues: CommunityIssueSample[];
}

export interface OwnRepoCommunityContext {
  login: string;
  /** The user's public organizations (lowercase): their members are insiders. */
  owner_orgs: string[];
  /** Org repo credited as the user's original: the repo's org members are
   * insiders too, and credit scales with the user's lead share. */
  attributed: boolean;
  /** Owners of repos the user contributes to (lowercase): mutual contributors
   * count at half weight. */
  mutual_owners: string[];
  profiles: Record<string, CommunityProfile>;
  now: string;
}

/** Collector output per repo; {@link ownRepoCommunity} turns it into 0..1. */
export interface OwnRepoCommunityFacts {
  weighted_contributors: number;
  sustained_contributors: number;
  outside_demand: number;
  merge_latency_days: number | null;
  owner_response_share: number;
  outside_acceptance: number;
  forks: number;
  outside_merged_prs?: number;
  days_since_outside_merge: number | null;
  /** 1 for repos on the user's account; for attributed org originals, the
   * user's commits relative to the repo's top contributor. */
  lead_share: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const COMMUNITY_MIN_FOLLOWERS = 10;

const COMMUNITY_MIN_OUTSIDE_MERGED_PRS = 3;

const COMMUNITY_MUTUAL_WEIGHT = 0.5;

const COMMUNITY_SUSTAINED_COMMITS = 5;

const COMMUNITY_RESPONSE_MIN_AGE_DAYS = 3;

const COMMUNITY_CONTRIBUTORS_FULL_AT = 30;

const COMMUNITY_SUSTAINED_FULL_AT = 10;

const COMMUNITY_DEMAND_FULL_AT = 300;

const COMMUNITY_FORKS_FULL_AT = 1000;

const COMMUNITY_LATENCY_ZERO_DAYS = 60;

const COMMUNITY_RECENT_DAYS = 90;

const COMMUNITY_STALE_DAYS = 730;

const COMMUNITY_STALE_FLOOR = 0.4;

/** Community depth: a fully engaged community equals a fully worked 5k★ repo. */
const COMMUNITY_DEPTH = 2.5;

const BOT_LOGIN = /\[bot\]$|-bot$|^bot-|^(renovate|dependabot|github-actions|greenkeeper|snyk-bot|codecov|allcontributors)/i;

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function isCommunityBot(login: string | null, type: string | null): boolean {
  return !login || (type !== null && type !== "User") || BOT_LOGIN.test(login);
}

/** An established outside account: at least 90 days old when it acted, and
 * an independent footprint (followers, or merged PRs beyond those seen here). */
function isEstablishedAccount(
  profile: CommunityProfile | undefined,
  at: string,
  seenHere: number,
): boolean {
  if (!profile?.created_at) return false;
  const created = Date.parse(profile.created_at);
  const acted = Date.parse(at);
  if (!Number.isFinite(created) || !Number.isFinite(acted)) return false;
  if (acted - created < 90 * DAY_MS) return false;
  return (
    profile.followers >= COMMUNITY_MIN_FOLLOWERS ||
    profile.merged_prs - seenHere >= COMMUNITY_MIN_OUTSIDE_MERGED_PRS
  );
}

/**
 * Filter raw samples into community facts. Excluded everywhere: bots, the
 * user, accounts that are new or lack an independent footprint, and members of
 * the user's (or the attributed repo's) organizations. Trivial (≤5-line) and
 * doc-like PRs do not count, and their share scales the contributor weight.
 * Pure so TypeScript and Go can be pinned to the same facts.
 */
export function computeOwnRepoCommunityFacts(
  raw: OwnRepoCommunityRaw,
  ctx: OwnRepoCommunityContext,
): OwnRepoCommunityFacts {
  const loginLower = ctx.login.toLowerCase();
  const owner = repoOwner(raw.repo);
  const insiderOrgs = new Set(ctx.owner_orgs.map((o) => o.toLowerCase()));
  if (ctx.attributed && owner) insiderOrgs.add(owner);
  const mutual = new Set(ctx.mutual_owners.map((o) => o.toLowerCase()));
  const profileOf = (login: string | null) => (login ? ctx.profiles[login.toLowerCase()] : undefined);
  const isInsider = (login: string | null) =>
    (profileOf(login)?.orgs ?? []).some((o) => insiderOrgs.has(o.toLowerCase()));
  const nowMs = Date.parse(ctx.now);

  // PR sample: who counts, and what share of their work is substantive.
  const seen = new Map<string, number>();
  for (const pr of raw.merged) {
    if (pr.author) seen.set(pr.author.toLowerCase(), (seen.get(pr.author.toLowerCase()) ?? 0) + 1);
  }
  const kept: CommunityPrSample[] = [];
  let trivial = 0;
  for (const pr of raw.merged) {
    if (isCommunityBot(pr.author, pr.author_type) || pr.author?.toLowerCase() === loginLower) continue;
    if (isInsider(pr.author)) continue;
    if (!isEstablishedAccount(profileOf(pr.author), pr.created_at, seen.get(pr.author!.toLowerCase()) ?? 0)) continue;
    const asPr: RecentPr = {
      title: pr.title,
      repo: raw.repo,
      repo_stars: 0,
      churn: pr.churn,
      changed_files: pr.files.length,
      trivial: pr.churn <= 5,
      files: pr.files,
    };
    if (asPr.trivial || isDocLikeImpactPr(asPr)) {
      trivial += 1;
      continue;
    }
    kept.push(pr);
  }
  const decided = kept.length + trivial;
  const substantiveShare = decided > 0 ? Math.max(0.5, kept.length / decided) : 0.5;

  // Contributors: GitHub's contributor list (commits), filtered the same way.
  let weighted = 0;
  let sustained = 0;
  let topCommits = 0;
  let userCommits = 0;
  // A merged author may be missing from GitHub's delayed/squash contributor stats.
  // max, not sum: a landed PR can already be counted as a commit.
  const contributors = new Map(raw.contributors.map((c) => [c.login.toLowerCase(), { ...c }]));
  for (const pr of raw.merged) {
    if (isCommunityBot(pr.author, pr.author_type) || pr.author!.toLowerCase() === loginLower) continue;
    const lower = pr.author!.toLowerCase();
    const existing = contributors.get(lower);
    contributors.set(lower, {
      login: pr.author!, type: pr.author_type ?? "User",
      contributions: Math.max(existing?.contributions ?? 0, seen.get(lower) ?? 0),
    });
  }
  for (const c of contributors.values()) {
    const lower = c.login.toLowerCase();
    if (isCommunityBot(c.login, c.type)) continue;
    topCommits = Math.max(topCommits, c.contributions);
    if (lower === loginLower) {
      userCommits = c.contributions;
      continue;
    }
    if (isInsider(c.login) || !isEstablishedAccount(profileOf(c.login), ctx.now, seen.get(lower) ?? 0)) continue;
    weighted += logRatio(c.contributions, 10) * (mutual.has(lower) ? COMMUNITY_MUTUAL_WEIGHT : 1);
    if (c.contributions >= COMMUNITY_SUSTAINED_COMMITS) sustained += 1;
  }

  // Demand: issues and PRs opened by others, scaled by the established share.
  const keptIssues = raw.issues.filter(
    (i) =>
      !isCommunityBot(i.author, i.author_type) &&
      i.author?.toLowerCase() !== loginLower &&
      !isInsider(i.author) &&
      isEstablishedAccount(profileOf(i.author), i.created_at, 0),
  );
  const issueShare = raw.issues.length > 0 ? keptIssues.length / raw.issues.length : 0;
  const prShare = raw.merged.length > 0 ? kept.length / raw.merged.length : 0;
  const demand = raw.issues_total * issueShare + raw.prs_opened_total * prShare;

  // Responsiveness: merge latency, replies to outside issues, acceptance.
  const latencies = kept
    .map((pr) => (Date.parse(pr.merged_at) - Date.parse(pr.created_at)) / DAY_MS)
    .sort((a, b) => a - b);
  const mid = latencies.length >> 1;
  const latency =
    latencies.length === 0
      ? null
      : latencies.length % 2
        ? latencies[mid]
        : (latencies[mid - 1] + latencies[mid]) / 2;
  const answerable = keptIssues.filter(
    (i) => nowMs - Date.parse(i.created_at) > COMMUNITY_RESPONSE_MIN_AGE_DAYS * DAY_MS,
  );
  const answered = answerable.filter((i) => i.commenters.some((c) => c.toLowerCase() === loginLower));
  const decidedPrs = raw.merged_total + raw.closed_unmerged_total;
  const lastMerge = kept.reduce((a, pr) => Math.max(a, Date.parse(pr.merged_at)), 0);

  return {
    weighted_contributors: round4(weighted * substantiveShare),
    sustained_contributors: sustained,
    outside_demand: round4(demand),
    merge_latency_days: latency === null ? null : round4(latency),
    owner_response_share: answerable.length > 0 ? round4(answered.length / answerable.length) : 0,
    outside_acceptance: decidedPrs > 0 ? round4(raw.merged_total / decidedPrs) : 0,
    forks: raw.forks,
    outside_merged_prs: raw.merged.filter((pr) =>
      !isCommunityBot(pr.author, pr.author_type) && pr.author!.toLowerCase() !== loginLower).length,
    days_since_outside_merge: lastMerge > 0 ? round4(Math.max(0, nowMs - lastMerge) / DAY_MS) : null,
    lead_share: ctx.attributed
      ? topCommits > 0
        ? round4(Math.min(1, userCommits / topCommits))
        : 0
      : 1,
  };
}

/**
 * 0..1 community score: lead × recency × contributors × (0.6 + 0.4 · mean of
 * retention, demand, responsiveness, forks). Contributors gate everything.
 */
export function ownRepoCommunity(f: OwnRepoCommunityFacts): number {
  const contributors = logRatio(f.weighted_contributors, COMMUNITY_CONTRIBUTORS_FULL_AT);
  const retention = logRatio(f.sustained_contributors, COMMUNITY_SUSTAINED_FULL_AT);
  const demand = logRatio(f.outside_demand, COMMUNITY_DEMAND_FULL_AT);
  const latencyScore =
    f.merge_latency_days === null
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            1 - Math.log10(Math.max(f.merge_latency_days, 1)) / Math.log10(COMMUNITY_LATENCY_ZERO_DAYS),
          ),
        );
  const responsiveness =
    0.5 * latencyScore + 0.25 * f.owner_response_share + 0.25 * f.outside_acceptance;
  const forks = logRatio(f.forks, COMMUNITY_FORKS_FULL_AT);
  const days = f.days_since_outside_merge;
  const recency =
    days === null || days >= COMMUNITY_STALE_DAYS
      ? COMMUNITY_STALE_FLOOR
      : days <= COMMUNITY_RECENT_DAYS
        ? 1
        : 1 -
          (1 - COMMUNITY_STALE_FLOOR) *
            ((days - COMMUNITY_RECENT_DAYS) / (COMMUNITY_STALE_DAYS - COMMUNITY_RECENT_DAYS));
  const modulators = (retention + demand + responsiveness + forks) / 4;
  return round4(
    Math.max(0, Math.min(1, f.lead_share)) * recency * contributors * (0.6 + 0.4 * modulators),
  );
}

/**
 * Contribution Quality's own-PR weight: the share of the user's own-repo PRs
 * that landed in repos with a community, weighted by that community. Repos
 * on the user's account and attributed originals count.
 */
export function ownPrCommunityShare(
  repos: ContribRepoAgg[],
  loginLower: string,
  ownPrs: number,
): number {
  if (ownPrs <= 0) return 0;
  const weighted = repos.reduce(
    (a, r) =>
      isOwnImpactRepo(r, loginLower) && !r.is_fork && (r.community ?? 0) > 0
        ? a + r.prs * projectShare(r) * (r.community ?? 0)
        : a,
    0,
  );
  return round4(Math.max(0, Math.min(1, weighted / ownPrs)));
}

/** Commits that represent authored work: merge commits are excluded. */
export function authoredCommits(r: Pick<ContribRepoAgg, "commits" | "merge_commits">): number {
  return Math.max(0, r.commits - Math.max(0, r.merge_commits ?? 0));
}

/**
 * Compute Ecosystem & Maintainer Impact from all-time per-repo contribution
 * aggregates (commits + PRs), instead of the recent-PR window. A repo qualifies
 * when it is popular enough (external ≥200★, own repos with outside evidence) AND the
 * user did real work in it (normally ≥{@link IMPACT_COMMIT_MIN} landed commits
 * OR ≥1 PR). Canonical projects whose official patch flow does not produce
 * GitHub merged PRs can use a narrower repo-specific commit minimum. Private
 * and fork repos are excluded (a fork's star count is borrowed; pushing to it
 * isn't impact).
 *
 * Each repo's prestige and depth are weighted by:
 *   - code share ({@link impactRepoCodeWeight}): docs/site/example work counts
 *     at 0.3, so doc-heavy repos shrink without a global cliff;
 *   - tenure ({@link impactRepoTenureWeight}): a one-month burst earns ~0.75;
 *   - docs/site/resource repos (see {@link isDocOrResourceRepo}) need
 *     {@link DOC_RESOURCE_IMPACT_MIN_STARS} and then count at half weight.
 * Own repos (including attributed originals) do not normally earn impact from their
 * stars by default. Proven attributed creators with outside adoption retain
 * the historical external star formula (max with community, no code/tenure
 * discount), unless star inflation is suspected. Other own repos earn it from
 * their outside community ({@link ownRepoCommunity}): community × work ×
 * code share × tenure × doc weight as prestige, plus 2.5 × community × repo
 * weight as depth on top of the legacy damped star depth (0.3 × engagement
 * multiplier, smooth star/adoption weights). With a measured community they qualify at the
 * external 200★ bar. Merge commits never count as work.
 *
 * TODO(content-repos): also treat a repo as content when its file tree is
 * ≥70% md/pdf/png/mp3/html with fewer than 15 code files (e.g. prompt/skill
 * collections without telling names or topics). The collector has no file
 * listing for contribution repos today, and a recursive tree per impact repo
 * is too expensive (multi-MB, truncated for monorepos) to add to every scan.
 *
 * Pure so it can be unit-tested without network access.
 */
export function computeImpactFromContribMap(
  repos: ContribRepoAgg[],
  loginLower: string,
): ImpactMetrics {
  const qualifying = repos.filter(
    (r) =>
      passesImpactRepoGates(r, loginLower) &&
      (r.stars >= DOC_RESOURCE_IMPACT_MIN_STARS || !isDocOrResourceRepo(r)),
  );

  const maxImpactRepoStars = qualifying.reduce((a, r) => Math.max(a, r.stars), 0);
  const isOwn = (r: ContribRepoAgg) => isOwnImpactRepo(r, loginLower);
  const repoWeight = (r: ContribRepoAgg) =>
    (isDocOrResourceRepo(r) ? DOC_RESOURCE_IMPACT_WEIGHT : 1) *
    impactRepoCodeWeight(r) *
    impactRepoTenureWeight(r);
  const impactPrestigeScore =
    Math.round(
      qualifying.reduce((a, r) => {
        // Own repos earn maintainer prestige from their outside community,
        // never from stars (Original Project Quality credits those).
        const repoPrestige =
          (isOwn(r) ? (r.community ?? 0) : logRatio(r.stars, 100_000)) *
          prestigeWorkMultiplier(authoredCommits(r), r.prs) *
          repoWeight(r);
        const historical = hasAttributedCreatorStarCredit(r, loginLower)
          ? logRatio(r.stars, 100_000) * prestigeWorkMultiplier(authoredCommits(r), r.prs) *
            (isDocOrResourceRepo(r) ? DOC_RESOURCE_IMPACT_WEIGHT : 1)
          : 0;
        const ownPrestige = repoPrestige + attributedCreatorWeight(r, loginLower) * Math.max(0, historical - repoPrestige);
        const share = r.attribution_share === undefined ? 1 : projectShare(r);
        const external = r.stars>=200 ? logRatio(r.stars,100_000)*prestigeWorkMultiplier(authoredCommits(r),r.prs)*repoWeight(r) : 0;
        return Math.max(a, share*ownPrestige+(1-share)*external);
      }, 0) * 10_000,
    ) / 10_000;
  const impactDepthRaw =
    Math.round(
      qualifying.reduce((a, r) => {
        // Weight a repo by how much work landed there, so "17 PRs + many
        // commits" beats a single PR (the per-repo aggregate would otherwise
        // flatten that signal). Bounded so one mega-repo can't dominate.
        const work = authoredCommits(r) + r.prs;
        const weight = work > 0 ? Math.min(1 + Math.log10(work), 2.5) : 0;
        if (isOwn(r)) {
          // Damped own-star depth rises continuously with adoption and stars.
          const starDepth = logRatio(r.stars, 5000) * weight * repoWeight(r) *
            OWN_REPO_IMPACT_DEPTH_WEIGHT * starEngagementMultiplier(r.engagement) *
            ownStarWeight(r.stars) * impactEvidenceWeight(r) * impactStarDiscount(r);
          const communityDepth = starDepth + COMMUNITY_DEPTH * (r.community ?? 0) * repoWeight(r);
          const historical = hasAttributedCreatorStarCredit(r, loginLower)
            ? logRatio(r.stars, 5000) * weight * (isDocOrResourceRepo(r) ? DOC_RESOURCE_IMPACT_WEIGHT : 1)
            : 0;
          const ownDepth = communityDepth + attributedCreatorWeight(r, loginLower) * Math.max(0, historical - communityDepth);
          const share = projectShare(r);
          return a + share*ownDepth + (1-share)*(r.stars>=200 ? logRatio(r.stars,5000)*weight*repoWeight(r) : 0);
        }
        return a + logRatio(r.stars, 5000) * weight * repoWeight(r);
      }, 0) * 100,
    ) / 100;

  const toImpactRepo = (r: ContribRepoAgg): ImpactRepo => ({
    repo: r.repo,
    stars: r.stars,
    commits: r.commits,
    prs: r.prs,
  });
  const byStars = [...qualifying].sort((a, b) => b.stars - a.stars).slice(0, 6);
  const byWork = [...qualifying]
    .sort((a, b) => {
      const aWork = a.prs * 4 + a.commits;
      const bWork = b.prs * 4 + b.commits;
      return bWork - aWork || b.stars - a.stars;
    })
    .slice(0, 8);
  const impactRepos: ImpactRepo[] = [...byStars, ...byWork]
    .filter((repo, idx, arr) => arr.findIndex((r) => r.repo === repo.repo) === idx)
    .slice(0, 12)
    .map(toImpactRepo);

  return {
    max_impact_repo_stars: maxImpactRepoStars,
    impact_prestige_score: impactPrestigeScore,
    impact_depth_raw: impactDepthRaw,
    impact_repo_count: qualifying.length,
    impact_commit_count: qualifying.reduce((a, r) => a + r.commits, 0),
    impact_pr_count: qualifying.reduce((a, r) => a + r.prs, 0),
    impact_repos: impactRepos,
  };
}

/** "YYYY-MM" (UTC) of a GitHub timestamp, or null when unparseable. */
function monthKey(value: string | null | undefined): string | null {
  const ts = parseTs(value);
  return ts ? ts.toISOString().slice(0, 7) : null;
}

export function addMonth(
  monthsByRepo: Map<string, Set<string>>,
  key: string,
  timestamp: string | null | undefined,
): void {
  const month = monthKey(timestamp);
  if (!month) return;
  const months = monthsByRepo.get(key) ?? new Set<string>();
  months.add(month);
  monthsByRepo.set(key, months);
}

export function sortedMonths(months: Set<string> | undefined): string[] {
  return [...(months ?? [])].sort();
}

export interface MergedPrRepoNode {
  id?: string | null;
  mergedAt: string | null;
  repository: {
    nameWithOwner: string;
    stargazerCount: number;
    isPrivate: boolean;
    isFork: boolean;
    owner: { login: string } | null;
  } | null;
}

/** Per-repo merged-PR aggregates from PR nodes, deduplicated by PR id. */
export function aggregateMergedPrNodes(nodes: MergedPrRepoNode[]): ContribRepoAgg[] {
  const map = new Map<string, ContribRepoAgg>();
  const yearsByRepo = new Map<string, Set<number>>();
  const monthsByRepo = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const node of nodes) {
    const repo = node.repository;
    if (!repo) continue;
    if (node.id) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
    }
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
    addMonth(monthsByRepo, key, node.mergedAt);
  }

  return [...map.entries()].map(([key, value]) => ({
    ...value,
    active_years: yearsByRepo.get(key)?.size ?? 0,
    months: sortedMonths(monthsByRepo.get(key)),
  }));
}

/** Share of PR nodes that target repos with ≥200 stars (1 when empty). */
export function highStarPrShare(nodes: MergedPrRepoNode[]): number {
  if (nodes.length === 0) return 1;
  const high = nodes.filter((n) => (n.repository?.stargazerCount ?? 0) >= 200).length;
  return Math.round((high / nodes.length) * 10_000) / 10_000;
}

export interface ImpactRepoSignal {
  topics: string[];
  sampled_commits: number;
  merge_commits: number;
  /** Community engagement ratio; undefined when not measurable. */
  engagement?: number;
}

/** Attach topics, engagement and an estimated merge-commit count to each repo
 * with a signal: the sampled merge share is applied to the contribution-graph
 * total. */
export function applyImpactRepoSignals(
  repos: ContribRepoAgg[],
  signals: Map<string, ImpactRepoSignal>,
): ContribRepoAgg[] {
  return repos.map((r) => {
    const signal = signals.get(r.repo.toLowerCase());
    if (!signal) return r;
    const share = signal.sampled_commits > 0 ? signal.merge_commits / signal.sampled_commits : 0;
    return {
      ...r,
      topics: signal.topics,
      merge_commits: Math.round(r.commits * share),
      ...(signal.engagement !== undefined ? { engagement: signal.engagement } : {}),
    };
  });
}

/** Most merged PRs per repo that are file-classified for code share. */
export const IMPACT_CODE_SAMPLE_SIZE = 10;

export interface ImpactCodeSample {
  pr_sample: number;
  code_pr_sample: number;
}

/** Classify up to {@link IMPACT_CODE_SAMPLE_SIZE} merged PRs: code vs docs. */
export function impactCodeSample(prs: RecentPr[]): ImpactCodeSample {
  const sample = prs.slice(0, IMPACT_CODE_SAMPLE_SIZE);
  return {
    pr_sample: sample.length,
    code_pr_sample: sample.reduce((sum, pr) => {
      const share = prPresentationShare(pr);
      return sum + (share === undefined ? Number(!isDocLikeImpactPr(pr)) : 1 - share);
    }, 0),
  };
}

export function applyImpactCodeSamples(
  repos: ContribRepoAgg[],
  samples: Map<string, ImpactCodeSample>,
): ContribRepoAgg[] {
  return repos.map((r) => {
    const sample = samples.get(r.repo.toLowerCase());
    return sample && sample.pr_sample > 0 ? { ...r, ...sample } : r;
  });
}

/** Attach community facts and scores; star-inflation suspects get 0. */
export function applyOwnRepoCommunities(
  repos: ContribRepoAgg[],
  facts: Map<string, OwnRepoCommunityFacts>,
  starInflationSuspect: boolean,
): ContribRepoAgg[] {
  return repos.map((r) => {
    const f = facts.get(r.repo.toLowerCase());
    const repo = { ...r, star_inflation_suspect: starInflationSuspect, ...(f ? { community_facts: f } : {}) };
    repo.star_inflation_severity = impactStarSeverity(repo);
    return f ? { ...repo, community: ownRepoCommunity(f) * impactStarDiscount(repo) } : repo;
  });
}

