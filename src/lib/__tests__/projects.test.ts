import { describe, expect, it } from "vitest";
import {
  buildProjectListHref,
  normalizeProjectLanguage,
  parseProjectPage,
  parseProjectSort,
  communityStrengthScore,
  projectRecommendationReason,
} from "../projects";

describe("project discovery primitives", () => {
  it("scores community strength with logarithmic contributor scale", () => {
    expect(communityStrengthScore(90, 3)).toBeCloseTo(180);
    expect(communityStrengthScore(90, 0)).toBe(0);
    expect(communityStrengthScore(Number.NaN, 3)).toBe(0);
  });

  it("chooses one deterministic recommendation reason", () => {
    expect(projectRecommendationReason({ eliteCount: 3, contributorAttention: 2, avgScore: 85 })).toBe(
      "elite",
    );
    expect(projectRecommendationReason({ eliteCount: 0, contributorAttention: 20, avgScore: 70 })).toBe(
      "attention",
    );
    expect(projectRecommendationReason({ eliteCount: 0, contributorAttention: 1, avgScore: 90 })).toBe(
      "community",
    );
    expect(projectRecommendationReason({ eliteCount: 0, contributorAttention: 1, avgScore: 70 })).toBe(
      "popular",
    );
  });

  it("parses stable project list URL parameters", () => {
    expect(parseProjectSort("community")).toBe("community");
    expect(parseProjectSort("attention")).toBe("attention");
    expect(parseProjectSort("stars")).toBe("stars");
    expect(parseProjectSort("unknown")).toBe("community");

    expect(parseProjectPage("3")).toBe(3);
    expect(parseProjectPage("0")).toBe(1);
    expect(parseProjectPage("nope")).toBe(1);
    expect(parseProjectPage(["4"])).toBe(4);

    expect(normalizeProjectLanguage(" TypeScript ")).toBe("TypeScript");
    expect(normalizeProjectLanguage(" ")).toBeNull();
    expect(normalizeProjectLanguage(undefined)).toBeNull();
  });

  it("builds stable project list URLs while preserving filters", () => {
    expect(buildProjectListHref({ sort: "community", language: null, page: 1 })).toBe(
      "/projects",
    );
    expect(
      buildProjectListHref({ sort: "attention", language: "TypeScript", page: 3 }),
    ).toBe("/projects?sort=attention&language=TypeScript&page=3");
    expect(buildProjectListHref({ sort: "stars", language: "C++", page: 1 })).toBe(
      "/projects?sort=stars&language=C%2B%2B",
    );
  });
});
