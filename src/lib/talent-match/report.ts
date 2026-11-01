import { z } from "zod";
import type { ChatMessage } from "@/lib/llm";
import type { EmploymentType } from "@/lib/jobs";
import type { SubScoreKey } from "@/lib/types";
import { completeStructured, type Complete, type Usage } from "./extract";
import type { GrowthCandidate } from "./retrieve";
import type { Degree, ExtractedRequirement, StoredProfile } from "./schema";
import { rankMatches, type MatchGap, type MatchScore } from "./score";
import { skillLabel } from "./taxonomy";
import type { CandidateReport, GrowthItem, JobMatch, MatchGap as PresentedGap, TalentProfile, Text } from "./types";

/**
 * LLM #2 and report assembly. The model only writes prose around facts it is
 * handed: every job id, repository and gap it references is checked against
 * what was passed in, out-of-list references are dropped, and no number in
 * the report comes from the model.
 */

/** Matches shown in a report; advice is written for the top few. */
export const REPORT_MATCH_LIMIT = 8;
const ADVICE_MATCH_LIMIT = 5;
const ADVICE_GAP_LIMIT = 10;

export interface MatchableJob {
  id: string;
  company: string;
  title: Text;
  location: Text;
  requirement: ExtractedRequirement;
}

export interface ScoredJob {
  job: MatchableJob;
  score: MatchScore;
}

const same = (value: string): Text => ({ zh: value, en: value });

const DIRECTION_LABEL: Record<StoredProfile["direction"], Text> = {
  agent: { zh: "智能体与工作流", en: "Agents & workflows" },
  ai: { zh: "AI 与模型基础设施", en: "AI & model infrastructure" },
  infra: { zh: "后端与基础设施", en: "Backend & infrastructure" },
  frontend: { zh: "前端与全栈", en: "Frontend & full-stack" },
  tools: { zh: "开发者工具与数据", en: "Developer tools & data" },
  other: { zh: "其他", en: "Other" },
};

/** Best-scored jobs first (fit, then reach, then id). */
export function topMatches(scored: readonly ScoredJob[], limit: number): ScoredJob[] {
  return rankMatches(scored.map((s) => ({ ...s, id: s.job.id }))).slice(0, limit);
}

const DEGREE_LABEL: Record<Degree, Text> = {
  none: { zh: "无学历要求", en: "No degree" },
  associate: { zh: "专科学历", en: "Associate degree" },
  bachelor: { zh: "本科学历", en: "Bachelor's degree" },
  master: { zh: "硕士学位", en: "Master's degree" },
  phd: { zh: "博士学位", en: "PhD" },
};

const EMPLOYMENT_LABEL: Record<EmploymentType, Text> = {
  full_time: { zh: "全职", en: "Full-time" },
  intern: { zh: "实习", en: "Internship" },
  part_time: { zh: "兼职", en: "Part-time" },
};

/** Stable reference the model uses to say which gaps an action closes. */
export function gapKey(gap: MatchGap): string {
  return gap.kind === "skill" ? `skill:${gap.skillId}` : gap.kind;
}

export function gapLabel(gap: MatchGap): Text {
  switch (gap.kind) {
    case "skill":
      return gap.have === 0
        ? { zh: skillLabel(gap.skillId, true), en: skillLabel(gap.skillId) }
        : { zh: `${skillLabel(gap.skillId, true)} 提升到 ${gap.required} 级`, en: `${skillLabel(gap.skillId)} to level ${gap.required}` };
    case "experience":
      return { zh: `${gap.required} 年以上经验`, en: `${gap.required}+ years of experience` };
    case "education":
      return DEGREE_LABEL[gap.degree];
    case "research":
      return { zh: "顶会论文", en: "Top-venue publication" };
  }
}

function presentGap(gap: MatchGap): PresentedGap {
  return { label: gapLabel(gap), kind: gap.kind, cost: gap.cost };
}

function fallbackReason(score: MatchScore, requirement: ExtractedRequirement): Text {
  const total = requirement.mustHave.length + requirement.niceToHave.length;
  return {
    zh: `满足 ${score.matched.length}/${total} 项技能要求`,
    en: `Meets ${score.matched.length} of ${total} skill requirements`,
  };
}

export function toJobMatch({ job, score }: ScoredJob, reason?: Text): JobMatch {
  return {
    jobId: job.id,
    company: job.company,
    title: job.title,
    location: job.location,
    fit: score.fit,
    reach: score.reach,
    breakdown: score.breakdown,
    matched: score.matched.map((id) => skillLabel(id)),
    gaps: score.gaps.map(presentGap),
    reason: reason ?? fallbackReason(score, job.requirement),
  };
}

export function presentProfile(profile: StoredProfile, dimensions: Record<SubScoreKey, number>): TalentProfile {
  const item = (i: { title: string; detail: string; source: "verified" | "claimed" }) => ({ title: same(i.title), detail: same(i.detail), source: i.source });
  return {
    login: profile.login,
    name: profile.name,
    headline: profile.headline,
    direction: DIRECTION_LABEL[profile.direction],
    years: profile.years,
    dimensions,
    skills: profile.skills.map((s) => ({
      id: s.id,
      label: s.id === "other" ? s.name ?? s.id : skillLabel(s.id),
      level: s.level as 1 | 2 | 3 | 4,
      source: s.source,
      evidence: same(s.evidence),
    })),
    experience: profile.experience.map(item),
    research: profile.research.map(item),
    education: profile.education.map((e) => ({
      title: same(e.school),
      detail: { zh: [DEGREE_LABEL[e.degree].zh, e.field].filter(Boolean).join(" · "), en: [DEGREE_LABEL[e.degree].en, e.field].filter(Boolean).join(" · ") },
      source: e.source,
    })),
    preferences: {
      location: same(profile.preferences.location),
      remote: profile.preferences.remote,
      employment: {
        zh: profile.preferences.employment.map((t) => EMPLOYMENT_LABEL[t].zh).join(" / "),
        en: profile.preferences.employment.map((t) => EMPLOYMENT_LABEL[t].en).join(" / "),
      },
    },
  };
}

const text = z.object({ zh: z.string().trim().min(1).max(600), en: z.string().trim().min(1).max(600) });

export const adviceSchema = z.object({
  summary: text,
  strengths: z.array(text).max(5),
  reasons: z.array(z.object({ jobId: z.string(), reason: text })).max(ADVICE_MATCH_LIMIT),
  growth: z.array(z.object({
    kind: z.enum(["open_source", "skill", "research", "education", "portfolio"]),
    title: text,
    detail: text,
    /** owner/name from the provided list, or null. */
    repo: z.string().nullable(),
    /** Gap keys from the provided list. */
    closes: z.array(z.string()).max(6),
    horizon: text,
  })).max(8),
});
export type Advice = z.infer<typeof adviceSchema>;

/** The most common gaps across the top matches, most frequent first. */
export function commonGaps(scored: readonly ScoredJob[]): MatchGap[] {
  const counts = new Map<string, { gap: MatchGap; n: number }>();
  for (const { score } of scored) {
    for (const gap of score.gaps) {
      const key = gapKey(gap);
      const entry = counts.get(key);
      if (entry) entry.n++;
      else counts.set(key, { gap, n: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, ADVICE_GAP_LIMIT).map((e) => e.gap);
}

export interface AdviceInput {
  profile: StoredProfile;
  matches: readonly ScoredJob[];
  gaps: readonly MatchGap[];
  projects: readonly GrowthCandidate[];
}

export function adviceMessages(input: AdviceInput): ChatMessage[] {
  const facts = {
    candidate: {
      headline: input.profile.headline.en,
      direction: input.profile.direction,
      years: input.profile.years,
      skills: input.profile.skills.slice(0, 20).map((s) => ({ skill: s.id === "other" ? s.name : skillLabel(s.id), level: s.level, evidence: s.source })),
    },
    growthTargetJobId: topMatches(input.matches, 1)[0]?.job.id ?? null,
    jobs: topMatches(input.matches, ADVICE_MATCH_LIMIT).map(({ job, score }) => ({
      jobId: job.id, company: job.company, title: job.title.en, fit: score.fit, reach: score.reach,
      matched: score.matched.map((id) => skillLabel(id)), gaps: score.gaps.map((g) => gapLabel(g).en),
    })),
    gaps: input.gaps.map((g) => ({ key: gapKey(g), label: gapLabel(g).en, cost: g.cost })),
    repositories: input.projects.map(({ project, closes }) => ({
      repo: project.fullName, summary: project.summary.slice(0, 300), language: project.language, closes: closes.map((id) => `skill:${id}`),
    })),
  };
  return [
    {
      role: "system",
      content: `You write a concise career report for a software developer from the facts given as JSON.
Rules: refer only to the jobIds, repositories and gap keys in the facts; never invent jobs, companies, repositories, requirements or scores, and do not state any number that is not in the facts.
Focus the growth plan on growthTargetJobId and its listed gaps. Other jobs are alternative matches. When there are no jobs, give evidence-based general growth advice without inventing a role.
Reply with one JSON object: {"summary": {"zh","en"} (2-3 sentences), "strengths": [{"zh","en"}] (max 5),
"reasons": [{"jobId", "reason": {"zh","en"}}] (one sentence per job on why it fits and what is missing),
"growth": [{"kind": "open_source"|"skill"|"research"|"education"|"portfolio", "title": {"zh","en"}, "detail": {"zh","en"}, "repo": "owner/name" or null (open_source needs a listed repository), "closes": [gap keys], "horizon": {"zh","en"} (e.g. "1-2 months")}] (max 6, most valuable first).
Write zh in Simplified Chinese and en in English.`,
    },
    { role: "user", content: JSON.stringify(facts) },
  ];
}

/** Drop everything that points outside the provided facts. */
export function sanitizeAdvice(advice: Advice, input: AdviceInput): Advice {
  const jobIds = new Set(topMatches(input.matches, ADVICE_MATCH_LIMIT).map((m) => m.job.id));
  const repos = new Set(input.projects.map((p) => p.project.fullName));
  const gapKeys = new Set(input.gaps.map(gapKey));
  return {
    ...advice,
    reasons: advice.reasons.filter((r) => jobIds.has(r.jobId)),
    growth: advice.growth
      .map((g) => ({ ...g, repo: g.repo && repos.has(g.repo) ? g.repo : null, closes: g.closes.filter((k) => gapKeys.has(k)) }))
      .filter((g) => g.kind !== "open_source" || g.repo !== null)
      .slice(0, 6),
  };
}

export async function generateAdvice(complete: Complete, input: AdviceInput): Promise<{ advice: Advice; usage: Usage }> {
  const { value, usage } = await completeStructured(complete, adviceMessages(input), adviceSchema);
  return { advice: sanitizeAdvice(value, input), usage };
}

export interface ReportParts {
  id: string;
  createdAt: number;
  matchVersion: number;
  profile: StoredProfile;
  dimensions: Record<SubScoreKey, number>;
  scored: readonly ScoredJob[];
  gaps: readonly MatchGap[];
  projects: readonly GrowthCandidate[];
  advice: Advice;
}

export function assembleCandidateReport(parts: ReportParts): CandidateReport {
  const reasons = new Map(parts.advice.reasons.map((r) => [r.jobId, r.reason]));
  const ranked = topMatches(parts.scored, REPORT_MATCH_LIMIT);
  const labels = new Map(parts.gaps.map((g) => [gapKey(g), gapLabel(g)]));
  const repos = new Map(parts.projects.map((p) => [p.project.fullName, p.project]));
  const growth: GrowthItem[] = parts.advice.growth.map((g) => {
    const repo = g.repo ? repos.get(g.repo) : undefined;
    return {
      kind: g.kind,
      title: g.title,
      detail: g.detail,
      ...(repo ? { repo: { fullName: repo.fullName, stars: repo.stars, language: repo.language ?? "" } } : {}),
      closes: g.closes.flatMap((k) => (labels.has(k) ? [labels.get(k)!] : [])),
      horizon: g.horizon,
    };
  });
  return {
    id: parts.id,
    matchVersion: parts.matchVersion,
    createdAt: new Date(parts.createdAt).toISOString(),
    profile: presentProfile(parts.profile, parts.dimensions),
    summary: parts.advice.summary,
    strengths: parts.advice.strengths,
    matches: ranked.map((s) => toJobMatch(s, reasons.get(s.job.id))),
    growth,
  };
}
