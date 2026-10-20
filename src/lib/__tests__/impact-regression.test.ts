import { describe, expect, it } from "vitest";
import {
  computeImpactFromContribMap,
  computeImpactQualitySignals,
  ownPrCommunityShare,
  ownRepoCommunity,
  weightedOriginalStars,
  contentSkillSignals,
  type ContribRepoAgg,
} from "../github";
import { score } from "../score";
import type { RawMetrics, RecentPr, TopRepo } from "../types";
import fixtures from "./impact-regression-fixtures.json";

// Real-account snapshots recorded with scripts/record-score-fixtures.mts at a
// pinned clock (`recorded_at`). The pure pipeline (impact aggregates, verified
// PR quality, weighted stars) is recomputed from the recorded inputs and must
// reproduce both the collected metrics and the recorded score.
// internal/backend shares this file, so `expected` pins TypeScript/Go parity.
interface ScoreRegressionFixture {
  description: string;
  before_final_score: number;
  expected_final_range: [number, number];
  recorded_at: string;
  metrics: RawMetrics;
  contrib_repos: ContribRepoAgg[];
  recent_prs: RecentPr[];
  star_repos: TopRepo[];
  expected: {
    impact_prestige_score: number;
    impact_depth_raw: number;
    impact_repo_count: number;
    sub_scores: Record<string, number>;
    final_score: number;
  };
}

function recompute(f: ScoreRegressionFixture) {
  const login = f.metrics.username.toLowerCase();
  const impact = computeImpactFromContribMap(f.contrib_repos, login);
  const quality = computeImpactQualitySignals(
    f.recent_prs,
    impact.impact_pr_count,
    login,
    f.metrics.workflow_landed_impact_pr_count ?? 0,
  );
  const stars = weightedOriginalStars(f.star_repos, new Date(f.recorded_at));
  const metrics: RawMetrics = {
    ...f.metrics,
    max_impact_repo_stars: impact.max_impact_repo_stars,
    impact_prestige_score: impact.impact_prestige_score,
    impact_depth_raw: impact.impact_depth_raw,
    impact_repo_count: impact.impact_repo_count,
    impact_commit_count: impact.impact_commit_count,
    impact_pr_count: impact.impact_pr_count,
    ...quality,
    ...stars,
    ...contentSkillSignals(f.star_repos),
  };
  return { impact, metrics, scoring: score(metrics) };
}

const fixtureLogin = (f: ScoreRegressionFixture) => f.metrics.username.toLowerCase();

describe("score regression fixtures (real snapshots)", () => {
  for (const [name, raw] of Object.entries(fixtures)) {
    const fixture = raw as unknown as ScoreRegressionFixture;
    it(`${name}: ${fixture.before_final_score} → ${fixture.expected_final_range.join("–")}`, () => {
      const { impact, metrics, scoring } = recompute(fixture);

      // The pure pipeline reproduces what the collector recorded.
      for (const key of [
        "max_impact_repo_stars",
        "impact_prestige_score",
        "impact_depth_raw",
        "impact_repo_count",
        "impact_commit_count",
        "impact_pr_count",
        "verified_impact_pr_count",
        "core_impact_pr_count",
        "doc_like_impact_pr_count",
        "unverified_impact_pr_count",
        "weighted_total_stars",
        "weighted_max_stars",
      ] as const) {
        expect(metrics[key], key).toBe(fixture.metrics[key]);
      }

      // Community scores and the own-PR community share follow from the
      // recorded facts (star-inflation suspects get 0).
      for (const r of fixture.contrib_repos) {
        if (!r.community_facts) continue;
        const want = fixture.metrics.star_inflation_suspect ? 0 : ownRepoCommunity(r.community_facts);
        expect(r.community, r.repo).toBe(want);
      }
      if (fixture.metrics.external_merged_pr_count !== undefined) {
        const ownPrs =
          fixture.metrics.merged_pr_count -
          Math.min(fixture.metrics.external_merged_pr_count, fixture.metrics.merged_pr_count);
        expect(ownPrCommunityShare(fixture.contrib_repos, fixtureLogin(fixture), ownPrs)).toBe(
          fixture.metrics.own_pr_community,
        );
      }

      expect(impact.impact_prestige_score).toBe(fixture.expected.impact_prestige_score);
      expect(impact.impact_depth_raw).toBe(fixture.expected.impact_depth_raw);
      expect(impact.impact_repo_count).toBe(fixture.expected.impact_repo_count);
      expect(scoring.sub_scores).toEqual(fixture.expected.sub_scores);
      expect(scoring.final_score).toBe(fixture.expected.final_score);
      const [lo, hi] = fixture.expected_final_range;
      expect(scoring.final_score).toBeGreaterThanOrEqual(lo);
      expect(scoring.final_score).toBeLessThanOrEqual(hi);
    });
  }

  it("keeps the control account above 92 and lowers the inflated ones", () => {
    const final = (name: keyof typeof fixtures) =>
      recompute(fixtures[name] as unknown as ScoreRegressionFixture).scoring.final_score;
    expect(final("fixture-account-074")).toBeGreaterThanOrEqual(92);
    expect(final("fixture-account-018")).toBeLessThan(final("fixture-account-035"));
    expect(final("fixture-account-035")).toBeLessThan(final("fixture-account-074"));
    expect(final("fixture-account-004")).toBeLessThanOrEqual(60);
  });
});
