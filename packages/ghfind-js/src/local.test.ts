import { describe, it, expect } from "vitest";
import { ratingForScore, ratingLevel, scoreMetrics, verifyScan } from "./local.js";
import type { RawMetrics } from "./types.js";

/** A complete, all-neutral RawMetrics (valid input to the pure scorer). */
function emptyMetrics(over: Partial<RawMetrics> = {}): RawMetrics {
  return {
    username: "test",
    profile_url: null,
    avatar_url: null,
    name: null,
    bio: null,
    company: null,
    account_age_years: 0,
    created_at: null,
    followers: 0,
    following: 0,
    public_repos: 0,
    fetched_repo_count: 0,
    original_repo_count: 0,
    nonempty_original_repo_count: 0,
    fork_repo_count: 0,
    empty_original_repo_count: 0,
    total_stars: 0,
    max_stars: 0,
    merged_pr_count: 0,
    total_pr_count: 0,
    issues_created: 0,
    last_year_contributions: 0,
    activity_type_count: 0,
    contribution_years_active: 0,
    days_since_last_activity: null,
    recent_merged_pr_sample: 0,
    recent_trivial_pr_count: 0,
    external_trivial_pr_count: 0,
    max_impact_repo_stars: 0,
    impact_pr_count: 0,
    impact_depth_raw: 0,
    star_inflation_suspect: false,
    closed_unmerged_pr_count: 0,
    pr_rejection_rate: 0,
    recent_pr_sample: 0,
    top_repo_pr_target: null,
    top_repo_pr_share: 0,
    templated_pr_ratio: 0,
    pr_flood_suspect: false,
    ...over,
  };
}

describe("ghfind/local", () => {
  it("scoreMetrics runs the real deterministic core and returns a full Scoring", () => {
    const s = scoreMetrics(emptyMetrics());
    expect(s).toHaveProperty("final_score");
    expect(s).toHaveProperty("tier");
    expect(s).toHaveProperty("sub_scores");
    expect(Object.keys(s.sub_scores)).toContain("contribution_quality");
    expect(s.final_score).toBeGreaterThanOrEqual(0);
    expect(s.final_score).toBeLessThanOrEqual(100);
  });

  it("scoreMetrics is deterministic (same input → same score)", () => {
    const m = emptyMetrics({ followers: 500, total_stars: 3000, merged_pr_count: 40 });
    expect(scoreMetrics(m).final_score).toBe(scoreMetrics(m).final_score);
  });

  it("verifyScan accepts an untouched scan", () => {
    const metrics = emptyMetrics({ followers: 1200, total_stars: 9000, merged_pr_count: 80, account_age_years: 9 });
    const check = verifyScan({ metrics, scoring: scoreMetrics(metrics) });
    expect(check.verified).toBe(true);
    expect(check.differences).toEqual([]);
  });

  it("verifyScan reports every field that does not match", () => {
    const metrics = emptyMetrics({ followers: 1200, total_stars: 9000, merged_pr_count: 80 });
    const scoring = scoreMetrics(metrics);
    const tampered = {
      ...scoring,
      final_score: scoring.final_score + 7,
      sub_scores: { ...scoring.sub_scores, community_influence: scoring.sub_scores.community_influence + 1 },
    };
    const check = verifyScan({ metrics, scoring: tampered });
    expect(check.verified).toBe(false);
    expect(check.differences.map((d) => d.field)).toEqual(["final_score", "sub_scores.community_influence"]);
    expect(check.differences[0]).toMatchObject({ server: scoring.final_score + 7, local: scoring.final_score });
  });

  it("verifyScan rejects payloads without evidence", () => {
    expect(() => verifyScan({ scoring: scoreMetrics(emptyMetrics()) } as never)).toThrow(/metrics/);
  });

  it("re-exports the public rating ladder", () => {
    expect(ratingLevel(94.6)).toBe(94);
    expect(ratingForScore(94.6).id).toBe("mahayana");
    expect(ratingForScore(29.9).id).toBe("qi");
  });
});
