import { expect, it } from "vitest";
import { attributedCreatorWeight, impactEvidenceWeight, impactStarDiscount, ownStarWeight, computeImpactFromContribMap, type ContribRepoAgg } from "../github";
import fixtures from "./smooth-impact-fixtures.json";

it.each(fixtures)("v14 shared curve: $name", ({ repo, expected }) => {
  const r = repo as unknown as ContribRepoAgg;
  expect(attributedCreatorWeight(r, "maker")).toBeCloseTo(expected.weight, 12);
  expect(impactEvidenceWeight(r)).toBeCloseTo(expected.evidence, 12);
  expect(impactStarDiscount(r)).toBeCloseTo(expected.discount, 12);
  expect(ownStarWeight(r.stars)).toBeCloseTo(expected.star_weight, 12);
  expect(computeImpactFromContribMap([r], "maker")).toMatchObject({
    impact_prestige_score: expected.impact_prestige_score,
    impact_depth_raw: expected.impact_depth_raw,
    impact_repo_count: expected.impact_repo_count,
  });
});

it("is monotone in evidence and continuous at the former star gates", () => {
  const base = fixtures[0].repo as unknown as ContribRepoAgg;
  for (const field of ["forks", "outside_merged_prs"] as const) {
    let previous = { impact_prestige_score: 0, impact_depth_raw: 0 };
    let lastWeight = 0, lastGain = 1;
    for (let n = 0; n <= 1000; n++) {
      const r = { ...base, forks: field === "forks" ? n : 0,
        community_facts: { ...base.community_facts!, [field]: n } };
      const current = computeImpactFromContribMap([r], "maker");
      expect(current.impact_prestige_score).toBeGreaterThanOrEqual(previous.impact_prestige_score);
      expect(current.impact_depth_raw).toBeGreaterThanOrEqual(previous.impact_depth_raw);
      const weight = impactEvidenceWeight(r), gain = weight - lastWeight;
      if (n > 0) expect(gain).toBeLessThanOrEqual(lastGain + 1e-12);
      lastGain = n > 0 ? gain : 1; lastWeight = weight; previous = current;
    }
  }
  for (const [field, gate] of [["outside_merged_prs", 1], ["forks", 10]] as const) {
    const run = (n: number) => attributedCreatorWeight({ ...base, forks: field === "forks" ? n : 0,
      community_facts: { ...base.community_facts!, [field]: n } }, "maker");
    expect(Math.abs(run(gate + .001) - run(gate - .001))).toBeLessThan(.002);
  }
  for (const gate of [200, 1000]) {
    const run = (stars: number) => computeImpactFromContribMap([{ ...base, stars, forks: 33 }], "maker");
    expect(Math.abs(run(gate + 1).impact_prestige_score - run(gate - 1).impact_prestige_score)).toBeLessThan(.002);
    expect(Math.abs(run(gate + 1).impact_depth_raw - run(gate - 1).impact_depth_raw)).toBeLessThan(.02);
  }
});

it("star farming has diminishing unrounded prestige returns even under suspicion", () => {
  for (const severity of [0, .9]) {
    const values = [500, 1000, 1500, 2000].map(stars => {
      const r = fixtures.find(f => f.name === `farm-stars-${stars}-${severity}`)!.repo as unknown as ContribRepoAgg;
      return attributedCreatorWeight(r, "maker") * Math.log1p(stars) / Math.log1p(100000);
    });
    expect(values[2] - values[1]).toBeLessThan(values[1] - values[0]);
    expect(values[3] - values[2]).toBeLessThan(values[2] - values[1]);
    if (severity) expect(values[3]).toBeLessThan(.002);
  }
});
