import { describe, expect, it } from "vitest";
import { runBench } from "./bench/bench";

/**
 * Regression floor for the role-family benchmark (see bench/). Before
 * MATCH_VERSION 2 every login's top 3 held a must-not role (HR, PM, sales,
 * trainee, ops) and no top-1 job was in an expected family.
 */
describe("role-family benchmark", () => {
  const { rows, top1, top3, violationRate } = runBench();

  it("keeps family precision above the v2 floor", () => {
    expect(top1).toBeGreaterThanOrEqual(0.65);
    expect(top3).toBeGreaterThanOrEqual(0.75);
    expect(violationRate).toBeLessThanOrEqual(0.1);
  });

  it("recommends inference / infra roles, not HR / PM / sales, to an SGLang contributor", () => {
    const row = rows.find((r) => r.login === "zhaochenyang20")!;
    expect(row.top1Hit).toBe(true);
    expect(row.violations).toEqual([]);
  });
});
