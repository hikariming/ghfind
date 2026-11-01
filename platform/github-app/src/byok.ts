import { JEV_BASE_URL, JEV_MODEL, jevConfigured } from "./jev";
import { AIProviderError, canonicalProviderBaseUrl } from "./provider-http";
export { AIProviderError } from "./provider-http";

declare global {
  interface Env {
    BYOK_ENCRYPTION_KEY?: string;
  }
}

export interface AIProviderMetadata {
  mode: "platform" | "byok";
  provider: "llm" | "jev";
  baseUrl: string;
  model: string;
  hasKey: boolean;
  storageAvailable: boolean;
  ready: boolean;
  updatedAt: number | null;
}
export type AIProviderActor = string | { login: string; via: "web" | "api" };
interface ProviderRow {
  repository: number;
  owner: string;
  mode: "platform" | "byok";
  provider: "llm" | "jev";
  base_url: string;
  model: string;
  encrypted_key: string | null;
  updated: number;
}
const LLM_BASE_URL = "https://api.stepfun.com/v1";
const LLM_MODEL = "step-3.7-flash";
const encoder = new TextEncoder();
function invalid(): never {
  throw new AIProviderError("invalid_config");
}

function context(repository: number, fullName: string): string {
  if (
    !Number.isSafeInteger(repository) ||
    repository < 1 ||
    typeof fullName !== "string" ||
    fullName.length > 256 ||
    !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(fullName)
  )
    invalid();
  return fullName.split("/")[0].toLowerCase();
}
function actorValue(actor: AIProviderActor, via: "web" | "api" = "web") {
  const value = typeof actor === "string" ? { login: actor, via } : actor;
  if (
    !value ||
    typeof value.login !== "string" ||
    !value.login.length ||
    value.login.length > 100 ||
    /[\x00-\x1f\x7f]/.test(value.login) ||
    !["web", "api"].includes(value.via)
  )
    invalid();
  return value;
}
function keyValue(value: unknown): string {
  if (typeof value !== "string" || /[^\x20-\x7e]/.test(value)) invalid();
  const key = value.trim();
  if (!/^[\x21-\x7e]{8,4096}$/.test(key)) invalid();
  return key;
}
function modelValue(value: unknown, provider: "llm" | "jev"): string {
  if (typeof value !== "string") invalid();
  const model = value.trim();
  if (
    !model.length ||
    model.length > 200 ||
    /[\x00-\x1f\x7f]/.test(model) ||
    (provider === "jev" && !/^typesafe\/jev-1\.13(?:-\d{8})?$/.test(model))
  )
    invalid();
  return model;
}
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function decode(value: string): Uint8Array {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error();
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (char) => char.charCodeAt(0),
  );
}
function encryptionBytes(env: Env): Uint8Array | null {
  try {
    const setting = env.BYOK_ENCRYPTION_KEY;
    if (typeof setting !== "string" || !/^[a-zA-Z0-9_-]{43}=?$/.test(setting))
      return null;
    const bytes = decode(setting.replace(/=$/, ""));
    return bytes.length === 32 && encode(bytes) === setting.replace(/=$/, "")
      ? bytes
      : null;
  } catch {
    return null;
  }
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  const bytes = encryptionBytes(env);
  if (!bytes) throw new AIProviderError("storage_unavailable", 503);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
function aad(
  row: Pick<ProviderRow, "repository" | "owner" | "provider" | "base_url">,
) {
  return encoder.encode(
    JSON.stringify([
      "ghfind-byok-v1",
      row.repository,
      row.owner,
      row.provider,
      row.base_url,
    ]),
  );
}
async function encrypt(
  env: Env,
  row: ProviderRow,
  key: string,
): Promise<string> {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(row), tagLength: 128 },
      await encryptionKey(env),
      encoder.encode(key),
    );
    return `v1.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
  } catch {
    throw new AIProviderError("storage_unavailable", 503);
  }
}
async function decrypt(env: Env, row: ProviderRow): Promise<string | null> {
  try {
    const parts = row.encrypted_key?.split(".");
    if (
      !parts ||
      parts.length !== 3 ||
      parts[0] !== "v1" ||
      parts[1].length !== 16 ||
      parts[2].length > 6000
    )
      return null;
    const iv = decode(parts[1]);
    if (iv.length !== 12) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad(row), tagLength: 128 },
      await encryptionKey(env),
      decode(parts[2]),
    );
    return keyValue(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        plaintext,
      ),
    );
  } catch {
    return null;
  }
}

async function readRow(
  env: Env,
  repository: number,
): Promise<{ row: ProviderRow | null; available: boolean }> {
  try {
    const row = await env.DB.prepare(
      "SELECT repository,owner,mode,provider,base_url,model,encrypted_key,updated FROM ai_providers WHERE repository=?",
    )
      .bind(repository)
      .first<ProviderRow>();
    return { row, available: true };
  } catch {
    return { row: null, available: false };
  }
}
function platformMetadata(
  env: Env,
  available: boolean,
  updatedAt: number | null = null,
): AIProviderMetadata {
  const provider = env.TRIAGE_PROVIDER?.trim() === "jev" ? "jev" : "llm";
  const hasKey = !!(provider === "jev"
    ? env.OPENROUTER_API_KEY?.trim()
    : env.LLM_API_KEY?.trim());
  return {
    mode: "platform",
    provider,
    baseUrl:
      provider === "jev"
        ? env.JEV_BASE_URL?.trim() || JEV_BASE_URL
        : env.LLM_BASE_URL?.trim() || LLM_BASE_URL,
    model:
      provider === "jev"
        ? env.JEV_MODEL?.trim() || JEV_MODEL
        : env.LLM_MODEL?.trim() || LLM_MODEL,
    hasKey,
    storageAvailable: available && !!encryptionBytes(env),
    ready:
      available &&
      (provider === "jev"
        ? jevConfigured(env)
        : hasKey &&
          (!env.TRIAGE_PROVIDER?.trim() ||
            env.TRIAGE_PROVIDER.trim() === "llm")),
    updatedAt,
  };
}
function disabledMetadata(available: boolean, env: Env): AIProviderMetadata {
  return {
    mode: "byok",
    provider: "llm",
    baseUrl: "",
    model: "",
    hasKey: false,
    storageAvailable: available && !!encryptionBytes(env),
    ready: false,
    updatedAt: null,
  };
}
function validRow(row: ProviderRow) {
  if (
    !["platform", "byok"].includes(row.mode) ||
    !["llm", "jev"].includes(row.provider) ||
    !Number.isSafeInteger(row.updated) ||
    row.updated < 0
  )
    return false;
  try {
    return (
      canonicalProviderBaseUrl(row.base_url) === row.base_url &&
      modelValue(row.model, row.provider) === row.model
    );
  } catch {
    return false;
  }
}

export async function getAIProvider(
  env: Env,
  repository: number,
  fullName: string,
): Promise<AIProviderMetadata> {
  const owner = context(repository, fullName);
  const { row, available } = await readRow(env, repository);
  if (!available) return platformMetadata(env, false);
  if (!row) return platformMetadata(env, true);
  if (row.owner !== owner || row.repository !== repository)
    return disabledMetadata(true, env);
  if (row.mode === "platform") return platformMetadata(env, true, row.updated);
  if (!validRow(row)) return disabledMetadata(true, env);
  return {
    mode: "byok",
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    hasKey: !!row.encrypted_key,
    storageAvailable: !!encryptionBytes(env),
    ready: !!(await decrypt(env, row)),
    updatedAt: row.updated,
  };
}

async function store(
  env: Env,
  row: ProviderRow,
  actor: AIProviderActor,
  action: string,
) {
  const who = actorValue(actor);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ai_providers(repository,owner,mode,provider,base_url,model,encrypted_key,updated,updated_by)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(repository) DO UPDATE SET owner=excluded.owner,mode=excluded.mode,provider=excluded.provider,
        base_url=excluded.base_url,model=excluded.model,encrypted_key=excluded.encrypted_key,updated=excluded.updated,updated_by=excluded.updated_by`,
      ).bind(
        row.repository,
        row.owner,
        row.mode,
        row.provider,
        row.base_url,
        row.model,
        row.encrypted_key,
        row.updated,
        who.login,
      ),
      env.DB.prepare(
        "INSERT INTO audit_log(repository,actor,via,action,detail,created) VALUES(?,?,?,?,?,?)",
      ).bind(
        row.repository,
        who.login,
        who.via,
        action,
        JSON.stringify({
          mode: row.mode,
          provider: row.provider,
          has_key: !!row.encrypted_key,
        }),
        row.updated,
      ),
    ]);
  } catch {
    throw new AIProviderError("storage_unavailable", 503);
  }
}

export async function putAIProvider(
  env: Env,
  repository: number,
  fullName: string,
  input: Record<string, unknown>,
  actor: AIProviderActor,
  via: "web" | "api" = "web",
): Promise<AIProviderMetadata> {
  const owner = context(repository, fullName);
  const who = actorValue(actor, via);
  if (
    !input ||
    Object.keys(input).some(
      (key) =>
        !["mode", "provider", "base_url", "model", "api_key"].includes(key),
    ) ||
    (input.mode !== "platform" && input.mode !== "byok")
  )
    invalid();
  const { row: previous, available } = await readRow(env, repository);
  if (!available) throw new AIProviderError("storage_unavailable", 503);
  const current =
    previous?.owner === owner &&
    previous.repository === repository &&
    validRow(previous)
      ? previous
      : null;
  let next: ProviderRow;
  if (input.mode === "platform") {
    if (input.api_key !== undefined && input.api_key !== "") invalid();
    next = current
      ? { ...current, mode: "platform", updated: Date.now() }
      : {
          repository,
          owner,
          mode: "platform",
          provider: "llm",
          base_url: LLM_BASE_URL,
          model: LLM_MODEL,
          encrypted_key: null,
          updated: Date.now(),
        };
  } else {
    if (input.provider !== "llm" && input.provider !== "jev") invalid();
    if (typeof input.base_url !== "string") invalid();
    const base = canonicalProviderBaseUrl(input.base_url);
    const model = modelValue(input.model, input.provider);
    next = {
      repository,
      owner,
      mode: "byok",
      provider: input.provider,
      base_url: base,
      model,
      encrypted_key: null,
      updated: Date.now(),
    };
    if (
      input.api_key !== undefined &&
      (typeof input.api_key !== "string" || /[^\x20-\x7e]/.test(input.api_key))
    )
      invalid();
    const supplied =
      typeof input.api_key === "string" && input.api_key.trim().length > 0;
    if (supplied)
      next.encrypted_key = await encrypt(env, next, keyValue(input.api_key));
    else {
      if (
        typeof input.api_key === "string" &&
        /[\x00-\x1f\x7f]/.test(input.api_key)
      )
        invalid();
      if (
        !current?.encrypted_key ||
        current.provider !== next.provider ||
        current.base_url !== base ||
        !(await decrypt(env, current))
      )
        throw new AIProviderError("key_required");
      next.encrypted_key = current.encrypted_key;
    }
  }
  await store(env, next, who, "ai_provider.update");
  return getAIProvider(env, repository, fullName);
}

export async function removeAIProviderKey(
  env: Env,
  repository: number,
  fullName: string,
  actor: AIProviderActor,
  via: "web" | "api" = "web",
): Promise<AIProviderMetadata> {
  const owner = context(repository, fullName);
  const who = actorValue(actor, via);
  const { row, available } = await readRow(env, repository);
  if (!available) throw new AIProviderError("storage_unavailable", 503);
  const next: ProviderRow =
    row?.owner === owner && validRow(row)
      ? { ...row, mode: "byok", encrypted_key: null, updated: Date.now() }
      : {
          repository,
          owner,
          mode: "byok",
          provider: "llm",
          base_url: LLM_BASE_URL,
          model: LLM_MODEL,
          encrypted_key: null,
          updated: Date.now(),
        };
  await store(env, next, who, "ai_provider.key_remove");
  return getAIProvider(env, repository, fullName);
}

function disabledEnv(env: Env): Env {
  return {
    ...env,
    LLM_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
    BYOK_REQUIRE_PUBLIC_ENDPOINT: true,
  };
}
export async function resolveAIEnv(
  env: Env,
  repository: number,
  fullName: string,
): Promise<Env> {
  let owner: string;
  try {
    owner = context(repository, fullName);
  } catch {
    return disabledEnv(env);
  }
  const { row, available } = await readRow(env, repository);
  if (!available) return disabledEnv(env);
  if (!row) return env;
  if (row.repository !== repository || row.owner !== owner)
    return disabledEnv(env);
  if (row.mode === "platform") return env;
  const scoped = disabledEnv(env);
  if (!validRow(row)) return scoped;
  scoped.TRIAGE_PROVIDER = row.provider;
  const key = await decrypt(env, row);
  if (!key) return scoped;
  if (row.provider === "jev") {
    scoped.OPENROUTER_API_KEY = key;
    scoped.JEV_BASE_URL = row.base_url;
    scoped.JEV_MODEL = row.model;
  } else {
    scoped.LLM_API_KEY = key;
    scoped.LLM_BASE_URL = row.base_url;
    scoped.LLM_MODEL = row.model;
  }
  return scoped;
}
