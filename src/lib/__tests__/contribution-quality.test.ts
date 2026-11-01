import { describe, expect, it } from "vitest";
import { lowPrestigeBulkContributionCap, score } from "../score";
import type { RawMetrics } from "../types";
import fixtures from "./contribution-quality-fixtures.json";

const own = fixtures[0].metrics as RawMetrics;

describe("v18 contribution recognition", () => {
  it.each(fixtures)("shared three-engine golden: $name", ({ metrics, expected, before, cap }) => {
    const actual = score(metrics as RawMetrics);
    expect(actual).toMatchObject(expected);
    expect(lowPrestigeBulkContributionCap(metrics as RawMetrics)).toBeCloseTo(cap, 12);
    // v19 also rescores ecosystem impact. The other four dimensions stay put.
    for (const key of ["account_maturity", "original_project_quality", "community_influence", "activity_authenticity"] as const) {
      expect(actual.sub_scores[key]).toBe(before.sub_scores[key]);
    }
    expect(actual.total_penalty).toBe(before.total_penalty);
    expect(actual.red_flags).toEqual(before.red_flags);
  });

  it("cannot use own stars or unrecognized own PR volume to bypass the cap", () => {
    for (const max_stars of [0, 949, 950, 1000, 1050, 2507, 1000000]) {
      for (const merged_pr_count of [123, 200, 10000]) {
        const m = { ...own, max_stars, merged_pr_count };
        expect(lowPrestigeBulkContributionCap(m)).toBe(20);
        expect(score(m).sub_scores.contribution_quality).toBeLessThanOrEqual(20);
        expect(score(m).sub_scores.contribution_quality).toBeGreaterThanOrEqual(19);
      }
    }
  });

  it("makes the cap monotone in independent landings and measured own community", () => {
    const base = { ...own, merged_pr_count: 1000, impact_prestige_score: 1 };
    let previous = 0;
    for (const external of [0, 1, 10, 40, 80, 123, 200, 400, 600, 1000]) {
      const m = { ...base, external_merged_pr_count: external };
      const cap = lowPrestigeBulkContributionCap(m)!;
      expect(cap).toBeGreaterThanOrEqual(previous);
      expect(cap).toBeLessThanOrEqual(27);
      previous = cap;
    }
    previous = 0;
    for (const community of [0, .001, .01, .1, .5, .9, 1]) {
      const cap = lowPrestigeBulkContributionCap({ ...base, own_pr_community: community })!;
      expect(cap).toBeGreaterThanOrEqual(previous);
      previous = cap;
    }
    const capAt = (n: number) => lowPrestigeBulkContributionCap({ ...base, external_merged_pr_count: n })!;
    expect(capAt(160) - capAt(80)).toBeLessThan(capAt(80) - capAt(0));
    expect(capAt(123)).toBeLessThan(26);
    const saturated = score({ ...base, external_merged_pr_count: 600 }).sub_scores.contribution_quality;
    expect(saturated).toBeGreaterThan(26.5);
    expect(saturated).toBeLessThanOrEqual(27);
  });

  it("keeps legacy unknown ownership distinct from measured zero and bounds inputs", () => {
    const unknown = { ...own, external_merged_pr_count: undefined };
    expect(lowPrestigeBulkContributionCap(unknown)).toBeCloseTo(21.944, 12);
    expect(lowPrestigeBulkContributionCap({ ...own, external_merged_pr_count: -100, own_pr_community: -1 })).toBe(20);
    expect(lowPrestigeBulkContributionCap({ ...own, external_merged_pr_count: 10000 })).toBe(
      lowPrestigeBulkContributionCap({ ...own, external_merged_pr_count: own.merged_pr_count }),
    );
    expect(lowPrestigeBulkContributionCap({ ...own, own_pr_community: 100 })).toBe(
      lowPrestigeBulkContributionCap({ ...own, own_pr_community: 1 }),
    );
  });

  it("treats JSON null ownership as unknown, matching Go nil and Python None", () => {
    const missing = { ...own, merged_pr_count: 10, issues_created: 0, own_pr_community: 1, external_merged_pr_count: undefined };
    const jsonNull = { ...missing, external_merged_pr_count: null } as unknown as RawMetrics;
    expect(lowPrestigeBulkContributionCap(jsonNull)).toBe(lowPrestigeBulkContributionCap(missing));
    expect(score(jsonNull)).toEqual(score(missing));
  });

  it("is continuous across old volume/prestige boundaries", () => {
    for (const n of [40, 80, 120, 200]) {
      const a = lowPrestigeBulkContributionCap({ ...own, external_merged_pr_count: undefined, merged_pr_count: n - 1e-5 });
      const b = lowPrestigeBulkContributionCap({ ...own, external_merged_pr_count: undefined, merged_pr_count: n + 1e-5 });
      expect(a).toBeCloseTo(b!, 5);
    }
    for (const p of [.3, .65, .8]) {
      const a = lowPrestigeBulkContributionCap({ ...own, external_merged_pr_count: undefined, impact_prestige_score: p - 1e-7 });
      const b = lowPrestigeBulkContributionCap({ ...own, external_merged_pr_count: undefined, impact_prestige_score: p + 1e-7 });
      expect(a).toBeCloseTo(b!, 5);
    }
  });

  it("keeps author self-closure and the absence of alternative workflow landings neutral", () => {
    for (const n of [0, 1, 22, 10000]) {
      expect(score({ ...own, self_closed_external_pr_count: n, self_closed_own_repo_pr_count: n })).toEqual(score(own));
    }
    const external = fixtures[1].metrics as RawMetrics;
    expect(score({ ...external, workflow_landed_pr_count: 0 })).toEqual(
      score({ ...external, workflow_landed_pr_count: 50, workflow_landed_impact_pr_count: 50 }),
    );
  });
});
