import { createHash, randomUUID } from "node:crypto";
import { createClient, type Client, type InValue } from "@libsql/client";
import {
  projectAnalysisArtifactSchema,
  type ProjectAnalysisArtifact,
  type ProjectAnalysisPhase,
  type ProjectAnalysisStatus,
  type VerificationLevel,
} from "./project-analysis-contract";
import { deriveProjectBoardEligibility } from "./project-ranking";

export type ProjectBoard = "treasure" | "classic";
export type TreasureEntryStatus = "active" | "graduated" | "removed";

export class ProjectAnalysisDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectAnalysisDatabaseError";
  }
}

export interface CreateProjectAnalysisRunInput {
  id: string;
  repoKey: string;
  canonicalUrl: string;
  requestedRef: string | null;
  schemaVersion: string;
  rubricVersion: string;
  agentVersion: string;
  skillVersion: string;
}

export interface ProjectAnalysisRun {
  id: string;
  repoKey: string;
  canonicalUrl: string;
  requestedRef: string | null;
  resolvedCommitSha: string | null;
  idempotencyKey: string;
  status: ProjectAnalysisStatus;
  phase: ProjectAnalysisPhase;
  progress: number;
  mosooAgentId: string | null;
  mosooThreadId: string | null;
  mosooRunId: string | null;
  schemaVersion: string;
  rubricVersion: string;
  agentVersion: string;
  skillVersion: string;
  verificationLevel: VerificationLevel | null;
  errorCode: string | null;
  errorMessage: string | null;
  createAttempts: number;
  createRetryAt: number | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface CreateProjectAnalysisRunResult {
  run: ProjectAnalysisRun;
  created: boolean;
}

export interface ProjectAssessment {
  repoKey: string;
  latestAnalysisId: string;
  projectType: ProjectAnalysisArtifact["project"]["project_type"];
  lifecycle: ProjectAnalysisArtifact["project"]["lifecycle"];
  productScore: number;
  painScore: number;
  effectivenessScore: number;
  experienceScore: number;
  valueDensityScore: number;
  communityStrength: number;
  confidence: number;
  verificationLevel: VerificationLevel;
  unknowns: string[];
  risks: ProjectAnalysisArtifact["risks"];
  exposureBand: ProjectAnalysisArtifact["exposure"]["band"];
  stars: number | null;
  treasureEligible: boolean;
  classicEligible: boolean;
  resolvedCommitSha: string;
  analyzedAt: number;
  analysis: ProjectAnalysisArtifact;
  reportMarkdown: string;
}

export interface TreasureHistoryEntry {
  id: string;
  repoKey: string;
  analysisId: string;
  status: TreasureEntryStatus;
  selectedAt: number;
  productScoreSnapshot: number;
  confidenceSnapshot: number;
  verificationLevelSnapshot: VerificationLevel;
  starsSnapshot: number | null;
  exposureSnapshot: ProjectAnalysisArtifact["exposure"]["band"];
  reason: string;
  resolvedCommitSha: string;
  graduatedAt: number | null;
  removedAt: number | null;
  removedReason: string | null;
}

export interface FinalizeProjectAnalysisInput {
  analysisId: string;
  analysis: ProjectAnalysisArtifact;
  analysisJson: string;
  evidenceJson: string;
  reportMarkdown: string;
  hashes: {
    analysis: string;
    evidence: string;
    report: string;
  };
}

let client: Client | null = null;
let schemaReady: Promise<void> | null = null;

function database(): Client {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL?.trim();
  if (!url) {
    throw new ProjectAnalysisDatabaseError(
      "TURSO_DATABASE_URL is required for project analysis persistence.",
    );
  }
  client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined,
  });
  return client;
}

function ensureSchema(db: Client): Promise<void> {
  if (!schemaReady) {
    schemaReady = db
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS project_analysis_runs (
             id TEXT PRIMARY KEY,
             repo_key TEXT NOT NULL,
             canonical_url TEXT NOT NULL,
             requested_ref TEXT,
             resolved_commit_sha TEXT,
             active_key TEXT UNIQUE,
             idempotency_key TEXT NOT NULL UNIQUE,
             status TEXT NOT NULL,
             phase TEXT NOT NULL,
             progress INTEGER NOT NULL DEFAULT 0,
             mosoo_agent_id TEXT,
             mosoo_thread_id TEXT UNIQUE,
             mosoo_run_id TEXT,
             schema_version TEXT NOT NULL,
             rubric_version TEXT NOT NULL,
             agent_version TEXT NOT NULL,
             skill_version TEXT NOT NULL,
             verification_level TEXT,
             analysis_json TEXT,
             report_markdown TEXT,
             evidence_json TEXT,
             analysis_sha256 TEXT,
             report_sha256 TEXT,
             evidence_sha256 TEXT,
             error_code TEXT,
             error_message TEXT,
             create_attempts INTEGER NOT NULL DEFAULT 0,
             create_retry_at INTEGER,
             created_at INTEGER NOT NULL,
             started_at INTEGER,
             completed_at INTEGER,
             updated_at INTEGER NOT NULL
           )`,
          `CREATE INDEX IF NOT EXISTS idx_project_analysis_runs_repo_created
             ON project_analysis_runs(repo_key, created_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_project_analysis_runs_status_updated
             ON project_analysis_runs(status, updated_at)`,
          `CREATE TABLE IF NOT EXISTS project_assessments (
             repo_key TEXT PRIMARY KEY,
             latest_analysis_id TEXT NOT NULL,
             project_type TEXT NOT NULL,
             lifecycle TEXT NOT NULL,
             product_score REAL NOT NULL,
             pain_score REAL NOT NULL,
             effectiveness_score REAL NOT NULL,
             experience_score REAL NOT NULL,
             value_density_score REAL NOT NULL,
             community_strength REAL NOT NULL DEFAULT 0,
             confidence REAL NOT NULL,
             verification_level TEXT NOT NULL,
             unknowns_json TEXT NOT NULL,
             risks_json TEXT NOT NULL,
             exposure_band TEXT NOT NULL,
             stars INTEGER,
             treasure_eligible INTEGER NOT NULL DEFAULT 0,
             classic_eligible INTEGER NOT NULL DEFAULT 0,
             resolved_commit_sha TEXT NOT NULL,
             rubric_version TEXT NOT NULL,
             analyzed_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
           )`,
          `CREATE INDEX IF NOT EXISTS idx_project_assessments_treasure
             ON project_assessments(treasure_eligible, product_score DESC, confidence DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_project_assessments_classic
             ON project_assessments(classic_eligible, product_score DESC, confidence DESC)`,
          `CREATE TABLE IF NOT EXISTS treasure_entries (
             id TEXT PRIMARY KEY,
             repo_key TEXT NOT NULL,
             analysis_id TEXT NOT NULL,
             status TEXT NOT NULL,
             selected_at INTEGER NOT NULL,
             product_score_snapshot REAL NOT NULL,
             confidence_snapshot REAL NOT NULL,
             verification_level_snapshot TEXT NOT NULL,
             stars_snapshot INTEGER,
             exposure_snapshot TEXT NOT NULL,
             reason TEXT NOT NULL,
             resolved_commit_sha TEXT NOT NULL,
             graduated_at INTEGER,
             removed_at INTEGER,
             removed_reason TEXT
           )`,
          `CREATE INDEX IF NOT EXISTS idx_treasure_entries_repo_selected
             ON treasure_entries(repo_key, selected_at DESC)`,
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_treasure_entries_one_active
             ON treasure_entries(repo_key) WHERE status = 'active'`,
        ],
        "write",
      )
      .then(async () => {
        for (const statement of [
          "ALTER TABLE project_assessments ADD COLUMN community_strength REAL NOT NULL DEFAULT 0",
          "ALTER TABLE project_analysis_runs ADD COLUMN create_attempts INTEGER NOT NULL DEFAULT 0",
          "ALTER TABLE project_analysis_runs ADD COLUMN create_retry_at INTEGER",
        ]) {
          try {
            await db.execute(statement);
          } catch (error) {
            if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) {
              throw error;
            }
          }
        }
      });
  }
  return schemaReady;
}

function activeKey(input: CreateProjectAnalysisRunInput): string {
  return createHash("sha256")
    .update(
      [input.repoKey.toLowerCase(), input.requestedRef ?? "", input.rubricVersion].join("\0"),
    )
    .digest("hex");
}

function rowString(value: unknown): string {
  return String(value ?? "");
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapRun(row: Record<string, unknown>): ProjectAnalysisRun {
  return {
    id: rowString(row.id),
    repoKey: rowString(row.repo_key),
    canonicalUrl: rowString(row.canonical_url),
    requestedRef: nullableString(row.requested_ref),
    resolvedCommitSha: nullableString(row.resolved_commit_sha),
    idempotencyKey: rowString(row.idempotency_key),
    status: rowString(row.status) as ProjectAnalysisStatus,
    phase: rowString(row.phase) as ProjectAnalysisPhase,
    progress: Number(row.progress ?? 0),
    mosooAgentId: nullableString(row.mosoo_agent_id),
    mosooThreadId: nullableString(row.mosoo_thread_id),
    mosooRunId: nullableString(row.mosoo_run_id),
    schemaVersion: rowString(row.schema_version),
    rubricVersion: rowString(row.rubric_version),
    agentVersion: rowString(row.agent_version),
    skillVersion: rowString(row.skill_version),
    verificationLevel: nullableString(row.verification_level) as VerificationLevel | null,
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    createAttempts: Number(row.create_attempts ?? 0),
    createRetryAt: nullableNumber(row.create_retry_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: nullableNumber(row.started_at),
    completedAt: nullableNumber(row.completed_at),
  };
}

async function selectRun(db: Client, analysisId: string): Promise<ProjectAnalysisRun | null> {
  const result = await db.execute({
    sql: `SELECT * FROM project_analysis_runs WHERE id = ? LIMIT 1`,
    args: [analysisId],
  });
  const row = result.rows[0];
  return row ? mapRun(row as Record<string, unknown>) : null;
}

export async function createProjectAnalysisRun(
  input: CreateProjectAnalysisRunInput,
): Promise<CreateProjectAnalysisRunResult> {
  const db = database();
  await ensureSchema(db);
  const now = Date.now();
  const key = activeKey(input);
  const idempotencyKey = `ghfind-project-${input.id}`;
  const insert = await db.execute({
    sql: `INSERT OR IGNORE INTO project_analysis_runs (
            id, repo_key, canonical_url, requested_ref, active_key,
            idempotency_key, status, phase, progress,
            schema_version, rubric_version, agent_version, skill_version,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.repoKey.toLowerCase(),
      input.canonicalUrl,
      input.requestedRef,
      key,
      idempotencyKey,
      input.schemaVersion,
      input.rubricVersion,
      input.agentVersion,
      input.skillVersion,
      now,
      now,
    ],
  });
  const created = insert.rowsAffected === 1;
  const result = await db.execute({
    sql: `SELECT * FROM project_analysis_runs WHERE active_key = ? LIMIT 1`,
    args: [key],
  });
  const row = result.rows[0];
  if (!row) throw new ProjectAnalysisDatabaseError("Failed to create or find analysis run.");
  return { run: mapRun(row as Record<string, unknown>), created };
}

export async function getProjectAnalysisRun(
  analysisId: string,
): Promise<ProjectAnalysisRun | null> {
  const db = database();
  await ensureSchema(db);
  return selectRun(db, analysisId);
}

export async function reserveProjectAnalysisExecutionSlot(
  analysisId: string,
  maximumConcurrentRuns: number,
  leaseDurationMs = 30_000,
): Promise<boolean> {
  const db = database();
  await ensureSchema(db);
  const current = await selectRun(db, analysisId);
  if (!current) throw new ProjectAnalysisDatabaseError("Analysis run not found.");
  const now = Date.now();
  const leaseUntil = now + Math.max(1_000, Math.floor(leaseDurationMs));
  if (current.status === "creating_thread" && !current.mosooThreadId) {
    if (current.createRetryAt !== null && current.createRetryAt > now) return false;
    const reclaimed = await db.execute({
      sql: `UPDATE project_analysis_runs
            SET create_attempts = create_attempts + 1, create_retry_at = ?, updated_at = ?
            WHERE id = ? AND status = 'creating_thread' AND mosoo_thread_id IS NULL
              AND (create_retry_at IS NULL OR create_retry_at <= ?)`,
      args: [leaseUntil, now, analysisId, now],
    });
    return reclaimed.rowsAffected === 1;
  }
  if (current.status !== "queued") return false;

  const result = await db.execute({
    sql: `UPDATE project_analysis_runs
          SET status = 'creating_thread', phase = 'creating_thread', progress = 5,
              create_attempts = create_attempts + 1, create_retry_at = ?,
              started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE id = ? AND status = 'queued'
            AND (create_retry_at IS NULL OR create_retry_at <= ?)
            AND (
              SELECT COUNT(*) FROM project_analysis_runs
              WHERE status IN ('creating_thread', 'running', 'finalizing')
            ) < ?`,
    args: [
      leaseUntil,
      now,
      now,
      analysisId,
      now,
      Math.max(1, Math.floor(maximumConcurrentRuns)),
    ],
  });
  return result.rowsAffected === 1;
}

export async function scheduleProjectAnalysisCreateRetry(
  analysisId: string,
  nextRetryAt: number,
): Promise<ProjectAnalysisRun | null> {
  const db = database();
  await ensureSchema(db);
  const now = Date.now();
  const result = await db.execute({
    sql: `UPDATE project_analysis_runs
          SET status = 'queued', phase = 'queued', progress = 0,
              create_retry_at = ?, updated_at = ?
          WHERE id = ? AND status = 'creating_thread' AND mosoo_thread_id IS NULL`,
    args: [Math.max(now, Math.floor(nextRetryAt)), now, analysisId],
  });
  return result.rowsAffected === 1 ? selectRun(db, analysisId) : null;
}

export interface AttachMosooThreadInput {
  analysisId: string;
  agentId: string;
  threadId: string;
  runId: string;
}

export async function attachMosooThread(input: AttachMosooThreadInput): Promise<void> {
  const db = database();
  await ensureSchema(db);
  const now = Date.now();
  const result = await db.execute({
    sql: `UPDATE project_analysis_runs
          SET status = 'running', phase = 'classifying', progress = 10,
              mosoo_agent_id = ?, mosoo_thread_id = ?, mosoo_run_id = ?,
              create_retry_at = NULL,
              started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE id = ? AND status IN ('queued', 'creating_thread', 'running')`,
    args: [input.agentId, input.threadId, input.runId, now, now, input.analysisId],
  });
  if (result.rowsAffected !== 1) {
    throw new ProjectAnalysisDatabaseError("Analysis run cannot accept a Mosoo Thread.");
  }
}

export async function prepareProjectAnalysisRetry(
  analysisId: string,
  expectedThreadId: string,
  nextIdempotencyKey: string,
): Promise<ProjectAnalysisRun | null> {
  const db = database();
  await ensureSchema(db);
  const current = await selectRun(db, analysisId);
  if (!current || current.mosooThreadId !== expectedThreadId) return null;
  const now = Date.now();
  const result = await db.execute({
    sql: `UPDATE project_analysis_runs
          SET active_key = ?, idempotency_key = ?, status = 'queued',
              phase = 'queued', progress = 0,
              create_attempts = 0, create_retry_at = NULL,
              mosoo_thread_id = NULL, mosoo_run_id = NULL,
              error_code = NULL, error_message = NULL, completed_at = NULL,
              updated_at = ?
          WHERE id = ? AND mosoo_thread_id = ?
            AND status IN ('running', 'failed')`,
    args: [
      activeKey(current),
      nextIdempotencyKey,
      now,
      analysisId,
      expectedThreadId,
    ],
  });
  return result.rowsAffected === 1 ? selectRun(db, analysisId) : null;
}

export interface UpdateProjectAnalysisStateInput {
  analysisId: string;
  status: ProjectAnalysisStatus;
  phase: ProjectAnalysisPhase;
  progress: number;
  runId?: string;
}

export async function updateProjectAnalysisState(
  input: UpdateProjectAnalysisStateInput,
): Promise<void> {
  const db = database();
  await ensureSchema(db);
  await db.execute({
    sql: `UPDATE project_analysis_runs
          SET status = ?, phase = ?, progress = ?,
              mosoo_run_id = COALESCE(?, mosoo_run_id), updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'expired')`,
    args: [
      input.status,
      input.phase,
      Math.max(0, Math.min(100, Math.round(input.progress))),
      input.runId ?? null,
      Date.now(),
      input.analysisId,
    ],
  });
}

export async function failProjectAnalysis(
  analysisId: string,
  errorCode: string,
  errorMessage: string,
  status: "failed" | "cancelled" | "expired" = "failed",
): Promise<void> {
  const db = database();
  await ensureSchema(db);
  const now = Date.now();
  await db.execute({
    sql: `UPDATE project_analysis_runs
          SET status = ?, active_key = NULL, error_code = ?, error_message = ?,
              create_retry_at = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'expired')`,
    args: [status, errorCode, errorMessage.slice(0, 2_000), now, now, analysisId],
  });
}

function treasureReason(analysis: ProjectAnalysisArtifact): string {
  return `${analysis.project.summary} 产品价值 ${analysis.scores.product_score}，${analysis.exposure.rationale}`;
}

export async function finalizeProjectAnalysis(
  input: FinalizeProjectAnalysisInput,
): Promise<ProjectAnalysisRun> {
  const db = database();
  await ensureSchema(db);
  const run = await selectRun(db, input.analysisId);
  if (!run) throw new ProjectAnalysisDatabaseError("Analysis run not found.");
  if (run.status === "completed") return run;
  if (["failed", "cancelled", "expired"].includes(run.status)) {
    throw new ProjectAnalysisDatabaseError("Terminal analysis run cannot be finalized.");
  }

  const now = Date.now();
  const analysis = input.analysis;
  const eligibility = deriveProjectBoardEligibility(analysis);
  const analyzedAt = Date.parse(analysis.analyzed_at);
  const statements: Array<{ sql: string; args: InValue[] }> = [
    {
      sql: `INSERT INTO project_assessments (
              repo_key, latest_analysis_id, project_type, lifecycle,
              product_score, pain_score, effectiveness_score, experience_score,
              value_density_score, confidence, verification_level,
              community_strength, unknowns_json, risks_json, exposure_band, stars,
              treasure_eligible, classic_eligible, resolved_commit_sha,
              rubric_version, analyzed_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(repo_key) DO UPDATE SET
              latest_analysis_id = excluded.latest_analysis_id,
              project_type = excluded.project_type,
              lifecycle = excluded.lifecycle,
              product_score = excluded.product_score,
              pain_score = excluded.pain_score,
              effectiveness_score = excluded.effectiveness_score,
              experience_score = excluded.experience_score,
              value_density_score = excluded.value_density_score,
              community_strength = excluded.community_strength,
              confidence = excluded.confidence,
              verification_level = excluded.verification_level,
              unknowns_json = excluded.unknowns_json,
              risks_json = excluded.risks_json,
              exposure_band = excluded.exposure_band,
              stars = excluded.stars,
              treasure_eligible = excluded.treasure_eligible,
              classic_eligible = excluded.classic_eligible,
              resolved_commit_sha = excluded.resolved_commit_sha,
              rubric_version = excluded.rubric_version,
              analyzed_at = excluded.analyzed_at,
              updated_at = excluded.updated_at`,
      args: [
        analysis.repository.repo_key.toLowerCase(),
        input.analysisId,
        analysis.project.project_type,
        analysis.project.lifecycle,
        analysis.scores.product_score,
        analysis.scores.pain.score,
        analysis.scores.effectiveness.score,
        analysis.scores.experience.score,
        analysis.scores.value_density.score,
        analysis.confidence,
        analysis.verification_level,
        analysis.community_strength.score,
        JSON.stringify(analysis.unknowns),
        JSON.stringify(analysis.risks),
        analysis.exposure.band,
        analysis.exposure.stars,
        eligibility.treasureEligible ? 1 : 0,
        eligibility.classicEligible ? 1 : 0,
        analysis.repository.resolved_commit_sha,
        analysis.rubric_version,
        analyzedAt,
        now,
      ],
    },
  ];

  if (eligibility.treasureEligible) {
    statements.push({
      sql: `INSERT OR IGNORE INTO treasure_entries (
              id, repo_key, analysis_id, status, selected_at,
              product_score_snapshot, confidence_snapshot,
              verification_level_snapshot, stars_snapshot, exposure_snapshot,
              reason, resolved_commit_sha
            ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        randomUUID(),
        analysis.repository.repo_key.toLowerCase(),
        input.analysisId,
        now,
        analysis.scores.product_score,
        analysis.confidence,
        analysis.verification_level,
        analysis.exposure.stars,
        analysis.exposure.band,
        treasureReason(analysis),
        analysis.repository.resolved_commit_sha,
      ],
    });
  } else if (["established", "mainstream"].includes(analysis.exposure.band)) {
    statements.push({
      sql: `UPDATE treasure_entries
            SET status = 'graduated', graduated_at = ?
            WHERE repo_key = ? AND status = 'active'`,
      args: [now, analysis.repository.repo_key.toLowerCase()],
    });
  }

  statements.push({
    sql: `UPDATE project_analysis_runs
          SET repo_key = ?, canonical_url = ?, resolved_commit_sha = ?, active_key = NULL,
              status = 'completed', phase = 'completed', progress = 100,
              verification_level = ?, analysis_json = ?, report_markdown = ?,
              evidence_json = ?, analysis_sha256 = ?, report_sha256 = ?,
              evidence_sha256 = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'expired')`,
    args: [
      analysis.repository.repo_key.toLowerCase(),
      analysis.repository.canonical_url,
      analysis.repository.resolved_commit_sha,
      analysis.verification_level,
      input.analysisJson,
      input.reportMarkdown,
      input.evidenceJson,
      input.hashes.analysis,
      input.hashes.report,
      input.hashes.evidence,
      now,
      now,
      input.analysisId,
    ],
  });

  const results = await db.batch(statements, "write");
  const updateResult = results.at(-1);
  if (!updateResult || updateResult.rowsAffected !== 1) {
    throw new ProjectAnalysisDatabaseError("Analysis finalization lost its state race.");
  }
  const completed = await selectRun(db, input.analysisId);
  if (!completed) throw new ProjectAnalysisDatabaseError("Completed analysis run disappeared.");
  return completed;
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== "string") return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function mapAssessment(row: Record<string, unknown>): ProjectAssessment {
  const analysis = projectAnalysisArtifactSchema.parse(JSON.parse(rowString(row.analysis_json)));
  return {
    repoKey: rowString(row.repo_key),
    latestAnalysisId: rowString(row.latest_analysis_id),
    projectType: analysis.project.project_type,
    lifecycle: analysis.project.lifecycle,
    productScore: Number(row.product_score),
    painScore: Number(row.pain_score),
    effectivenessScore: Number(row.effectiveness_score),
    experienceScore: Number(row.experience_score),
    valueDensityScore: Number(row.value_density_score),
    communityStrength: Number(row.community_strength),
    confidence: Number(row.confidence),
    verificationLevel: analysis.verification_level,
    unknowns: parseJsonArray<string>(row.unknowns_json),
    risks: parseJsonArray<ProjectAnalysisArtifact["risks"][number]>(row.risks_json),
    exposureBand: analysis.exposure.band,
    stars: nullableNumber(row.stars),
    treasureEligible: Number(row.treasure_eligible) === 1,
    classicEligible: Number(row.classic_eligible) === 1,
    resolvedCommitSha: rowString(row.resolved_commit_sha),
    analyzedAt: Number(row.analyzed_at),
    analysis,
    reportMarkdown: rowString(row.report_markdown),
  };
}

const ASSESSMENT_SELECT = `
  SELECT pa.*, pr.analysis_json, pr.report_markdown
  FROM project_assessments AS pa
  JOIN project_analysis_runs AS pr ON pr.id = pa.latest_analysis_id`;

export async function getProjectAssessment(repoKey: string): Promise<ProjectAssessment | null> {
  const db = database();
  await ensureSchema(db);
  const result = await db.execute({
    sql: `${ASSESSMENT_SELECT} WHERE pa.repo_key = ? LIMIT 1`,
    args: [repoKey.toLowerCase()],
  });
  const row = result.rows[0];
  return row ? mapAssessment(row as Record<string, unknown>) : null;
}

export async function listProjectBoard(
  board: ProjectBoard,
  options: { limit: number; offset: number },
): Promise<ProjectAssessment[]> {
  const db = database();
  await ensureSchema(db);
  const eligibilityColumn = board === "treasure" ? "treasure_eligible" : "classic_eligible";
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
  const offset = Math.max(0, Math.floor(options.offset));
  const result = await db.execute({
    sql: `${ASSESSMENT_SELECT}
          WHERE pa.${eligibilityColumn} = 1
          ORDER BY pa.product_score DESC, pa.confidence DESC, pa.analyzed_at DESC
          LIMIT ? OFFSET ?`,
    args: [limit, offset],
  });
  return result.rows.map((row) => mapAssessment(row as Record<string, unknown>));
}

export async function listReconciliableProjectAnalysisRuns(
  limit = 20,
): Promise<ProjectAnalysisRun[]> {
  const db = database();
  await ensureSchema(db);
  const result = await db.execute({
    sql: `SELECT * FROM project_analysis_runs
          WHERE status IN ('running', 'finalizing')
             OR (
               status IN ('queued', 'creating_thread')
               AND (create_retry_at IS NULL OR create_retry_at <= ?)
             )
          ORDER BY updated_at ASC LIMIT ?`,
    args: [Date.now(), Math.max(1, Math.min(100, Math.floor(limit)))],
  });
  return result.rows.map((row) => mapRun(row as Record<string, unknown>));
}

function mapTreasureEntry(row: Record<string, unknown>): TreasureHistoryEntry {
  return {
    id: rowString(row.id),
    repoKey: rowString(row.repo_key),
    analysisId: rowString(row.analysis_id),
    status: rowString(row.status) as TreasureEntryStatus,
    selectedAt: Number(row.selected_at),
    productScoreSnapshot: Number(row.product_score_snapshot),
    confidenceSnapshot: Number(row.confidence_snapshot),
    verificationLevelSnapshot: rowString(row.verification_level_snapshot) as VerificationLevel,
    starsSnapshot: nullableNumber(row.stars_snapshot),
    exposureSnapshot: rowString(
      row.exposure_snapshot,
    ) as ProjectAnalysisArtifact["exposure"]["band"],
    reason: rowString(row.reason),
    resolvedCommitSha: rowString(row.resolved_commit_sha),
    graduatedAt: nullableNumber(row.graduated_at),
    removedAt: nullableNumber(row.removed_at),
    removedReason: nullableString(row.removed_reason),
  };
}

export async function listTreasureHistory(repoKey: string): Promise<TreasureHistoryEntry[]> {
  const db = database();
  await ensureSchema(db);
  const result = await db.execute({
    sql: `SELECT * FROM treasure_entries
          WHERE repo_key = ? ORDER BY selected_at DESC`,
    args: [repoKey.toLowerCase()],
  });
  return result.rows.map((row) => mapTreasureEntry(row as Record<string, unknown>));
}

export async function removeTreasureProject(repoKey: string, reason: string): Promise<boolean> {
  const db = database();
  await ensureSchema(db);
  const normalizedRepoKey = repoKey.toLowerCase();
  const removedAt = Date.now();
  const results = await db.batch(
    [
      {
        sql: `UPDATE treasure_entries
              SET status = 'removed', removed_at = ?, removed_reason = ?
              WHERE repo_key = ? AND status = 'active'`,
        args: [removedAt, reason.slice(0, 2_000), normalizedRepoKey],
      },
      {
        sql: `UPDATE project_assessments
              SET treasure_eligible = 0, updated_at = ?
              WHERE repo_key = ?`,
        args: [removedAt, normalizedRepoKey],
      },
    ],
    "write",
  );
  return (results[0]?.rowsAffected ?? 0) > 0;
}

export function resetProjectAnalysisDbForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new ProjectAnalysisDatabaseError("Database reset is test-only.");
  }
  client?.close();
  client = null;
  schemaReady = null;
}
