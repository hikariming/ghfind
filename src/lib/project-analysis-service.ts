import { createHash, randomUUID } from "node:crypto";
import {
  PROJECT_AGENT_VERSION,
  PROJECT_ANALYSIS_SCHEMA_VERSION,
  PROJECT_RUBRIC_VERSION,
  PROJECT_SKILL_VERSION,
  normalizeGitHubRepository,
  parseProjectAnalysisArtifacts,
  type ProjectAnalysisPhase,
  type ProjectAnalysisActivity,
} from "./project-analysis-contract";
import {
  attachMosooThread,
  createProjectAnalysisRun,
  failProjectAnalysis,
  finalizeProjectAnalysis,
  findReusableCompletedProjectAnalysisRun,
  getProjectAnalysisRun,
  getProjectAssessment,
  listReconciliableProjectAnalysisRuns,
  listTreasureHistory,
  prepareProjectAnalysisRetry,
  reserveProjectAnalysisExecutionSlot,
  scheduleProjectAnalysisCreateRetry,
  updateProjectAnalysisState,
  updateProjectAnalysisActivities,
  type ProjectAnalysisRun,
  type ReusableProjectAnalysisRunInput,
} from "./project-analysis-db";
import {
  createMosooProjectAnalysisThread,
  getMosooProjectAgentId,
  getMosooProjectAnalysisSnapshot,
  MosooProjectAnalysisError,
  readMosooProjectAnalysisArtifacts,
  type MosooThreadSnapshot,
} from "./mosoo-project-analysis";
import {
  clearCachedProjectAnalysisId,
  getCachedProjectAnalysisId,
  setCachedProjectAnalysisId,
} from "./redis";

export type ProjectAnalysisServiceErrorCode =
  | "invalid_repository"
  | "invalid_ref"
  | "analysis_not_found"
  | "artifact_invalid"
  | "unexpected_input_request"
  | "analysis_timeout";

export class ProjectAnalysisServiceError extends Error {
  constructor(
    public readonly code: ProjectAnalysisServiceErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ProjectAnalysisServiceError";
  }
}

export interface CreateProjectAnalysisInput {
  repositoryUrl: string;
  requestedRef?: string | null;
}

function reusableProjectAnalysisInput(
  repoKey: string,
  requestedRef: string | null,
): ReusableProjectAnalysisRunInput {
  return {
    repoKey,
    requestedRef,
    schemaVersion: PROJECT_ANALYSIS_SCHEMA_VERSION,
    rubricVersion: PROJECT_RUBRIC_VERSION,
    agentVersion: PROJECT_AGENT_VERSION,
    skillVersion: PROJECT_SKILL_VERSION,
  };
}

function projectAnalysisResultFingerprint(
  input: ReusableProjectAnalysisRunInput,
): string {
  return createHash("sha256")
    .update(
      [
        input.repoKey.toLowerCase(),
        input.requestedRef ?? "",
        input.schemaVersion,
        input.rubricVersion,
        input.agentVersion,
        input.skillVersion,
      ].join("\0"),
    )
    .digest("hex");
}

async function findReusableProjectAnalysisByIdentity(
  input: ReusableProjectAnalysisRunInput,
): Promise<ProjectAnalysisRun | null> {
  const fingerprint = projectAnalysisResultFingerprint(input);
  const cachedAnalysisId = await getCachedProjectAnalysisId(fingerprint);
  if (cachedAnalysisId) {
    const cachedRun = await getProjectAnalysisRun(cachedAnalysisId);
    const currentAssessment = await getProjectAssessment(input.repoKey);
    if (
      cachedRun?.status === "completed" &&
      currentAssessment?.latestAnalysisId === cachedRun.id &&
      cachedRun.repoKey === input.repoKey.toLowerCase() &&
      cachedRun.requestedRef === input.requestedRef &&
      cachedRun.schemaVersion === input.schemaVersion &&
      cachedRun.rubricVersion === input.rubricVersion &&
      cachedRun.agentVersion === input.agentVersion &&
      cachedRun.skillVersion === input.skillVersion
    ) {
      return cachedRun;
    }
    await clearCachedProjectAnalysisId(fingerprint);
  }

  const persisted = await findReusableCompletedProjectAnalysisRun(input);
  if (persisted) {
    await setCachedProjectAnalysisId(fingerprint, persisted.id);
  }
  return persisted;
}

export async function getReusableProjectAnalysis(
  input: CreateProjectAnalysisInput,
): Promise<ProjectAnalysisRun | null> {
  let repository;
  try {
    repository = normalizeGitHubRepository(input.repositoryUrl);
  } catch {
    throw new ProjectAnalysisServiceError(
      "invalid_repository",
      "Pass a public GitHub repository URL or owner/repository.",
      400,
    );
  }
  const requestedRef = normalizeRequestedRef(input.requestedRef);
  return findReusableProjectAnalysisByIdentity(
    reusableProjectAnalysisInput(repository.repoKey, requestedRef),
  );
}

async function cacheCompletedProjectAnalysis(run: ProjectAnalysisRun): Promise<void> {
  const input = reusableProjectAnalysisInput(run.repoKey, run.requestedRef);
  await setCachedProjectAnalysisId(projectAnalysisResultFingerprint(input), run.id);
}

export interface PublicProjectAnalysisView {
  analysisId: string;
  repoKey: string;
  canonicalUrl: string;
  requestedRef: string | null;
  status: ProjectAnalysisRun["status"];
  phase: ProjectAnalysisRun["phase"];
  progress: number;
  activities: ProjectAnalysisActivity[];
  error: { code: string; message: string } | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  retry: ProjectAnalysisRetryState;
  assessment: Awaited<ReturnType<typeof getProjectAssessment>>;
  treasureHistory: Awaited<ReturnType<typeof listTreasureHistory>>;
}

export type ProjectAnalysisRetryState = {
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: number;
} | null;

function publicProjectAnalysisErrorMessage(code: string): string {
  if (code === "artifact_invalid") {
    return "The generated assessment could not be verified. Please try again.";
  }
  return "Project analysis could not be completed. Please try again.";
}

function normalizeRequestedRef(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const ref = value.trim();
  if (
    ref.length > 200 ||
    /[\x00-\x20~^:?*[\\]/.test(ref) ||
    ref.startsWith("-") ||
    ref.includes("..") ||
    ref.includes("@{")
  ) {
    throw new ProjectAnalysisServiceError("invalid_ref", "Invalid Git ref.", 400);
  }
  return ref;
}

function runtimeAllowlist(): Set<string> {
  const raw = process.env.PROJECT_ANALYSIS_RUNTIME_ALLOWLIST ?? "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function projectAnalysisExecutionMode(
  repoKey: string,
): "source_only" | "allowlisted_runtime" {
  return runtimeAllowlist().has(repoKey.toLowerCase())
    ? "allowlisted_runtime"
    : "source_only";
}

function isRetryableMosooCreateError(error: MosooProjectAnalysisError): boolean {
  return error.code === "mosoo_unavailable" || error.code === "mosoo_rate_limited";
}

const MAX_AUTOMATIC_MOSOO_RUN_RETRIES = 1;
const DEFAULT_MAX_AUTOMATIC_MOSOO_CREATE_ATTEMPTS = 3;
const DEFAULT_MOSOO_CREATE_RETRY_BASE_MS = 5_000;

function mosooRunRetryCount(run: ProjectAnalysisRun): number {
  const match = run.idempotencyKey.match(/-retry-(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function isRetryableMosooRunFailure(snapshot: MosooThreadSnapshot): boolean {
  return snapshot.runStatus === "failed" && snapshot.runError?.code === "runtime.inactive";
}

async function retryMosooRun(
  run: ProjectAnalysisRun,
): Promise<ProjectAnalysisRun | null> {
  if (!run.mosooThreadId) return null;
  const retryCount = mosooRunRetryCount(run);
  if (retryCount >= MAX_AUTOMATIC_MOSOO_RUN_RETRIES) return null;
  const pending = await prepareProjectAnalysisRetry(
    run.id,
    run.mosooThreadId,
    `${run.idempotencyKey}-retry-${retryCount + 1}`,
  );
  return pending ? createOrResumeMosooThread(pending) : null;
}

function maximumConcurrentRuns(): number {
  const configured = Number(process.env.PROJECT_ANALYSIS_MAX_CONCURRENCY);
  return Number.isFinite(configured) && configured >= 1
    ? Math.min(20, Math.floor(configured))
    : 3;
}

function maximumCreateAttempts(): number {
  const configured = Number(process.env.PROJECT_ANALYSIS_CREATE_MAX_ATTEMPTS);
  return Number.isFinite(configured) && configured >= 1
    ? Math.min(10, Math.floor(configured))
    : DEFAULT_MAX_AUTOMATIC_MOSOO_CREATE_ATTEMPTS;
}

export function projectAnalysisRetryState(
  run: ProjectAnalysisRun,
): ProjectAnalysisRetryState {
  return run.status === "queued" && run.createAttempts > 0 && run.createRetryAt !== null
    ? {
        attempt: run.createAttempts,
        maxAttempts: maximumCreateAttempts(),
        nextAttemptAt: run.createRetryAt,
      }
    : null;
}

function createRetryBaseMs(): number {
  const configured = Number(process.env.PROJECT_ANALYSIS_CREATE_RETRY_BASE_MS);
  return Number.isFinite(configured) && configured >= 1_000
    ? Math.min(60_000, Math.floor(configured))
    : DEFAULT_MOSOO_CREATE_RETRY_BASE_MS;
}

function createAttemptLeaseMs(): number {
  const requestTimeout = Number(process.env.MOSOO_PROJECT_REQUEST_TIMEOUT_MS);
  const timeout = Number.isFinite(requestTimeout) && requestTimeout >= 1_000
    ? Math.floor(requestTimeout)
    : 15_000;
  return timeout + 5_000;
}

function createRetryDelayMs(
  attempt: number,
  error: MosooProjectAnalysisError,
): number {
  if (error.retryAfterSeconds && error.retryAfterSeconds > 0) {
    return Math.min(5 * 60_000, Math.ceil(error.retryAfterSeconds * 1_000));
  }
  return Math.min(60_000, createRetryBaseMs() * 2 ** Math.max(0, attempt - 1));
}

function analysisTimeoutMs(): number {
  const configured = Number(process.env.PROJECT_ANALYSIS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 60_000
    ? Math.floor(configured)
    : 15 * 60_000;
}

async function createOrResumeMosooThread(run: ProjectAnalysisRun): Promise<ProjectAnalysisRun> {
  if (
    !run.mosooThreadId &&
    run.createAttempts >= maximumCreateAttempts() &&
    (run.createRetryAt === null || run.createRetryAt <= Date.now())
  ) {
    await failProjectAnalysis(
      run.id,
      "mosoo_create_retry_exhausted",
      `Mosoo Thread creation failed after ${run.createAttempts} attempts.`,
    );
    return (await getProjectAnalysisRun(run.id)) ?? run;
  }
  const reserved = await reserveProjectAnalysisExecutionSlot(
    run.id,
    maximumConcurrentRuns(),
    createAttemptLeaseMs(),
  );
  if (!reserved) return (await getProjectAnalysisRun(run.id)) ?? run;
  const attemptRun = (await getProjectAnalysisRun(run.id)) ?? run;
  try {
    const thread = await createMosooProjectAnalysisThread(
      attemptRun,
      projectAnalysisExecutionMode(attemptRun.repoKey),
    );
    await attachMosooThread({
      analysisId: attemptRun.id,
      agentId: getMosooProjectAgentId(),
      threadId: thread.threadId,
      runId: thread.runId,
    });
  } catch (error) {
    if (error instanceof MosooProjectAnalysisError && isRetryableMosooCreateError(error)) {
      if (attemptRun.createAttempts >= maximumCreateAttempts()) {
        await failProjectAnalysis(attemptRun.id, "mosoo_create_retry_exhausted", error.message);
        return (await getProjectAnalysisRun(attemptRun.id)) ?? attemptRun;
      }
      const retryDelayMs = createRetryDelayMs(attemptRun.createAttempts, error);
      const pending = await scheduleProjectAnalysisCreateRetry(
        attemptRun.id,
        Date.now() + retryDelayMs,
      );
      if (!pending) {
        throw new ProjectAnalysisServiceError(
          "analysis_not_found",
          "Project analysis could not schedule its next creation attempt.",
          500,
        );
      }
      console.warn("project_analysis.create_retry_scheduled", {
        analysisId: pending.id,
        repoKey: pending.repoKey,
        attempt: pending.createAttempts,
        maxAttempts: maximumCreateAttempts(),
        nextAttemptAt: pending.createRetryAt,
        errorCode: error.code,
      });
      return pending;
    }
    const code = error instanceof MosooProjectAnalysisError ? error.code : "mosoo_unavailable";
    const message = error instanceof Error ? error.message : "Mosoo project analysis failed.";
    await failProjectAnalysis(attemptRun.id, code, message);
    throw error;
  }
  const attached = await getProjectAnalysisRun(attemptRun.id);
  if (!attached) {
    throw new ProjectAnalysisServiceError(
      "analysis_not_found",
      "Project analysis disappeared after Mosoo Thread creation.",
      500,
    );
  }
  return attached;
}

export async function createProjectAnalysis(
  input: CreateProjectAnalysisInput,
): Promise<ProjectAnalysisRun> {
  let repository;
  try {
    repository = normalizeGitHubRepository(input.repositoryUrl);
  } catch {
    throw new ProjectAnalysisServiceError(
      "invalid_repository",
      "Pass a public GitHub repository URL or owner/repository.",
      400,
    );
  }
  const requestedRef = normalizeRequestedRef(input.requestedRef);
  const reusable = await findReusableProjectAnalysisByIdentity(
    reusableProjectAnalysisInput(repository.repoKey, requestedRef),
  );
  if (reusable) return reusable;

  const created = await createProjectAnalysisRun({
    id: randomUUID(),
    repoKey: repository.repoKey,
    canonicalUrl: repository.canonicalUrl,
    requestedRef,
    schemaVersion: PROJECT_ANALYSIS_SCHEMA_VERSION,
    rubricVersion: PROJECT_RUBRIC_VERSION,
    agentVersion: PROJECT_AGENT_VERSION,
    skillVersion: PROJECT_SKILL_VERSION,
  });
  if (!created.created) return created.run;
  return createOrResumeMosooThread(created.run);
}

function runningPhase(snapshot: MosooThreadSnapshot): {
  phase: ProjectAnalysisPhase;
  progress: number;
} {
  const latestActivity = snapshot.activities.at(-1)?.kind;
  const activityPhase = {
    started: { phase: "classifying", progress: 15 },
    inspecting_source: { phase: "inspecting", progress: 30 },
    inspecting_docs: { phase: "inspecting", progress: 40 },
    inspecting_history: { phase: "inspecting", progress: 50 },
    checking_community: { phase: "inspecting", progress: 60 },
    evaluating: { phase: "evaluating", progress: 70 },
    writing: { phase: "writing_report", progress: 80 },
    validating: { phase: "persisting", progress: 88 },
    saving: { phase: "persisting", progress: 92 },
    completed: { phase: "persisting", progress: 95 },
    failed: { phase: "evaluating", progress: 65 },
  } satisfies Record<ProjectAnalysisActivity["kind"], {
    phase: ProjectAnalysisPhase;
    progress: number;
  }>;
  if (latestActivity) return activityPhase[latestActivity];
  if (
    snapshot.eventTypes.includes("file.changed") ||
    snapshot.eventTypes.includes("session_files.updated")
  ) {
    return { phase: "writing_report", progress: 80 };
  }
  if (snapshot.eventTypes.includes("tool.use.completed")) {
    return { phase: "evaluating", progress: 65 };
  }
  if (snapshot.eventTypes.includes("tool.use.started")) {
    return { phase: "inspecting", progress: 35 };
  }
  return { phase: "classifying", progress: 15 };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactRepoKey(analysisJson: string): string | null {
  try {
    const value: unknown = JSON.parse(analysisJson);
    if (!value || typeof value !== "object") return null;
    const repository = (value as { repository?: unknown }).repository;
    if (!repository || typeof repository !== "object") return null;
    const repoKey = (repository as { repo_key?: unknown }).repo_key;
    return typeof repoKey === "string" ? repoKey.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function verifiedArtifactRepoKey(
  run: ProjectAnalysisRun,
  analysisJson: string,
): Promise<string> {
  const claimedRepoKey = artifactRepoKey(analysisJson);
  if (!claimedRepoKey || claimedRepoKey === run.repoKey) return run.repoKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(run.canonicalUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      cache: "no-store",
      headers: { "User-Agent": "ghfind-project-identity-resolver" },
    });
    if (!response.ok) return run.repoKey;
    const redirected = normalizeGitHubRepository(response.url);
    return redirected.repoKey === claimedRepoKey ? redirected.repoKey : run.repoKey;
  } catch {
    return run.repoKey;
  } finally {
    clearTimeout(timer);
  }
}

async function finalizeCompletedRun(run: ProjectAnalysisRun): Promise<ProjectAnalysisRun> {
  let artifacts;
  try {
    artifacts = await readMosooProjectAnalysisArtifacts(run.mosooThreadId!, run.id);
  } catch (error) {
    if (
      error instanceof MosooProjectAnalysisError &&
      error.code === "artifact_missing" &&
      Date.now() - run.updatedAt < 30_000
    ) {
      return run;
    }
    const code = error instanceof MosooProjectAnalysisError ? error.code : "artifact_missing";
    const message = error instanceof Error ? error.message : "Project artifacts are missing.";
    await failProjectAnalysis(run.id, code, message);
    const failed = await getProjectAnalysisRun(run.id);
    if (!failed) throw error;
    return failed;
  }

  await updateProjectAnalysisState({
    analysisId: run.id,
    status: "finalizing",
    phase: "persisting",
    progress: 90,
  });

  try {
    const expectedRepoKey = await verifiedArtifactRepoKey(run, artifacts.analysisJson);
    const parsed = parseProjectAnalysisArtifacts({
      analysisRaw: artifacts.analysisJson,
      evidenceRaw: artifacts.evidenceJson,
      reportMarkdown: artifacts.reportMarkdown,
      expectedAnalysisId: run.id,
      expectedRepoKey,
    });
    if (
      parsed.analysis.rubric_version !== run.rubricVersion ||
      parsed.analysis.agent_version !== run.agentVersion ||
      parsed.analysis.skill_version !== run.skillVersion ||
      parsed.analysis.repository.requested_ref !== run.requestedRef
    ) {
      throw new Error("Artifact version or requested ref does not match the analysis run.");
    }
    const completed = await finalizeProjectAnalysis({
      analysisId: run.id,
      analysis: parsed.analysis,
      analysisJson: artifacts.analysisJson,
      evidenceJson: artifacts.evidenceJson,
      reportMarkdown: artifacts.reportMarkdown,
      hashes: {
        analysis: sha256(artifacts.analysisJson),
        evidence: sha256(artifacts.evidenceJson),
        report: sha256(artifacts.reportMarkdown),
      },
    });
    await cacheCompletedProjectAnalysis(completed);
    console.info("project_analysis.completed", {
      analysisId: completed.id,
      repoKey: completed.repoKey,
      mosooThreadId: completed.mosooThreadId,
      status: completed.status,
      phase: completed.phase,
      durationMs: (completed.completedAt ?? Date.now()) - completed.createdAt,
      verificationLevel: completed.verificationLevel,
      artifactBytes:
        artifacts.analysisJson.length +
        artifacts.evidenceJson.length +
        artifacts.reportMarkdown.length,
      schemaVersion: completed.schemaVersion,
      rubricVersion: completed.rubricVersion,
      errorCode: completed.errorCode,
    });
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project artifacts are invalid.";
    await failProjectAnalysis(run.id, "artifact_invalid", message);
    const failed = await getProjectAnalysisRun(run.id);
    if (!failed) {
      throw new ProjectAnalysisServiceError("artifact_invalid", message, 502);
    }
    return failed;
  }
}

export async function reconcileProjectAnalysis(
  analysisId: string,
): Promise<ProjectAnalysisRun> {
  let run = await getProjectAnalysisRun(analysisId);
  if (!run) {
    throw new ProjectAnalysisServiceError(
      "analysis_not_found",
      "Project analysis was not found.",
      404,
    );
  }
  if (["completed", "failed", "cancelled", "expired"].includes(run.status)) {
    if (run.activities.length === 0 && run.mosooThreadId) {
      try {
        const snapshot = await getMosooProjectAnalysisSnapshot(run.mosooThreadId);
        if (snapshot.activities.length > 0) {
          await updateProjectAnalysisActivities(run.id, snapshot.activities);
          return (await getProjectAnalysisRun(run.id)) ?? run;
        }
      } catch {
        // Historical terminal results remain readable when Mosoo is unavailable.
      }
    }
    return run;
  }
  if (run.startedAt && Date.now() - run.startedAt > analysisTimeoutMs()) {
    await failProjectAnalysis(
      run.id,
      "analysis_timeout",
      "Project analysis exceeded the configured execution timeout.",
      "expired",
    );
    return (await getProjectAnalysisRun(run.id)) ?? run;
  }
  if (!run.mosooThreadId) return createOrResumeMosooThread(run);

  let snapshot: MosooThreadSnapshot;
  try {
    snapshot = await getMosooProjectAnalysisSnapshot(run.mosooThreadId);
  } catch (error) {
    if (error instanceof MosooProjectAnalysisError && isRetryableMosooCreateError(error)) {
      return run;
    }
    const code = error instanceof MosooProjectAnalysisError ? error.code : "mosoo_unavailable";
    const message = error instanceof Error ? error.message : "Mosoo project analysis failed.";
    await failProjectAnalysis(run.id, code, message);
    return (await getProjectAnalysisRun(run.id)) ?? run;
  }

  if (snapshot.runStatus === "waiting_input") {
    await failProjectAnalysis(
      run.id,
      "unexpected_input_request",
      "The Cattle project Agent unexpectedly requested user input.",
    );
    return (await getProjectAnalysisRun(run.id)) ?? run;
  }
  if (["failed", "cancelled", "expired"].includes(snapshot.runStatus)) {
    if (isRetryableMosooRunFailure(snapshot)) {
      const retried = await retryMosooRun(run);
      if (retried) return retried;
    }
    const terminalStatus =
      snapshot.runStatus === "cancelled"
        ? "cancelled"
        : snapshot.runStatus === "expired"
          ? "expired"
          : "failed";
    await failProjectAnalysis(
      run.id,
      `mosoo_run_${snapshot.runStatus}`,
      `Mosoo project analysis ended with ${snapshot.runStatus}.`,
      terminalStatus,
      snapshot.activities,
    );
    return (await getProjectAnalysisRun(run.id)) ?? run;
  }
  if (snapshot.runStatus === "completed") return finalizeCompletedRun(run);

  const phase = runningPhase(snapshot);
  await updateProjectAnalysisState({
    analysisId: run.id,
    status: "running",
    phase: phase.phase,
    progress: phase.progress,
    runId: snapshot.runId,
    activities: snapshot.activities,
  });
  run = (await getProjectAnalysisRun(run.id)) ?? run;
  return run;
}

export async function reconcilePendingProjectAnalyses(limit = 20): Promise<{
  processed: number;
  completed: number;
  failed: number;
}> {
  const runs = await listReconciliableProjectAnalysisRuns(limit);
  let completed = 0;
  let failed = 0;
  for (const run of runs) {
    try {
      const next = await reconcileProjectAnalysis(run.id);
      if (next.status === "completed") completed += 1;
      if (["failed", "cancelled", "expired"].includes(next.status)) failed += 1;
    } catch (error) {
      console.error("project analysis reconcile failed", {
        analysisId: run.id,
        repoKey: run.repoKey,
        error: error instanceof Error ? error.message : String(error),
      });
      failed += 1;
    }
  }
  return { processed: runs.length, completed, failed };
}

export async function getPublicProjectAnalysisView(
  analysisId: string,
  reconcile = false,
): Promise<PublicProjectAnalysisView> {
  const run = reconcile
    ? await reconcileProjectAnalysis(analysisId)
    : await getProjectAnalysisRun(analysisId);
  if (!run) {
    throw new ProjectAnalysisServiceError(
      "analysis_not_found",
      "Project analysis was not found.",
      404,
    );
  }
  const assessment =
    run.status === "completed" ? await getProjectAssessment(run.repoKey) : null;
  const treasureHistory =
    run.status === "completed" ? await listTreasureHistory(run.repoKey) : [];
  return {
    analysisId: run.id,
    repoKey: run.repoKey,
    canonicalUrl: run.canonicalUrl,
    requestedRef: run.requestedRef,
    status: run.status,
    phase: run.phase,
    progress: run.progress,
    activities: run.activities,
    error:
      run.errorCode && run.errorMessage
        ? {
            code: run.errorCode,
            message: publicProjectAnalysisErrorMessage(run.errorCode),
          }
        : null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    retry: projectAnalysisRetryState(run),
    assessment,
    treasureHistory,
  };
}
