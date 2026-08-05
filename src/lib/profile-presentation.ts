/**
 * Public presentation models returned by the Go backend. These types are
 * deliberately separate from the former Turso helpers: server components and
 * image renderers may consume them, but must never acquire database access.
 */
import type { ImpactRepo, RoastLine, SubScores, Tags, Tier, TopRepo } from "@/lib/types";
import type { SignatureWork } from "@/lib/types";

export interface AccountDetail {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  final_score: number;
  tier: Tier;
  tags: Tags;
  sub_scores: SubScores;
  roast_line: RoastLine;
  roast: string | null;
  roast_en: string | null;
  score_version: string | null;
  legacy_read_fallback: boolean;
  score_source_collection_version: string | null;
  score_source_snapshot_hash: string | null;
  scanned_at: number;
  prev_score: number | null;
  prev_scanned_at: number | null;
}

export interface ProfileCardMetrics {
  account_age_years: number;
  created_at: string | null;
  followers: number;
  public_repos: number;
  total_stars: number;
  max_stars: number;
  original_repo_count: number;
  merged_pr_count: number;
  impact_pr_count: number;
  verified_impact_pr_count: number;
  core_impact_pr_count: number;
  impact_repo_count: number;
  max_impact_repo_stars: number;
  last_year_contributions: number;
  contribution_years_active: number;
}

export interface ProfileSnapshotView {
  top_repos: TopRepo[];
  impact_repos: ImpactRepo[];
  signature_work: SignatureWork | null;
  pinned_repos: string[];
  organizations: string[];
  bio: string | null;
  company: string | null;
  metrics: ProfileCardMetrics;
  scanned_at: number;
}

export interface ProfileRank {
  rank: number;
  total: number;
  below: number;
}

export interface ProfilePercentile {
  beat: number | null;
  total: number;
  rank: number | null;
}

export interface PresentationLeaderboardEntry {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  final_score: number;
  tier: Tier;
  tags: Tags;
  lookup_count: number;
  recent_lookup_count: number;
  trending_score: number;
  prev_score?: number;
  delta?: number;
}

export interface CommonProfileProject {
  repo: {
    repo_key: string;
    name_with_owner: string;
    language: string | null;
  };
  avgScore: number;
}

export interface VsMatchup {
  handleA: string;
  handleB: string;
  winner: string | null;
  bucket: string;
  gap: number;
  scoreA: number;
  scoreB: number;
  verdict: RoastLine | null;
  advice: RoastLine | null;
  verdictSource: string | null;
  viewCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface FacetRankData {
  facetType: string;
  facetValue: string;
  rank: number;
  total: number;
  ahead: { username: string; final_score: number } | null;
}

export interface ProfilePresentation {
  detail: AccountDetail;
  snapshot: ProfileSnapshotView | null;
  rank: ProfileRank | null;
  percentile: ProfilePercentile | null;
  delta: number | null;
  similar: PresentationLeaderboardEntry[];
  common_projects: CommonProfileProject[];
  battles: VsMatchup[];
  facetRank: FacetRankData | null;
  existing_repo_keys: string[];
}

export interface VsPresentation {
  a: AccountDetail | null;
  b: AccountDetail | null;
  matchup: VsMatchup | null;
}
