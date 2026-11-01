import type { SubScoreKey } from "@/lib/types";

/**
 * Talent Match data contract (docs/plans/2026-10-12-talent-match-report.md).
 * The backend returns these shapes from /api/talent-match/*; `mock.ts` holds a
 * sample report of the same shape. Company-side shapes arrive with phase 3.
 */

/** Bilingual copy. The prototype ships zh + en; other locales fall back to en. */
export type Text = { zh: string; en: string };

/** `verified` = proven by the GitHub scan; `claimed` = résumé or website only. */
export type EvidenceSource = "verified" | "claimed";

export type SkillLevel = 1 | 2 | 3 | 4;

export type ProfileSkill = {
  /** Taxonomy id, e.g. "llm-inference". */
  id: string;
  label: string;
  level: SkillLevel;
  source: EvidenceSource;
  evidence: Text;
};

export type ProfileItem = { title: Text; detail: Text; source: EvidenceSource };

export type TalentProfile = {
  login: string;
  name: string;
  headline: Text;
  direction: Text;
  years: number;
  /** v11 GitHub sub-scores (verified evidence strength). */
  dimensions: Record<SubScoreKey, number>;
  skills: ProfileSkill[];
  experience: ProfileItem[];
  research: ProfileItem[];
  education: ProfileItem[];
  preferences: { location: Text; remote: boolean; employment: Text };
};

export type GapKind = "skill" | "research" | "education" | "experience";
export type Cost = "low" | "medium" | "high";

export type MatchGap = { label: Text; kind: GapKind; cost: Cost };

/** Deterministic score breakdown, each part 0-100. */
export type MatchBreakdown = { mustHave: number; niceToHave: number; conditions: number };

export type JobMatch = {
  jobId: string;
  company: string;
  title: Text;
  location: Text;
  /** Fit now, 0-100. */
  fit: number;
  /** How reachable the role is once gaps are counted. */
  reach: "high" | "medium" | "low";
  breakdown: MatchBreakdown;
  matched: string[];
  gaps: MatchGap[];
  reason: Text;
};

export type GrowthKind = "open_source" | "skill" | "research" | "education" | "portfolio";

export type GrowthItem = {
  kind: GrowthKind;
  title: Text;
  detail: Text;
  /** Only repos returned by the project feed; never model-invented. */
  repo?: { fullName: string; stars: number; language: string };
  /** Labels of the gaps this step closes. */
  closes: Text[];
  horizon: Text;
};

export type CandidateReport = {
  id: string;
  matchVersion: number;
  createdAt: string;
  profile: TalentProfile;
  summary: Text;
  strengths: Text[];
  matches: JobMatch[];
  growth: GrowthItem[];
};

export type Quota = { used: number; limit: number; resetsAt: string };

/** Pipeline stages, in order, shown while a report is generated. */
export const CANDIDATE_STAGES = ["normalize", "extract", "verify", "match", "advise"] as const;
