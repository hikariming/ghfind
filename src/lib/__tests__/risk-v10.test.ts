import { describe, expect, it } from "vitest";
import { score } from "../score";
import type { RawMetrics } from "../types";

const BASE: RawMetrics = {
  username: "risk-test",
  profile_url: null,
  avatar_url: null,
  name: "Risk Test",
  bio: "developer",
  company: null,
  account_age_years: 5,
  created_at: "2021-01-01T00:00:00Z",
  followers: 50,
  following: 30,
  public_repos: 20,
  fetched_repo_count: 20,
  original_repo_count: 10,
  nonempty_original_repo_count: 5,
  fork_repo_count: 2,
  empty_original_repo_count: 0,
  total_stars: 100,
  max_stars: 50,
  merged_pr_count: 30,
  total_pr_count: 35,
  issues_created: 10,
  last_year_contributions: 500,
  activity_type_count: 3,
  contribution_years_active: 3,
  days_since_last_activity: 30,
  recent_merged_pr_sample: 20,
  recent_trivial_pr_count: 2,
  external_trivial_pr_count: 0,
  max_impact_repo_stars: 0,
  impact_pr_count: 0,
  impact_depth_raw: 0,
  star_inflation_suspect: false,
  closed_unmerged_pr_count: 2,
  pr_rejection_rate: 0.06,
  recent_pr_sample: 20,
  top_repo_pr_target: "someone/project",
  top_repo_pr_share: 0.3,
  templated_pr_ratio: 0.2,
  pr_flood_suspect: false,
};

function result(over: Partial<RawMetrics> = {}) {
  return score({ ...BASE, ...over });
}

function hasSignal(output: ReturnType<typeof result>, flag: string, collection: "signals" | "notes" = "signals") {
  const signals = collection === "signals"
    ? output.risk_assessment?.signals ?? []
    : output.risk_notes ?? [];
  return signals.some((signal) => signal.flag === flag);
}

describe("v10 risk rules", () => {
  it("turns footprint scarcity into notes without a penalty", () => {
    const output = result({
      account_age_years: 0.5,
      public_repos: 40,
      fetched_repo_count: 40,
      original_repo_count: 5,
      nonempty_original_repo_count: 0,
      fork_repo_count: 5,
      empty_original_repo_count: 5,
      bio: null,
      followers: 0,
      following: 0,
      total_stars: 0,
      max_stars: 0,
      merged_pr_count: 0,
      total_pr_count: 0,
      last_year_contributions: 0,
      activity_type_count: 0,
      contribution_years_active: 0,
      days_since_last_activity: null,
      recent_merged_pr_sample: 0,
      recent_pr_sample: 0,
    });
    expect(output.total_penalty).toBe(0);
    expect(output.red_flags).toHaveLength(0);
    expect(hasSignal(output, "no_original_work", "notes")).toBe(true);
  });

  it("does not penalize normal self-repository PR volume", () => {
    const output = result({
      recent_merged_pr_sample: 30,
      recent_pr_sample: 30,
      top_repo_pr_share: 1,
      templated_pr_ratio: 1,
      pr_flood_suspect: false,
    });
    expect(output.total_penalty).toBe(0);
    expect(output.red_flags).toHaveLength(0);
    expect(hasSignal(output, "templated_pr_flooding")).toBe(false);
  });

  it("only notes external trivial PRs below the 20-PR sample floor", () => {
    const output = result({ recent_merged_pr_sample: 19, external_trivial_pr_count: 15 });
    expect(output.total_penalty).toBe(0);
    expect(hasSignal(output, "trivial_pr_farming", "notes")).toBe(true);
  });

  it("requires corroboration before penalizing templated external PR flooding", () => {
    const templateOnly = result({
      recent_pr_sample: 30,
      top_repo_pr_share: 1,
      templated_pr_ratio: 1,
      pr_flood_suspect: true,
    });
    expect(templateOnly.total_penalty).toBe(0);
    expect(hasSignal(templateOnly, "templated_pr_flooding", "notes")).toBe(true);

    const corroborated = result({
      recent_merged_pr_sample: 30,
      external_trivial_pr_count: 30,
      recent_pr_sample: 30,
      top_repo_pr_share: 1,
      templated_pr_ratio: 1,
      pr_flood_suspect: true,
    });
    expect(corroborated.total_penalty).toBeGreaterThan(0);
    expect(corroborated.red_flags.map((flag) => flag.flag)).toEqual([
      "trivial_pr_farming",
      "templated_pr_flooding",
    ]);
  });

  it("uses Wilson rejection evidence and leaves optional metrics unpenalized when absent", () => {
    const rejected = result({
      merged_pr_count: 5,
      maintainer_closed_unmerged_pr_count: 20,
    });
    expect(rejected.red_flags.find((flag) => flag.flag === "high_pr_rejection")?.penalty).toBeGreaterThan(0);

    const missingStarMetric = result({
      following: 3000,
      followers: 10,
      star_inflation_suspect: true,
      max_stars: 2000,
      top_repo_engagement_ratio: undefined,
    });
    expect(missingStarMetric.total_penalty).toBe(0);
    expect(hasSignal(missingStarMetric, "possible_star_inflation", "notes")).toBe(true);
  });

  it("requires both independent social signals and caps the social family at 9", () => {
    const single = result({ following: 2000, followers: 100 });
    expect(single.total_penalty).toBe(0);
    expect(hasSignal(single, "follow_farming", "notes")).toBe(true);

    const paired = result({
      following: 10_000,
      followers: 0,
      star_inflation_suspect: true,
      max_stars: 10_000,
      top_repo_engagement_ratio: 0,
    });
    expect(paired.total_penalty).toBeGreaterThan(0);
    expect(paired.total_penalty).toBeLessThanOrEqual(9);
    expect(paired.risk_assessment?.level).toBe("review");
  });

  it("keeps the aggregate penalty at 25", () => {
    const output = result({
      merged_pr_count: 40,
      maintainer_closed_unmerged_pr_count: 40,
      recent_merged_pr_sample: 40,
      external_trivial_pr_count: 40,
      recent_pr_sample: 40,
      top_repo_pr_share: 1,
      templated_pr_ratio: 1,
      pr_flood_suspect: true,
      following: 10_000,
      followers: 0,
      star_inflation_suspect: true,
      max_stars: 10_000,
      top_repo_engagement_ratio: 0,
    });
    expect(output.total_penalty).toBe(25);
    expect(output.risk_assessment?.risk_score).toBe(100);
    expect(output.risk_assessment?.level).toBe("high");
    expect(output.red_flags.reduce((sum, flag) => sum + flag.penalty, 0)).toBe(25);
  });
});
