import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api as handle } from "../src/api";
import { runCleanup } from "../src/cleanup";
import { COMMENT_MARKER, LABELS } from "../src/review";
import { getSettings } from "../src/settings";
import { resolveAIEnv } from "../src/byok";

declare const TEST_SQL: string[];
const testEnv = env as Env;
const gh = "https://api.github.com";
const repo = "AsperforMias/test-bot";
const base = `https://bot.example/api/v1/repos/${repo}`;
const token = `ghf_${"a".repeat(43)}`;
const sent: unknown[] = [];
let whoami: () => Response;
const e = {
  ...testEnv,
  BYOK_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  SCORE: {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://ghfind.com/api/account/whoami");
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      return whoami();
    },
  },
  JOBS: {
    send: async (body: unknown) => void sent.push(body),
    sendBatch: async (batch: { body: unknown }[]) =>
      void sent.push(...batch.map((x) => x.body)),
  },
} as unknown as Env;

const pending: { url: string; method: string; status: number; body: string }[] = [];
const intercept = (path: string, body: unknown, status = 200, method = "GET") =>
  pending.push({ url: gh + path, method, status, body: JSON.stringify(body) });
// The calls every API request makes before routing.
function authorized(permission = "admin") {
  intercept(`/repos/${repo}/installation`, { id: 10 });
  intercept("/app/installations/10/access_tokens", { token: "t" }, 201, "POST");
  intercept(`/repos/${repo}`, { id: 100, full_name: repo });
  intercept("/user/7", { login: "maintainer" });
  intercept(`/repos/${repo}/collaborators/maintainer/permission`, { permission });
}
// Each call starts with an empty permission cache so the scripted GitHub
// calls above are consumed; the cache has its own test.
const call = async (path = "", method = "GET", body?: unknown, auth = `Bearer ${token}`) => {
  await testEnv.DB.exec("DELETE FROM api_auth;");
  return cached(path, method, body, auth);
};
const cached = (path = "", method = "GET", body?: unknown, auth = `Bearer ${token}`) =>
  handle(
    new Request(base + path, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    e,
  );
const rows = (sql: string) => testEnv.DB.prepare(sql).all().then((x) => x.results);

beforeAll(async () => {
  for (const sql of TEST_SQL) await testEnv.DB.prepare(sql).run();
});
beforeEach(async () => {
  await testEnv.DB.exec(
    "DELETE FROM jobs; DELETE FROM repo_settings; DELETE FROM audit_log; DELETE FROM cleanups; DELETE FROM cleanup_items; DELETE FROM triage_labels; DELETE FROM api_auth; DELETE FROM api_rate; DELETE FROM ai_providers;",
  );
  sent.splice(0);
  whoami = () => Response.json({ github_id: 7, scopes: ["scan", "bot"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input),
        method = init?.method ?? "GET";
      const at = pending.findIndex((x) => x.url === url && x.method === method);
      if (at < 0) throw new Error(`Unexpected request: ${method} ${url}`);
      const x = pending.splice(at, 1)[0];
      return new Response(x.status === 204 ? null : x.body, { status: x.status });
    }),
  );
});
afterEach(() => {
  expect(pending.splice(0)).toEqual([]);
  vi.unstubAllGlobals();
});

describe("API auth", () => {
  it("requires explicit bot scope before GitHub calls, including cached reads", async () => {
    authorized();
    expect((await call()).status).toBe(200);
    for (const scopes of [undefined, ["scan"], "bot", []]) {
      whoami = () => Response.json({ github_id: 7, scopes });
      for (const [path, method] of [["", "GET"], ["/pause", "POST"]]) {
        const response = await cached(path, method);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "token_scope_required" });
      }
    }
    expect(sent).toEqual([]);
    expect(await rows("SELECT * FROM audit_log")).toEqual([]);
  });
  it("rejects missing, malformed and revoked tokens", async () => {
    expect((await call("", "GET", undefined, "")).status).toBe(401);
    expect((await call("", "GET", undefined, "Bearer ghp_x")).status).toBe(401);
    whoami = () => Response.json({ error: "invalid_token" }, { status: 401 });
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });
  it("reports ghfind.com outages as unavailable, not as a bad token", async () => {
    whoami = () => new Response("down", { status: 502 });
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "auth_unavailable" });
  });
  it("hides repositories the App is not installed on or the user cannot write", async () => {
    intercept(`/repos/${repo}/installation`, {}, 404);
    expect(await (await call()).json()).toEqual({ error: "not_found" });
    authorized("read");
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    const outside = await handle(
      new Request("https://bot.example/api/v1/repos/someone/else", {
        headers: { authorization: `Bearer ${token}` },
      }),
      e,
    );
    expect(await outside.json()).toEqual({ error: "not_found" });
  });
  it("lets writers read status but not change anything", async () => {
    authorized("write");
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      repository: { id: 100, full_name: repo, installation: 10 },
      viewer: { login: "maintainer", admin: false },
      settings: { issues_enabled: true, prs_enabled: true, triage_enabled: false },
      jobs: { failed: 0, recent: [] },
      cleanup: null,
    });
    authorized("write");
    const denied = await call("/pause", "POST");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "admin_required" });
    expect(await getSettings(testEnv, 100)).toMatchObject({ issuesEnabled: true });
  });
});

describe("API operations", () => {
  it("patches only the given settings and validates them", async () => {
    authorized();
    intercept("/app/installations/10/access_tokens", { token: "t" }, 201, "POST");
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, [{ name: "bug" }]);
    const res = await call("/settings", "PATCH", {
      triage_enabled: true,
      allowed_labels: ["bug", "bug"],
    });
    expect(await res.json()).toMatchObject({
      settings: { triage_enabled: true, allowed_labels: ["bug"], issues_enabled: true },
    });
    for (const bad of [
      { allowed_labels: ["review: top"] },
      { triage_enabled: "yes" },
      { unknown: true },
      { comment_prompt: "x".repeat(2001) },
    ]) {
      authorized();
      expect((await call("/settings", "PATCH", bad)).status).toBe(400);
    }
    expect(await rows("SELECT actor,via,action FROM audit_log")).toEqual([
      { actor: "maintainer", via: "api", action: "settings.update" },
    ]);
  });
  it("rejects intent labels that are absent from the repository", async () => {
    authorized();
    intercept("/app/installations/10/access_tokens", { token: "t" }, 201, "POST");
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, [{ name: "bug" }]);
    const response = await call("/settings", "PATCH", { allowed_labels: ["invented"] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_settings" });
    expect((await getSettings(testEnv, 100)).allowedLabels).toEqual([]);
    expect(await rows("SELECT * FROM audit_log")).toEqual([]);
  });
  it("pauses (cancelling queued work) and resumes", async () => {
    await testEnv.DB.prepare(
      "INSERT INTO jobs(id,installation,repository,pr,kind,created,due,updated) VALUES('q',10,100,1,'label',0,0,0),('other',10,200,1,'label',0,0,0)",
    ).run();
    authorized();
    expect(await (await call("/pause", "POST")).json()).toMatchObject({
      settings: { issues_enabled: false, prs_enabled: false },
      cancelled_jobs: 1,
    });
    expect(await rows("SELECT id,state FROM jobs ORDER BY id")).toEqual([
      { id: "other", state: "pending" },
      { id: "q", state: "cancelled" },
    ]);
    authorized();
    expect(await (await call("/resume", "POST")).json()).toMatchObject({
      settings: { issues_enabled: true, prs_enabled: true },
    });
  });
  it("queues one backfill at a time", async () => {
    authorized();
    const res = await call("/backfill", "POST", { limit: 10 });
    expect(res.status).toBe(202);
    expect((await getSettings(testEnv, 100)).backfillLimit).toBe(10);
    authorized();
    expect(await (await call("/backfill", "POST", { limit: 10 })).json()).toEqual({
      error: "backfill_busy",
    });
    authorized();
    expect((await call("/backfill", "POST", { limit: 0 })).status).toBe(400);
  });
  it("retries failed jobs of the repository only", async () => {
    await testEnv.DB.prepare(
      "INSERT INTO jobs(id,installation,repository,full_name,pr,kind,state,created,due,updated) VALUES('f1',9,100,?,1,'label','failed',0,0,0),('f2',9,200,'x/y',1,'label','failed',0,0,0)",
    )
      .bind(repo)
      .run();
    authorized();
    expect(await (await call("/retry", "POST", {})).json()).toEqual({ retried: 1 });
    expect(await rows("SELECT id,installation,repository,state FROM jobs ORDER BY id")).toEqual([
      { id: "f1", installation: 9, repository: 100, state: "cancelled" },
      { id: expect.stringMatching(/^f1~retry\d+$/), installation: 10, repository: 100, state: "pending" },
      { id: "f2", installation: 9, repository: 200, state: "failed" },
    ]);
    // The failed row is closed, so a second retry clones nothing.
    authorized();
    expect(await (await call("/retry", "POST", {})).json()).toEqual({ retried: 0 });
    authorized();
    expect((await call("/retry", "POST", { job_id: "f2" })).status).toBe(404);
  });
});

const labelEvent = (name: string, id = 1, event = "labeled", actor = { login: "ghfind-review-test[bot]", type: "Bot" }) => ({
  id, event, label: { name }, actor, created_at: new Date(Date.UTC(2026, 9, 7, 0, 0, id)).toISOString(),
});
const eventRead = (number: number, events: unknown[], page = 1, status = 200) =>
  intercept(`/repos/${repo}/issues/${number}/events?per_page=100&page=${page}`, events, status);

// Planning reads for a full cleanup on a small repository.
function planReads() {
  intercept("/app/installations/10/access_tokens", { token: "t" }, 201, "POST");
  for (const [i, name] of LABELS.entries())
    intercept(
      `/repos/${repo}/issues?state=all&labels=${encodeURIComponent(name)}&per_page=100&page=1`,
      i === 2 ? [{ number: 1 }, { number: 2 }] : [],
    );
  intercept(`/repos/${repo}/issues/comments?sort=created&direction=desc&per_page=100&page=1`, [
    {
      id: 501,
      issue_url: `${gh}/repos/${repo}/issues/1`,
      user: { login: "ghfind-review-test[bot]", type: "Bot" },
      body: `${COMMENT_MARKER}\nhello`,
    },
    // A person quoting the marker is never touched.
    {
      id: 502,
      issue_url: `${gh}/repos/${repo}/issues/1`,
      user: { login: "someone", type: "User" },
      body: `${COMMENT_MARKER}\nquoted`,
    },
  ]);
}

describe("cleanup", () => {
  it("plans, refuses a wrong token, then removes only what the bot wrote", async () => {
    await testEnv.DB.prepare(
      "INSERT INTO triage_labels(repository,number,label,created) VALUES(100,2,'bug',0),(999,2,'bug',0)",
    ).run();
    authorized();
    const created = await call("/cleanups", "POST", { labels: "all", comments: true });
    expect(created.status).toBe(202);
    const { cleanup, confirm_token } = (await created.json()) as {
      cleanup: { id: string; state: string; summary: { bot_active: boolean } };
      confirm_token: string;
    };
    expect(cleanup).toMatchObject({ state: "planning", summary: { bot_active: true } });
    expect(sent).toEqual([{ cleanup: cleanup.id }]);

    authorized();
    expect(await (await call(`/cleanups/${cleanup.id}/confirm`, "POST", { token: confirm_token })).json()).toEqual({
      error: "cleanup_still_planning",
    });

    planReads();
    await runCleanup(e, cleanup.id);
    authorized("write");
    const planned = (await (await call(`/cleanups/${cleanup.id}`)).json()) as {
      cleanup: Record<string, unknown>;
      items: unknown[];
    };
    expect(planned.cleanup).toMatchObject({
      state: "planned",
      total: 4,
      summary: { review_labels: 2, triage_labels: 1, comments: 1, label_definitions: 0, truncated: false },
    });
    expect(planned.items).toEqual([
      { kind: "issue_label", number: 1, name: LABELS[2], comment: null, state: "pending" },
      { kind: "issue_label", number: 2, name: LABELS[2], comment: null, state: "pending" },
      { kind: "issue_label", number: 2, name: "bug", comment: null, state: "pending" },
      { kind: "comment", number: 1, name: null, comment: 501, state: "pending" },
    ]);

    authorized();
    const wrong = await call(`/cleanups/${cleanup.id}/confirm`, "POST", {
      token: `${cleanup.id}.${"x".repeat(24)}`,
    });
    expect(await wrong.json()).toEqual({ error: "invalid_confirm_token" });
    authorized();
    const ok = await call(`/cleanups/${cleanup.id}/confirm`, "POST", { token: confirm_token });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ cleanup: { state: "running", confirmed_by: "maintainer" } });

    intercept("/app/installations/10/access_tokens", { token: "t" }, 201, "POST");
    eventRead(1, [labelEvent(LABELS[2])]);
    intercept(`/repos/${repo}/issues/1/labels/${encodeURIComponent(LABELS[2])}`, null, 204, "DELETE");
    eventRead(2, [labelEvent(LABELS[2]), labelEvent("bug", 2)]);
    // Removed by a person meanwhile: counted as skipped.
    intercept(`/repos/${repo}/issues/2/labels/${encodeURIComponent(LABELS[2])}`, {}, 404, "DELETE");
    eventRead(2, [labelEvent(LABELS[2]), labelEvent("bug", 2)]);
    intercept(`/repos/${repo}/issues/2/labels/bug`, null, 204, "DELETE");
    intercept(`/repos/${repo}/issues/comments/501`, null, 204, "DELETE");
    await runCleanup(e, cleanup.id);
    authorized("write");
    expect(await (await call(`/cleanups/${cleanup.id}`)).json()).toMatchObject({
      cleanup: { state: "done", done: 3, skipped: 1, result: "Removed 3, skipped 1" },
    });
    expect(await rows("SELECT repository FROM triage_labels")).toEqual([{ repository: 999 }]);
    expect((await rows("SELECT action FROM audit_log ORDER BY id")).map((x) => x.action)).toEqual([
      "cleanup.plan",
      "cleanup.confirm",
    ]);
  });
  it("plans individual labels before definitions so in-use definitions can be preserved", async () => {
    authorized();
    const { cleanup } = (await (
      await call("/cleanups", "POST", { labels: "review", delete_label_definitions: true })
    ).json()) as { cleanup: { id: string } };
    intercept("/app/installations/10/access_tokens", { token: "t" }, 201, "POST");
    for (const [i, name] of LABELS.entries())
      intercept(
        `/repos/${repo}/issues?state=all&labels=${encodeURIComponent(name)}&per_page=100&page=1`,
        i === 0 ? [{ number: 3 }] : [],
      );
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, [
      { name: LABELS[0] },
      { name: LABELS[4] },
      { name: "bug" },
    ]);
    await runCleanup(e, cleanup.id);
    expect(await rows("SELECT kind,name FROM cleanup_items ORDER BY seq")).toEqual([
      { kind: "issue_label", name: LABELS[0] },
      { kind: "label", name: LABELS[0] },
      { kind: "label", name: LABELS[4] },
    ]);
    expect(await rows("SELECT summary FROM cleanups")).toEqual([
      { summary: expect.stringContaining('"review_labels":1') },
    ]);
  });
  it("finishes at once when there is nothing to remove", async () => {
    authorized();
    const { cleanup } = (await (await call("/cleanups", "POST", { labels: "triage" })).json()) as {
      cleanup: { id: string };
    };
    intercept("/app/installations/10/access_tokens", { token: "t" }, 201, "POST");
    await runCleanup(e, cleanup.id);
    expect(await rows("SELECT state,result FROM cleanups")).toEqual([
      { state: "done", result: "Nothing to clean up" },
    ]);
  });
  it("allows one active cleanup, rejects empty scopes, expires and cancels", async () => {
    authorized();
    expect((await call("/cleanups", "POST", { labels: "none" })).status).toBe(400);
    authorized();
    const { cleanup, confirm_token } = (await (
      await call("/cleanups", "POST", { comments: true })
    ).json()) as { cleanup: { id: string }; confirm_token: string };
    authorized();
    expect(await (await call("/cleanups", "POST", { comments: true })).json()).toEqual({
      error: "cleanup_busy",
    });
    await testEnv.DB.prepare(
      "UPDATE cleanups SET state='planned',expires=?,total=1",
    )
      .bind(Date.now() - 1)
      .run();
    authorized();
    expect(await (await call(`/cleanups/${cleanup.id}/confirm`, "POST", { token: confirm_token })).json()).toEqual({
      error: "confirm_token_expired",
    });
    // An expired preview no longer blocks a new one.
    authorized();
    const next = (await (await call("/cleanups", "POST", { comments: true })).json()) as {
      cleanup: { id: string };
    };
    authorized();
    expect(await (await call(`/cleanups/${next.cleanup.id}/cancel`, "POST")).json()).toMatchObject({
      cleanup: { state: "cancelled" },
    });
    authorized();
    expect((await call(`/cleanups/${next.cleanup.id}/cancel`, "POST")).status).toBe(409);
  });
  it("waits for the GitHub quota instead of failing", async () => {
    authorized();
    const { cleanup } = (await (await call("/cleanups", "POST", { comments: true })).json()) as {
      cleanup: { id: string };
    };
    intercept("/app/installations/10/access_tokens", { token: "t" }, 201, "POST");
    pending.push({
      url: `${gh}/repos/${repo}/issues/comments?sort=created&direction=desc&per_page=100&page=1`,
      method: "GET",
      status: 429,
      body: "{}",
    });
    await runCleanup(e, cleanup.id);
    const [row] = (await rows("SELECT state,lease,result FROM cleanups")) as {
      state: string;
      lease: number;
      result: string;
    }[];
    expect(row.state).toBe("planning");
    expect(row.lease).toBeGreaterThan(Date.now() + 50_000);
    expect(row.result).toMatch(/quota/);
  });
});

describe("API limits", () => {
  it("reuses a read permission check for a minute but re-checks every change", async () => {
    authorized("write");
    expect((await call()).status).toBe(200);
    // No GitHub calls scripted: served from the cache.
    expect((await cached()).status).toBe(200);
    expect((await cached("/settings")).status).toBe(200);
    authorized("write");
    expect((await cached("/pause", "POST")).status).toBe(403);
  });
  it("remembers a denial, so probing costs no GitHub quota", async () => {
    intercept(`/repos/${repo}/installation`, {}, 404);
    expect((await call()).status).toBe(404);
    expect(await (await cached()).json()).toEqual({ error: "not_found" });
    expect(await (await cached("/pause", "POST")).json()).toEqual({ error: "not_found" });
  });
  it("rate-limits each GitHub account", async () => {
    const slot = Date.now() - (Date.now() % 60_000);
    await testEnv.DB.prepare("INSERT INTO api_rate(key,slot,count) VALUES(?,?,60)")
      .bind("60000:7", slot)
      .run();
    const res = await call();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("plans label definitions even after the comment scan hits its page cap", async () => {
    authorized();
    const { cleanup } = (await (
      await call("/cleanups", "POST", { comments: true, delete_label_definitions: true })
    ).json()) as { cleanup: { id: string } };
    // Resume planning at the comment page cap.
    await testEnv.DB.prepare("UPDATE cleanups SET cursor=? WHERE id=?")
      .bind(JSON.stringify({ phase: 2, index: 0, page: 51, seq: 0 }), cleanup.id)
      .run();
    intercept("/app/installations/10/access_tokens", { token: "t" }, 201, "POST");
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, [{ name: LABELS[1] }]);
    await runCleanup(e, cleanup.id);
    expect(await rows("SELECT state,total FROM cleanups")).toEqual([{ state: "planned", total: 1 }]);
    expect(await rows("SELECT summary FROM cleanups")).toEqual([
      { summary: expect.stringContaining('"truncated":true') },
    ]);
  });
  it("survives a failed queue send between steps", async () => {
    authorized();
    const { cleanup } = (await (await call("/cleanups", "POST", { comments: true })).json()) as {
      cleanup: { id: string };
    };
    intercept("/app/installations/10/access_tokens", { token: "t" }, 201, "POST");
    // 40 full comment pages fill one step, so another step must be queued.
    for (let page = 1; page <= 40; page++)
      intercept(
        `/repos/${repo}/issues/comments?sort=created&direction=desc&per_page=100&page=${page}`,
        Array.from({ length: 100 }, (_, i) => ({ id: page * 1000 + i, user: { login: "x", type: "User" }, body: "hi" })),
      );
    const broken = { ...e, JOBS: { send: async () => { throw new Error("Queue send failed"); } } } as unknown as Env;
    await runCleanup(broken, cleanup.id);
    expect(await rows("SELECT state,lease FROM cleanups")).toEqual([{ state: "planning", lease: 0 }]);
  });
});

describe("repository BYOK API", () => {
  const own = { mode: "byok", provider: "llm", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", api_key: "user-private-test-key" };
  const save = async (input: unknown = own) => {
    authorized();
    return call("/ai-provider", "PATCH", input);
  };
  it("stores encrypted credentials and exposes safe metadata to writable users", async () => {
    const saved = await save();
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    const metadata = await saved.json();
    expect(metadata).toMatchObject({ ai_provider: { mode: "byok", provider: "llm", base_url: own.base_url, model: own.model, has_key: true, ready: true, storage_available: true, updated_at: expect.any(String) } });
    expect(JSON.stringify(metadata)).not.toContain(own.api_key);
    const stored = await rows("SELECT * FROM ai_providers");
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(own.api_key);
    expect(stored[0].encrypted_key).toMatch(/^v1\./);
    expect(await rows("SELECT via,action,detail FROM audit_log")).toEqual([{ via: "api", action: "ai_provider.update", detail: '{"mode":"byok","provider":"llm","has_key":true}' }]);
    authorized("write");
    const read = await call("/ai-provider");
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).not.toContain("encrypted_key");
    const scoped = await resolveAIEnv(e, 100, repo);
    expect(scoped.LLM_API_KEY).toBe(own.api_key);
    expect(scoped.OPENROUTER_API_KEY).toBeUndefined();
  });
  it("requires fresh administrator permission for save, connection test and key removal", async () => {
    expect((await save()).status).toBe(200);
    for (const [path, method, input] of [["/ai-provider", "PATCH", own], ["/ai-provider/test", "POST", {}], ["/ai-provider/key", "DELETE", {}]] as const) {
      authorized("write");
      const denied = await call(path, method, input);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "admin_required" });
    }
    expect(await rows("SELECT count(*) AS n FROM audit_log")).toEqual([{ n: 1 }]);
    expect((await resolveAIEnv(e, 100, repo)).LLM_API_KEY).toBe(own.api_key);
    expect(sent).toEqual([]);
  });
  it("does not redirect a retained key to another endpoint and rejects internal URLs", async () => {
    expect((await save()).status).toBe(200);
    const { api_key: _key, ...retained } = own;
    expect((await save(retained)).status).toBe(200);
    expect(await (await save({ ...retained, base_url: "https://other-provider.com/v1" })).json()).toEqual({ error: "key_required" });
    for (const base_url of ["http://api.openai.com/v1", "https://127.0.0.1/v1", "https://[::1]/v1", "https://localhost/v1", "https://api.openai.com/v1?secret=x"]) {
      const failed = await save({ ...own, base_url });
      expect(failed.status).toBe(400);
      expect(await failed.json()).toEqual({ error: "invalid_config" });
    }
    expect((await resolveAIEnv(e, 100, repo)).LLM_BASE_URL).toBe(own.base_url);
    expect((await resolveAIEnv(e, 100, repo)).LLM_API_KEY).toBe(own.api_key);
  });
  it("uses the saved own key for explicit model tests and rate limits without GitHub writes", async () => {
    expect((await save()).status).toBe(200);
    for (const type of [1, 28]) pending.push({ url: `https://cloudflare-dns.com/dns-query?name=api.openai.com&type=${type}`, method: "GET", status: 200, body: JSON.stringify({ Status: 0, Answer: type === 1 ? [{ name: "api.openai.com", type: 1, data: "104.18.32.7" }] : [] }) });
    pending.push({ url: own.base_url + "/chat/completions", method: "POST", status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"labels":["bug"]}' } }] }) });
    authorized();
    const connected = await call("/ai-provider/test", "POST", {});
    expect(connected.status).toBe(200);
    expect(await connected.json()).toEqual({ connected: true, provider: "llm", model: own.model });
    const modelCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/chat/completions"));
    expect(new Headers(modelCall?.[1]?.headers).get("authorization")).toBe(`Bearer ${own.api_key}`);
    expect(modelCall?.[1]?.redirect).toBe("manual");
    const dnsCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith("https://cloudflare-dns.com"));
    expect(dnsCalls.every(([, init]) => !new Headers(init?.headers).has("authorization"))).toBe(true);
    authorized();
    const second = await call("/ai-provider/test", "POST", {});
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    expect(sent).toEqual([]);
    expect(await rows("SELECT * FROM jobs")).toEqual([]);
    expect(await rows("SELECT * FROM repo_settings")).toEqual([]);
  });
  it("removing the user key disables AI and requires explicit platform selection", async () => {
    expect((await save()).status).toBe(200);
    authorized();
    const removed = await call("/ai-provider/key", "DELETE", {});
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ ai_provider: { mode: "byok", has_key: false, ready: false } });
    expect((await resolveAIEnv({ ...e, LLM_API_KEY: "platform-key" }, 100, repo)).LLM_API_KEY).toBeUndefined();
    authorized();
    expect((await call("/ai-provider/test", "POST", {})).status).toBe(503);
    expect((await save({ mode: "platform" })).status).toBe(200);
    expect((await resolveAIEnv({ ...e, LLM_API_KEY: "platform-key" }, 100, repo)).LLM_API_KEY).toBe("platform-key");
  });
  it("fails safely on unavailable encryption storage without admitting model requests", async () => {
    const secret = e.BYOK_ENCRYPTION_KEY;
    e.BYOK_ENCRYPTION_KEY = undefined;
    try {
      const response = await save();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "storage_unavailable" });
      expect(await rows("SELECT * FROM ai_providers")).toEqual([]);
    } finally { e.BYOK_ENCRYPTION_KEY = secret; }
  });
});
