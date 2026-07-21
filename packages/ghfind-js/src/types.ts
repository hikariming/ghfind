/**
 * ghfind API contract types.
 *
 * Keys are snake_case to mirror the canonical scoring output (identical to the
 * open-source `github-account-value` skill and the website's `src/lib/types.ts`),
 * so the JSON is byte-for-byte compatible across the site, SDKs, and CLIs.
 *
 * Source of truth: https://github.com/hikariming/ghfind (src/lib/types.ts).
 * Keep this file in sync when the contract changes.
 */

export interface ReadmeFeatures {
  length: number;
  heading_count: number;
  has_install: boolean;
  has_usage: boolean;
  has_api: boolean;
  has_demo: boolean;
  has_features: boolean;
  has_deploy: boolean;
  has_test: boolean;
  has_architecture: boolean;
  has_screenshot: boolean;
  placeholder_score: number;
  content_depth_score: number;
  prompt_summary: string;
}

export interface RepoReadme {
  path: string;
  sha: string | null;
  size: number;
  html_url: string | null;
  truncated: boolean;
  features: ReadmeFeatures;
}

export interface TopRepo {
  name: string;
  owner_login?: string;
  name_with_owner?: string;
  stars: number;
  forks: number;
  /** GitHub REST's aggregate, which includes open pull requests. */
  open_issues: number;
  /** Verified open GitHub Issues only; excludes pull requests and may be absent
   * when bounded enrichment is unavailable. */
  open_issue_count?: number;
  size: number;
  language: string | null;
  description: string | null;
  pushed_at: string | null;
  readme?: RepoReadme;
  readme_excerpt?: string | null;
  topics?: string[];
  languages?: { name: string; size: number }[];
  attributed_original?: boolean;
  attribution_evidence?: string[];
}

export interface RecentPr {
  title: string | null;
  repo: string | null;
  repo_stars: number;
  churn: number;
  changed_files: number;
  trivial: boolean;
  files?: string[];
}

export interface ImpactRepo {
  repo: string;
  stars: number;
  commits: number;
  prs: number;
}

/** Raw GitHub-derived metrics that feed the deterministic scorer (snake_case).
 * Indexed so forward-compatible fields don't break older consumers. */
export interface RawMetrics {
  username: string;
  profile_url: string | null;
  avatar_url: string | null;
  name: string | null;
  bio: string | null;
  company: string | null;
  account_age_years: number;
  created_at: string | null;
  followers: number;
  following: number;
  public_repos: number;
  fetched_repo_count: number;
  original_repo_count: number;
  nonempty_original_repo_count: number;
  fork_repo_count: number;
  empty_original_repo_count: number;
  total_stars: number;
  max_stars: number;
  merged_pr_count: number;
  total_pr_count: number;
  issues_created: number;
  last_year_contributions: number;
  activity_type_count: number;
  contribution_years_active: number;
  days_since_last_activity: number | null;
  recent_merged_pr_sample: number;
  recent_trivial_pr_count: number;
  external_trivial_pr_count: number;
  max_impact_repo_stars: number;
  impact_pr_count: number;
  impact_depth_raw: number;
  star_inflation_suspect: boolean;
  closed_unmerged_pr_count: number;
  pr_rejection_rate: number;
  recent_pr_sample: number;
  top_repo_pr_target: string | null;
  top_repo_pr_share: number;
  templated_pr_ratio: number;
  pr_flood_suspect: boolean;
  // Forward-compatible / optional fields carried through verbatim.
  [key: string]: unknown;
}

export type SubScoreKey =
  | "account_maturity"
  | "original_project_quality"
  | "contribution_quality"
  | "ecosystem_impact"
  | "community_influence"
  | "activity_authenticity";

export type SubScores = Record<SubScoreKey, number>;

export interface RedFlag {
  flag: string;
  penalty: number;
  detail: string;
}

/** Stored tier label (Chinese). Use {@link TierKey} for a stable slug. */
export type Tier = "夯" | "顶级" | "人上人" | "NPC" | "拉完了";

/** Language-neutral tier slug. */
export type TierKey = "god" | "elite" | "solid" | "npc" | "trash";

export const TIER_KEY: Record<Tier, TierKey> = {
  夯: "god",
  顶级: "elite",
  人上人: "solid",
  NPC: "npc",
  拉完了: "trash",
};

export interface Scoring {
  sub_scores: SubScores;
  base_score: number;
  red_flags: RedFlag[];
  total_penalty: number;
  final_score: number;
  tier: Tier;
  tier_label: string;
}

/** Full scan payload returned by POST /api/scan. */
export interface ScanResult {
  metrics: RawMetrics;
  top_repos: TopRepo[];
  recent_prs: RecentPr[];
  flood_pr_titles: string[];
  impact_repos?: ImpactRepo[];
  verified_impact_prs?: RecentPr[];
  pinned_repos?: string[];
  organizations?: string[];
  scoring: Scoring;
}

export interface Tags {
  zh: string[];
  en: string[];
}

export interface RoastLine {
  zh: string;
  en: string;
}

export interface Percentile {
  beat: number | null;
  total: number;
  rank: number | null;
}

/** Meta emitted by the roast stream after the bounded ±10 LLM adjustment. */
export interface RoastMeta {
  final_score: number;
  tier: Tier;
  tier_label: string;
  delta: number;
  percentile: Percentile | null;
  tags: Tags;
  roast_line: RoastLine;
}

/** Response shape of GET /api/score/{username}. */
export interface ScorePayload {
  /** `indexed` = stored (roasted) account; `live` = just crawled + scored
   * deterministically (no LLM). */
  source: "indexed" | "live";
  /** live path only: served from the scan cache. */
  cached?: boolean;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string;
  final_score: number;
  tier: Tier;
  tier_key: TierKey;
  sub_scores: SubScores;
  /** live path only: deterministic penalties. */
  red_flags?: RedFlag[];
  base_score?: number;
  total_penalty?: number;
  /** LLM-authored copy — null on the live (not-yet-roasted) path. */
  tags: Tags | null;
  roast_line: RoastLine | null;
  percentile: Percentile | null;
  /** indexed path only: epoch ms of last stored score. */
  scanned_at?: number;
  profile: string;
}

/** Parsed result of a roast stream (report + meta + progress lines). */
export interface RoastResult {
  meta: RoastMeta | null;
  report: string;
  progress: string[];
}

export type LeaderboardView = "trending" | "score" | "heat" | "progress";
export type LeaderboardWindow = "all" | "24h" | "7d" | "30d";
export type DeveloperFacet = "language" | "org" | "repo";

export interface LeaderboardResponse {
  entries: unknown[];
  cached: boolean;
  view: LeaderboardView;
  window: LeaderboardWindow;
}

export interface StatsResponse {
  total: number;
  cached: boolean;
}

export interface SearchUsersResponse {
  users: {
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    final_score: number;
    tier: Tier;
  }[];
}

/** Bring-your-own OpenAI-compatible LLM provider for POST /api/roast. */
export interface ByoKey {
  baseURL: string;
  apiKey: string;
  model: string;
}

/** Minimal public GitHub profile, from GitHub's own API (not ghfind). Used by the
 * client-side existence pre-check. */
export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
  avatar_url: string;
  html_url: string;
  type: string;
  public_repos: number;
  followers: number;
  following: number;
  created_at: string;
}
