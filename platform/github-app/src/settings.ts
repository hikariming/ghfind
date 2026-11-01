import { jevConfigured } from "./jev";

export interface RepoSettings {
  issuesEnabled: boolean;
  prsEnabled: boolean;
  commentsEnabled: boolean;
  commentPrompt: string;
  triageEnabled: boolean;
  allowedLabels: string[];
  backfillLimit: number;
}
// Matches the column defaults in 0006_repo_settings.sql.
export const DEFAULT_SETTINGS: RepoSettings = {
  issuesEnabled: true,
  prsEnabled: true,
  commentsEnabled: false,
  commentPrompt: "",
  triageEnabled: false,
  allowedLabels: [],
  backfillLimit: 25,
};
const MAX_PROMPT = 2000;
const MAX_LABELS = 50;
const MAX_LABEL = 100;
const MAX_BACKFILL = 100;
interface Row {
  full_name: string;
  issues_enabled: number;
  prs_enabled: number;
  comments_enabled: number;
  comment_prompt: string;
  triage_enabled: number;
  allowed_labels: string;
  backfill_limit: number;
}
function labelsFrom(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value)
      ? value.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}
// Before migration 0006 is applied the table is missing; webhooks keep the
// defaults instead of failing. Any other database error still throws.
export async function getSettings(
  env: Env,
  repository: number,
  fullName?: string,
): Promise<RepoSettings> {
  let row: Row | null;
  try {
    row = await env.DB.prepare(
      "SELECT full_name,issues_enabled,prs_enabled,comments_enabled,comment_prompt,triage_enabled,allowed_labels,backfill_limit FROM repo_settings WHERE repository=?",
    )
      .bind(repository)
      .first<Row>();
  } catch (error) {
    if (
      error instanceof Error &&
      /no such table: repo_settings/.test(error.message)
    )
      row = null;
    else throw error;
  }
  if (!row || (fullName && owner(row.full_name) !== owner(fullName)))
    return { ...DEFAULT_SETTINGS, allowedLabels: [] };
  return {
    issuesEnabled: row.issues_enabled === 1,
    prsEnabled: row.prs_enabled === 1,
    commentsEnabled: row.comments_enabled === 1,
    commentPrompt: row.comment_prompt,
    triageEnabled: row.triage_enabled === 1,
    allowedLabels: labelsFrom(row.allowed_labels),
    backfillLimit: row.backfill_limit,
  };
}
export type SettingsForm = Omit<RepoSettings, "backfillLimit">;
const owner = (fullName: string) => fullName.split("/")[0].toLowerCase();
// A repository id survives transfer. A new owner must opt in again before
// private issue text or AI comments use the previous owner's preferences.
// Rename/reinstall under the same owner preserves settings. Reset before a
// partial write (notably backfill limit) can adopt the new full_name.
async function resetTransferredSettings(env: Env, repository: number, fullName: string) {
  await env.DB.prepare(`UPDATE repo_settings SET
    issues_enabled=1,prs_enabled=1,comments_enabled=0,comment_prompt='',
    triage_enabled=0,allowed_labels='[]',backfill_limit=25,full_name=?
    WHERE repository=? AND lower(substr(full_name,1,instr(full_name,'/')-1))<>?`)
    .bind(fullName, repository, owner(fullName)).run();
}
// installation records the last installation that saved; it is not part of the key.
// backfill_limit is saved only by putBackfillLimit.
export async function putSettings(
  env: Env,
  installation: number,
  repository: number,
  fullName: string,
  value: SettingsForm,
  updatedBy: string,
): Promise<void> {
  await resetTransferredSettings(env, repository, fullName);
  await env.DB.prepare(
    `INSERT INTO repo_settings(repository,installation,full_name,issues_enabled,prs_enabled,comments_enabled,comment_prompt,triage_enabled,allowed_labels,updated,updated_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(repository) DO UPDATE SET installation=excluded.installation,full_name=excluded.full_name,issues_enabled=excluded.issues_enabled,prs_enabled=excluded.prs_enabled,comments_enabled=excluded.comments_enabled,comment_prompt=excluded.comment_prompt,triage_enabled=excluded.triage_enabled,allowed_labels=excluded.allowed_labels,updated=excluded.updated,updated_by=excluded.updated_by`,
  )
    .bind(
      repository,
      installation,
      fullName,
      value.issuesEnabled ? 1 : 0,
      value.prsEnabled ? 1 : 0,
      value.commentsEnabled ? 1 : 0,
      value.commentPrompt,
      value.triageEnabled ? 1 : 0,
      JSON.stringify(value.allowedLabels),
      Date.now(),
      updatedBy,
    )
    .run();
}
export async function putBackfillLimit(
  env: Env,
  installation: number,
  repository: number,
  fullName: string,
  limit: number,
  updatedBy: string,
): Promise<void> {
  await resetTransferredSettings(env, repository, fullName);
  await env.DB.prepare(
    `INSERT INTO repo_settings(repository,installation,full_name,backfill_limit,updated,updated_by) VALUES(?,?,?,?,?,?)
     ON CONFLICT(repository) DO UPDATE SET installation=excluded.installation,full_name=excluded.full_name,backfill_limit=excluded.backfill_limit,updated=excluded.updated,updated_by=excluded.updated_by`,
  )
    .bind(repository, installation, fullName, limit, Date.now(), updatedBy)
    .run();
}
function invalid(): never {
  throw new Error("Invalid settings");
}
function checkbox(form: URLSearchParams, name: string) {
  const values = form.getAll(name);
  if (values.length > 1 || (values.length && values[0] !== "on")) invalid();
  return values.length === 1;
}
// An admin-triggered backfill queues 1..100 of the newest open items.
export function parseBackfillLimit(form: URLSearchParams): number {
  const text = form.get("backfill_limit") ?? "";
  if (!/^\d{1,3}$/.test(text)) invalid();
  const limit = Number(text);
  if (limit < 1 || limit > MAX_BACKFILL) invalid();
  return limit;
}
function validate(value: SettingsForm): SettingsForm {
  if (value.commentPrompt.length > MAX_PROMPT) invalid();
  const allowedLabels = [...new Set(value.allowedLabels)];
  if (allowedLabels.length > MAX_LABELS) invalid();
  for (const name of allowedLabels)
    // review: labels belong to the bot's score labeling, never to triage.
    if (
      !name.length ||
      name.length > MAX_LABEL ||
      name.toLowerCase().startsWith("review:") ||
      // "." and ".." would collapse the label URL path on GitHub writes.
      name === "." ||
      name === ".."
    )
      invalid();
  return { ...value, allowedLabels };
}
export function parseSettingsForm(form: URLSearchParams): SettingsForm {
  return validate({
    issuesEnabled: checkbox(form, "issues_enabled"),
    prsEnabled: checkbox(form, "prs_enabled"),
    commentsEnabled: checkbox(form, "comments_enabled"),
    commentPrompt: form.get("comment_prompt") ?? "",
    triageEnabled: checkbox(form, "triage_enabled"),
    allowedLabels: form.getAll("allowed_labels"),
  });
}
// API PATCH body: snake_case keys as in the form; omitted keys keep `current`.
export function mergeSettingsJson(
  current: SettingsForm,
  body: Record<string, unknown>,
): SettingsForm {
  const keys: Record<string, keyof SettingsForm> = {
    issues_enabled: "issuesEnabled",
    prs_enabled: "prsEnabled",
    comments_enabled: "commentsEnabled",
    comment_prompt: "commentPrompt",
    triage_enabled: "triageEnabled",
    allowed_labels: "allowedLabels",
  };
  const next = { ...current, allowedLabels: [...current.allowedLabels] };
  for (const [key, value] of Object.entries(body)) {
    const field = keys[key];
    if (!field) invalid();
    if (field === "commentPrompt") {
      if (typeof value !== "string") invalid();
      next.commentPrompt = value;
    } else if (field === "allowedLabels") {
      if (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
        invalid();
      next.allowedLabels = value as string[];
    } else {
      if (typeof value !== "boolean") invalid();
      next[field] = value;
    }
  }
  return validate(next);
}
export function settingsJson(value: RepoSettings) {
  return {
    issues_enabled: value.issuesEnabled,
    prs_enabled: value.prsEnabled,
    comments_enabled: value.commentsEnabled,
    comment_prompt: value.commentPrompt,
    triage_enabled: value.triageEnabled,
    allowed_labels: value.allowedLabels,
    backfill_limit: value.backfillLimit,
  };
}
export function llmConfigured(env: Env): boolean {
  const key = (env as unknown as { LLM_API_KEY?: string }).LLM_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

// Intent classification and introductory comments may use separate providers.
export function triageConfigured(env: Env): boolean {
  const provider = env.TRIAGE_PROVIDER?.trim() || "llm";
  return provider === "jev"
    ? jevConfigured(env)
    : provider === "llm" && llmConfigured(env);
}
