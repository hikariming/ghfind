import { describe, expect, it } from "vitest";
import { deriveProjectBoardEligibility } from "../project-ranking";
import type { ProjectAnalysisArtifact } from "../project-analysis-contract";
import { validProjectAnalysis } from "./project-analysis-contract.test";

function artifact(
  overrides: Partial<ProjectAnalysisArtifact> = {},
): ProjectAnalysisArtifact {
	return { ...(validProjectAnalysis as ProjectAnalysisArtifact), ...overrides } as ProjectAnalysisArtifact;
}

describe("project board eligibility", () => {
  it("admits verified high-value, low-exposure projects to treasure", () => {
    expect(deriveProjectBoardEligibility(artifact())).toEqual({
      treasureEligible: true,
      classicEligible: false,
      blockingReasons: [],
    });
  });

  it("admits a score at the treasure threshold", () => {
    const result = deriveProjectBoardEligibility(
      artifact({
        scores: {
          ...(validProjectAnalysis as ProjectAnalysisArtifact).scores,
          pain: {
            ...(validProjectAnalysis as ProjectAnalysisArtifact).scores.pain,
            score: 5,
          },
          product_score: 60,
        },
      }),
    );

    expect(result.treasureEligible).toBe(true);
    expect(result.blockingReasons).not.toContain("product_score_below_treasure_threshold");
  });

  it("does not treat low exposure as a quality bonus below 60", () => {
    const result = deriveProjectBoardEligibility(
      artifact({
        scores: {
          ...(validProjectAnalysis as ProjectAnalysisArtifact).scores,
          pain: {
            ...(validProjectAnalysis as ProjectAnalysisArtifact).scores.pain,
            score: 5,
          },
          product_score: 59,
        },
      }),
    );

    expect(result.treasureEligible).toBe(false);
    expect(result.blockingReasons).toContain("product_score_below_treasure_threshold");
  });

  it("admits established mature projects at the 60-point threshold to classic", () => {
    const result = deriveProjectBoardEligibility(
      artifact({
        confidence: 82,
        scores: {
          ...(validProjectAnalysis as ProjectAnalysisArtifact).scores,
          product_score: 60,
        },
        exposure: {
          ...(validProjectAnalysis as ProjectAnalysisArtifact).exposure,
          band: "established",
        },
        project: {
          ...(validProjectAnalysis as ProjectAnalysisArtifact).project,
          lifecycle: "stable_maintenance",
        },
      }),
    );

    expect(result.treasureEligible).toBe(false);
    expect(result.classicEligible).toBe(true);
  });

  it("keeps established mature projects below 60 off classic", () => {
    const result = deriveProjectBoardEligibility(
      artifact({
        confidence: 82,
        scores: {
          ...(validProjectAnalysis as ProjectAnalysisArtifact).scores,
          product_score: 59,
        },
        exposure: {
          ...(validProjectAnalysis as ProjectAnalysisArtifact).exposure,
          band: "established",
        },
        project: {
          ...(validProjectAnalysis as ProjectAnalysisArtifact).project,
          lifecycle: "stable_maintenance",
        },
      }),
    );

    expect(result.treasureEligible).toBe(false);
    expect(result.classicEligible).toBe(false);
  });

  it("blocks both boards on a critical adoption risk", () => {
    const result = deriveProjectBoardEligibility(
      artifact({
        risks: [
          {
            severity: "critical",
            category: "security",
            summary: "The core authentication flow is bypassable.",
            evidence_ids: ["readme-contract"],
          },
        ],
      }),
    );

    expect(result.treasureEligible).toBe(false);
    expect(result.classicEligible).toBe(false);
    expect(result.blockingReasons).toContain("critical_adoption_risk");
  });
});
