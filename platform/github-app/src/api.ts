import { audit, recentAudit } from "./audit";
import { AIProviderError, getAIProvider, putAIProvider, removeAIProviderKey, resolveAIEnv, type AIProviderMetadata } from "./byok";
import { testAIProvider } from "./provider-test";
import { repoLabels } from "./repo-labels";
import {
  cancelCleanup,
  cleanupItems,
  cleanupJson,
  confirmCleanup,
  createCleanup,
  getCleanup,
  latestCleanup,
  parseScope,
} from "./cleanup";
import {
  ApiError,
  appJWT,
  github,
  installationToken,
  jsonRequest,
  positive,
  readText,
  record,
  repositoryName,
} from "./github";
import {
  allowed,
  dispatch,
  Job,
  lastBackfill,
  putBackfill,
  retryJob,
} from "./jobs";
import {
  getSettings,
  llmConfigured,
  triageConfigured,
  mergeSettingsJson,
  putBackfillLimit,
  putSettings,
  settingsJson,
} from "./settings";

// JSON API for the ghfind CLI and agents: /api/v1/...
// Auth is a ghfind.com personal API token (Bearer ghf_...). ghfind.com maps
// it to a GitHub account; this Worker then checks that account's current
// repository permission with the App's installation token, on every request.
// Reading needs write access to the repository, every change needs admin:
// the same rule as Retry and the web admin's save.

class Failure extends Error {
  constructor(
    public status: number,
    public code: string,
    public retryAfter = 0,
  ) {
    super(code);
  }
}
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function identity(env: Env, request: Request, deadline: number) {
  const token = /^Bearer\s+(ghf_[A-Za-z0-9_-]{40,})$/i.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (!token) throw new Failure(401, "invalid_token");
  let body: Record<string, unknown>;
  try {
    body = record(
      await jsonRequest(
        "https://ghfind.com/api/account/whoami",
        { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
        deadline,
        env.SCORE.fetch.bind(env.SCORE),
      ),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      throw new Failure(401, "invalid_token");
    throw new Failure(503, "auth_unavailable");
  }
  // Fail closed for legacy whoami responses and scan-only tokens. Check on
  // every request before consulting repository permission caches.
  if (!Array.isArray(body.scopes) || !body.scopes.includes("bot"))
    throw new Failure(403, "token_scope_required");
  return positive(body.github_id);
}

// Per GitHub account. Polling a cleanup every 2 seconds stays well inside.
const PER_MINUTE = 60;
const PER_HOUR = 600;
async function limit(env: Env, userId: number) {
  const now = Date.now();
  for (const [size, max] of [
    [60_000, PER_MINUTE],
    [3600_000, PER_HOUR],
  ]) {
    const slot = now - (now % size);
    const row = await env.DB.prepare(
      "INSERT INTO api_rate(key,slot,count) VALUES(?,?,1) ON CONFLICT(key,slot) DO UPDATE SET count=count+1 RETURNING count",
    )
      .bind(`${size}:${userId}`, slot)
      .first<{ count: number }>();
    if ((row?.count ?? 0) > max)
      throw new Failure(429, "rate_limited", Math.ceil((slot + size - now) / 1000));
  }
}

interface Context {
  installation: number;
  repository: number;
  fullName: string;
  login: string;
  admin: boolean;
}
// Reads reuse a permission check for a minute, and a denial is remembered
// for a minute too, so polling or probing costs no GitHub quota. Every change
// re-checks live.
const AUTH_TTL = 60_000;
async function authorize(
  env: Env,
  request: Request,
  owner: string,
  name: string,
  deadline: number,
): Promise<Context> {
  const userId = await identity(env, request, deadline);
  await limit(env, userId);
  const wanted = repositoryName(`${owner}/${name}`);
  // One answer for "not installed", "no such repository" and "no access",
  // so a token cannot probe which private repositories exist.
  if (!allowed(env, wanted)) throw new Failure(404, "not_found");
  const key = `${userId}:${wanted.toLowerCase()}`;
  const read = request.method === "GET";
  const cached = await env.DB.prepare(
    "SELECT value FROM api_auth WHERE key=? AND expires>?",
  )
    .bind(key, Date.now())
    .first<{ value: string }>();
  if (cached) {
    const value = JSON.parse(cached.value) as Context | null;
    if (!value) throw new Failure(404, "not_found");
    if (read) return value;
  }
  const remember = (value: Context | null) =>
    env.DB.prepare(
      "INSERT INTO api_auth(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires",
    )
      .bind(key, JSON.stringify(value), Date.now() + AUTH_TTL)
      .run();
  try {
    const context = await check(env, userId, wanted, deadline);
    await remember(context);
    return context;
  } catch (error) {
    if (error instanceof Failure && error.status === 404) await remember(null);
    throw error;
  }
}
async function check(
  env: Env,
  userId: number,
  wanted: string,
  deadline: number,
): Promise<Context> {
  let installation: number;
  try {
    installation = positive(
      record(await github(appJWT(env), deadline)(`/repos/${wanted}/installation`)).id,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404)
      throw new Failure(404, "not_found");
    throw error;
  }
  const api = github(
    await installationToken(env, installation, undefined, deadline),
    deadline,
  );
  const repo = record(await api(`/repos/${wanted}`));
  const repository = positive(repo.id);
  const fullName = repositoryName(repo.full_name);
  const user = record(await api(`/user/${userId}`));
  if (typeof user.login !== "string" || !/^[A-Za-z0-9-]+$/.test(user.login))
    throw new Failure(403, "forbidden");
  let permission: unknown;
  try {
    permission = record(
      await api(
        `/repos/${fullName}/collaborators/${encodeURIComponent(user.login)}/permission`,
      ),
    ).permission;
  } catch (error) {
    if (error instanceof ApiError && [403, 404].includes(error.status))
      permission = "none";
    else throw error;
  }
  // Without write access the repository is reported as missing, as on /admin.
  if (permission !== "admin" && permission !== "write")
    throw new Failure(404, "not_found");
  return {
    installation,
    repository,
    fullName,
    login: user.login,
    admin: permission === "admin",
  };
}
async function body(request: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readText(request, AbortSignal.timeout(5000), 65536);
  } catch {
    throw new Failure(413, "body_too_large");
  }
  if (!text.trim()) return {};
  try {
    return record(JSON.parse(text));
  } catch {
    throw new Failure(400, "invalid_body");
  }
}
const iso = (ms: number) => new Date(ms).toISOString();
const providerJson = (x: AIProviderMetadata) => ({
  mode: x.mode, provider: x.provider, base_url: x.baseUrl, model: x.model,
  has_key: x.hasKey, storage_available: x.storageAvailable, ready: x.ready,
  updated_at: x.updatedAt === null ? null : iso(x.updatedAt),
});
const jobJson = (x: Job) => ({
  id: x.id,
  kind: x.kind,
  number: x.pr,
  state: x.state,
  result: x.result,
  attempts: x.attempts,
  updated_at: iso(x.updated),
});

async function status(env: Env, c: Context) {
  const aiEnv = await resolveAIEnv(env, c.repository, c.fullName);
  const [settings, last, recent, failed, cleanup, log] = await Promise.all([
    getSettings(env, c.repository, c.fullName),
    lastBackfill(env, c.repository),
    env.DB.prepare(
      "SELECT * FROM jobs WHERE repository=? ORDER BY updated DESC LIMIT 20",
    )
      .bind(c.repository)
      .all<Job>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE repository=? AND state='failed'",
    )
      .bind(c.repository)
      .first<{ n: number }>(),
    latestCleanup(env, c.repository),
    recentAudit(env, c.repository),
  ]);
  return {
    repository: {
      id: c.repository,
      full_name: c.fullName,
      installation: c.installation,
    },
    viewer: { login: c.login, admin: c.admin },
    bot_enabled: env.ENABLED === "true",
    llm_configured: llmConfigured(aiEnv),
    triage_configured: triageConfigured(aiEnv),
    settings: settingsJson(settings),
    backfill: last
      ? { state: last.state, result: last.result, updated_at: iso(last.updated) }
      : null,
    jobs: { failed: failed?.n ?? 0, recent: recent.results.map(jobJson) },
    cleanup: cleanup ? cleanupJson(cleanup) : null,
    audit: log,
  };
}

async function route(
  env: Env,
  request: Request,
  c: Context,
  rest: string,
): Promise<Response> {
  const method = request.method;
  if (rest === "" && method === "GET") return json(await status(env, c));
  if (rest === "/settings" && method === "GET")
    return json({ settings: settingsJson(await getSettings(env, c.repository, c.fullName)) });
  if (rest === "/ai-provider" && method === "GET")
    return json({ ai_provider: providerJson(await getAIProvider(env, c.repository, c.fullName)) });
  const cleanupMatch = /^\/cleanups\/([0-9a-f-]{36})(\/confirm|\/cancel)?$/.exec(rest);
  if (cleanupMatch && method === "GET") {
    const cleanup = await getCleanup(env, c.repository, cleanupMatch[1]);
    if (!cleanup) throw new Failure(404, "not_found");
    return json({
      cleanup: cleanupJson(cleanup),
      items: await cleanupItems(env, cleanup.id),
    });
  }
  if (method !== "POST" && method !== "PATCH" && !(method === "DELETE" && rest === "/ai-provider/key"))
    throw new Failure(405, "method_not_allowed");
  if (!c.admin) throw new Failure(403, "admin_required");
  const input = await body(request);
  const log = (action: string, detail?: Record<string, unknown>) =>
    audit(env, c.repository, c.login, "api", action, detail);

  if (rest === "/ai-provider" && method === "PATCH") {
    const config = await putAIProvider(env, c.repository, c.fullName, input, { login: c.login, via: "api" });
    return json({ ai_provider: providerJson(config) });
  }
  if ((rest === "/ai-provider/key" && method === "DELETE") || (rest === "/ai-provider/test" && method === "POST")) {
    if (Object.keys(input).length) throw new Failure(400, "invalid_body");
    if (method === "DELETE")
      return json({ ai_provider: providerJson(await removeAIProviderKey(env, c.repository, c.fullName, { login: c.login, via: "api" })) });
    const result = await testAIProvider(env, c.repository, c.fullName);
    await log("ai_provider.test", result);
    return json({ connected: true, ...result });
  }

  if (rest === "/settings" && method === "PATCH") {
    const current = await getSettings(env, c.repository, c.fullName);
    let next;
    try {
      next = mergeSettingsJson(current, input);
    } catch {
      throw new Failure(400, "invalid_settings");
    }
    if (input.allowed_labels !== undefined && next.allowedLabels.length) {
      const gh = github(
        await installationToken(env, c.installation, undefined, Date.now() + 15_000),
        Date.now() + 15_000,
      );
      const existing = new Set((await repoLabels(gh, c.fullName)).map(label => label.name));
      if (next.allowedLabels.some(label => !existing.has(label)))
        throw new Failure(400, "invalid_settings");
    }
    await putSettings(env, c.installation, c.repository, c.fullName, next, c.login);
    await log("settings.update", { changed: Object.keys(input) });
    return json({ settings: settingsJson(await getSettings(env, c.repository, c.fullName)) });
  }
  if ((rest === "/pause" || rest === "/resume") && method === "POST") {
    const on = rest === "/resume";
    const current = await getSettings(env, c.repository, c.fullName);
    await putSettings(
      env,
      c.installation,
      c.repository,
      c.fullName,
      { ...current, issuesEnabled: on, prsEnabled: on },
      c.login,
    );
    // Queued work for the repository stops too; execution rechecks the toggles.
    let cancelled = 0;
    if (!on)
      cancelled =
        (
          await env.DB.prepare(
            "UPDATE jobs SET state='cancelled',lease=0,result='Paused by an admin',updated=? WHERE repository=? AND state='pending'",
          )
            .bind(Date.now(), c.repository)
            .run()
        ).meta.changes ?? 0;
    await log(on ? "resume" : "pause", on ? {} : { cancelled });
    return json({
      settings: settingsJson(await getSettings(env, c.repository, c.fullName)),
      ...(on ? {} : { cancelled_jobs: cancelled }),
    });
  }
  if (rest === "/backfill" && method === "POST") {
    const limit = input.limit ?? 25;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      Object.keys(input).some((x) => x !== "limit")
    )
      throw new Failure(400, "invalid_limit");
    const last = await lastBackfill(env, c.repository);
    if (last && (last.state === "pending" || last.state === "running"))
      throw new Failure(409, "backfill_busy");
    await putBackfillLimit(env, c.installation, c.repository, c.fullName, limit, c.login);
    if (!(await putBackfill(env, c.installation, c.repository, c.fullName)))
      throw new Failure(409, "backfill_busy");
    await log("backfill", { limit });
    await dispatch(env);
    return json({ queued: true, limit }, 202);
  }
  if (rest === "/retry" && method === "POST") {
    const id = input.job_id;
    if (
      (id !== undefined && (typeof id !== "string" || id.length > 200)) ||
      Object.keys(input).some((x) => x !== "job_id")
    )
      throw new Failure(400, "invalid_body");
    const { results } = await env.DB.prepare(
      `SELECT * FROM jobs WHERE repository=? AND state='failed'${id ? " AND id=?" : ""} ORDER BY updated DESC LIMIT 100`,
    )
      .bind(...(id ? [c.repository, id] : [c.repository]))
      .all<Job>();
    if (id && !results.length) throw new Failure(404, "not_found");
    let retried = 0;
    for (const job of results)
      if (await retryJob(env, job, c.installation, c.fullName)) retried++;
    await log("retry", { retried, ...(id ? { job_id: id } : {}) });
    await dispatch(env);
    return json({ retried }, 202);
  }
  if (rest === "/cleanups" && method === "POST") {
    let scope;
    try {
      scope = parseScope(input);
    } catch {
      throw new Failure(400, "invalid_cleanup");
    }
    const settings = await getSettings(env, c.repository, c.fullName);
    const created = await createCleanup(
      env,
      c.installation,
      c.repository,
      c.fullName,
      scope,
      c.login,
      settings.issuesEnabled || settings.prsEnabled,
    );
    if (!created) throw new Failure(409, "cleanup_busy");
    await log("cleanup.plan", { id: created.cleanup.id, scope: input });
    await env.JOBS.send({ cleanup: created.cleanup.id });
    return json(
      { cleanup: cleanupJson(created.cleanup), confirm_token: created.token },
      202,
    );
  }
  if (cleanupMatch?.[2] === "/confirm" && method === "POST") {
    if (typeof input.token !== "string") throw new Failure(400, "invalid_body");
    if (!input.token.startsWith(`${cleanupMatch[1]}.`))
      throw new Failure(400, "invalid_confirm_token");
    const result = await confirmCleanup(env, c.repository, { token: input.token }, c.login);
    if (result !== "ok")
      throw new Failure(
        result === "not_ready" ? 409 : 400,
        result === "not_ready"
          ? "cleanup_still_planning"
          : result === "expired"
            ? "confirm_token_expired"
            : "invalid_confirm_token",
      );
    await log("cleanup.confirm", { id: cleanupMatch[1] });
    await env.JOBS.send({ cleanup: cleanupMatch[1] });
    return json(
      { cleanup: cleanupJson((await getCleanup(env, c.repository, cleanupMatch[1]))!) },
      202,
    );
  }
  if (cleanupMatch?.[2] === "/cancel" && method === "POST") {
    if (!(await cancelCleanup(env, c.repository, cleanupMatch[1])))
      throw new Failure(409, "cleanup_not_active");
    await log("cleanup.cancel", { id: cleanupMatch[1] });
    return json({
      cleanup: cleanupJson((await getCleanup(env, c.repository, cleanupMatch[1]))!),
    });
  }
  throw new Failure(404, "not_found");
}

export async function api(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const deadline = Date.now() + 25_000;
  try {
    if (path === "/api/v1/whoami" && request.method === "GET") {
      const id = await identity(env, request, deadline);
      return json({ github_id: id });
    }
    const match =
      /^\/api\/v1\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/[a-z0-9/-]*)?$/.exec(
        path,
      );
    if (!match) throw new Failure(404, "not_found");
    const c = await authorize(env, request, match[1], match[2], deadline);
    return await route(env, request, c, (match[3] ?? "").replace(/\/$/, ""));
  } catch (error) {
    if (error instanceof AIProviderError) {
      const response = json({ error: error.code }, error.status);
      if (error.code === "rate_limited") response.headers.set("Retry-After", "60");
      return response;
    }
    if (error instanceof Failure) {
      const response = json({ error: error.code }, error.status);
      if (error.retryAfter)
        response.headers.set("Retry-After", String(error.retryAfter));
      return response;
    }
    if (error instanceof ApiError && error.status === 404)
      return json({ error: "not_found" }, 404);
    if (error instanceof ApiError && error.quota)
      return json({ error: "github_rate_limited" }, 503);
    if (error instanceof Error && /^Invalid (repository|identifier)/.test(error.message))
      return json({ error: "not_found" }, 404);
    return json({ error: "temporarily_unavailable" }, 503);
  }
}
