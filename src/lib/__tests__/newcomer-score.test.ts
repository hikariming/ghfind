import { describe, expect, it } from "vitest";
import { roundHalfEven, score } from "../score";
import type { RawMetrics } from "../types";
import fixtures from "./newcomer-score-fixtures.json";

const base = fixtures.metrics as RawMetrics;

describe("v10 scoring has no newcomer maturity bonus", () => {
  it("sets account maturity from age and span only", () => {
    const agePts = Math.min(base.account_age_years / 6, 1) * 7;
    const years = base.contribution_years_active;
    const spanPts = years === 0 ? 0 : years === 1 ? 1 : years === 2 ? 2 : 3;
    expect(score(base).sub_scores.account_maturity).toBe(roundHalfEven(agePts + spanPts, 1));
  });

  it("does not change other dimensions when created_at is missing", () => {
    const withDate = score(base);
    const withoutDate = score({ ...base, created_at: null });
    expect(withDate.sub_scores).toEqual(withoutDate.sub_scores);
    expect(withDate.final_score).toBe(withoutDate.final_score);
    expect(withDate.total_penalty).toBe(withoutDate.total_penalty);
  });
});
