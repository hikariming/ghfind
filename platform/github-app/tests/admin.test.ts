import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ui } from "../src/ui";
import { seal } from "../src/secrets";
import { getSettings } from "../src/settings";
import { ADMIN_MESSAGES } from "../src/admin-i18n";

declare const TEST_SQL: string[];
const testEnv = env as Env;
const e = { ...testEnv, APP_CLIENT_ID: "client-test" } as Env;
const api = "https://api.github.com";
const repo = "AsperforMias/test-bot";
const origin = "https://bot.example";
const target = `${origin}/admin/repo?installation_id=10&repository=100`;

const pending: { url: string; method: string; status: number; body: string }[] = [];
const intercept = (path: string, body: unknown, status = 200, method = "GET") =>
  pending.push({ url: api + path, method, status, body: JSON.stringify(path === `/repos/${repo}` && body && typeof body === "object" ? { id: 100, full_name: repo, ...body } : body) });
beforeAll(async () => {
  for (const sql of TEST_SQL) await testEnv.DB.prepare(sql).run();
});
beforeEach(async () => {
  await testEnv.DB.exec("DELETE FROM sessions; DELETE FROM repo_settings; DELETE FROM jobs; DELETE FROM cleanups; DELETE FROM cleanup_items; DELETE FROM audit_log;");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input),
        method = init?.method ?? "GET";
      const at = pending.findIndex((x) => x.url === url && x.method === method);
      if (at < 0 && method === "GET" && url === `${api}/user/installations?per_page=100&page=1`)
        return Response.json({ installations: [{ id: 10, account: { login: "AsperforMias" } }] });
      if (at < 0) throw new Error(`Unexpected request: ${method} ${url}`);
      const x = pending.splice(at, 1)[0];
      return new Response(x.body, { status: x.status });
    }),
  );
});
afterEach(() => {
  expect(pending.splice(0)).toEqual([]);
  vi.unstubAllGlobals();
});

// Sealed exactly as /callback stores it.
async function signIn() {
  const id = crypto.randomUUID();
  await testEnv.DB.prepare("INSERT INTO sessions(id,value,expires) VALUES(?,?,?)")
    .bind(`session:${id}`, await seal(testEnv, "user-test-token"), Date.now() + 3600_000)
    .run();
  return { cookie: `ghfind_bot_session=${id}`, csrf: id };
}
const access = (repositories = [{ id: 100, full_name: repo }]) =>
  intercept("/user/installations/10/repositories?per_page=100&page=1", { repositories });
const get = (url: string, cookie?: string) =>
  ui(new Request(url, { headers: cookie ? { cookie } : {} }), e);
const post = (cookie: string, body: URLSearchParams, from = origin, url = target) =>
  ui(
    new Request(url, {
      method: "POST",
      headers: { cookie, origin: from, "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    e,
  );
const backfillUrl = `${origin}/admin/backfill?installation_id=10&repository=100`;
const backfill = (cookie: string, csrf: string, limit = "10", from = origin) =>
  post(cookie, new URLSearchParams([["csrf", csrf], ["backfill_limit", limit]]), from, backfillUrl);
const jobs = () =>
  testEnv.DB.prepare("SELECT id,installation,repository,full_name,kind,page,state FROM jobs").all();
const form = (csrf: string, extra: [string, string][] = []) =>
  new URLSearchParams([
    ["csrf", csrf],
    ["issues_enabled", "on"],
    ["comments_enabled", "on"],
    ["triage_enabled", "on"],
    ["comment_prompt", "Reply in Chinese <b>briefly</b>"],
    ["allowed_labels", "bug"],
    ...extra,
  ]);

describe("admin pages", () => {
  it("asks for sign-in and round-trips the login state to /admin", async () => {
    const page = await get(`${origin}/admin`);
    expect(await page.text()).toContain('href="/login?return_to=admin"');
    expect((await get(`${target}`)).status).toBe(200);
    const denied = await ui(new Request(target, { method: "POST", headers: { origin } }), e);
    expect(denied.status).toBe(403);
    const login = await get(`${origin}/login?return_to=admin`);
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    pending.push({
      url: "https://github.com/login/oauth/access_token",
      method: "POST",
      status: 200,
      body: JSON.stringify({ access_token: "user-test-token" }),
    });
    const cb = await ui(
      new Request(`${origin}/callback?code=test&state=${state}`, {
        headers: { cookie: `ghfind_bot_state=${state}` },
      }),
      e,
    );
    expect(cb.headers.get("location")).toBe("/admin");
    expect((await get(`${origin}/login?return_to=elsewhere`)).status).toBe(400);
  });
  it("signs out only after a same-origin, CSRF-protected submission", async () => {
    const { cookie, csrf } = await signIn();
    const logout = `${origin}/logout`;
    expect((await get(logout, cookie)).status).toBe(405);
    expect((await post(cookie, new URLSearchParams({ csrf }), "https://evil.example", logout)).status).toBe(403);
    expect((await post(cookie, new URLSearchParams({ csrf: "wrong" }), origin, logout)).status).toBe(403);
    const response = await post(cookie, new URLSearchParams({ csrf }), origin, logout);
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await (await get(target, cookie)).text()).toContain("/login?return_to=admin");
  });
  it("offers sign-in again when GitHub revokes a dashboard token", async () => {
    const { cookie } = await signIn();
    intercept("/user/installations?per_page=100&page=1", { message: "Bad credentials" }, 401);
    const response = await get(`${origin}/admin`, cookie);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("/login?return_to=admin");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("lists installations and accessible repositories", async () => {
    const { cookie } = await signIn();
    intercept("/user/installations?per_page=100&page=1", {
      installations: [{ id: 10, account: { login: "AsperforMias" } }],
    });
    access();
    intercept(`/repos/${repo}`, { permissions: { admin:true } });
    const list = await (await get(`${origin}/admin`, cookie)).text();
    expect(list).toContain('href="/admin?installation_id=10"');
    access();
    intercept(`/repos/${repo}`, { id:100, full_name:repo, permissions: { admin:true } });
    const repos = await (await get(`${origin}/admin?installation_id=10`, cookie)).text();
    expect(repos).toContain("/admin/repo?installation_id=10&amp;repository=100");
  });
  it("makes empty installation and repository lists actionable without queueing jobs", async () => {
    const { cookie } = await signIn();
    intercept("/user/installations?per_page=100&page=1", { installations: [] });
    const response = await ui(new Request(`${origin}/admin`, { headers: { cookie } }), { ...e, ENABLED: "true", APP_SLUG: "ghfind-test" });
    expect(await response.text()).toContain("https://github.com/apps/ghfind-test/installations/new");
    access([]);
    expect(await (await get(`${origin}/admin?installation_id=10`, cookie)).text()).toContain("https://github.com/settings/installations");
    expect((await jobs()).results).toEqual([]);
  });
  it("hides repositories outside the user's installation access", async () => {
    const { cookie, csrf } = await signIn();
    access([{ id: 200, full_name: "AsperforMias/other" }]);
    expect((await get(target, cookie)).status).toBe(404);
    access([]);
    expect((await post(cookie, form(csrf))).status).toBe(404);
    expect((await get(`${origin}/admin?installation_id=11`, cookie)).status).toBe(404);
    expect(await getSettings(testEnv, 100)).toMatchObject({ commentsEnabled: false });
  });
  it("renders a read-only form for non-admins and rejects their POST", async () => {
    const { cookie, csrf } = await signIn();
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: false, push: true } });
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, []);
    const text = await (await get(target, cookie)).text();
    expect(text).toContain('<fieldset class="stack" disabled>');
    expect(text).toContain("Read only");
    expect(text).not.toContain("Save settings");
    for (const name of ["issues_enabled", "prs_enabled", "comments_enabled", "triage_enabled"])
      expect(text).toContain(`name="${name}"`);
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: false } });
    expect((await post(cookie, form(csrf))).status).toBe(403);
    expect((await getSettings(testEnv, 100)).commentsEnabled).toBe(false);
  });
  it("saves an admin's settings and shows them again", async () => {
    const { cookie, csrf } = await signIn();
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    intercept("/user", { id: 1, login: "octo-admin" });
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, [{ name: "bug" }, { name: "gone" }]);
    const saved = await post(cookie, form(csrf, [["allowed_labels", "gone"]]));
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(
      "/admin/repo?installation_id=10&repository=100&saved=1",
    );
    expect(await getSettings(testEnv, 100)).toEqual({
      issuesEnabled: true,
      prsEnabled: false,
      commentsEnabled: true,
      commentPrompt: "Reply in Chinese <b>briefly</b>",
      triageEnabled: true,
      allowedLabels: ["bug", "gone"],
      backfillLimit: 25,
    });
    const row = await testEnv.DB.prepare("SELECT updated_by,full_name FROM repo_settings").first();
    expect(row).toEqual({ updated_by: "octo-admin", full_name: repo });
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, [
      { name: "bug", color: "d73a4a", description: "Something is broken" },
      { name: "docs", color: "0075ca", description: "" },
    ]);
    const text = await (await get(`${target}&saved=1`, cookie)).text();
    expect(text).toContain("Settings saved.");
    expect(text).toContain('<fieldset class="stack">');
    expect(text).toContain('name="issues_enabled" value="on" checked');
    expect(text).toContain('name="prs_enabled" value="on">');
    expect(text).toContain('name="allowed_labels" value="bug" checked');
    expect(text).toContain('name="allowed_labels" value="docs">');
    expect(text).toMatch(/value="gone" checked>.*Missing from repository/);
    expect(text).toContain("Reply in Chinese &lt;b&gt;briefly&lt;/b&gt;");
    expect(text).toContain("tab=backfill");
    expect(text).toContain('class="settings-flow"');
    expect(text).toContain(ADMIN_MESSAGES.en.aiGreetingsUnavailable);
  });
  it("hides settings from users without write access, matching the API", async () => {
    const { cookie } = await signIn();
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: false, push: false, pull: true } });
    const response = await get(target, cookie);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Repository write access is required");
  });
  it("rejects allowed labels that no longer exist in the repository", async () => {
    const { cookie, csrf } = await signIn();
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    intercept("/user", { id: 1, login: "octo-admin" });
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, [{ name: "docs" }]);
    const response = await post(cookie, form(csrf));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Select only labels that currently exist");
    expect((await getSettings(testEnv, 100)).allowedLabels).toEqual([]);
  });
  it("rejects bad origin and csrf", async () => {
    const { cookie, csrf } = await signIn();
    expect((await post(cookie, form(csrf), "https://evil.example")).status).toBe(403);
    expect((await post(cookie, form("wrong"))).status).toBe(403);
    expect(await getSettings(testEnv, 100)).toMatchObject({ backfillLimit: 25 });
  });
  it("explains an invalid form instead of saving it", async () => {
    const { cookie, csrf } = await signIn();
    for (const extra of [
      [["allowed_labels", "review: top"]],
      [["comment_prompt", "x".repeat(2001)]],
    ] as [string, string][][]) {
      access();
      intercept(`/repos/${repo}`, { permissions: { admin: true } });
      const body = form(csrf);
      for (const [k, v] of extra) body.set(k, v);
      const r = await post(cookie, body);
      expect(r.status).toBe(400);
      expect(await r.text()).toContain("Settings not saved");
    }
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    const huge = await post(cookie, form(csrf, [["allowed_labels", "y".repeat(70_000)]]));
    expect(huge.status).toBe(400);
    expect(await getSettings(testEnv, 100)).toMatchObject({ backfillLimit: 25 });
  });
  it("escapes label text, validates colours and hides review: labels", async () => {
    const { cookie } = await signIn();
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, [
      { name: '<img src=x onerror="a">', color: '000;background:url(x)', description: "<script>x</script>" },
      { name: "review: top", color: "ded0a6", description: "bot" },
      { name: "Review: Low", color: "d9dee3", description: "bot" },
    ]);
    const text = await (await get(target, cookie)).text();
    expect(text).toContain("&lt;img src=x onerror=&quot;a&quot;&gt;");
    expect(text).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(text).not.toContain("<script>x");
    expect(text).not.toContain("url(x)");
    expect(text).not.toContain("review: top");
    expect(text).not.toContain("Review: Low");
  });
  it("queues an admin backfill and shows its status", async () => {
    const { cookie, csrf } = await signIn();
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    intercept("/user", { id: 1, login: "octo-admin" });
    const before = Date.now();
    const r = await backfill(cookie, csrf, "10");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(
      "/admin/repo?installation_id=10&repository=100&tab=backfill&backfill=queued",
    );
    expect((await getSettings(testEnv, 100)).backfillLimit).toBe(10);
    const { results } = await jobs();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      installation: 10,
      repository: 100,
      full_name: repo,
      kind: "initialize",
      page: 1,
      state: "pending",
    });
    const stamp = Number(/^backfill-10-100-(\d+)$/.exec(String(results[0].id))![1]);
    expect(stamp).toBeGreaterThanOrEqual(before);
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, []);
    const text = await (await get(`${target}&backfill=queued`, cookie)).text();
    expect(text).toContain("Backfill queued.");
    expect(text).toContain('<form id="backfill" method="post" action="/admin/backfill?installation_id=10&amp;repository=100">');
    expect(text).toMatch(/<p id="backfill-status" class="result">Last backfill: <span class="state-text" data-state="pending">Pending<\/span> <time/);
    expect(text).toContain('required value="10"');
    expect(text).toContain("Queue backfill");
  });
  it("rejects a second backfill while one is pending or running", async () => {
    const { cookie, csrf } = await signIn();
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    intercept("/user", { id: 1, login: "octo-admin" });
    expect((await backfill(cookie, csrf, "10")).status).toBe(303);
    for (const state of ["pending", "running"]) {
      await testEnv.DB.prepare("UPDATE jobs SET state=?").bind(state).run();
      access();
      intercept(`/repos/${repo}`, { permissions: { admin: true } });
      const busy = await backfill(cookie, csrf, "50");
      expect(busy.status).toBe(409);
      expect(await busy.text()).toContain("still pending or running");
    }
    expect((await jobs()).results).toHaveLength(1);
    expect((await getSettings(testEnv, 100)).backfillLimit).toBe(10);
    // Once the previous one finishes, another may be queued.
    await testEnv.DB.prepare("UPDATE jobs SET state='done',result='Queued 3 open issues and pull requests'").run();
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    intercept("/user", { id: 1, login: "octo-admin" });
    await new Promise((x) => setTimeout(x, 2));
    expect((await backfill(cookie, csrf, "50")).status).toBe(303);
    expect((await jobs()).results).toHaveLength(2);
  });
  it("shows the last backfill result read-only to non-admins and rejects their backfill", async () => {
    const { cookie, csrf } = await signIn();
    await testEnv.DB.prepare(
      "INSERT INTO jobs(id,installation,repository,full_name,kind,state,result,created,due,updated) VALUES('backfill-10-100-1',10,100,?,'initialize','done','Queued 3 open issues and pull requests',1,1,1)",
    )
      .bind(repo)
      .run();
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: false, push: true } });
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, []);
    const text = await (await get(`${target}&tab=backfill`, cookie)).text();
    expect(text).toContain('data-state="done">Done</span> <time datetime="1970-01-01T00:00:00.001Z">1970-01-01 00:00 UTC</time> · Queued 3 open issues and pull requests');
    expect(text).not.toContain("Queue backfill");
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: false } });
    expect((await backfill(cookie, csrf)).status).toBe(403);
    expect((await jobs()).results).toHaveLength(1);
  });
  it("checks origin, csrf, access and the limit before queueing a backfill", async () => {
    const { cookie, csrf } = await signIn();
    expect((await backfill(cookie, csrf, "10", "https://evil.example")).status).toBe(403);
    expect((await backfill(cookie, "wrong")).status).toBe(403);
    expect((await ui(new Request(backfillUrl, { method: "POST", headers: { origin } }), e)).status).toBe(403);
    expect((await get(backfillUrl, cookie)).status).toBe(405);
    access([]);
    expect((await backfill(cookie, csrf)).status).toBe(404);
    for (const limit of ["0", "101", "2.5", ""]) {
      access();
      intercept(`/repos/${repo}`, { permissions: { admin: true } });
      const r = await backfill(cookie, csrf, limit);
      expect(r.status).toBe(400);
      expect(await r.text()).toContain("Backfill not queued");
    }
    expect((await jobs()).results).toHaveLength(0);
    expect((await getSettings(testEnv, 100)).backfillLimit).toBe(25);
  });

  it("previews a cleanup, lets only its requester confirm, and audits it", async () => {
    const { cookie, csrf } = await signIn();
    const cleanupUrl = (path = "") =>
      `${origin}/admin/cleanup${path}?installation_id=10&repository=100`;
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    intercept("/user", { id: 1, login: "octo-admin" });
    const empty = await post(cookie, new URLSearchParams([["csrf", csrf]]), origin, cleanupUrl());
    expect(empty.status).toBe(400);
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    intercept("/user", { id: 1, login: "octo-admin" });
    const r = await post(
      cookie,
      new URLSearchParams([["csrf", csrf], ["review_labels", "on"], ["comments", "on"]]),
      origin,
      cleanupUrl(),
    );
    expect(r.headers.get("location")).toBe(`${target.slice(origin.length)}&tab=cleanup#cleanup`);
    const row = await testEnv.DB.prepare("SELECT id,scope,state,requested_by FROM cleanups").first<{
      id: string;
      scope: string;
    }>();
    expect(row).toMatchObject({ state: "planning", requested_by: "octo-admin" });
    expect(JSON.parse(row!.scope)).toEqual({ labels: "review", comments: true, definitions: false });
    await testEnv.DB.prepare(
      `UPDATE cleanups SET state='planned',expires=?,total=3,summary='{"review_labels":2,"triage_labels":0,"comments":1,"label_definitions":0,"truncated":false,"bot_active":true}'`,
    )
      .bind(Date.now() + 600_000)
      .run();
    const page = async (login: string) => {
      access();
      intercept(`/repos/${repo}`, { permissions: { admin: true } });
      intercept(`/repos/${repo}/labels?per_page=100&page=1`, []);
      intercept("/user", { id: 1, login });
      return (await get(`${target}&tab=cleanup`, cookie)).text();
    };
    const mine = await page("octo-admin");
    expect(mine).toContain("Preview candidates: 2 review: labels, 0 intent labels, 1 comments and 0 label definitions");
    expect(mine).toContain("Score labels are still on");
    expect(mine).toContain('action="/admin/cleanup/confirm?installation_id=10&amp;repository=100"');
    const theirs = await page("other-admin");
    expect(theirs).toContain("Only octo-admin, who started this preview, can confirm it here.");
    expect(theirs).not.toContain("/admin/cleanup/confirm");
    // Another admin's confirm is refused; the requester's is accepted.
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    intercept("/user", { id: 2, login: "other-admin" });
    await post(cookie, new URLSearchParams([["csrf", csrf], ["cleanup", row!.id]]), origin, cleanupUrl("/confirm"));
    expect((await testEnv.DB.prepare("SELECT state FROM cleanups").first())?.state).toBe("planned");
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: true } });
    intercept("/user", { id: 1, login: "octo-admin" });
    await post(cookie, new URLSearchParams([["csrf", csrf], ["cleanup", row!.id]]), origin, cleanupUrl("/confirm"));
    expect(await testEnv.DB.prepare("SELECT state,confirmed_by FROM cleanups").first()).toEqual({
      state: "running",
      confirmed_by: "octo-admin",
    });
    const log = await testEnv.DB.prepare("SELECT actor,via,action FROM audit_log ORDER BY id").all();
    expect(log.results).toEqual([
      { actor: "octo-admin", via: "web", action: "cleanup.plan" },
      { actor: "octo-admin", via: "web", action: "cleanup.confirm" },
    ]);
    // Non-admins and cross-origin posts are refused.
    access();
    intercept(`/repos/${repo}`, { permissions: { admin: false } });
    expect(
      (await post(cookie, new URLSearchParams([["csrf", csrf], ["comments", "on"]]), origin, cleanupUrl())).status,
    ).toBe(403);
    expect(
      (await post(cookie, new URLSearchParams([["csrf", csrf], ["comments", "on"]]), "https://evil.example", cleanupUrl())).status,
    ).toBe(403);
    expect((await get(cleanupUrl(), cookie)).status).toBe(405);
  });
  it("lists recent activity, escaped and localized, without extra GitHub calls", async () => {
    const { cookie } = await signIn();
    const add = (actor: string, via: string, action: string, detail: unknown, created: number) =>
      testEnv.DB.prepare(
        "INSERT INTO audit_log(repository,actor,via,action,detail,created) VALUES(100,?,?,?,?,?)",
      )
        .bind(actor, via, action, JSON.stringify(detail), created)
        .run();
    const view = async (query = "") => {
      access();
      intercept(`/repos/${repo}`, { permissions: { admin: false, push: true } });
      intercept(`/repos/${repo}/labels?per_page=100&page=1`, []);
      return (await get(`${target}&tab=activity${query}`, cookie)).text();
    };
    const empty = await view();
    expect(empty).toContain('id="activity"');
    expect(empty).toContain("Nothing recorded yet.");
    await add("octo-admin", "web", "backfill", { limit: 30 }, Date.UTC(2026, 9, 1, 8, 5));
    await add('<b>"x"</b>', "api", "cleanup.plan", { id: "0123abcd-4567-89ef-0123-456789abcdef", scope: { secret: "<i>" } }, Date.UTC(2026, 9, 2, 9, 0));
    await add("octo-admin", "api", "pause", { cancelled: 3 }, Date.UTC(2026, 9, 3, 10, 0));
    await add("octo-admin", "api", "retry", { retried: 2 }, Date.UTC(2026, 9, 4, 11, 0));
    await testEnv.DB.prepare(
      "INSERT INTO audit_log(repository,actor,via,action,detail,created) VALUES(200,'elsewhere','web','resume','{}',1)",
    ).run();
    const text = await view();
    expect(text).not.toContain("Nothing recorded yet.");
    expect(text).toContain("Queued a backfill");
    expect(text).toContain("up to 30 items");
    expect(text).toContain("2026-10-01 08:05 UTC");
    expect(text).toContain("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
    expect(text).not.toContain('<b>"x"');
    expect(text).toContain("Previewed a cleanup");
    expect(text).toContain("#0123abcd");
    expect(text).not.toContain("0123abcd-4567");
    expect(text).not.toContain("secret");
    expect(text).toContain("3 queued jobs cancelled");
    expect(text).toContain("2 retried");
    expect(text).toContain("CLI · API");
    expect(text).not.toContain("elsewhere");
    // Newest first.
    expect(text.indexOf("Retried failed jobs")).toBeLessThan(text.indexOf("Queued a backfill"));
    const zh = await view("&lang=zh");
    expect(zh).toContain("操作记录");
    expect(zh).toContain("发起了补扫");
    expect(zh).toContain("最多 30 条");
  });
});
