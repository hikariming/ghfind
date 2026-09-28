import { rateDeveloper } from "@/lib/devscore/engine";
import { synthetic } from "@/lib/devscore/engine/__tests__/helpers";
import type { Developer } from "@/lib/devscore/model";
import { devscoreSummary } from "@/lib/devscore-scoring";
import type { DisplayScan } from "@/lib/scan-core";
import type { DevscoreSummary, RawMetrics } from "@/lib/types";

/** The shared synthetic developers (see engine/__tests__/helpers.ts). */
export type SyntheticName = keyof typeof synthetic;

/** A synthetic v15 developer with a reviewed PR history, labelled as `login`. */
export function fixtureDeveloper(login: string, name: SyntheticName = "contributor"): Developer {
  return synthetic[name](login);
}

/** The devscore summary a published snapshot carries for `fixtureDeveloper`. */
export function fixtureDevscore(login: string, name?: SyntheticName): DevscoreSummary {
  const dev = fixtureDeveloper(login, name);
  return devscoreSummary(dev, rateDeveloper(dev));
}

function displayMetrics(username: string): RawMetrics {
  return {
    username,
    profile_url: "https://example.test/synthetic-user",
    avatar_url: "https://example.test/avatar.png",
    name: "Synthetic User",
    bio: "Synthetic fixture",
    company: null,
    account_age_years: 4,
    created_at: "2022-01-01T00:00:00.000Z",
    followers: 20,
    following: 10,
    public_repos: 4,
    fetched_repo_count: 4,
    original_repo_count: 3,
    nonempty_original_repo_count: 3,
    fork_repo_count: 1,
    empty_original_repo_count: 0,
    total_stars: 80,
    max_stars: 50,
    merged_pr_count: 8,
    total_pr_count: 10,
    issues_created: 3,
    last_year_contributions: 320,
    activity_type_count: 3,
    contribution_years_active: 3,
    days_since_last_activity: 4,
    recent_merged_pr_sample: 8,
    recent_trivial_pr_count: 1,
    external_trivial_pr_count: 0,
    max_impact_repo_stars: 1_000,
    impact_pr_count: 2,
    impact_depth_raw: 1,
    star_inflation_suspect: false,
    closed_unmerged_pr_count: 2,
    pr_rejection_rate: 0.2,
    recent_pr_sample: 10,
    top_repo_pr_target: "sample/repository",
    top_repo_pr_share: 0.25,
    templated_pr_ratio: 0.1,
    pr_flood_suspect: false,
  };
}

/** A minimal valid display/roast payload from ghfind's `collect()`. */
export function fixtureDisplayScan(username: string): DisplayScan {
  return {
    metrics: displayMetrics(username),
    top_repos: [],
    recent_prs: [],
    flood_pr_titles: [],
    impact_repos: [],
    verified_impact_prs: [],
    pinned_repos: [],
    organizations: [],
  };
}
