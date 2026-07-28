import { z } from "zod";
import type { ProjectAnalysisRun } from "./project-analysis-db";

const DEFAULT_API_BASE = "http://127.0.0.1:8787/api/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const runStatusSchema = z.enum([
  "queued",
  "booting",
  "running",
  "waiting_input",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

const runSchema = z.object({
  id: z.string().min(1),
  status: runStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
  trigger: z.string(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

const threadResponseSchema = z.object({
  thread: z.object({
    id: z.string().min(1),
    agent_id: z.string().min(1),
    kind: z.enum(["pet", "cattle"]),
    status: z.enum(["IDLE", "RUNNING", "RESCHEDULING", "TERMINATED"]),
    client_external_ref: z.string().nullable(),
  }),
  run: runSchema.nullable(),
});

const threadFilesSchema = z.object({
  files: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      kind: z.enum(["attachment", "artifact"]),
      committed: z.boolean(),
      size: z.number().int().nonnegative(),
      mimeType: z.string().nullable(),
    }),
  ),
});

const threadEventsSchema = z.object({
  events: z.array(
    z.object({
      id: z.string().min(1),
      type: z.string(),
      status: z.enum(["available", "error", "unsupported"]),
      content: z.string(),
      occurredAt: z.string(),
      durationMs: z.number().nullable(),
      tokens: z.number().nullable(),
    }),
  ),
  truncated: z.boolean(),
});

export type MosooRunStatus = z.infer<typeof runStatusSchema>;

export type MosooProjectAnalysisErrorCode =
  | "mosoo_unavailable"
  | "mosoo_unauthenticated"
  | "mosoo_forbidden"
  | "mosoo_not_ready"
  | "mosoo_rate_limited"
  | "mosoo_invalid_response"
  | "artifact_missing";

export class MosooProjectAnalysisError extends Error {
  constructor(
    public readonly code: MosooProjectAnalysisErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "MosooProjectAnalysisError";
  }
}

export interface MosooProjectAnalysisConfig {
  apiBase: string;
  apiToken: string;
  agentId: string;
  requestTimeoutMs: number;
}

export interface MosooThreadSnapshot {
  threadId: string;
  runId: string;
  runStatus: MosooRunStatus;
  kind: "pet" | "cattle";
  eventTypes: string[];
  runError: { code: string; message: string; retryable?: boolean } | null;
}

export interface MosooProjectArtifactContents {
  analysisJson: string;
  evidenceJson: string;
  reportMarkdown: string;
}

function projectAgentConfig(): MosooProjectAnalysisConfig {
  const apiToken = process.env.MOSOO_API_TOKEN?.trim();
  const agentId = process.env.MOSOO_PROJECT_AGENT_ID?.trim();
  if (!apiToken) {
    throw new MosooProjectAnalysisError(
      "mosoo_unauthenticated",
      "MOSOO_API_TOKEN is required for project analysis.",
      503,
    );
  }
  if (!agentId) {
    throw new MosooProjectAnalysisError(
      "mosoo_not_ready",
      "MOSOO_PROJECT_AGENT_ID is required and cannot fall back to the account Agent.",
      503,
    );
  }
  const rawTimeout = Number(process.env.MOSOO_PROJECT_REQUEST_TIMEOUT_MS);
  return {
    apiBase: (process.env.MOSOO_API_BASE || DEFAULT_API_BASE).replace(/\/$/, ""),
    apiToken,
    agentId,
    requestTimeoutMs:
      Number.isFinite(rawTimeout) && rawTimeout >= 1_000
        ? Math.floor(rawTimeout)
        : DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

function mapApiError(status: number, body: unknown, retryAfter: string | null) {
  const parsed = z
    .object({ error: z.object({ code: z.string(), message: z.string().optional() }) })
    .safeParse(body);
  const upstreamCode = parsed.success ? parsed.data.error.code : "unknown";
  const message = parsed.success
    ? parsed.data.error.message || upstreamCode
    : `Mosoo Public Thread API returned HTTP ${status}.`;
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : undefined;
  if (status === 401) {
    return new MosooProjectAnalysisError("mosoo_unauthenticated", message, 503);
  }
  if (status === 403 || status === 404) {
    return new MosooProjectAnalysisError("mosoo_forbidden", message, 503);
  }
  if (status === 409) {
    return new MosooProjectAnalysisError("mosoo_not_ready", message, 503);
  }
  if (status === 429) {
    return new MosooProjectAnalysisError(
      "mosoo_rate_limited",
      message,
      503,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    );
  }
  return new MosooProjectAnalysisError("mosoo_unavailable", message, 503);
}

async function mosooFetch(
  config: MosooProjectAnalysisConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${config.apiToken}`);
    const response = await fetch(`${config.apiBase}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw mapApiError(response.status, body, response.headers.get("retry-after"));
    }
    return response;
  } catch (error) {
    if (error instanceof MosooProjectAnalysisError) throw error;
    throw new MosooProjectAnalysisError(
      "mosoo_unavailable",
      controller.signal.aborted
        ? "Mosoo project analysis request timed out."
        : error instanceof Error
          ? error.message
          : "Mosoo project analysis is unavailable.",
      503,
    );
  } finally {
    clearTimeout(timer);
  }
}

function buildProjectAnalysisPrompt(
  run: ProjectAnalysisRun,
  executionMode: "source_only" | "allowlisted_runtime",
): string {
  return [
    "[GHFIND_PROJECT_ANALYSIS_V2]",
    `analysis_id: ${run.id}`,
    `repository_url: ${run.canonicalUrl}`,
    `requested_ref: ${run.requestedRef ?? ""}`,
    `execution_mode: ${executionMode}`,
    `rubric_version: ${run.rubricVersion}`,
    `schema_version: ${run.schemaVersion}`,
    `artifact_prefix: project-analysis-${run.id}`,
    "locale: zh-CN",
  ].join("\n");
}

export async function createMosooProjectAnalysisThread(
  run: ProjectAnalysisRun,
  executionMode: "source_only" | "allowlisted_runtime",
): Promise<MosooThreadSnapshot> {
  const config = projectAgentConfig();
  const response = await mosooFetch(config, `/agents/${config.agentId}/threads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": run.idempotencyKey,
    },
    body: JSON.stringify({
      client_external_ref: run.id,
      input: {
        type: "user.message",
        content: [{ type: "text", text: buildProjectAnalysisPrompt(run, executionMode) }],
      },
    }),
  });
  const parsed = threadResponseSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.run) {
    throw new MosooProjectAnalysisError(
      "mosoo_invalid_response",
      "Mosoo returned an invalid create-Thread response.",
      502,
    );
  }
  if (parsed.data.thread.kind !== "cattle") {
    throw new MosooProjectAnalysisError(
      "mosoo_invalid_response",
      "Project analysis requires a cattle Agent.",
      502,
    );
  }
  return {
    threadId: parsed.data.thread.id,
    runId: parsed.data.run.id,
    runStatus: parsed.data.run.status,
    kind: parsed.data.thread.kind,
    eventTypes: [],
    runError: parsed.data.run.error ?? null,
  };
}

export async function getMosooProjectAnalysisSnapshot(
  threadId: string,
): Promise<MosooThreadSnapshot> {
  const config = projectAgentConfig();
  const [threadResponse, eventResponse] = await Promise.all([
    mosooFetch(config, `/threads/${threadId}`),
    mosooFetch(config, `/threads/${threadId}/events?limit=100`),
  ]);
  const thread = threadResponseSchema.safeParse(await threadResponse.json());
  const events = threadEventsSchema.safeParse(await eventResponse.json());
  if (!thread.success || !thread.data.run || !events.success) {
    throw new MosooProjectAnalysisError(
      "mosoo_invalid_response",
      "Mosoo returned an invalid Thread snapshot.",
      502,
    );
  }
  return {
    threadId: thread.data.thread.id,
    runId: thread.data.run.id,
    runStatus: thread.data.run.status,
    kind: thread.data.thread.kind,
    eventTypes: events.data.events.map((event) => event.type),
    runError: thread.data.run.error ?? null,
  };
}

async function downloadArtifact(
  config: MosooProjectAnalysisConfig,
  fileId: string,
): Promise<string> {
  const response = await mosooFetch(
    config,
    `/files/${fileId}/content?disposition=inline`,
    { headers: { Accept: "application/octet-stream" } },
  );
  return response.text();
}

export async function readMosooProjectAnalysisArtifacts(
  threadId: string,
  analysisId: string,
): Promise<MosooProjectArtifactContents> {
  const config = projectAgentConfig();
  const response = await mosooFetch(config, `/threads/${threadId}/files`);
  const parsed = threadFilesSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new MosooProjectAnalysisError(
      "mosoo_invalid_response",
      "Mosoo returned an invalid Thread file list.",
      502,
    );
  }
  const artifacts = new Map(
    parsed.data.files
      .filter((file) => file.kind === "artifact" && file.committed)
      .map((file) => [file.name, file]),
  );
  const analysis = artifacts.get(`project-analysis-${analysisId}.json`);
  const evidence = artifacts.get(`runtime-evidence-${analysisId}.json`);
  const report = artifacts.get(`project-report-${analysisId}.md`);
  if (!analysis || !evidence || !report) {
    throw new MosooProjectAnalysisError(
      "artifact_missing",
      "Completed Mosoo run is missing one or more required project artifacts.",
      502,
    );
  }
  if (analysis.size > 512_000 || evidence.size > 1_500_000 || report.size > 500_000) {
    throw new MosooProjectAnalysisError(
      "mosoo_invalid_response",
      "Project analysis artifact exceeds the configured size limit.",
      502,
    );
  }
  const [analysisJson, evidenceJson, reportMarkdown] = await Promise.all([
    downloadArtifact(config, analysis.id),
    downloadArtifact(config, evidence.id),
    downloadArtifact(config, report.id),
  ]);
  return { analysisJson, evidenceJson, reportMarkdown };
}

export function getMosooProjectAgentId(): string {
  return projectAgentConfig().agentId;
}
