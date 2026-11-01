import { canonicalizeSkills, storedProfileSchema, type ExtractedProfile, type StoredProfile, type StoredSkill } from "./schema";
import { SOURCE_WEIGHT } from "./score";
import { resolveSkill } from "./taxonomy";

/**
 * Verified skill evidence from data the scan already stored in D1 (language
 * facets and the repo graph), merged into the extracted résumé profile without
 * any model involvement. Evidence strings are locale-neutral (repo names,
 * counts, percentages) so they read the same in every report language.
 */

/** One `developer_facets` language row: weight is the % byte share. */
export interface LanguageShare {
  language: string;
  share: number;
}

/** One repo from `repo_developers` joined to `repos`. */
export interface RepoEvidence {
  nameWithOwner: string;
  relation: "owner" | "contributor";
  stars: number;
  language: string | null;
  topics: readonly string[];
  /** Merged PRs (contributors); null when unknown. */
  prs: number | null;
}

/** A language that makes up this share of someone's code is a core skill. */
const CORE_LANGUAGE_SHARE = 40;

/** Level a repo proves for its language and topics. */
export function repoLevel(repo: RepoEvidence): 1 | 2 | 3 | 4 {
  if (repo.relation === "owner") {
    if (repo.stars >= 1000) return 4;
    return repo.stars >= 100 ? 3 : 2;
  }
  const prs = repo.prs ?? 0;
  if (prs >= 5 && repo.stars >= 1000) return 4;
  if (prs >= 1 && repo.stars >= 500) return 3;
  return 2;
}

function formatStars(stars: number): string {
  return stars >= 1000 ? `${Math.round(stars / 100) / 10}k★` : `${stars}★`;
}

function repoEvidence(repo: RepoEvidence): string {
  const parts = [repo.nameWithOwner];
  if (repo.relation === "contributor" && repo.prs) parts.push(`${repo.prs} PR${repo.prs === 1 ? "" : "s"}`);
  parts.push(formatStars(repo.stars));
  return parts.join(" · ");
}

/** Stronger credit wins, matching how the scorer picks between duplicates. */
function stronger(a: StoredSkill, b: StoredSkill): StoredSkill {
  return b.level * SOURCE_WEIGHT[b.source] > a.level * SOURCE_WEIGHT[a.source] ? b : a;
}

export function verifiedSkills(languages: readonly LanguageShare[], repos: readonly RepoEvidence[]): StoredSkill[] {
  const byId = new Map<string, StoredSkill>();
  const offer = (id: string | null, level: 1 | 2 | 3 | 4, evidence: string) => {
    if (!id) return;
    const skill: StoredSkill = { id, level, evidence, source: "verified" };
    const existing = byId.get(id);
    // Equal credit keeps the first offer: languages, then repos by stars.
    byId.set(id, existing ? stronger(existing, skill) : skill);
  };
  for (const { language, share } of languages) {
    offer(resolveSkill(language), share >= CORE_LANGUAGE_SHARE ? 3 : 2, `GitHub · ${language} ${Math.round(share)}%`);
  }
  for (const repo of [...repos].sort((a, b) => b.stars - a.stars)) {
    const level = repoLevel(repo);
    const evidence = repoEvidence(repo);
    if (repo.language) offer(resolveSkill(repo.language), level, evidence);
    // Well-known projects are taxonomy aliases (vllm, sglang, deepspeed, …).
    offer(resolveSkill(repo.nameWithOwner.slice(repo.nameWithOwner.indexOf("/") + 1)), level, evidence);
    for (const topic of repo.topics) offer(resolveSkill(topic), level, evidence);
  }
  return [...byId.values()];
}

export interface ProfileInput {
  login: string;
  extracted: ExtractedProfile;
  verified: readonly StoredSkill[];
  preferences: StoredProfile["preferences"];
}

/**
 * Build the stored profile: canonical résumé skills (claimed) merged with
 * verified skills, one entry per id. Résumé sections are claimed evidence.
 */
export function buildStoredProfile(input: ProfileInput): StoredProfile {
  const { extracted } = input;
  const claimed = canonicalizeSkills(extracted.skills).skills.map(
    (skill): StoredSkill => ({ ...skill, source: "claimed" }),
  );
  const byId = new Map<string, StoredSkill>();
  const others: StoredSkill[] = [];
  for (const skill of [...input.verified, ...claimed]) {
    if (skill.id === "other") {
      others.push(skill);
      continue;
    }
    const existing = byId.get(skill.id);
    byId.set(skill.id, existing ? stronger(existing, skill) : skill);
  }
  const skills = [...byId.values()]
    .sort((a, b) => b.level * SOURCE_WEIGHT[b.source] - a.level * SOURCE_WEIGHT[a.source])
    .concat(others)
    .slice(0, 60);
  return storedProfileSchema.parse({
    login: input.login,
    name: extracted.name || input.login,
    headline: extracted.headline,
    direction: extracted.direction,
    years: extracted.years,
    skills,
    experience: extracted.experience.map((item) => ({ ...item, source: "claimed" })),
    research: extracted.research.map((item) => ({ ...item, source: "claimed" })),
    education: extracted.education.map((item) => ({ ...item, source: "claimed" })),
    preferences: input.preferences,
  });
}
