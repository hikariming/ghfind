import { describe, expect, it } from "vitest";
import { CRUSH_GAP, EDGE_GAP, VERDICT_TEMPLATE_COUNT, verdict } from "../verdict";
import type { AccountDetail } from "../db";
import type { SubScores } from "../types";

const ZERO_SUB: SubScores = {
  account_maturity: 0,
  original_project_quality: 0,
  contribution_quality: 0,
  ecosystem_impact: 0,
  community_influence: 0,
  activity_authenticity: 0,
};

function acct(username: string, final: number, sub: Partial<SubScores> = {}): AccountDetail {
  return {
    username,
    display_name: null,
    avatar_url: null,
    profile_url: null,
    final_score: final,
    tier: "人上人",
    tags: { zh: [], en: [] },
    sub_scores: { ...ZERO_SUB, ...sub },
    roast_line: { zh: "", en: "" },
    roast: null,
    roast_en: null,
    legacy_read_fallback: false,
    score_source_collection_version: null,
    score_source_snapshot_hash: null,
    scanned_at: 0,
    prev_score: null,
    prev_scanned_at: null,
  };
}

describe("verdict — bucketing", () => {
  it("buckets a large gap as crush", () => {
    const v = verdict(acct("a", 90), acct("b", 90 - CRUSH_GAP - 1));
    expect(v.bucket).toBe("crush");
    expect(v.winner).toBe("a");
    expect(v.gap).toBeCloseTo(CRUSH_GAP + 1);
  });

  it("buckets a mid gap as edge", () => {
    expect(verdict(acct("a", 80), acct("b", 80 - EDGE_GAP)).bucket).toBe("edge");
  });

  it("buckets a tiny gap as even", () => {
    expect(verdict(acct("a", 70), acct("b", 69)).bucket).toBe("even");
  });

  it("marks a dead heat as a tie", () => {
    expect(verdict(acct("a", 70), acct("b", 70)).winner).toBe("tie");
  });
});

describe("verdict — determinism", () => {
  it("selects the same template regardless of argument order", () => {
    const v1 = verdict(acct("torvalds", 88), acct("linus", 66));
    const v2 = verdict(acct("linus", 66), acct("torvalds", 88));
    expect(v1.templateKey).toBe(v2.templateKey);
  });

  it("keeps the template index within the bucket's template count", () => {
    const v = verdict(acct("a", 90), acct("b", 40));
    const idx = Number(v.templateKey.split(".")[1]);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(VERDICT_TEMPLATE_COUNT.crush);
  });
});

describe("verdict — dimensions & missing sides", () => {
  it("computes per-dimension winners", () => {
    const a = acct("a", 80, { ecosystem_impact: 15, contribution_quality: 5 });
    const b = acct("b", 78, { ecosystem_impact: 5, contribution_quality: 20 });
    const v = verdict(a, b);
    expect(v.dimWinners.ecosystem_impact).toBe("a");
    expect(v.dimWinners.contribution_quality).toBe("b");
    expect(v.dimWinners.account_maturity).toBe("tie");
  });

  it("returns a missing verdict when a side is unscored", () => {
    const v = verdict(acct("a", 80), null);
    expect(v.missing).toBe(true);
    expect(v.templateKey).toBe("");
  });
});
