/**
 * Shared types for the GitHub value/trust scorer.
 *
 * Keys are intentionally snake_case to mirror the canonical Python skill output
 * (`github-account-value/scripts/fetch_github_profile.py`), so the JSON contract
 * is identical between the website and the open-source Claude skill.
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
  /**
   * GitHub REST's `open_issues_count`, which includes open pull requests.
   * Retained for snapshot compatibility only; never use it as Issue evidence.
   */
  open_issues: number;
  /**
   * Exact number of currently open GitHub Issues, excluding pull requests.
   * Undefined means the bounded GraphQL enrichment was unavailable, not zero.
   */
  open_issue_count?: number;
  size: number;
  language: string | null;
  description: string | null;
  pushed_at: string | null;
  readme?: RepoReadme;
  readme_excerpt?: string | null;
  /** GitHub repo topics (official domain labels). Optional — empty when the
   * REST payload omits them or for scans cached before this field existed. */
  topics?: string[];
  /** Per-language byte breakdown for the repo (e.g. Python 70% + Cuda 20%),
   * a finer domain signal than the single primary `language`. Top repos only. */
  languages?: { name: string; size: number }[];
  /** True when an organization-owned repo is credited as the user's attributable
   * original project because the user is an org member with strong long-term
   * maintenance signals. */
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

export type SignatureImpactRepo = ImpactRepo;

export interface SignatureWorkCluster {
  repo: string;
  stars: number;
  all_time_prs?: number;
  recent_merged_prs_in_sample?: number;
  quality_keyword_hits: number;
  examples: string[];
  org_context_repo?: string;
  org_context_stars?: number;
  substantive_low_star_signal?: boolean;
}

export interface SignatureWork {
  /** High-work representative contributed repos, not just the highest-star ones. */
  impact_repo_representatives: SignatureImpactRepo[];
  /** All-history or sample-derived clusters of concrete work by repo/title. */
  work_clusters: SignatureWorkCluster[];
  source: "all_history_public_scan" | "recent_sample";
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
  /** (watchers + issues ever + PRs ever) / stars for the top-starred original
   * repo. Only measured at ≥500★; undefined = not measured or fetch failed
   * (scored as "no penalty"). Viral-but-hollow repos run <1%, genuinely used
   * projects ≥5%. */
  top_repo_engagement_ratio?: number;
  attributed_original_repo_count?: number;
  attributed_original_repo_stars?: number;
  attributed_original_repos?: string[];
  best_original_repo_quality_score?: number;
  best_original_repo_quality_repo?: string | null;
  top_starred_original_repo_quality_score?: number;
  top_starred_original_repo_quality_repo?: string | null;
  merged_pr_count: number;
  /** Closed PRs that a repository-owned merge bot explicitly marked as landed.
   * This is intentionally separate from GitHub-native `merged_pr_count`. */
  workflow_landed_pr_count?: number;
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
  recent_external_pr_sample?: number;
  recent_external_doc_like_pr_count?: number;
  recent_external_doc_like_pr_ratio?: number;
  external_trivial_pr_count: number;
  max_impact_repo_stars: number;
  /** 0..1 prestige signal after weighting the biggest contributed repos by
   * landed work volume. Optional so older cached snapshots fall back to
   * max_impact_repo_stars. */
  impact_prestige_score?: number;
  impact_pr_count: number;
  /** Subset of impact PRs credited through a repository workflow rather than
   * GitHub's native merged state. */
  workflow_landed_impact_pr_count?: number;
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
  /** GitHub rejected the per-repository commit contribution graph for this
   * account, so impact uses native merged PRs but cannot credit commit-only work. */
  commit_contribution_aggregation_unavailable?: boolean;
  /** The quick collector deliberately omitted its bounded native merged-PR
   * aggregate. A durable paginated scan is required before this account can be
   * scored or written about as complete public history. */
  merged_pr_contribution_aggregation_incomplete?: boolean;
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
  /** Representative concrete work examples for report generation. */
  signature_work?: SignatureWork;
  /** "owner/name" of the user's pinned repos — their self-selected best work, a
   * strong signal of the direction they identify with. Optional for back-compat. */
  pinned_repos?: string[];
  /** Organizations the user belongs to (e.g. huggingface, pytorch) — high-signal
   * for circle/affiliation. Optional for back-compat. */
  organizations?: string[];
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
 * Factual LLM judgment produced before the roast-writing pass. This is the only
 * model output allowed to affect the score delta; the later writer pass must
 * treat it as fixed input.
 */
export interface RoastJudgeResult {
  delta: number;
  reason: string;
  verdict: string;
  risk_notes: string[];
  final_score?: number;
  tier?: string;
  tier_label?: string;
}

/**
 * Metadata the roast stream emits on its first line. `final_score` is the
 * authoritative deterministic score; `delta` remains zero because the model
 * generates report text only.
 */
export interface RoastMeta {
  final_score: number;
  tier: Tier;
  tier_label: string;
  delta: number;
  percentile: { beat: number | null; total: number; rank: number | null } | null;
  tags: Tags;
  /** Bilingual savage one-liner; the UI shows the side matching the locale. */
  roast_line: RoastLine;
}
