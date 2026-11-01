import type { Degree, RequirementSkill, StoredProfile, ExtractedRequirement } from "./schema";
import { skillGroup } from "./taxonomy";

/**
 * Deterministic Talent Match scoring. Models never decide a score: résumés
 * carry prompt injection, so extraction only produces structured facts and
 * this module turns them into numbers. Vector similarity is recall only and
 * never enters the score. Changing any weight or rule below must bump
 * {@link MATCH_VERSION} so stored reports stay labelled with their rules.
 */
// v2 narrows the candidate pool to DeepSeek and focuses advice on the top role.
// v3 adds the showcard job-matching fixes from #480.
export const MATCH_VERSION = 3;

/** Résumé-only (claimed) evidence counts for less than GitHub-verified. */
export const SOURCE_WEIGHT = { verified: 1, claimed: 0.7 } as const;

const MUST_HAVE_WEIGHT = 0.6;
const NICE_TO_HAVE_WEIGHT = 0.2;
const CONDITIONS_WEIGHT = 0.2;
/** Fit ceiling when any must-have skill is entirely absent. */
const MISSING_MUST_HAVE_CAP = 60;
/**
 * Specificity: how much a requirement says about the role, as the summed
 * levels of its skills, nice-to-haves and soft skills each counting half. A
 * role stated with at least SPECIFIC_MASS is fully specific; sparser roles
 * (a level-1 language, a couple of soft skills, as non-engineering roles
 * extract to) are easy to "fully meet" and say little about fit, so their
 * fit shrinks toward SPARSE_FIT_FLOOR of itself.
 */
const SPECIFIC_MASS = 8;
const SPARSE_FIT_FLOOR = 0.4;
const NICE_MASS_WEIGHT = 0.5;
const SOFT_SKILL_WEIGHT = 0.5;
/**
 * Fit factor when the candidate holds none of the role's domain skills (its
 * required skills other than languages): a language alone is shared by most
 * engineers and is not positive evidence for the role.
 */
const NO_DOMAIN_EVIDENCE_FACTOR = 0.75;
/** Soft skills outside the "practice" group. */
const SOFT_SKILLS: ReadonlySet<string> = new Set(["prompt-engineering"]);
/** Being at most this many years short is a medium-cost gap; more is high. */
const EXPERIENCE_MEDIUM_GAP_YEARS = 2;

const DEGREE_RANK: Record<Degree, number> = { none: 0, associate: 1, bachelor: 2, master: 3, phd: 4 };

export type Cost = "low" | "medium" | "high";
export type Reach = "high" | "medium" | "low";

export type MatchCandidate = Pick<StoredProfile, "years" | "skills" | "education" | "research">;
export type MatchRequirement = Pick<
  ExtractedRequirement,
  "yearsMin" | "mustHave" | "niceToHave" | "degree" | "research"
>;

export type MatchGap =
  | { kind: "skill"; skillId: string; required: number; /** 0 = absent. */ have: number; mustHave: boolean; cost: Cost }
  | { kind: "experience"; required: number; have: number; cost: Cost }
  | { kind: "education"; degree: Degree; cost: Cost }
  | { kind: "research"; required: boolean; cost: Cost };

export interface MatchScore {
  matchVersion: number;
  /** Fit now, 0-100. */
  fit: number;
  reach: Reach;
  /** Each part 0-100. */
  breakdown: { mustHave: number; niceToHave: number; conditions: number };
  /** How fully the requirement states the role, 0-1 (see SPECIFIC_MASS). */
  specificity: number;
  /** Fit before the missing-must-have cap; orders roles that share the cap. */
  uncappedFit: number;
  /** Required skill ids the candidate meets at the required level. */
  matched: string[];
  gaps: MatchGap[];
  /** Share of `matched` backed by verified evidence, 0-1. */
  verifiedShare: number;
}

type HeldSkill = MatchCandidate["skills"][number];

function skillCredit(held: HeldSkill | undefined, required: RequirementSkill): number {
  if (!held) return 0;
  return Math.min(1, held.level / required.level) * SOURCE_WEIGHT[held.source];
}

function skillGapCost(have: number, required: number): Cost {
  if (have === 0) return "medium";
  return required - have === 1 ? "low" : "medium";
}

const percent = (value: number) => Math.round(value * 100);

const isSoft = (id: string) => SOFT_SKILLS.has(id) || skillGroup(id) === "practice";
const isDomain = (id: string) => skillGroup(id) !== "language";

/** 0-1: how much the requirement's skills say about the role. */
export function requirementSpecificity(requirement: Pick<MatchRequirement, "mustHave" | "niceToHave">): number {
  const mass = (skills: readonly RequirementSkill[]) =>
    skills.reduce((sum, s) => sum + s.level * (isSoft(s.id) ? SOFT_SKILL_WEIGHT : 1), 0);
  const mustIds = new Set(requirement.mustHave.map((s) => s.id));
  const nice = requirement.niceToHave.filter((s) => !mustIds.has(s.id));
  return Math.min(1, (mass(requirement.mustHave) + NICE_MASS_WEIGHT * mass(nice)) / SPECIFIC_MASS);
}

export function scoreMatch(candidate: MatchCandidate, requirement: MatchRequirement): MatchScore {
  const held = new Map<string, HeldSkill>();
  for (const skill of candidate.skills) {
    const existing = held.get(skill.id);
    // Prefer the stronger credit when a skill appears twice.
    if (!existing || skill.level * SOURCE_WEIGHT[skill.source] > existing.level * SOURCE_WEIGHT[existing.source]) {
      held.set(skill.id, skill);
    }
  }

  const mustIds = new Set(requirement.mustHave.map((s) => s.id));
  const mustHave = requirement.mustHave;
  // A skill listed as both must and nice only counts as must.
  const niceToHave = requirement.niceToHave.filter((s) => !mustIds.has(s.id));

  const matched: string[] = [];
  const gaps: MatchGap[] = [];
  let missingMustHave = false;

  const coverage = (skills: readonly RequirementSkill[], isMust: boolean): number => {
    if (skills.length === 0) return 100;
    let credit = 0;
    for (const required of skills) {
      const skill = held.get(required.id);
      credit += skillCredit(skill, required);
      const have = skill?.level ?? 0;
      if (have >= required.level) {
        matched.push(required.id);
      } else {
        if (have === 0 && isMust) missingMustHave = true;
        gaps.push({ kind: "skill", skillId: required.id, required: required.level, have, mustHave: isMust, cost: skillGapCost(have, required.level) });
      }
    }
    return percent(credit / skills.length);
  };

  const mustHaveScore = coverage(mustHave, true);
  const niceToHaveScore = coverage(niceToHave, false);
  // With no must-haves the nice-to-haves are all the role states; an empty
  // must list must not count as fully met.
  const coreScore = mustHave.length ? mustHaveScore : niceToHaveScore;

  const conditions: number[] = [];
  const yearsMin = requirement.yearsMin ?? 0;
  if (yearsMin > 0) {
    conditions.push(Math.min(1, candidate.years / yearsMin));
    if (candidate.years < yearsMin) {
      const short = yearsMin - candidate.years;
      gaps.push({ kind: "experience", required: yearsMin, have: candidate.years, cost: short <= EXPERIENCE_MEDIUM_GAP_YEARS ? "medium" : "high" });
    }
  }
  if (requirement.degree !== "none") {
    const best = Math.max(0, ...candidate.education.map((e) => DEGREE_RANK[e.degree]));
    const met = best >= DEGREE_RANK[requirement.degree];
    conditions.push(met ? 1 : 0);
    if (!met) gaps.push({ kind: "education", degree: requirement.degree, cost: "high" });
  }
  const topVenue = candidate.research.some((r) => r.topVenue);
  if (requirement.research === "required") {
    conditions.push(topVenue ? 1 : candidate.research.length > 0 ? 0.5 : 0);
    if (!topVenue) gaps.push({ kind: "research", required: true, cost: "high" });
  } else if (requirement.research === "preferred" && !topVenue) {
    // Listed for growth advice; preferred research never lowers the score.
    gaps.push({ kind: "research", required: false, cost: "high" });
  }
  const conditionsScore = conditions.length
    ? percent(conditions.reduce((a, b) => a + b, 0) / conditions.length)
    : 100;

  const specificity = requirementSpecificity(requirement);
  let fit =
    (MUST_HAVE_WEIGHT * coreScore + NICE_TO_HAVE_WEIGHT * niceToHaveScore + CONDITIONS_WEIGHT * conditionsScore) *
    (SPARSE_FIT_FLOOR + (1 - SPARSE_FIT_FLOOR) * specificity);
  const domain = [...mustHave, ...niceToHave].filter((s) => isDomain(s.id));
  if (domain.length && !domain.some((s) => (held.get(s.id)?.level ?? 0) > 0)) fit *= NO_DOMAIN_EVIDENCE_FACTOR;
  const uncappedFit = Math.round(fit);
  if (missingMustHave) fit = Math.min(fit, MISSING_MUST_HAVE_CAP);

  const verified = matched.filter((id) => held.get(id)?.source === "verified").length;

  return {
    matchVersion: MATCH_VERSION,
    fit: Math.round(fit),
    reach: reachOf(gaps),
    breakdown: { mustHave: mustHaveScore, niceToHave: niceToHaveScore, conditions: conditionsScore },
    specificity,
    uncappedFit,
    matched,
    gaps,
    verifiedShare: matched.length ? verified / matched.length : 0,
  };
}

/** Gaps that stand between the candidate and the role (nice-to-haves and preferred research don't). */
function isBlocking(gap: MatchGap): boolean {
  if (gap.kind === "skill") return gap.mustHave;
  if (gap.kind === "research") return gap.required;
  return true;
}

/** High when every blocking gap is cheap to close, low when any is expensive. */
export function reachOf(gaps: readonly MatchGap[]): Reach {
  const blocking = gaps.filter(isBlocking);
  if (blocking.some((g) => g.cost === "high")) return "low";
  if (blocking.every((g) => g.cost === "low")) return "high";
  return "medium";
}

const REACH_ORDER: Record<Reach, number> = { high: 0, medium: 1, low: 2 };

/** Best first: fit, then uncapped fit, then reach, then the caller's stable id. */
export function rankMatches<T extends { id: string; score: MatchScore }>(matches: readonly T[]): T[] {
  return [...matches].sort(
    (a, b) =>
      b.score.fit - a.score.fit ||
      b.score.uncappedFit - a.score.uncappedFit ||
      REACH_ORDER[a.score.reach] - REACH_ORDER[b.score.reach] ||
      a.id.localeCompare(b.id),
  );
}
