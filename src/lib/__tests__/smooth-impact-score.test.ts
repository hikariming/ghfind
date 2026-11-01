import { describe, expect, it } from "vitest";
import {
  impactBreadth,
  impactSubstance,
  impactTouch,
  saturateToward,
  score,
} from "../score";
import type { RawMetrics } from "../types";
import archetypes from "./smooth-impact-archetypes.json";

/** Established account with no impact evidence. Archetype tests fill that in. */
const BASE: RawMetrics = {
  username: "fiction-archetype",
  profile_url: null,
  avatar_url: null,
  name: "Fiction",
  bio: "developer",
  company: null,
  account_age_years: 8,
  created_at: "2018-01-01T00:00:00Z",
  followers: 80,
  following: 20,
  public_repos: 6,
  fetched_repo_count: 6,
  original_repo_count: 2,
  nonempty_original_repo_count: 2,
  fork_repo_count: 0,
  empty_original_repo_count: 0,
  total_stars: 40,
  max_stars: 30,
  best_original_repo_quality_score: 0.4,
  merged_pr_count: 12,
  external_merged_pr_count: 12,
  own_pr_community: 0,
  total_pr_count: 14,
  issues_created: 8,
  last_year_contributions: 400,
  activity_type_count: 3,
  contribution_years_active: 4,
  days_since_last_activity: 3,
  recent_merged_pr_sample: 6,
  recent_trivial_pr_count: 0,
  external_trivial_pr_count: 0,
  max_impact_repo_stars: 0,
  impact_pr_count: 0,
  impact_depth_raw: 0,
  impact_repo_count: 0,
  impact_commit_count: 0,
  star_inflation_suspect: false,
  closed_unmerged_pr_count: 1,
  pr_rejection_rate: 0.05,
  recent_pr_sample: 6,
  top_repo_pr_target: null,
  top_repo_pr_share: 0,
  templated_pr_ratio: 0,
  pr_flood_suspect: false,
};

describe("v19 smooth contribution ceiling", () => {
  it("stays on the raw curve far below the ceiling and bends at the ceiling", () => {
    expect(saturateToward(10, 27)).toBeCloseTo(10, 2);
    expect(saturateToward(30, 20)).toBeGreaterThan(19.5);
    expect(saturateToward(30, 20)).toBeLessThan(20);
    expect(saturateToward(40, 20)).toBeGreaterThan(saturateToward(30, 20));
  });
});

describe("v19 shared archetype fixtures", () => {
  it.each(archetypes)("$name locks ecosystem and final score", (row) => {
    const got = score(row.metrics as RawMetrics);
    expect(got.sub_scores.ecosystem_impact).toBe(row.ecosystem_impact);
    expect(got.sub_scores.contribution_quality).toBe(row.contribution_quality);
    expect(got.final_score).toBe(row.final_score);
  });

  it("keeps one repository below the same work spread across four", () => {
    const byName = Object.fromEntries(archetypes.map((row) => [row.name, row]));
    expect(byName["one-repo-sustained"].ecosystem_impact).toBeLessThan(byName["four-repo-spread"].ecosystem_impact);
    expect(byName["few-tiny-prs-mega-repo"].ecosystem_impact).toBeLessThan(6);
    expect(byName["five-repo-core"].ecosystem_impact).toBeGreaterThan(15);
  });
});

describe("v19 ecosystem depth and breadth", () => {
  it("does not let a few tiny pull requests fill ecosystem impact", () => {
    const fewTiny = score({
      ...BASE,
      max_impact_repo_stars: 180000,
      impact_prestige_score: 0.98,
      impact_pr_count: 3,
      impact_commit_count: 3,
      impact_depth_raw: 4,
      impact_repo_count: 1,
      core_impact_pr_count: 0,
      doc_like_impact_pr_count: 3,
      external_trivial_pr_count: 3,
      recent_merged_pr_sample: 3,
      presentation_churn_share: 0.8,
      top_repo_pr_share: 1,
      impact_repos: [{ repo: "mega/framework", stars: 180000, commits: 3, prs: 3 }],
    });
    expect(impactSubstance({
      ...BASE,
      external_trivial_pr_count: 3,
      recent_merged_pr_sample: 3,
      doc_like_impact_pr_count: 3,
      presentation_churn_share: 0.8,
    })).toBeLessThan(0.45);
    expect(fewTiny.sub_scores.ecosystem_impact).toBeLessThan(8);
  });

  it("smoothly discounts pull requests concentrated in one repository", () => {
    const oneRepo = {
      ...BASE,
      merged_pr_count: 40,
      external_merged_pr_count: 40,
      impact_prestige_score: 0.9,
      impact_pr_count: 40,
      impact_commit_count: 80,
      impact_depth_raw: 12,
      impact_repo_count: 1,
      core_impact_pr_count: 20,
      doc_like_impact_pr_count: 0,
      top_repo_pr_share: 1,
      impact_repos: [{ repo: "org/platform", stars: 40000, commits: 80, prs: 40 }],
    };
    const spread = {
      ...oneRepo,
      impact_repo_count: 4,
      top_repo_pr_share: 0.25,
      impact_repos: [1, 2, 3, 4].map((n) => ({
        repo: `org/platform-${n}`,
        stars: 40000,
        commits: 20,
        prs: 10,
      })),
    };
    // 40 PRs + 80 commits → partial maintainer relief above the 0.62 floor.
    expect(impactBreadth(oneRepo)).toBeGreaterThan(0.68);
    expect(impactBreadth(oneRepo)).toBeLessThan(0.76);
    expect(impactBreadth(spread)).toBeGreaterThan(0.95);
    const driveBy = {
      ...oneRepo,
      impact_pr_count: 3,
      impact_commit_count: 1,
      impact_depth_raw: 2,
      core_impact_pr_count: 0,
      doc_like_impact_pr_count: 3,
      impact_repos: [{ repo: "org/platform", stars: 40000, commits: 1, prs: 3 }],
    };
    expect(impactBreadth(driveBy)).toBeLessThan(0.64);
    expect(impactBreadth(oneRepo)).toBeGreaterThan(impactBreadth(driveBy) + 0.05);
    const concentrated = score(oneRepo).sub_scores.ecosystem_impact;
    const diverse = score(spread).sub_scores.ecosystem_impact;
    expect(concentrated).toBeLessThan(diverse);
    expect(diverse - concentrated).toBeGreaterThan(1);
    expect(diverse).toBeLessThanOrEqual(20);
  });

  it("still scores sustained core work across repositories highly", () => {
    const sustained = score({
      ...BASE,
      merged_pr_count: 80,
      external_merged_pr_count: 80,
      max_impact_repo_stars: 90000,
      impact_prestige_score: 0.95,
      impact_pr_count: 70,
      impact_commit_count: 200,
      impact_depth_raw: 18,
      impact_repo_count: 5,
      core_impact_pr_count: 24,
      doc_like_impact_pr_count: 1,
      top_repo_pr_share: 0.22,
      impact_repos: [1, 2, 3, 4, 5].map((n) => ({
        repo: `foundation/project-${n}`,
        stars: 20000 + n * 1000,
        commits: 40,
        prs: 14,
      })),
    });
    expect(impactTouch({
      ...BASE,
      impact_pr_count: 70,
      impact_commit_count: 200,
      core_impact_pr_count: 24,
      doc_like_impact_pr_count: 1,
    })).toBeGreaterThan(0.9);
    expect(sustained.sub_scores.ecosystem_impact).toBeGreaterThan(15);
  });

  it("keeps missing breadth evidence neutral", () => {
    const {
      impact_pr_count: _prs,
      impact_commit_count: _commits,
      impact_repo_count: _repos,
      impact_repos: _list,
      top_repo_pr_share: _share,
      ...rest
    } = BASE;
    const bare = {
      ...rest,
      impact_prestige_score: 0.5,
      impact_depth_raw: 2,
      recent_merged_pr_sample: 0,
    } as RawMetrics;
    expect(impactBreadth(bare)).toBe(1);
    expect(impactTouch(bare)).toBe(1);
    expect(impactSubstance(bare)).toBe(1);
  });
});
