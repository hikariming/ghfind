import { describe, expect, it } from "vitest";
import { beatPercent } from "../percentile";

describe("beatPercent", () => {
  it("returns null when you are the only ranked account (or board empty)", () => {
    expect(beatPercent(0, 0)).toBeNull();
    expect(beatPercent(0, 1)).toBeNull();
  });

  it("computes the share of accounts scored below you, rounded to 1 decimal", () => {
    expect(beatPercent(87, 100)).toBe(87);
    expect(beatPercent(1, 3)).toBe(33.3); // 33.33 -> 33.3
    expect(beatPercent(2, 3)).toBe(66.7); // 66.66 -> 66.7
  });

  it("beats 0% when nobody is below you, 100% when everyone else is", () => {
    expect(beatPercent(0, 10)).toBe(0);
    expect(beatPercent(9, 10)).toBe(90);
    expect(beatPercent(99, 100)).toBe(99);
  });

  it("clamps into [0, 100]", () => {
    expect(beatPercent(100, 100)).toBe(100);
    expect(beatPercent(0, 2)).toBe(0);
  });
});
