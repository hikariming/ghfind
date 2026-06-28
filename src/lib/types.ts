/**
 * Shared types for the GitHub value/trust scorer.
 *
 * Keys are intentionally snake_case to mirror the canonical Python skill output
 * (`github-account-value/scripts/fetch_github_profile.py`), so the JSON contract
 * is identical between the website and the open-source Claude skill.
 */

export interface TopRepo {
  name: string;
  stars: number;
  forks: number;
  open_issues: number;
  language: string | null;
  description: string | null;
  readme_excerpt?: string | null;
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

/**
 * A popular repo the user has materially contributed to (PRs and/or commits),
 * aggregated all-time from the contribution graph rather than the recent-PR
 * window. Surfaces work that predates the last ~50 PRs (e.g. old apache/flink
 * commits) so both the score and the LLM can credit it.
 */
export interface ImpactRepo {
  repo: string;
  stars: number;
  commits: number;
  prs: number;
}

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
  recent_doc_like_pr_count?: number;
  recent_doc_like_pr_ratio?: number;
  external_trivial_pr_count: number;
  max_impact_repo_stars: number;
  impact_pr_count: number;
  impact_depth_raw: number;
  impact_quality_cap?: number;
  verified_impact_pr_count?: number;
  core_impact_pr_count?: number;
  doc_like_impact_pr_count?: number;
  unverified_impact_pr_count?: number;
  // All-time per-repo impact aggregates (commits + PRs into popular repos).
  // Optional so existing RawMetrics literals / fixtures stay valid.
  impact_repo_count?: number;
  impact_commit_count?: number;
  star_inflation_suspect: boolean;
  // Spam / low-quality PR signals.
  closed_unmerged_pr_count: number;
  maintainer_closed_unmerged_pr_count?: number;
  self_closed_external_pr_count?: number;
  self_closed_own_repo_pr_count?: number;
  unknown_closed_unmerged_pr_count?: number;
  pr_rejection_rate: number;
  recent_pr_sample: number;
  top_repo_pr_target: string | null;
  top_repo_pr_share: number;
  templated_pr_ratio: number;
  pr_flood_suspect: boolean;
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

export type Tier = "夯" | "顶级" | "人上人" | "NPC" | "拉完了";

export interface Scoring {
  sub_scores: SubScores;
  base_score: number;
  red_flags: RedFlag[];
  total_penalty: number;
  final_score: number;
  tier: Tier;
  tier_label: string;
}

/** Full scan payload — same shape the Python script prints. */
export interface ScanResult {
  metrics: RawMetrics;
  top_repos: TopRepo[];
  recent_prs: RecentPr[];
  /** Representative titles from the largest templated-PR cluster (for the LLM). */
  flood_pr_titles: string[];
  /** Popular repos the user contributed to all-time (PRs + commits). Optional
   * for backward compatibility with cached scans written before this field. */
  impact_repos?: ImpactRepo[];
  /** Verified popular-repo PR samples with file paths, for LLM qualitative review. */
  verified_impact_prs?: RecentPr[];
  scoring: Scoring;
}

/** Fun, viral tags the AI assigns to an account (3-5 each), for sharing. */
export interface Tags {
  zh: string[];
  en: string[];
}

/**
 * The savage one-liner roast, generated in both languages in a single LLM call
 * (so switching site language never shows an empty roast). The full report stays
 * single-language; only this one-liner is bilingual — the extra cost is ~one
 * short sentence, mirroring the bilingual {@link Tags}.
 */
export interface RoastLine {
  zh: string;
  en: string;
}

/**
 * Metadata the roast stream emits on its first line, after the AI applies its
 * bounded ±10 qualitative adjustment. `final_score` is the deterministic score
 * plus `delta` (clamped 0-100, 2 decimals) and is the authoritative final score.
 */
export interface RoastMeta {
  final_score: number;
  tier: Tier;
  tier_label: string;
  delta: number;
  percentile: { beat: number | null; total: number } | null;
  tags: Tags;
  /** Bilingual savage one-liner; the UI shows the side matching the locale. */
  roast_line: RoastLine;
}
