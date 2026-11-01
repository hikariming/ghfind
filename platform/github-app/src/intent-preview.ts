import { github } from "./github";
import { resolveAIEnv } from "./byok";
import { repoLabels } from "./repo-labels";
import { getSettings, triageConfigured } from "./settings";
import { classifyIntent, type IntentResult } from "./triage";

export type IntentPreviewCode = "invalid_input" | "no_candidates" | "not_configured" | "rate_limited" | "classifier_unavailable";
export class IntentPreviewError extends Error {
  constructor(public code: IntentPreviewCode, public status: number) {
    super(code);
  }
}
export interface IntentPreviewResult {
  kind: "issue" | "pull_request";
  title: string;
  body: string;
  classification: IntentResult;
  candidateCount: number;
}

// Caller must enforce live administrator authorization and Origin/CSRF checks.
// Preview input and model output are ephemeral; only a cost-limiting counter is saved.
export async function runIntentPreview(
  env: Env,
  api: ReturnType<typeof github>,
  repository: number,
  fullName: string,
  form: URLSearchParams,
): Promise<IntentPreviewResult> {
  const kind = form.get("preview_kind");
  const title = (form.get("preview_title") || "").trim();
  const body = form.get("preview_body") || "";
  if ((kind !== "issue" && kind !== "pull_request") || !title || title.length > 256 || body.length > 8000 ||
    ["preview_kind", "preview_title", "preview_body"].some((key) => form.getAll(key).length > 1))
    throw new IntentPreviewError("invalid_input", 400);
  const aiEnv = await resolveAIEnv(env, repository, fullName);
  if (!triageConfigured(aiEnv)) throw new IntentPreviewError("not_configured", 503);
  const settings = await getSettings(env, repository, fullName);
  const labels = new Map((await repoLabels(api, fullName)).map((label) => [label.name, label]));
  const allowed = [...new Set(settings.allowedLabels)].filter((name) => labels.has(name) && name !== "." && name !== ".." && !name.toLowerCase().startsWith("review:"));
  if (!allowed.length) throw new IntentPreviewError("no_candidates", 400);
  const rate = await env.DB.prepare("INSERT INTO api_rate(key,slot,count) VALUES(?,?,1) ON CONFLICT(key,slot) DO UPDATE SET count=count+1 RETURNING count")
    .bind(`intent-preview:${repository}`, Math.floor(Date.now() / 60000) * 60000).first<{count:number}>();
  if (!rate || rate.count > 1) throw new IntentPreviewError("rate_limited", 429);
  try {
    const classification = await classifyIntent(aiEnv, { title, body, ...(kind === "pull_request" ? { pull_request: {} } : {}) }, allowed, labels, Date.now() + 60_000);
    return { kind, title, body, classification, candidateCount: allowed.length };
  } catch {
    // Never expose provider response details, credentials or issue text in errors.
    throw new IntentPreviewError("classifier_unavailable", 503);
  }
}
