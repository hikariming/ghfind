import { hasSkillRequirements } from "../../pipeline";
import { topMatches, type MatchableJob, type ScoredJob } from "../../report";
import type { ExtractedProfile, ExtractedRequirement } from "../../schema";
import { scoreMatch } from "../../score";
import { buildStoredProfile, verifiedSkills, type LanguageShare, type RepoEvidence } from "../../verify";
import candidatesFile from "./candidates.json";
import jobsFile from "./jobs.json";

/**
 * Role-family benchmark for Talent Match: real GitHub evidence (no résumé
 * claims) scored against a labelled job board through the same filter,
 * scorer and ranking as `runMatch`. A hit is a top job whose family is one of
 * the candidate's expected families; a violation is a must-not family in the
 * top {@link VIOLATION_DEPTH}.
 */

const VIOLATION_DEPTH = 3;

interface BenchCandidate {
  login: string;
  expect: string[];
  mustNot: string[];
  languages: LanguageShare[];
  repos: RepoEvidence[];
}

type BenchJob = MatchableJob & { family: string };

const candidates = candidatesFile.candidates as BenchCandidate[];
const jobs: BenchJob[] = jobsFile.jobs.map((job) => ({
  ...job,
  company: "Bench",
  location: { zh: "北京", en: "Beijing" },
  requirement: job.requirement as ExtractedRequirement,
}));
const familyOf = new Map(jobs.map((job) => [job.id, job.family]));

/** No résumé: the profile is verified GitHub evidence only. */
const EMPTY_RESUME: ExtractedProfile = {
  name: "",
  headline: { zh: "", en: "" },
  direction: "ai",
  years: 5,
  skills: [],
  experience: [],
  research: [],
  education: [],
};

export interface BenchRow {
  login: string;
  expect: string[];
  top: { id: string; family: string; fit: number }[];
  top1Hit: boolean;
  top3Hit: boolean;
  violations: string[];
}

function rankFor(candidate: BenchCandidate): ScoredJob[] {
  const profile = buildStoredProfile({
    login: candidate.login,
    extracted: EMPTY_RESUME,
    verified: verifiedSkills(candidate.languages, candidate.repos),
    preferences: { location: "", remote: false, employment: [] },
  });
  const matchable = jobs.filter((job) => hasSkillRequirements(job.requirement));
  return topMatches(matchable.map((job) => ({ job, score: scoreMatch(profile, job.requirement) })), 5);
}

export function runBench(): { rows: BenchRow[]; top1: number; top3: number; violationRate: number } {
  const rows = candidates.map((candidate): BenchRow => {
    const top = rankFor(candidate).map((s) => ({ id: s.job.id, family: familyOf.get(s.job.id) ?? "?", fit: s.score.fit }));
    const expected = new Set(candidate.expect);
    return {
      login: candidate.login,
      expect: candidate.expect,
      top,
      top1Hit: expected.has(top[0]?.family ?? ""),
      top3Hit: top.slice(0, 3).some((t) => expected.has(t.family)),
      violations: top.slice(0, VIOLATION_DEPTH).filter((t) => candidate.mustNot.includes(t.family)).map((t) => t.id),
    };
  });
  const share = (pred: (row: BenchRow) => boolean) => rows.filter(pred).length / rows.length;
  return {
    rows,
    top1: share((r) => r.top1Hit),
    top3: share((r) => r.top3Hit),
    violationRate: share((r) => r.violations.length > 0),
  };
}
