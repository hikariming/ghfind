import { z } from "zod";
import type { ProjectAnalysisRun } from "./project-analysis-db";
import type {
  ProjectAnalysisActivity,
  ProjectAnalysisActivityKind,
} from "./project-analysis-contract";

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
  activities: ProjectAnalysisActivity[];
  runError: { code: string; message: string; retryable?: boolean } | null;
}

export interface MosooProjectArtifactContents {
  analysisJson: string;
  evidenceJson: string;
  reportMarkdown: string;
}

type MosooThreadEvent = z.infer<typeof threadEventsSchema>["events"][number];

function classifyActivity(event: MosooThreadEvent): ProjectAnalysisActivityKind | null {
  const content = event.content.toLowerCase();
  if (event.type === "run.started") return "started";
  if (event.type === "run.completed") return "completed";
  if (event.type === "run.failed") return "failed";
  if (event.type === "file.changed" || event.type === "session_files.updated") {
    return "saving";
  }
  if (event.type !== "tool.use.started") return null;
  if (/(validate_artifacts|validate|schema|校验)/.test(content)) return "validating";
  if (/(score|scoring|rubric|evidence|评分|证据)/.test(content)) return "evaluating";
  if (/(project-report|project-analysis|runtime-evidence|\/outputs|mkdir.*outputs|\bwrite\b)/.test(content)) {
    return "writing";
  }
  if (/(api\.github\.com|contributors|issues|pulls|releases|stars|forks)/.test(content)) {
    return "checking_community";
  }
  if (/(git log|git shortlog|git branch|commit history|提交历史)/.test(content)) {
    return "inspecting_history";
  }
  if (/(readme|\/docs\/|docs\/|spec\.md|architecture|contributing|license|prd)/.test(content)) {
    return "inspecting_docs";
  }
  return "inspecting_source";
}

export function publicProjectAnalysisActivities(
  events: MosooThreadEvent[],
): ProjectAnalysisActivity[] {
  const activities: ProjectAnalysisActivity[] = [];
  for (const event of [...events].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt),
  )) {
    const kind = classifyActivity(event);
    if (!kind || activities.at(-1)?.kind === kind) continue;
    activities.push({ id: event.id, kind, occurredAt: event.occurredAt });
  }
  return activities.slice(-8);
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
    "",
    "[REPORT_CONTRACT]",
    "报告是 analysis JSON 的读者视图，分数只能出自 JSON，不得改分或与 rationale 矛盾。",
    "按以下六维度章节顺序成文（zh-CN 标题必须原样使用，每节先一句明确判断再给证据）：",
    "# 产品潜力分析：<project name>",
    "## 产品价值（X/100）：product_score · confidence · verification_level，加 1-3 句总判断（值得关注吗、给谁看、为什么）。",
    "## 需求痛点（X/25）：痛点是否真实（真实且高频/真实但小众/存疑）、发生在谁身上、没有本项目时的具体工作流、现有替代方案为何不够。",
    "## 解决效果（X/30）：核心承诺 → 已验证的实现证据 → 未验证的部分与缺口；明确回答方案是否闭环解决了上述痛点。",
    "## 上手与核心体验（X/30）：发现 → 安装 → 配置 → 首次成功 → 出错反馈，五步各一句判断；验证过的写清实际观察到的行为。",
    "## 范围与价值密度（X/15）：功能边界是否克制、复杂度是否物有所值；指出可砍掉的部分（如有）。",
    "## 风险：risks 与 unknowns 逐条（没有就写「无」），每条一句判断加一句依据。unknowns 最多 4 条且必须是决策相关的未知（知道后会影响评分/置信/采用决策，并写明影响什么），验证范围事实（本次没构建/没运行）只写进「验证方式与可信度」，不得进 unknowns；禁止「未验证 X」「无法确认 Y」式模板句。",
    "## 验证方式与可信度：本次实际执行了哪个验证级别、做了什么、没做什么、置信度为什么是这个数。",
    "## 曝光与社区（不计入 product_score）：曝光档位与社区强度的客观上下文，以及因此进入哪个榜单或不进榜的原因。",
    "硬性风格：每节至少两段（判断段+证据段），每段不超过 5 句；证据必须可核对（具体文件/命令行为/文档内容/数据），不可核对的写入 unknowns 不得臆测；",
    "禁止第一人称自述：报告是给读者的产品分析，不是 agent 的工作日志。不得出现「我」「本次我」作为主语；验证范围一律用无人称表述，例如「本次验证未覆盖构建与执行（source_only）」而不是「我没有构建」。",
    "禁止填充语：值得注意的是、综上所述、不难发现、总的来说、在某种程度上及同义表达；「不是 X，而是 Y」式排比全篇最多一次；单句最多引用两个方法名/路径名/类名，实现细节归入 evidence JSON。",
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
    activities: [],
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
    activities: publicProjectAnalysisActivities(events.data.events),
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
