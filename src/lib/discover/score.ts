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

type Env = Record<string, string | undefined>;

/**
 * Opt-in only. Default off. Even when set, the score is shown only to the
 * internal allowlist (`isDiscoverScoreViewer`); public Discover never reads it.
 */
export function isDiscoverScoreEnabled(env: Env = process.env): boolean {
  return env.GHFIND_DISCOVER_SCORE_V1 === "1";
}

/**
 * Internal allowlist: comma-separated numeric GitHub account ids from
 * `GHFIND_DISCOVER_INTERNAL_GITHUB_IDS` (a Worker secret). Ids, not logins,
 * because logins can be renamed and re-registered. Any malformed entry
 * disables the allowlist entirely (fail closed).
 */
export function discoverInternalGithubIds(env: Env = process.env): ReadonlySet<number> {
  const raw = (env.GHFIND_DISCOVER_INTERNAL_GITHUB_IDS ?? "").trim();
  if (!raw) return new Set();
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length > 20 || parts.some((part) => !/^[1-9]\d{0,15}$/.test(part) || !Number.isSafeInteger(Number(part)))) {
    return new Set();
  }
  return new Set(parts.map(Number));
}

/** True only for a signed-in allowlisted account while the flag is on. */
export function isDiscoverScoreViewer(githubId: number | null | undefined, env: Env = process.env): boolean {
  if (!isDiscoverScoreEnabled(env)) return false;
  if (typeof githubId !== "number" || !Number.isSafeInteger(githubId) || githubId <= 0) return false;
  return discoverInternalGithubIds(env).has(githubId);
}

type ScoredCard = { repoKey: string; productScore: number; discoverScore?: DiscoverScoreResult | null };

/**
 * Internal ranking: discover score first. Ties (notably the 84 ceiling that
 * hard_to_try projects collapse onto) break by how easily a stranger can try
 * the project, then by product score, then by repo key for a stable order.
 */
export function compareByDiscoverScore(a: ScoredCard, b: ScoredCard): number {
  const sa = a.discoverScore?.score ?? -1;
  const sb = b.discoverScore?.score ?? -1;
  if (sb !== sa) return sb - sa;
  const ta = a.discoverScore?.tryGate.strangerTryability ?? -1;
  const tb = b.discoverScore?.tryGate.strangerTryability ?? -1;
  if (tb !== ta) return tb - ta;
  if (b.productScore !== a.productScore) return b.productScore - a.productScore;
  return a.repoKey < b.repoKey ? -1 : a.repoKey > b.repoKey ? 1 : 0;
}

export function sortByDiscoverScore<T extends ScoredCard>(cards: readonly T[]): T[] {
  return [...cards].sort(compareByDiscoverScore);
}
