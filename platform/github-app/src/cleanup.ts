import { ApiError, github, installationToken, positive, record } from "./github";
import { COMMENT_MARKER, labels, LABELS } from "./review";

// Removes only what the bot wrote: review: labels, intent labels recorded in
// triage_labels, and its own marked comments. A dry run (planning) lists the
// items; nothing is written to GitHub until the plan is confirmed.
export type LabelScope = "none" | "review" | "triage" | "all";
export interface CleanupScope {
  labels: LabelScope;
  comments: boolean;
  // Deletes the five review: label definitions, which also removes them from
  // every issue in one call each. Intent label definitions are never deleted.
  definitions: boolean;
}
export interface Cleanup {
  id: string;
  installation: number;
  repository: number;
  full_name: string;
  scope: string;
  state: string;
  code_hash: string;
  expires: number;
  cursor: string;
  summary: string;
  total: number;
  done: number;
  skipped: number;
  lease: number;
  attempts: number;
  requested_by: string;
  confirmed_by: string | null;
  result: string | null;
  created: number;
  updated: number;
}
interface Item {
  seq: number;
  kind: "issue_label" | "comment" | "label";
  number: number | null;
  name: string | null;
  comment: number | null;
}
interface Cursor {
  phase?: number;
  index?: number;
  page?: number;
  seq?: number;
}
interface Summary {
  review_labels: number;
  triage_labels: number;
  comments: number;
  label_definitions: number;
  truncated: boolean;
  bot_active?: boolean;
}

export const CONFIRM_MS = 10 * 60_000;
const MAX_ITEMS = 5000;
// Repository comments are scanned newest first; older bot comments are left
// for a later cleanup once these are gone.
const MAX_COMMENT_PAGES = 50;
// GitHub calls per queue execution, well inside the eight-minute budget.
const STEP_CALLS = 40;
const MAX_EVENT_PAGES = 5;
// Every label needs up to five attribution reads and one removal. Keep the
// execution step inside the same GitHub-call budget, including mixed scopes.
const STEP_ITEMS = Math.floor(STEP_CALLS / (MAX_EVENT_PAGES + 1));
const ACTIVE = `state IN ('planning','running') OR (state='planned' AND expires>?)`;

function invalid(): never {
  throw new Error("Invalid cleanup");
}
export function parseScope(body: Record<string, unknown>): CleanupScope {
  for (const key of Object.keys(body))
    if (!["labels", "comments", "delete_label_definitions"].includes(key))
      invalid();
  const labels = body.labels ?? "none";
  if (
    typeof labels !== "string" ||
    !["none", "review", "triage", "all"].includes(labels)
  )
    invalid();
  const comments = body.comments ?? false;
  const definitions = body.delete_label_definitions ?? false;
  if (typeof comments !== "boolean" || typeof definitions !== "boolean")
    invalid();
  if (labels === "none" && !comments && !definitions) invalid();
  return { labels: labels as LabelScope, comments, definitions };
}
export function parseScopeForm(form: URLSearchParams): CleanupScope {
  const on = (name: string) => {
    const values = form.getAll(name);
    if (values.length > 1 || (values.length && values[0] !== "on")) invalid();
    return values.length === 1;
  };
  const review = on("review_labels"),
    intent = on("triage_labels");
  return parseScope({
    labels: review && intent ? "all" : review ? "review" : intent ? "triage" : "none",
    comments: on("comments"),
    delete_label_definitions: on("delete_label_definitions"),
  });
}
async function hash(text: string) {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  ).toString("hex");
}
const scopeOf = (c: Cleanup) => JSON.parse(c.scope) as CleanupScope;
const summaryOf = (c: Cleanup) => JSON.parse(c.summary) as Summary;

// One active cleanup per repository; one statement, so concurrent requests
// cannot both pass. Returns null when another is active. The confirm token is
// returned once and only its hash is stored.
export async function createCleanup(
  env: Env,
  installation: number,
  repository: number,
  fullName: string,
  scope: CleanupScope,
  actor: string,
  botActive: boolean,
): Promise<{ cleanup: Cleanup; token: string } | null> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString(
    "base64url",
  );
  const summary: Summary = {
    review_labels: 0,
    triage_labels: 0,
    comments: 0,
    label_definitions: 0,
    truncated: false,
    bot_active: botActive,
  };
  const cleanup = await env.DB.prepare(
    `INSERT INTO cleanups(id,installation,repository,full_name,scope,state,code_hash,summary,requested_by,created,updated)
     SELECT ?,?,?,?,?,'planning',?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM cleanups WHERE repository=? AND (${ACTIVE})) RETURNING *`,
  )
    .bind(
      id,
      installation,
      repository,
      fullName,
      JSON.stringify(scope),
      await hash(secret),
      JSON.stringify(summary),
      actor,
      now,
      now,
      repository,
      now,
    )
    .first<Cleanup>();
  return cleanup ? { cleanup, token: `${id}.${secret}` } : null;
}
export async function getCleanup(env: Env, repository: number, id: string) {
  return env.DB.prepare("SELECT * FROM cleanups WHERE id=? AND repository=?")
    .bind(id, repository)
    .first<Cleanup>();
}
export async function latestCleanup(env: Env, repository: number) {
  return env.DB.prepare(
    "SELECT * FROM cleanups WHERE repository=? ORDER BY created DESC LIMIT 1",
  )
    .bind(repository)
    .first<Cleanup>();
}
// The API confirms with the token from the dry run. The web form, which has
// no token, may confirm only the signed-in user's own plan.
export async function confirmCleanup(
  env: Env,
  repository: number,
  input: { token: string } | { id: string; requester: string },
  actor: string,
): Promise<"ok" | "invalid" | "expired" | "not_ready"> {
  let id: string, check: string, value: string;
  if ("token" in input) {
    const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{24})$/.exec(input.token);
    if (!match) return "invalid";
    id = match[1];
    check = "code_hash=?";
    value = await hash(match[2]);
  } else {
    id = input.id;
    check = "requested_by=?";
    value = input.requester;
  }
  const now = Date.now();
  const row = await env.DB.prepare(
    `UPDATE cleanups SET state='running',confirmed_by=?,lease=0,attempts=0,updated=?
     WHERE id=? AND repository=? AND state='planned' AND expires>? AND ${check} RETURNING id`,
  )
    .bind(actor, now, id, repository, now, value)
    .first();
  if (row) return "ok";
  const current = await getCleanup(env, repository, id);
  if (!current) return "invalid";
  if (current.state === "planning") return "not_ready";
  if (
    current.state === "expired" ||
    (current.state === "planned" && current.expires <= now)
  )
    return "expired";
  return "invalid";
}
export async function cancelCleanup(env: Env, repository: number, id: string) {
  const row = await env.DB.prepare(
    `UPDATE cleanups SET state='cancelled',lease=0,result='Cancelled',updated=?
     WHERE id=? AND repository=? AND state IN ('planning','planned','running') RETURNING id`,
  )
    .bind(Date.now(), id, repository)
    .first();
  return row !== null;
}
export async function cleanupItems(env: Env, id: string, limit = 50) {
  const { results } = await env.DB.prepare(
    "SELECT kind,number,name,comment,state FROM cleanup_items WHERE cleanup=? ORDER BY seq LIMIT ?",
  )
    .bind(id, limit)
    .all<Omit<Item, "seq"> & { state: string }>();
  return results;
}
const iso = (ms: number) => new Date(ms).toISOString();
export function cleanupJson(c: Cleanup) {
  const scope = scopeOf(c);
  return {
    id: c.id,
    state:
      c.state === "planned" && c.expires <= Date.now() ? "expired" : c.state,
    scope: {
      labels: scope.labels,
      comments: scope.comments,
      delete_label_definitions: scope.definitions,
    },
    summary: summaryOf(c),
    total: c.total,
    done: c.done,
    skipped: c.skipped,
    confirm_before: c.state === "planned" ? iso(c.expires) : null,
    requested_by: c.requested_by,
    confirmed_by: c.confirmed_by,
    result: c.result,
    created_at: iso(c.created),
    updated_at: iso(c.updated),
  };
}

export async function dispatchCleanups(env: Env) {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE cleanups SET state='expired',updated=? WHERE state='planned' AND expires<=?",
  )
    .bind(now, now)
    .run();
  const { results } = await env.DB.prepare(
    "SELECT id FROM cleanups WHERE state IN ('planning','running') AND lease<? ORDER BY updated LIMIT 20",
  )
    .bind(now)
    .all<{ id: string }>();
  if (results.length)
    await env.JOBS.sendBatch(results.map((x) => ({ body: { cleanup: x.id } })));
  await env.DB.prepare("DELETE FROM api_rate WHERE slot<?")
    .bind(now - 2 * 3600_000)
    .run();
  await env.DB.prepare("DELETE FROM api_auth WHERE expires<?").bind(now).run();
  const old = now - 30 * 86400_000;
  await env.DB.prepare(
    "DELETE FROM cleanup_items WHERE cleanup IN (SELECT id FROM cleanups WHERE state IN ('done','failed','cancelled','expired') AND updated<?)",
  )
    .bind(old)
    .run();
  await env.DB.prepare(
    "DELETE FROM cleanups WHERE state IN ('done','failed','cancelled','expired') AND updated<?",
  )
    .bind(old)
    .run();
}

type Api = ReturnType<typeof github>;
const PHASES = ["review", "triage", "comments", "definitions"] as const;

// Returns true while more planning steps remain.
async function plan(env: Env, c: Cleanup, api: Api): Promise<boolean> {
  const scope = scopeOf(c);
  const summary = summaryOf(c);
  const cursor = JSON.parse(c.cursor) as Cursor;
  let phase = cursor.phase ?? 0,
    index = cursor.index ?? 0,
    page = cursor.page ?? 1,
    seq = cursor.seq ?? 0,
    calls = 0;
  const items: Item[] = [];
  const add = (item: Omit<Item, "seq">) => {
    if (seq >= MAX_ITEMS) {
      summary.truncated = true;
      return false;
    }
    items.push({ ...item, seq: seq++ });
    return true;
  };
  const save = async (done: boolean) => {
    const now = Date.now();
    const statements = items.map((x) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO cleanup_items(cleanup,seq,kind,number,name,comment) VALUES(?,?,?,?,?,?)",
      ).bind(c.id, x.seq, x.kind, x.number, x.name, x.comment),
    );
    statements.push(
      done
        ? env.DB.prepare(
            `UPDATE cleanups SET state=?,expires=?,total=?,summary=?,cursor='{}',lease=0,attempts=0,result=?,updated=? WHERE id=? AND state='planning'`,
          ).bind(
            seq ? "planned" : "done",
            seq ? now + CONFIRM_MS : 0,
            seq,
            JSON.stringify(summary),
            seq ? null : "Nothing to clean up",
            now,
            c.id,
          )
        : env.DB.prepare(
            "UPDATE cleanups SET cursor=?,summary=?,attempts=0,updated=? WHERE id=? AND state='planning'",
          ).bind(
            JSON.stringify({ phase, index, page, seq }),
            JSON.stringify(summary),
            now,
            c.id,
          ),
    );
    // Batches are atomic, so a retried step never duplicates items.
    for (let at = 0; at < statements.length; at += 50)
      await env.DB.batch(statements.slice(at, at + 50));
  };
  const next = () => {
    phase++;
    index = 0;
    page = 1;
  };
  // The item cap ends planning; the comment page cap only ends that phase,
  // so label definitions are still planned after a long comment scan.
  while (phase < PHASES.length && seq < MAX_ITEMS) {
    if (calls >= STEP_CALLS) {
      await save(false);
      return true;
    }
    const name = PHASES[phase];
    if (name === "review") {
      if (scope.labels !== "review" && scope.labels !== "all") {
        next();
        continue;
      }
      if (index >= LABELS.length) {
        next();
        continue;
      }
      const list = await api(
        `/repos/${c.full_name}/issues?state=all&labels=${encodeURIComponent(LABELS[index])}&per_page=100&page=${page}`,
      );
      calls++;
      if (!Array.isArray(list)) throw new Error("Invalid issue list");
      for (const value of list) {
        summary.review_labels++;
        add({
          kind: "issue_label",
          number: positive(record(value).number),
          name: LABELS[index],
          comment: null,
        });
      }
      if (list.length < 100) {
        index++;
        page = 1;
      } else page++;
    } else if (name === "triage") {
      if (scope.labels === "triage" || scope.labels === "all") {
        const { results } = await env.DB.prepare(
          "SELECT number,label FROM triage_labels WHERE repository=? ORDER BY number,label LIMIT ?",
        )
          .bind(c.repository, MAX_ITEMS + 1)
          .all<{ number: number; label: string }>();
        for (const row of results) {
          if (!add({ kind: "issue_label", number: row.number, name: row.label, comment: null }))
            break;
          summary.triage_labels++;
        }
      }
      next();
    } else if (name === "comments") {
      if (!scope.comments || page > MAX_COMMENT_PAGES) {
        if (scope.comments && page > MAX_COMMENT_PAGES) summary.truncated = true;
        next();
        continue;
      }
      const list = await api(
        `/repos/${c.full_name}/issues/comments?sort=created&direction=desc&per_page=100&page=${page}`,
      );
      calls++;
      if (!Array.isArray(list)) throw new Error("Invalid comment list");
      for (const value of list) {
        const comment = record(value);
        const user = record(comment.user);
        // Same ownership check as syncComment: quoted or spoofed markers in
        // user comments are never touched.
        if (
          user.type === "Bot" &&
          user.login === `${env.APP_SLUG}[bot]` &&
          typeof comment.body === "string" &&
          comment.body.startsWith(COMMENT_MARKER)
        ) {
          const issue =
            typeof comment.issue_url === "string"
              ? Number(/\/issues\/(\d+)$/.exec(comment.issue_url)?.[1])
              : NaN;
          if (
            !add({
              kind: "comment",
              number: Number.isSafeInteger(issue) && issue > 0 ? issue : null,
              name: null,
              comment: positive(comment.id),
            })
          )
            break;
          summary.comments++;
        }
      }
      if (list.length < 100 || seq >= MAX_ITEMS) next();
      else page++;
    } else {
      if (scope.definitions) {
        const existing = await labels(api, `/repos/${c.full_name}/labels`);
        calls++;
        for (const label of LABELS)
          if (existing.has(label)) {
            if (!add({ kind: "label", number: null, name: label, comment: null }))
              break;
            summary.label_definitions++;
          }
      }
      next();
    }
  }
  await save(true);
  return false;
}

async function remove(api: Api, path: string): Promise<boolean> {
  try {
    await api(path, "DELETE");
    return true;
  } catch (error) {
    // Already gone (removed by a person, or by an earlier attempt).
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

// A ledger entry or a label's presence cannot prove its current owner: a
// person may have removed and reapplied it after the bot's write. Read the
// complete bounded event history immediately before deletion and require its
// latest exact-name label event to identify this bot. Unresolved history is
// skipped, including histories larger than the cap and failed reads.
async function botOwnsLabel(env: Env, api: Api, path: string, name: string): Promise<boolean> {
  let latest: Record<string, unknown> | null = null;
  let latestTime = -1;
  let latestId = -1;
  try {
    for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
      const events = await api(`${path}/events?per_page=100&page=${page}`);
      if (!Array.isArray(events)) return false;
      for (const value of events) {
        const event = record(value);
        if (event.event !== "labeled" && event.event !== "unlabeled") continue;
        if (record(event.label).name !== name) continue;
        const time = typeof event.created_at === "string" ? Date.parse(event.created_at) : NaN;
        const id = event.id;
        if (!Number.isFinite(time) || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
          return false;
        if (time > latestTime || (time === latestTime && id > latestId)) {
          latest = event;
          latestTime = time;
          latestId = id;
        }
      }
      if (events.length < 100) {
        if (!latest || latest.event !== "labeled") return false;
        const actor = record(latest.actor);
        if (actor.type !== "Bot" || actor.login !== `${env.APP_SLUG}[bot]`) return false;
        // A provided App attribution must agree with the actor identity.
        const app = latest.performed_via_github_app;
        return app == null || record(app).slug === env.APP_SLUG;
      }
    }
  } catch (error) {
    if (error instanceof ApiError && error.quota) throw error;
  }
  return false;
}

async function unusedDefinition(api: Api, repo: string, name: string): Promise<boolean> {
  try {
    const items = await api(`${repo}/issues?state=all&labels=${encodeURIComponent(name)}&per_page=1`);
    return Array.isArray(items) && items.length === 0;
  } catch (error) {
    if (error instanceof ApiError && error.quota) throw error;
    return false;
  }
}
// Returns true while more items remain.
async function execute(env: Env, c: Cleanup, api: Api): Promise<boolean> {
  const { results } = await env.DB.prepare(
    "SELECT seq,kind,number,name,comment FROM cleanup_items WHERE cleanup=? AND state='pending' ORDER BY seq LIMIT ?",
  )
    .bind(c.id, STEP_ITEMS)
    .all<Item>();
  for (const item of results) {
    const repo = `/repos/${c.full_name}`;
    // A dot segment would resolve to the parent path; never send one.
    const unsafe = item.name === "." || item.name === "..";
    const removed = unsafe
      ? false
      : item.kind === "comment"
        ? await remove(api, `${repo}/issues/comments/${item.comment}`)
        : item.kind === "label"
          ? (await unusedDefinition(api, repo, item.name!)) && await remove(api, `${repo}/labels/${encodeURIComponent(item.name!)}`)
          : (await botOwnsLabel(env, api, `${repo}/issues/${item.number}`, item.name!)) && await remove(
              api,
              `${repo}/issues/${item.number}/labels/${encodeURIComponent(item.name!)}`,
            );
    const statements = [
      env.DB.prepare(
        "UPDATE cleanup_items SET state=? WHERE cleanup=? AND seq=?",
      ).bind(removed ? "done" : "skipped", c.id, item.seq),
      env.DB.prepare(
        `UPDATE cleanups SET ${removed ? "done=done+1" : "skipped=skipped+1"},attempts=0,updated=? WHERE id=?`,
      ).bind(Date.now(), c.id),
    ];
    if (item.kind === "issue_label" && !item.name!.startsWith("review:"))
      statements.push(
        env.DB.prepare(
          "DELETE FROM triage_labels WHERE repository=? AND number=? AND label=?",
        ).bind(c.repository, item.number, item.name),
      );
    await env.DB.batch(statements);
    // A cancel takes effect between items.
    const state = await env.DB.prepare("SELECT state FROM cleanups WHERE id=?")
      .bind(c.id)
      .first<{ state: string }>();
    if (state?.state !== "running") return false;
  }
  if (results.length === STEP_ITEMS) return true;
  await env.DB.prepare(
    `UPDATE cleanups SET state='done',lease=0,result='Removed '||done||', skipped '||skipped,updated=? WHERE id=? AND state='running'`,
  )
    .bind(Date.now(), c.id)
    .run();
  return false;
}

export async function runCleanup(env: Env, id: string) {
  const now = Date.now();
  const c = await env.DB.prepare(
    `UPDATE cleanups SET lease=?,updated=? WHERE id=? AND state IN ('planning','running') AND lease<? RETURNING *`,
  )
    .bind(now + 10 * 60_000, now, id, now)
    .first<Cleanup>();
  if (!c) return;
  const deadline = now + 8 * 60_000;
  try {
    const api = github(
      await installationToken(env, c.installation, c.repository, deadline),
      deadline,
    );
    const more =
      c.state === "planning" ? await plan(env, c, api) : await execute(env, c, api);
    if (more) {
      await env.DB.prepare("UPDATE cleanups SET lease=0 WHERE id=?").bind(id).run();
      // With the lease released, cron picks the next step up if this send fails.
      await env.JOBS.send({ cleanup: id }).catch(() => {});
    }
  } catch (error) {
    const api = error instanceof ApiError ? error : null;
    // Quota waits never fail a cleanup. Transient GitHub, D1 or queue errors
    // get bounded retries; a non-retryable GitHub answer fails it at once.
    const retry = api?.quota || (c.attempts < 10 && (!api || api.retry));
    if (retry) {
      const delay = Math.min(
        Math.max(api?.delay ?? 0, api?.quota ? 60_000 : 5000 * 2 ** c.attempts),
        65 * 60_000,
      );
      await env.DB.prepare(
        "UPDATE cleanups SET lease=?,attempts=attempts+1,result=?,updated=? WHERE id=? AND state IN ('planning','running')",
      )
        .bind(
          Date.now() + delay,
          api?.quota
            ? "Waiting for the GitHub App hourly quota to reset"
            : error instanceof Error
              ? error.message
              : "Retrying",
          Date.now(),
          id,
        )
        .run();
      return;
    }
    // Do not include tokens, payloads or response bodies.
    await env.DB.prepare(
      "UPDATE cleanups SET state='failed',lease=0,result=?,updated=? WHERE id=? AND state IN ('planning','running')",
    )
      .bind(
        error instanceof ApiError && [401, 403, 404, 422].includes(error.status)
          ? `GitHub access/configuration error (${error.status}); check installation permissions`
          : error instanceof Error
            ? error.message
            : "Cleanup failed",
        Date.now(),
        id,
      )
      .run();
  }
}
