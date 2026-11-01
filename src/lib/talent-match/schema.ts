import { z } from "zod";
import { TALENT_CATEGORIES } from "@/components/talent/categories";
import { EMPLOYMENT_TYPES } from "@/lib/jobs";
import { OTHER_SKILL, isSkillId, resolveSkill } from "./taxonomy";

/**
 * Stored and extracted Talent Match shapes. Extraction (LLM #1) output is
 * validated against the `extracted*` schemas; everything the model returns is
 * `claimed` evidence until merged with verified GitHub signals. Bump
 * {@link SCHEMA_VERSION} whenever a stored shape changes.
 */
export const SCHEMA_VERSION = 1;

export const DEGREES = ["none", "associate", "bachelor", "master", "phd"] as const;
export type Degree = (typeof DEGREES)[number];

export const RESEARCH_REQUIREMENTS = ["none", "preferred", "required"] as const;

export const DIRECTION_IDS = TALENT_CATEGORIES.map((c) => c.id) as [
  (typeof TALENT_CATEGORIES)[number]["id"],
  ...(typeof TALENT_CATEGORIES)[number]["id"][],
];

const line = (max: number) => z.string().trim().max(max);
const text = z.object({ zh: line(300), en: line(300) });
const level = z.number().int().min(1).max(4);
const source = z.enum(["verified", "claimed"]);

const extractedSkill = z.object({
  /** Taxonomy id; canonicalized (aliases resolved, unknowns → "other") after parsing. */
  id: line(80).min(1),
  level,
  evidence: line(300),
});

const extractedItem = z.object({ title: line(200).min(1), detail: line(500) });

const extractedResearch = extractedItem.extend({
  venue: line(120).default(""),
  firstAuthor: z.boolean().default(false),
  /** Top ML/systems venue (NeurIPS, ICML, ICLR, OSDI, MLSys, …). */
  topVenue: z.boolean().default(false),
});

const extractedEducation = z.object({
  degree: z.enum(DEGREES),
  school: line(200),
  field: line(200),
});

/** LLM #1 output for a candidate's résumé. */
export const extractedProfileSchema = z.object({
  name: line(120),
  headline: text,
  direction: z.enum(DIRECTION_IDS),
  years: z.number().min(0).max(60),
  skills: z.array(extractedSkill).max(40),
  experience: z.array(extractedItem).max(20),
  research: z.array(extractedResearch).max(30),
  education: z.array(extractedEducation).max(6),
});
export type ExtractedProfile = z.infer<typeof extractedProfileSchema>;

const requirementSkill = z.object({ id: line(80).min(1), level });

/** LLM #1 output for a job description; the same schema serves pasted JDs. */
export const extractedRequirementSchema = z.object({
  title: text,
  direction: z.enum(DIRECTION_IDS),
  yearsMin: z.number().min(0).max(30).nullable(),
  location: line(200),
  employment: z.array(z.enum(EMPLOYMENT_TYPES)).max(EMPLOYMENT_TYPES.length),
  mustHave: z.array(requirementSkill).max(20),
  niceToHave: z.array(requirementSkill).max(20),
  /** Minimum degree; "none" when unstated. */
  degree: z.enum(DEGREES),
  research: z.enum(RESEARCH_REQUIREMENTS),
});
export type ExtractedRequirement = z.infer<typeof extractedRequirementSchema>;

export type RequirementSkill = z.infer<typeof requirementSkill>;

/** A skill as stored on a profile, after canonicalization and verification. */
export const storedSkillSchema = extractedSkill.extend({
  source,
  /** Original name when `id` is "other". */
  name: line(80).optional(),
});
export type StoredSkill = z.infer<typeof storedSkillSchema>;

export const storedProfileSchema = z.object({
  login: line(39).min(1),
  name: line(120),
  headline: text,
  direction: z.enum(DIRECTION_IDS),
  years: z.number().min(0).max(60),
  skills: z.array(storedSkillSchema).max(60),
  experience: z.array(extractedItem.extend({ source })).max(20),
  research: z.array(extractedResearch.extend({ source })).max(30),
  education: z.array(extractedEducation.extend({ source })).max(6),
  preferences: z.object({
    location: line(200),
    remote: z.boolean(),
    employment: z.array(z.enum(EMPLOYMENT_TYPES)).max(EMPLOYMENT_TYPES.length),
  }),
});
export type StoredProfile = z.infer<typeof storedProfileSchema>;

/**
 * Map extracted skill ids onto the taxonomy: aliases resolve to their id,
 * unknown names become "other" (keeping the name, reported in `unknown` for
 * logging). Duplicates keep the highest level. Requirement lists use the same
 * rule but drop unknowns: a requirement nobody can be matched on only lowers
 * every candidate's score.
 */
export function canonicalizeSkills<T extends { id: string; level: number }>(
  skills: readonly T[],
): { skills: (T & { name?: string })[]; unknown: string[] } {
  const byId = new Map<string, T & { name?: string }>();
  const others: (T & { name?: string })[] = [];
  const unknown: string[] = [];
  for (const skill of skills) {
    const id = isSkillId(skill.id) ? skill.id : resolveSkill(skill.id);
    if (!id) {
      unknown.push(skill.id);
      others.push({ ...skill, id: OTHER_SKILL, name: skill.id });
      continue;
    }
    const existing = byId.get(id);
    if (!existing || skill.level > existing.level) byId.set(id, { ...skill, id });
  }
  return { skills: [...byId.values(), ...others], unknown };
}

export function canonicalizeRequirementSkills(
  skills: readonly RequirementSkill[],
): { skills: RequirementSkill[]; unknown: string[] } {
  const { skills: canonical, unknown } = canonicalizeSkills(skills);
  return {
    skills: canonical.filter((s) => s.id !== OTHER_SKILL).map(({ id, level }) => ({ id, level })),
    unknown,
  };
}
