import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { defaultLlmConfig, fallbackLlmConfig, type LlmConfig } from "@/lib/llm";
import { readResumeLibraryFull } from "@/lib/resume";
import type { SubScoreKey } from "@/lib/types";
import { ExtractionError, extractCandidate, extractRequirement, resumeToText, type Complete, type Usage } from "./extract";
import {
  assembleCandidateReport,
  commonGaps,
  generateAdvice,
  topMatches,
  REPORT_MATCH_LIMIT,
  type Advice,
  type ScoredJob,
} from "./report";
import { pickGrowthProjects, type GrowthCandidate } from "./retrieve";
import { SCHEMA_VERSION, type ExtractedProfile, type StoredProfile } from "./schema";
import { MATCH_VERSION, scoreMatch, type MatchGap } from "./score";
import {
  attachStars,
  listGrowthProjects,
  listJobSources,
  upsertJobRequirement,
  listMatchableJobs,
  loadDimensions,
  loadVerifiedEvidence,
  updateReport,
  upsertProfile,
} from "./store";
import type { CandidateReport } from "./types";
import { buildStoredProfile, verifiedSkills } from "./verify";

/**
 * The candidate report pipeline as plain functions over explicit inputs, so
 * the Workflow (apps/talent) only adds durable steps around them and tests
 * run them against in-memory databases. The Workflows engine persists step
 * outputs, so none of them carries raw résumé text: the extract step reads it
 * from the user's saved library and only extracted facts leave the step.
 */

/** Which saved résumé to use: a document id, or the library's reusable profile. */
export type ResumeSource = { kind: "resume"; id: string } | { kind: "profile" };

/**
 * Facts already extracted during the upload request (PDF résumés): the raw
 * text never reaches the Workflow, only what LLM #1 pulled out of it.
 */
export type ExtractedSource = { kind: "extracted"; profile: ExtractedProfile; unknownSkills: string[] };

export interface CandidateParams {
  reportId: string;
  githubId: number;
  login: string;
  source: ResumeSource | ExtractedSource;
  preferences: StoredProfile["preferences"];
  /** candidateInputHash of this input; stored with the profile. */
  inputHash: string;
  /** Unix ms the report was queued; the report's createdAt. */
  createdAt: number;
}

/** Raised for problems with the user's input; never retried. */
export class InputError extends Error {}

/** Résumé text from the user's saved library, or null when missing or empty. */
export async function loadResumeText(db: Client, githubId: number, source: ResumeSource): Promise<string | null> {
  const { rows } = await db.execute({ sql: `SELECT data FROM user_resume_libraries WHERE github_id = ?`, args: [githubId] });
  const data = rows[0]?.data;
  if (typeof data !== "string") return null;
  let library;
  try {
    library = readResumeLibraryFull(data);
  } catch {
    return null;
  }
  const doc = source.kind === "profile" ? library.profile : library.resumes.find((r) => r.id === source.id);
  const text = doc ? resumeToText(doc) : "";
  return text.trim() ? text : null;
}

/** Changes whenever a job requirement is (re)extracted, so reuse never serves a stale board. */
export async function jobsRevision(db: Client): Promise<string> {
  const { rows } = await db.execute(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS at FROM job_requirements`);
  return `${Number(rows[0]?.n ?? 0)}:${Number(rows[0]?.at ?? 0)}`;
}

/** Identical input under identical rules and job board reuses the finished report. */
export function candidateInputHash(input: {
  login: string;
  resumeText: string;
  preferences: StoredProfile["preferences"];
  jobsRevision: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([SCHEMA_VERSION, MATCH_VERSION, input.login.toLowerCase(), input.resumeText, input.preferences, input.jobsRevision]))
    .digest("hex");
}

/**
 * Model configs for Talent Match: TALENT_LLM_* when set (so this pipeline can
 * run on its own model), else the operator's default then fallback provider.
 */
export function talentLlmConfigs(): LlmConfig[] {
  const key = process.env.TALENT_LLM_API_KEY?.trim();
  if (key) {
    const baseURL = process.env.TALENT_LLM_BASE_URL?.trim();
    const model = process.env.TALENT_LLM_MODEL?.trim();
    if (!baseURL || !model) throw new Error("TALENT_LLM_BASE_URL and TALENT_LLM_MODEL are required with TALENT_LLM_API_KEY");
    return [{ baseURL, apiKey: key, model }];
  }
  return [defaultLlmConfig(), fallbackLlmConfig()].filter((c): c is LlmConfig => c !== null);
}

async function recordUsage(db: Client, reportId: string, usage: Usage, now: number): Promise<void> {
  await updateReport(db, reportId, { status: "running", now, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut });
}

/** LLM #1 over résumé text, charging the tokens to the report even when it fails. */
export async function extractForReport(
  db: Client,
  complete: Complete,
  reportId: string,
  text: string,
  now: number,
): Promise<{ extracted: ExtractedProfile; unknownSkills: string[] }> {
  try {
    const result = await extractCandidate(complete, text);
    await recordUsage(db, reportId, result.usage, now);
    return { extracted: result.profile, unknownSkills: result.unknownSkills };
  } catch (error) {
    if (error instanceof ExtractionError) await recordUsage(db, reportId, error.usage, now);
    throw error;
  }
}

/**
 * Step 1: the extracted profile. Saved résumés are read and extracted here;
 * uploads arrive already extracted (see {@link ExtractedSource}).
 */
export async function runExtract(
  db: Client,
  complete: Complete,
  params: CandidateParams,
  now: number,
): Promise<{ extracted: ExtractedProfile; unknownSkills: string[] }> {
  if (params.source.kind === "extracted") {
    return { extracted: params.source.profile, unknownSkills: params.source.unknownSkills };
  }
  const text = await loadResumeText(db, params.githubId, params.source);
  if (!text) throw new InputError("resume_missing");
  return extractForReport(db, complete, params.reportId, text, now);
}

/** Step 2: merge verified GitHub evidence and store the profile. */
export async function runVerify(
  db: Client,
  params: CandidateParams,
  extracted: ExtractedProfile,
  scoreVersion: string,
  now: number,
): Promise<{ profile: StoredProfile; dimensions: Record<SubScoreKey, number> }> {
  const [evidence, dimensions] = await Promise.all([
    loadVerifiedEvidence(db, params.login),
    loadDimensions(db, params.login, scoreVersion),
  ]);
  const profile = buildStoredProfile({
    login: params.login,
    extracted,
    verified: verifiedSkills(evidence.languages, evidence.repos),
    preferences: params.preferences,
  });
  // Phase 1 stores no talent vector: only opted-in profiles (phase 2) enter the index.
  await upsertProfile(db, { githubId: params.githubId, login: params.login, profile, inputHash: params.inputHash, vectorId: null, now });
  return { profile, dimensions };
}

export interface MatchResult {
  /** The best REPORT_MATCH_LIMIT jobs, ranked. */
  scored: ScoredJob[];
  gaps: MatchGap[];
  projects: GrowthCandidate[];
}

/**
 * A job is matchable only when its copy states at least one skill: with none,
 * every coverage term is vacuously 100 and a non-engineering role (or one
 * listed by title alone) would rank as a perfect match for everyone.
 */
export function hasSkillRequirements(requirement: { mustHave: readonly unknown[]; niceToHave: readonly unknown[] }): boolean {
  return requirement.mustHave.length + requirement.niceToHave.length > 0;
}

/**
 * Step 3: score every open DeepSeek job with stated skill requirements (the board is
 * small enough that recall would only add misses), then pick Feed projects
 * for the top role's gaps.
 */
export async function runMatch(db: Client, feedDb: Client | null, profile: StoredProfile, now: number): Promise<MatchResult> {
  const jobs = (await listMatchableJobs(db, now, undefined, "deepseek")).filter((job) => hasSkillRequirements(job.requirement));
  const scored = topMatches(jobs.map((job) => ({ job, score: scoreMatch(profile, job.requirement) })), REPORT_MATCH_LIMIT);
  const gaps = commonGaps(scored.slice(0, 1));
  const pool = feedDb ? await listGrowthProjects(feedDb) : [];
  const projects = await attachStars(db, pickGrowthProjects(gaps, pool));
  return { scored, gaps, projects };
}

/** Step 4: write the advice (LLM #2). */
export async function runAdvise(
  db: Client,
  complete: Complete,
  reportId: string,
  profile: StoredProfile,
  match: MatchResult,
  now: number,
): Promise<Advice> {
  try {
    const { advice, usage } = await generateAdvice(complete, { profile, matches: match.scored, gaps: match.gaps, projects: match.projects });
    await recordUsage(db, reportId, usage, now);
    return advice;
  } catch (error) {
    if (error instanceof ExtractionError) await recordUsage(db, reportId, error.usage, now);
    throw error;
  }
}

/** Step 5: assemble and publish the report. */
export async function runFinish(
  db: Client,
  params: CandidateParams,
  parts: { profile: StoredProfile; dimensions: Record<SubScoreKey, number>; match: MatchResult; advice: Advice },
  now: number,
): Promise<CandidateReport> {
  const report = assembleCandidateReport({
    id: params.reportId,
    createdAt: params.createdAt,
    matchVersion: MATCH_VERSION,
    profile: parts.profile,
    dimensions: parts.dimensions,
    scored: parts.match.scored,
    gaps: parts.match.gaps,
    projects: parts.match.projects,
    advice: parts.advice,
  });
  await updateReport(db, params.reportId, { status: "done", now, result: report });
  return report;
}

/** Public error codes stored on failed reports (never internal messages). */
export function failureCode(error: unknown): string {
  if (error instanceof InputError) return error.message;
  if (error instanceof ExtractionError) return "model_output_invalid";
  return "generation_failed";
}

/** Bad input and invalid model output fail the report; anything else may be retried. */
export function isFinalFailure(error: unknown): boolean {
  return error instanceof InputError || error instanceof ExtractionError;
}

/** Fail a report with a public error code (see {@link failureCode}). */
export async function failReport(db: Client, reportId: string, code: string, now: number): Promise<void> {
  await updateReport(db, reportId, { status: "failed", now, error: code });
}

/** Hash of a job's source copy under the current schema; unchanged hash = no re-extraction. */
export function jobInputHash(text: string): string {
  return createHash("sha256").update(`${SCHEMA_VERSION}\n${text}`).digest("hex");
}

/** Open jobs whose requirement is missing or was extracted from different copy. */
export async function jobsNeedingSync(db: Client, now: number, all = false): Promise<{ id: string; text: string; inputHash: string }[]> {
  const sources = await listJobSources(db, now);
  return sources.flatMap((job) => {
    const inputHash = jobInputHash(job.text);
    return all || job.storedHash !== inputHash ? [{ id: job.id, text: job.text, inputHash }] : [];
  });
}

/** Extract and store one job's requirement (LLM #1); returns unknown skill names for logging. */
export async function syncJobRequirement(
  db: Client,
  complete: Complete,
  job: { id: string; text: string; inputHash: string },
  now: number,
): Promise<{ unknownSkills: string[] }> {
  const { requirement, unknownSkills } = await extractRequirement(complete, job.text);
  await upsertJobRequirement(db, { jobId: job.id, requirement, inputHash: job.inputHash, vectorId: null, now });
  return { unknownSkills };
}
