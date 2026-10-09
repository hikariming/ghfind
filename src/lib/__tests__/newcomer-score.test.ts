import { describe, expect, it } from "vitest";
import { assessRisk } from "../risk";
import { roundHalfEven, score, superNewcomerBonus } from "../score";
import type { RawMetrics, Scoring } from "../types";
import fixtures from "./newcomer-score-fixtures.json";

type Case = {
  name: string;
  overrides?: Partial<RawMetrics>;
  omit?: (keyof RawMetrics)[];
  expected: Pick<Scoring, "sub_scores" | "base_score" | "final_score" | "total_penalty"> & { bonus: number };
};
const base = fixtures.metrics as RawMetrics;
const cases = fixtures.cases as unknown as Case[];
const metricsFor = (row: Case): RawMetrics => {
  const m = { ...base, ...row.overrides };
  for (const key of row.omit ?? []) delete (m as unknown as Record<string, unknown>)[key];
  return m;
};
const bonusFor = (m: RawMetrics) => superNewcomerBonus(m, score(m).sub_scores, assessRisk(m));

describe("super newcomer shared regression fixtures", () => {
  it.each(cases)("matches $name", (row) => {
    const m = metricsFor(row);
    const result = score(m);
    expect(result.sub_scores).toEqual(row.expected.sub_scores);
    expect(result.base_score).toBe(row.expected.base_score);
    expect(result.final_score).toBe(row.expected.final_score);
    expect(result.total_penalty).toBe(row.expected.total_penalty);
    expect(bonusFor(m)).toBeCloseTo(row.expected.bonus, 10);

    // Removing age evidence disables only the bonus, not other scores or risk.
    const previous = score({ ...m, created_at: null });
    const { account_maturity: maturity, ...other } = result.sub_scores;
    const { account_maturity: oldMaturity, ...oldOther } = previous.sub_scores;
    expect(other).toEqual(oldOther);
    expect(result.risk_assessment).toEqual(previous.risk_assessment);
    expect(result.red_flags).toEqual(previous.red_flags);
    expect(maturity).toBeGreaterThanOrEqual(oldMaturity);
    expect(maturity - oldMaturity).toBeLessThanOrEqual(4.00000001);
    expect(maturity).toBeLessThanOrEqual(10);
    expect(result.base_score).toBe(roundHalfEven(Object.values(result.sub_scores).reduce((a, b) => a + b, 0), 1));
  });
});

describe("newcomer bonus properties", () => {
  it("rewards younger exceptional accounts without automatically maxing maturity", () => {
    expect(bonusFor({ ...base, account_age_years: 0 })).toBe(4);
    expect(score(base).sub_scores.account_maturity).toBe(4.4);
    expect(score(base).sub_scores.account_maturity).toBeGreaterThan(
      score({ ...base, account_age_years: 1 }).sub_scores.account_maturity,
    );
  });

  it("decays monotonically for unchanged evidence and joins the old curve at 3 years", () => {
    let last = 4;
    for (let months = 0; months <= 48; months++) {
      const m = { ...base, account_age_years: months / 12 };
      const bonus = bonusFor(m);
      expect(bonus).toBeGreaterThanOrEqual(0);
      expect(bonus).toBeLessThanOrEqual(last + 1e-12);
      if (months >= 36) expect(score(m)).toEqual(score({ ...m, created_at: null }));
      last = bonus;
    }
    expect(bonusFor({ ...base, account_age_years: 3 - 0.001 })).toBeLessThan(0.000001);
  });

  it("allows improving evidence to offset age decay, but never extends the age window", () => {
    const initial = bonusFor({ ...base, best_original_repo_quality_score: 0.7 });
    expect(bonusFor({ ...base, account_age_years: 1 })).toBeGreaterThan(initial);
    expect(bonusFor({ ...base, account_age_years: 3 })).toBe(0);
  });

  it("tapers eligibility smoothly rather than granting a threshold windfall", () => {
    expect(bonusFor({ ...base, best_original_repo_quality_score: 0.55 })).toBe(0);
    expect(bonusFor({ ...base, best_original_repo_quality_score: 0.550001 })).toBeLessThan(1e-8);
    expect(bonusFor({ ...base, best_original_repo_quality_score: 0.7 })).toBeCloseTo(bonusFor(base) / 2, 10);
  });

  it("does not mistake unknown or non-finite measurements for extraordinary youth", () => {
    for (const age of [-1, NaN, Infinity]) {
      expect(superNewcomerBonus({ ...base, account_age_years: age }, score(base).sub_scores, assessRisk(base))).toBe(0);
    }
    for (const key of ["best_original_repo_quality_score", "impact_depth_raw", "verified_impact_pr_count", "core_impact_pr_count", "recent_merged_pr_sample", "days_since_last_activity"] as const) {
      expect(superNewcomerBonus({ ...base, [key]: NaN }, score(base).sub_scores, assessRisk(base))).toBe(0);
    }
  });

  it("does not penalize benign footprint notes or a small follow imbalance", () => {
    expect(bonusFor({ ...base, public_repos: 50 })).toBeCloseTo(bonusFor(base), 10);
    expect(bonusFor({ ...base, followers: 0, following: 5 })).toBeCloseTo(bonusFor(base), 10);
  });

  it("vetoes observed contribution problems even when risk notes apply no penalty", () => {
    const m = { ...base, recent_merged_pr_sample: 10, external_trivial_pr_count: 5 };
    expect(score(m).total_penalty).toBe(0);
    expect(score(m).risk_notes?.some((s) => s.family === "contribution")).toBe(true);
    expect(bonusFor(m)).toBe(0);
  });
});
