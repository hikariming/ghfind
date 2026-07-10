import { describe, expect, it } from "vitest";
import {
  normalizeProjectLanguage,
  parseProjectPage,
  parseProjectSort,
  projectQualityScore,
  projectRecommendationReason,
} from "../projects";

describe("project discovery primitives", () => {
  it("scores contributor quality with logarithmic project scale", () => {
    expect(projectQualityScore(90, 3)).toBeCloseTo(180);
    expect(projectQualityScore(90, 0)).toBe(0);
    expect(projectQualityScore(Number.NaN, 3)).toBe(0);
  });

  it("chooses one deterministic recommendation reason", () => {
    expect(projectRecommendationReason({ eliteCount: 3, momentum: 2, avgScore: 85 })).toBe(
      "elite",
    );
    expect(projectRecommendationReason({ eliteCount: 0, momentum: 20, avgScore: 70 })).toBe(
      "momentum",
    );
    expect(projectRecommendationReason({ eliteCount: 0, momentum: 1, avgScore: 90 })).toBe(
      "quality",
    );
    expect(projectRecommendationReason({ eliteCount: 0, momentum: 1, avgScore: 70 })).toBe(
      "popular",
    );
  });

  it("parses stable project list URL parameters", () => {
    expect(parseProjectSort("quality")).toBe("quality");
    expect(parseProjectSort("momentum")).toBe("momentum");
    expect(parseProjectSort("stars")).toBe("stars");
    expect(parseProjectSort("unknown")).toBe("quality");

    expect(parseProjectPage("3")).toBe(3);
    expect(parseProjectPage("0")).toBe(1);
    expect(parseProjectPage("nope")).toBe(1);
    expect(parseProjectPage(["4"])).toBe(4);

    expect(normalizeProjectLanguage(" TypeScript ")).toBe("TypeScript");
    expect(normalizeProjectLanguage(" ")).toBeNull();
    expect(normalizeProjectLanguage(undefined)).toBeNull();
  });
});
