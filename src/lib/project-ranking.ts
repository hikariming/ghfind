import type { ProjectAnalysisArtifact, VerificationLevel } from "./project-analysis-contract";

const VERIFICATION_RANK: Record<VerificationLevel, number> = {
  metadata_only: 0,
  source_inspected: 1,
  built: 2,
  core_flow_executed: 3,
};

export type BoardBlockingReason =
  | "product_score_below_treasure_threshold"
  | "confidence_below_treasure_threshold"
  | "verification_below_treasure_threshold"
  | "exposure_not_treasure_eligible"
  | "critical_adoption_risk";

export interface ProjectBoardEligibility {
  treasureEligible: boolean;
  classicEligible: boolean;
  blockingReasons: BoardBlockingReason[];
}

export function deriveProjectBoardEligibility(
  analysis: ProjectAnalysisArtifact,
): ProjectBoardEligibility {
  const blockingReasons: BoardBlockingReason[] = [];
  const criticalRisk = analysis.risks.some((risk) => risk.severity === "critical");
  if (criticalRisk) blockingReasons.push("critical_adoption_risk");

  if (analysis.scores.product_score < 75) {
    blockingReasons.push("product_score_below_treasure_threshold");
  }
  if (analysis.confidence < 60) {
    blockingReasons.push("confidence_below_treasure_threshold");
  }
  if (VERIFICATION_RANK[analysis.verification_level] < VERIFICATION_RANK.source_inspected) {
    blockingReasons.push("verification_below_treasure_threshold");
  }
  if (!["low", "emerging"].includes(analysis.exposure.band)) {
    blockingReasons.push("exposure_not_treasure_eligible");
  }

  const treasureEligible = blockingReasons.length === 0;
  const classicEligible =
    !criticalRisk &&
    analysis.scores.product_score >= 80 &&
    analysis.confidence >= 70 &&
    ["active_evolution", "stable_maintenance", "feature_complete"].includes(
      analysis.project.lifecycle,
    ) &&
    ["established", "mainstream"].includes(analysis.exposure.band);

  return { treasureEligible, classicEligible, blockingReasons };
}
