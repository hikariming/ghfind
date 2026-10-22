import {
  computeDiscoverScore,
  type DiscoverProjectType,
  type DiscoverScorePartition,
  type DiscoverTimeToFirstValue,
  type DiscoverScoreResult,
} from "../../../platform/shared/discover-score";
import { DISCOVER_PARTITION_TAG_IDS, type ProjectAnalysisArtifact } from "@/lib/project-analysis-contract";
import type { ProjectAssessment } from "@/lib/project-analysis-db";

export {
  DISCOVER_SCORE_VERSION,
  computeDiscoverScore,
  discoverScoreBand,
  lintDiscoverHookV6,
  type DiscoverScoreBand,
  type DiscoverScorePartition,
  type DiscoverScoreResult,
} from "../../../platform/shared/discover-score";

const CANONICAL_PARTITION: Readonly<Record<(typeof DISCOVER_PARTITION_TAG_IDS)[number], DiscoverScorePartition>> = {
  "use_case:ai-agent": "agent",
  "use_case:agent-skill": "skill",
  "artifact:microservice": "microservice",
  "artifact:sandbox": "sandbox",
};

/**
 * Scoring partition comes only from canonical evaluator tags. The #525
 * keyword cues stay a chip-filter fallback: on the 2026-10-23 sample they
 * mislabelled most matches (proxy -> agent, plugin API -> skill), so they
 * must not change a score.
 */
export function scoringPartitionFromTags(
  tags: ProjectAnalysisArtifact["project"]["product_tags"],
): DiscoverScorePartition {
  for (const tag of tags) {
    if (!("namespace" in tag)) continue;
    const id = `${tag.namespace}:${tag.slug}` as keyof typeof CANONICAL_PARTITION;
    const partition = CANONICAL_PARTITION[id];
    if (partition) return partition;
  }
  return "none";
}

export function discoverScoreFromAssessment(
  assessment: ProjectAssessment,
  partition: DiscoverScorePartition = scoringPartitionFromTags(assessment.analysis.project.product_tags),
): DiscoverScoreResult {
  return computeDiscoverScore({
    pain: assessment.painScore,
    effectiveness: assessment.effectivenessScore,
    experience: assessment.experienceScore,
    valueDensity: assessment.valueDensityScore,
    productScore: assessment.productScore,
    confidence: assessment.confidence,
    verificationLevel: assessment.verificationLevel,
    lifecycle: assessment.lifecycle,
    exposureBand: assessment.exposureBand,
    communityStrength: Number.isFinite(assessment.communityStrength) ? assessment.communityStrength : null,
    risks: assessment.risks.map((risk) => ({ severity: risk.severity, category: risk.category })),
    partition,
    projectType: assessment.projectType as DiscoverProjectType,
    timeToFirstValue: timeToFirstValueOf(assessment.analysis.project),
  });
}

const TTFV = new Set<string>(["minutes", "hour", "day", "weeks"]);

/** Skill v6 field; older artifacts do not carry it and fall back to a proxy. */
function timeToFirstValueOf(project: object): DiscoverTimeToFirstValue | null {
  const value = (project as { time_to_first_value?: unknown }).time_to_first_value;
  return typeof value === "string" && TTFV.has(value) ? (value as DiscoverTimeToFirstValue) : null;
}

/** Opt-in only. Default off; flipping it in production needs owner sign-off. */
export function isDiscoverScoreEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GHFIND_DISCOVER_SCORE_V1 === "1";
}
