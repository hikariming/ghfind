import type { ExtractedRequirement, StoredProfile } from "./schema";
import type { MatchGap } from "./score";
import { resolveSkill, skillLabel } from "./taxonomy";

/**
 * Recall for Talent Match: Workers AI embeddings into one Vectorize index that
 * holds both candidate profiles and job requirements (metadata `kind`). Recall
 * only narrows the pool; the deterministic scorer ranks it. Embeddings are
 * written when a profile or requirement changes, never on page reads.
 */

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;
export const JOB_RECALL_LIMIT = 50;

/** The slice of the Workers AI binding used here. */
export interface AiLike {
  run(model: string, input: { text: string[] }): Promise<unknown>;
}

export type VectorKind = "talent" | "job";

export interface VectorMetadata {
  kind: VectorKind;
  opted_in?: 0 | 1;
  direction?: string;
}

/** The slice of the Vectorize binding used here. */
export interface VectorizeLike {
  query(
    vector: number[],
    options: { topK: number; filter?: Record<string, unknown>; returnMetadata?: "none" | "indexed" | "all" },
  ): Promise<{ matches: { id: string; score: number }[] }>;
  upsert(vectors: { id: string; values: number[]; metadata: VectorMetadata }[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

/** Vectorize ids are capped at 64 bytes; GitHub ids and job ids stay well under. */
export const talentVectorId = (githubId: number) => `talent:${githubId}`;
export const jobVectorId = (jobId: string) => `job:${jobId}`;

export async function embed(ai: AiLike, text: string): Promise<number[]> {
  const result = (await ai.run(EMBEDDING_MODEL, { text: [text] })) as { data?: unknown };
  const vector = Array.isArray(result?.data) ? result.data[0] : null;
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) {
    throw new Error(`unexpected ${EMBEDDING_MODEL} output`);
  }
  return vector as number[];
}

/** English, skill-centric text so résumés in any language embed alike. */
export function profileEmbeddingText(profile: StoredProfile): string {
  const skills = profile.skills
    .filter((s) => s.id !== "other")
    .map((s) => `${skillLabel(s.id)} (${s.level})`);
  return [
    profile.headline.en,
    `Direction: ${profile.direction}. Experience: ${profile.years} years.`,
    `Skills: ${skills.join(", ")}`,
    profile.experience.map((e) => e.title).join("; "),
  ].filter(Boolean).join("\n");
}

export function requirementEmbeddingText(requirement: ExtractedRequirement): string {
  const list = (skills: ExtractedRequirement["mustHave"]) => skills.map((s) => `${skillLabel(s.id)} (${s.level})`).join(", ");
  return [
    requirement.title.en,
    `Direction: ${requirement.direction}. Experience: ${requirement.yearsMin ?? 0}+ years.`,
    `Required: ${list(requirement.mustHave)}`,
    `Preferred: ${list(requirement.niceToHave)}`,
  ].join("\n");
}

/** Job ids nearest to a profile vector, best first. */
export async function recallJobIds(index: VectorizeLike, vector: number[], topK = JOB_RECALL_LIMIT): Promise<string[]> {
  const { matches } = await index.query(vector, { topK, filter: { kind: "job" }, returnMetadata: "none" });
  return matches.flatMap((m) => (m.id.startsWith("job:") ? [m.id.slice(4)] : []));
}

/** A published Feed project, as the growth-advice candidate pool. */
export interface GrowthProject {
  repoKey: string;
  fullName: string;
  summary: string;
  language: string | null;
  topics: readonly string[];
  productScore: number;
  stars: number;
}

export interface GrowthCandidate {
  project: GrowthProject;
  /** Skill ids among the gaps that this project exercises. */
  closes: string[];
}

/**
 * Pick open-source projects that exercise the candidate's skill gaps: a
 * project qualifies when its language or a topic resolves to a gap skill.
 * Projects come pre-sorted by product score; each gap gets at most
 * `perGap` projects and the list is capped at `limit`.
 */
export function pickGrowthProjects(
  gaps: readonly MatchGap[],
  projects: readonly GrowthProject[],
  { perGap = 2, limit = 6 } = {},
): GrowthCandidate[] {
  const gapIds = [...new Set(gaps.flatMap((g) => (g.kind === "skill" ? [g.skillId] : [])))];
  if (!gapIds.length) return [];
  const used = new Map<string, number>(gapIds.map((id) => [id, 0]));
  const picked: GrowthCandidate[] = [];
  for (const project of projects) {
    if (picked.length >= limit) break;
    const skills = new Set(
      [project.language, ...project.topics].flatMap((name) => {
        const id = name ? resolveSkill(name) : null;
        return id ? [id] : [];
      }),
    );
    const closes = gapIds.filter((id) => skills.has(id) && (used.get(id) ?? 0) < perGap);
    if (!closes.length) continue;
    for (const id of closes) used.set(id, (used.get(id) ?? 0) + 1);
    picked.push({ project, closes });
  }
  return picked;
}
