import type { Client } from "@libsql/client";
import type { SubScoreKey } from "@/lib/types";
import { monthWindow } from "./quota";
import type { MatchableJob } from "./report";
import type { GrowthCandidate, GrowthProject } from "./retrieve";
import { SCHEMA_VERSION, extractedRequirementSchema, storedProfileSchema, type ExtractedRequirement, type StoredProfile } from "./schema";
import type { LanguageShare, RepoEvidence } from "./verify";

/**
 * D1 access for Talent Match. Every function takes its client, so routes use
 * `d1AsLibsqlClient(getD1Binding())` and tests use an in-memory libSQL
 * database with the real migrations. Timestamps are Unix ms.
 */

/**
 * A queued/running report whose row has not moved for this long is treated
 * as dead: it no longer blocks a new report and is failed when found.
 */
export const STALE_REPORT_MS = 15 * 60_000;

/** D1 binds at most 100 parameters per statement. */
const MAX_BOUND = 90;

const num = (value: unknown) => Number(value ?? 0) || 0;
const str = (value: unknown) => (typeof value === "string" ? value : "");

function parseJson(value: unknown): unknown {
  try {
    return typeof value === "string" ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

const stringArray = (value: unknown): string[] => {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
};

export async function quotaCounts(db: Client, githubId: number, now: number): Promise<{ doneThisMonth: number; inFlight: number }> {
  const { start, end } = monthWindow(now);
  const { rows } = await db.execute({
    sql: `SELECT
            COALESCE(SUM(CASE WHEN status = 'done' AND byo_key = 0 AND created_at >= ? AND created_at < ? THEN 1 ELSE 0 END), 0) AS done,
            COALESCE(SUM(CASE WHEN status IN ('queued', 'running') AND updated_at > ? THEN 1 ELSE 0 END), 0) AS in_flight
          FROM talent_reports
          WHERE github_id = ? AND kind = 'candidate'`,
    args: [start, end, now - STALE_REPORT_MS, githubId],
  });
  return { doneThisMonth: num(rows[0]?.done), inFlight: num(rows[0]?.in_flight) };
}

/** Estimated tokens spent this UTC month by free-channel reports, all users. */
export async function monthFreeTokens(db: Client, now: number): Promise<number> {
  const { start, end } = monthWindow(now);
  const { rows } = await db.execute({
    sql: `SELECT COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS tokens
          FROM talent_reports WHERE byo_key = 0 AND created_at >= ? AND created_at < ?`,
    args: [start, end],
  });
  return num(rows[0]?.tokens);
}

/** A finished report for identical input under the current rules, if any. */
export async function findDoneReport(db: Client, githubId: number, inputHash: string, matchVersion: number): Promise<string | null> {
  const { rows } = await db.execute({
    sql: `SELECT id FROM talent_reports
          WHERE github_id = ? AND input_hash = ? AND status = 'done' AND match_version = ?
          ORDER BY created_at DESC LIMIT 1`,
    args: [githubId, inputHash, matchVersion],
  });
  return rows[0] ? str(rows[0].id) : null;
}

export interface NewReport {
  id: string;
  githubId: number;
  kind: "candidate" | "company";
  inputHash: string;
  byoKey: boolean;
  matchVersion: number;
  now: number;
}

/**
 * Queue a report unless the owner already has a live one in flight. The
 * check and the insert are one statement, so two concurrent submissions
 * cannot both pass. Returns false when another report is in flight.
 */
export async function insertQueuedReport(db: Client, report: NewReport): Promise<boolean> {
  await db.execute({
    sql: `UPDATE talent_reports SET status = 'failed', error = 'stale', updated_at = ?
          WHERE github_id = ? AND status IN ('queued', 'running') AND updated_at <= ?`,
    args: [report.now, report.githubId, report.now - STALE_REPORT_MS],
  });
  const result = await db.execute({
    sql: `INSERT INTO talent_reports (id, github_id, kind, input_hash, status, byo_key, match_version, created_at, updated_at)
          SELECT ?, ?, ?, ?, 'queued', ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM talent_reports
            WHERE github_id = ? AND status IN ('queued', 'running') AND updated_at > ?
          )`,
    args: [
      report.id, report.githubId, report.kind, report.inputHash, report.byoKey ? 1 : 0, report.matchVersion, report.now, report.now,
      report.githubId, report.now - STALE_REPORT_MS,
    ],
  });
  return result.rowsAffected === 1;
}

export interface ReportUpdate {
  status: "running" | "done" | "failed";
  now: number;
  result?: unknown;
  tokensIn?: number;
  tokensOut?: number;
  error?: string;
}

/**
 * Advance a report. Token counts accumulate across steps. Finished and failed
 * reports are final: a run that was failed as stale cannot revive its row.
 */
export async function updateReport(db: Client, id: string, update: ReportUpdate): Promise<void> {
  await db.execute({
    sql: `UPDATE talent_reports SET
            status = ?,
            result_json = COALESCE(?, result_json),
            tokens_in = COALESCE(tokens_in, 0) + ?,
            tokens_out = COALESCE(tokens_out, 0) + ?,
            error = ?,
            updated_at = ?
          WHERE id = ? AND status NOT IN ('done', 'failed')`,
    args: [
      update.status,
      update.result === undefined ? null : JSON.stringify(update.result),
      update.tokensIn ?? 0,
      update.tokensOut ?? 0,
      update.error?.slice(0, 500) ?? null,
      update.now,
      id,
    ],
  });
}

export interface ReportRow {
  id: string;
  kind: "candidate" | "company";
  status: "queued" | "running" | "done" | "failed";
  result: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A report, only for its owner (null for anyone else). */
export async function getOwnReport(db: Client, id: string, githubId: number): Promise<ReportRow | null> {
  const { rows } = await db.execute({
    sql: `SELECT id, kind, status, result_json, error, created_at, updated_at
          FROM talent_reports WHERE id = ? AND github_id = ?`,
    args: [id, githubId],
  });
  const row = rows[0];
  if (!row) return null;
  return {
    id: str(row.id),
    kind: row.kind as ReportRow["kind"],
    status: row.status as ReportRow["status"],
    result: parseJson(row.result_json),
    error: typeof row.error === "string" ? row.error : null,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

/** The owner's most recent candidate report, if any. */
export async function latestReport(db: Client, githubId: number): Promise<ReportRow | null> {
  const { rows } = await db.execute({
    sql: `SELECT id FROM talent_reports WHERE github_id = ? AND kind = 'candidate' ORDER BY created_at DESC LIMIT 1`,
    args: [githubId],
  });
  return rows[0] ? getOwnReport(db, str(rows[0].id), githubId) : null;
}

/** How many past reports the history list shows. */
const HISTORY_LIMIT = 20;

/** One history entry: enough to label a report without loading its full result. */
export interface ReportSummaryRow {
  id: string;
  status: ReportRow["status"];
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** Profile headline of a finished report. */
  headline: { zh: string; en: string } | null;
  matchCount: number;
  /** Best fit across the report's matches, or null when it has none. */
  topFit: number | null;
}

/**
 * The owner's candidate reports, newest first. The summary fields are read
 * with json_extract so the list never ships whole reports.
 */
export async function listOwnReports(db: Client, githubId: number, limit = HISTORY_LIMIT): Promise<ReportSummaryRow[]> {
  const { rows } = await db.execute({
    sql: `SELECT id, status, error, created_at, updated_at,
                 CASE WHEN status = 'done' THEN json_extract(result_json, '$.profile.headline.zh') END AS headline_zh,
                 CASE WHEN status = 'done' THEN json_extract(result_json, '$.profile.headline.en') END AS headline_en,
                 CASE WHEN status = 'done' THEN json_array_length(result_json, '$.matches') END AS match_count,
                 CASE WHEN status = 'done' THEN (SELECT MAX(json_extract(m.value, '$.fit')) FROM json_each(result_json, '$.matches') m) END AS top_fit
          FROM talent_reports
          WHERE github_id = ? AND kind = 'candidate'
          ORDER BY created_at DESC LIMIT ?`,
    args: [githubId, limit],
  });
  return rows.map((row) => {
    const zh = str(row.headline_zh);
    const en = str(row.headline_en);
    return {
      id: str(row.id),
      status: row.status as ReportRow["status"],
      error: typeof row.error === "string" ? row.error : null,
      createdAt: num(row.created_at),
      updatedAt: num(row.updated_at),
      headline: zh || en ? { zh: zh || en, en: en || zh } : null,
      matchCount: num(row.match_count),
      topFit: row.top_fit === null || row.top_fit === undefined ? null : num(row.top_fit),
    };
  });
}

export async function upsertProfile(
  db: Client,
  input: { githubId: number; login: string; profile: StoredProfile; inputHash: string; vectorId: string | null; now: number },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO talent_match_profiles (github_id, login, profile_json, input_hash, vector_id, schema_version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(github_id) DO UPDATE SET
            login = excluded.login,
            profile_json = excluded.profile_json,
            input_hash = excluded.input_hash,
            vector_id = excluded.vector_id,
            schema_version = excluded.schema_version,
            updated_at = excluded.updated_at`,
    args: [input.githubId, input.login, JSON.stringify(input.profile), input.inputHash, input.vectorId, SCHEMA_VERSION, input.now],
  });
}

export async function getProfile(db: Client, githubId: number): Promise<{ profile: StoredProfile; optedIn: boolean } | null> {
  const { rows } = await db.execute({
    sql: `SELECT profile_json, opted_in FROM talent_match_profiles WHERE github_id = ? AND schema_version = ?`,
    args: [githubId, SCHEMA_VERSION],
  });
  const parsed = storedProfileSchema.safeParse(parseJson(rows[0]?.profile_json));
  return parsed.success ? { profile: parsed.data, optedIn: rows[0].opted_in === 1 } : null;
}

/** Returns false when the user has no profile yet. */
export async function setOptIn(db: Client, githubId: number, optedIn: boolean, now: number): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE talent_match_profiles SET opted_in = ?, updated_at = ? WHERE github_id = ?`,
    args: [optedIn ? 1 : 0, now, githubId],
  });
  return result.rowsAffected === 1;
}

/** Delete a user's profile and reports; returns vector ids to remove from Vectorize. */
export async function deleteTalentData(db: Client, githubId: number): Promise<string[]> {
  const { rows } = await db.execute({
    sql: `SELECT vector_id FROM talent_match_profiles WHERE github_id = ? AND vector_id IS NOT NULL`,
    args: [githubId],
  });
  await db.batch([
    { sql: `DELETE FROM talent_match_profiles WHERE github_id = ?`, args: [githubId] },
    { sql: `DELETE FROM talent_reports WHERE github_id = ?`, args: [githubId] },
  ]);
  return rows.map((row) => str(row.vector_id)).filter(Boolean);
}

/**
 * Open hiring-board jobs with a current structured requirement, titled in zh
 * and en (each falling back to the other). `ids` narrows to recalled jobs.
 */
export async function listMatchableJobs(db: Client, now: number, ids?: readonly string[], companyId?: string): Promise<MatchableJob[]> {
  if (ids && ids.length === 0) return [];
  const chunks = ids ? chunk(ids, MAX_BOUND) : [null];
  const jobs: MatchableJob[] = [];
  for (const part of chunks) {
    const { rows } = await db.execute({
      sql: `SELECT j.id, c.name AS company, r.requirement_json,
                   tz.title AS title_zh, te.title AS title_en, tz.location AS location_zh, te.location AS location_en
            FROM jobs j
            JOIN job_companies c ON c.id = j.company_id
            JOIN job_requirements r ON r.job_id = j.id AND r.schema_version = ?
            LEFT JOIN job_translations tz ON tz.job_id = j.id AND tz.locale = 'zh'
            LEFT JOIN job_translations te ON te.job_id = j.id AND te.locale = 'en'
            WHERE j.status = 'open' AND (j.expires_at IS NULL OR j.expires_at > ?)
              ${companyId ? "AND j.company_id = ?" : ""}
              ${part ? `AND j.id IN (${part.map(() => "?").join(",")})` : ""}
            ORDER BY j.id`,
      args: [SCHEMA_VERSION, now, ...(companyId ? [companyId] : []), ...(part ?? [])],
    });
    for (const row of rows) {
      const requirement = extractedRequirementSchema.safeParse(parseJson(row.requirement_json));
      if (!requirement.success) continue;
      const titleZh = str(row.title_zh) || str(row.title_en);
      const titleEn = str(row.title_en) || titleZh;
      const locationZh = str(row.location_zh) || str(row.location_en);
      jobs.push({
        id: str(row.id),
        company: str(row.company),
        title: { zh: titleZh, en: titleEn },
        location: { zh: locationZh, en: str(row.location_en) || locationZh },
        requirement: requirement.data,
      });
    }
  }
  return jobs;
}

/** Job copy to extract requirements from, with the hash of that copy. */
export interface JobSource {
  id: string;
  text: string;
  /** The stored requirement's input hash, or null when it has none. */
  storedHash: string | null;
}

/**
 * Open jobs and the text their requirement is extracted from (en copy, else
 * zh): title, category, location, employment, summary and the full JD.
 */
export async function listJobSources(db: Client, now: number): Promise<JobSource[]> {
  const { rows } = await db.execute({
    sql: `SELECT j.id, j.employment_types, r.input_hash,
                 COALESCE(te.title, tz.title) AS title,
                 COALESCE(te.category, tz.category) AS category,
                 COALESCE(te.location, tz.location) AS location,
                 COALESCE(te.summary, tz.summary) AS summary,
                 COALESCE(te.description, tz.description) AS description
          FROM jobs j
          LEFT JOIN job_requirements r ON r.job_id = j.id AND r.schema_version = ?
          LEFT JOIN job_translations te ON te.job_id = j.id AND te.locale = 'en'
          LEFT JOIN job_translations tz ON tz.job_id = j.id AND tz.locale = 'zh'
          WHERE j.status = 'open' AND (j.expires_at IS NULL OR j.expires_at > ?)
          ORDER BY j.id`,
    args: [SCHEMA_VERSION, now],
  });
  return rows.map((row) => ({
    id: str(row.id),
    text: [
      str(row.title),
      [str(row.category), str(row.location), str(row.employment_types)].filter(Boolean).join(" | "),
      str(row.summary),
      str(row.description),
    ].filter(Boolean).join("\n\n"),
    storedHash: typeof row.input_hash === "string" ? row.input_hash : null,
  }));
}

export async function upsertJobRequirement(
  db: Client,
  input: { jobId: string; requirement: ExtractedRequirement; inputHash: string; vectorId: string | null; now: number },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO job_requirements (id, job_id, requirement_json, input_hash, vector_id, schema_version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            requirement_json = excluded.requirement_json,
            input_hash = excluded.input_hash,
            vector_id = excluded.vector_id,
            schema_version = excluded.schema_version,
            updated_at = excluded.updated_at`,
    args: [input.jobId, input.jobId, JSON.stringify(input.requirement), input.inputHash, input.vectorId, SCHEMA_VERSION, input.now],
  });
}

/** Scan facts behind verified skills: language shares and the repo graph. */
export async function loadVerifiedEvidence(
  db: Client,
  login: string,
): Promise<{ languages: LanguageShare[]; repos: RepoEvidence[] }> {
  const username = login.toLowerCase();
  const [languages, repos] = await Promise.all([
    db.execute({
      sql: `SELECT facet_value, weight FROM developer_facets WHERE username = ? AND facet_type = 'language'`,
      args: [username],
    }),
    db.execute({
      sql: `SELECT r.name_with_owner, d.relation, r.stars, r.language, r.topics, d.prs
            FROM repo_developers d JOIN repos r ON r.repo_key = d.repo_key
            WHERE d.username = ?
            ORDER BY r.stars DESC, r.repo_key LIMIT 50`,
      args: [username],
    }),
  ]);
  return {
    languages: languages.rows.map((row) => ({ language: str(row.facet_value), share: num(row.weight) })),
    repos: repos.rows.map((row) => ({
      nameWithOwner: str(row.name_with_owner),
      relation: row.relation === "owner" ? "owner" : "contributor",
      stars: num(row.stars),
      language: typeof row.language === "string" ? row.language : null,
      topics: stringArray(row.topics),
      prs: row.prs === null || row.prs === undefined ? null : num(row.prs),
    })),
  };
}

const SUB_SCORE_KEYS: SubScoreKey[] = [
  "account_maturity", "original_project_quality", "contribution_quality",
  "ecosystem_impact", "community_influence", "activity_authenticity",
];

/** The account's public v11 sub-scores; zeros when it has none. */
export async function loadDimensions(db: Client, login: string, scoreVersion: string): Promise<Record<SubScoreKey, number>> {
  const { rows } = await db.execute({
    sql: `SELECT sub_scores FROM scores WHERE username = ? AND hidden = 0 AND score_version = ?`,
    args: [login.toLowerCase(), scoreVersion],
  });
  const parsed = parseJson(rows[0]?.sub_scores) as Partial<Record<SubScoreKey, unknown>> | null;
  return Object.fromEntries(SUB_SCORE_KEYS.map((key) => [key, num(parsed?.[key])])) as Record<SubScoreKey, number>;
}

/** Published, unmoderated Feed projects, best product score first (Feed D1). */
export async function listGrowthProjects(feedDb: Client, limit = 1500): Promise<GrowthProject[]> {
  const { rows } = await feedDb.execute({
    sql: `SELECT p.repo_key, p.owner_login, p.name, p.summary, p.language, p.topics_json, p.product_score
          FROM feed_projects p
          LEFT JOIN feed_project_moderation m ON m.repo_key = p.repo_key
          WHERE p.published = 1 AND COALESCE(m.removed, 0) = 0
          ORDER BY p.product_score DESC, p.repo_key ASC LIMIT ?`,
    args: [limit],
  });
  return rows.map((row) => ({
    repoKey: str(row.repo_key),
    fullName: `${str(row.owner_login)}/${str(row.name)}`,
    summary: str(row.summary),
    language: typeof row.language === "string" ? row.language : null,
    topics: stringArray(row.topics_json),
    productScore: num(row.product_score),
    stars: 0,
  }));
}

/** Fill star counts from the core repo graph for the few picked projects. */
export async function attachStars(db: Client, picked: GrowthCandidate[]): Promise<GrowthCandidate[]> {
  const keys = picked.map((p) => p.project.repoKey);
  const stars = new Map<string, number>();
  for (const part of chunk(keys, MAX_BOUND)) {
    const { rows } = await db.execute({
      sql: `SELECT repo_key, stars FROM repos WHERE repo_key IN (${part.map(() => "?").join(",")})`,
      args: part,
    });
    for (const row of rows) stars.set(str(row.repo_key), num(row.stars));
  }
  return picked.map((p) => ({ ...p, project: { ...p.project, stars: stars.get(p.project.repoKey) ?? 0 } }));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
