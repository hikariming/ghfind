import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tierOf } from "@/lib/devscore/engine";
import { devscoreSubScores, scoringFromDevscore } from "../devscore-scoring";
import { SUBSCORE_MAX } from "../score-presentation";
import { TIER_KEY } from "../tier";
import type { DevscoreSummary } from "../types";
import { fixtureDevscore } from "./devscore-fixture";

const TIER_BY_V3 = { hang: "夯", dingji: "顶级", renshangren: "人上人", npc: "NPC", lawanle: "拉完了" } as const;
const REAL = readdirSync(join(import.meta.dirname, "../devscore/engine/__tests__/fixtures/real"))
  .filter((f) => f !== "expected.json");

function withV3(base: DevscoreSummary, score: number, flags: Partial<DevscoreSummary["v3"]["flags"]> = {}): DevscoreSummary {
  return {
    ...base,
    v3: { ...base.v3, score, remapped: flags.slop || flags.influencer ? 70 : score, tier: tierOf(score), flags: { ...base.v3.flags, ...flags } },
  };
}

describe("scoringFromDevscore", () => {
  it.each(REAL)("publishes the devscore v3 score with its tier and bounded six dimensions (%s)", (file) => {
    const summary = fixtureDevscore("u", file);
    const scoring = scoringFromDevscore(summary);
    expect(scoring.final_score).toBeCloseTo(summary.v3.score, 1);
    expect(scoring.tier).toBe(TIER_BY_V3[summary.v3.tier]);
    for (const [key, max] of Object.entries(SUBSCORE_MAX)) {
      const value = scoring.sub_scores[key as keyof typeof SUBSCORE_MAX];
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(max);
    }
    const sum = Object.values(scoring.sub_scores).reduce((a, b) => a + b, 0);
    expect(scoring.base_score).toBeCloseTo(sum, 1);
    expect(scoring.total_penalty).toBeCloseTo(Math.max(0, scoring.base_score - scoring.final_score), 2);
  });

  it("never rounds a score across a tier boundary", () => {
    const base = fixtureDevscore("u");
    for (const edge of [39.996, 69.999, 79.995, 89.9999]) {
      const scoring = scoringFromDevscore(withV3(base, edge));
      expect(TIER_KEY[scoring.tier]).toBe(TIER_KEY[TIER_BY_V3[tierOf(edge)]]);
    }
  });

  it("turns the slop cap into a high-risk penalty signal and cuts activity authenticity", () => {
    const base = fixtureDevscore("u");
    const clean = scoringFromDevscore(withV3(base, 30));
    const slop = scoringFromDevscore(withV3(base, 30, { slop: true }));
    expect(slop.risk_assessment).toMatchObject({ version: "v11", level: "high" });
    expect(slop.red_flags).toEqual([expect.objectContaining({ flag: "devscore_slop", penalty: 40 })]);
    expect(slop.sub_scores.activity_authenticity).toBeLessThan(clean.sub_scores.activity_authenticity);
    expect(clean.red_flags).toEqual([]);
  });

  it("does not credit followers to community influence", () => {
    const base = fixtureDevscore("u");
    const famous = { ...base, followers: 1_000_000 };
    expect(devscoreSubScores(famous).community_influence).toBe(devscoreSubScores(base).community_influence);
  });
});
