import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_PAGE_SIZE, loadAdminData, parseAdminFilters } from "../src/admin-data";
import { ApiError, type github } from "../src/github";
import { putSettings } from "../src/settings";

declare const TEST_SQL: string[];
const e = env as Env;
const now = Date.UTC(2026, 9, 7, 12);
const repositories = new Map([[100, "owner/one"], [200, "owner/two"], [300, "owner/read-only"]]);
const api = (permissions: Record<number, { admin?: boolean; push?: boolean }> = {
  100: { admin: true }, 200: { push: true }, 300: {},
}, names = repositories) => vi.fn<ReturnType<typeof github>>(async (path) => {
  const found = [...names].find(([, name]) => `/repos/${name}` === path);
  if (!found) throw new Error(`Unexpected path ${path}`);
  return { id: found[0], full_name: found[1], permissions: permissions[found[0]] ?? {} };
});
const load = (params = "", upstream = api(), repos = repositories) =>
  loadAdminData(e, upstream, 10, repos, new URLSearchParams(params), now);
async function job(id: string, repository = 100, installation = 10, state = "done", updated = now, extra: { due?: number; lease?: number; kind?: string; fullName?: string } = {}) {
  await e.DB.prepare(`INSERT INTO jobs(id,installation,repository,full_name,kind,state,result,created,due,lease,updated)
    VALUES(?,?,?,?,?,?,?, ?,?,?,?)`)
    .bind(id, installation, repository, extra.fullName ?? repositories.get(repository) ?? "owner/hidden",
      extra.kind ?? "label", state, `result-${id}`, updated, extra.due ?? now, extra.lease ?? 0, updated).run();
}
async function audit(repository: number, actor: string, detail = "{}", created = now) {
  await e.DB.prepare("INSERT INTO audit_log(repository,actor,via,action,detail,created) VALUES(?,?,'web','settings.update',?,?)")
    .bind(repository, actor, detail, created).run();
}
async function cleanup(id: string, repository = 100, installation = 10, state = "running", expires = now + 1000) {
  await e.DB.prepare(`INSERT INTO cleanups(id,installation,repository,full_name,scope,state,code_hash,requested_by,created,updated,expires)
    VALUES(?,?,?,?,'{}',?,'never expose this','admin',?,?,?)`)
    .bind(id, installation, repository, repositories.get(repository) ?? "owner/hidden", state, now, now, expires).run();
}
beforeAll(async () => { for (const sql of TEST_SQL) await e.DB.prepare(sql).run(); });
beforeEach(async () => {
  await e.DB.exec("DELETE FROM jobs; DELETE FROM repo_settings; DELETE FROM audit_log; DELETE FROM cleanups;");
});

describe("bounded authenticated admin data", () => {
  it("orders the actual scoped task query by shared GitHub number before pagination, independent of completion", async () => {
    for (let number = 30; number >= 1; number--) {
      await job(`item-${number}`, 100, 10, "done", now - number);
      await e.DB.prepare("UPDATE jobs SET pr=? WHERE id=?").bind(number, `item-${number}`).run();
    }
    await job("wrong-installation", 100, 20);
    await e.DB.prepare("UPDATE jobs SET pr=1 WHERE id='wrong-installation'").run();
    const before = [...(await load()).tasks.rows, ...(await load("task_page=2")).tasks.rows].map(row => row.id);
    expect(before).toEqual(Array.from({ length: 30 }, (_, n) => `item-${n + 1}`));
    await e.DB.prepare("UPDATE jobs SET updated=?-pr*7").bind(now).run();
    const after = [...(await load()).tasks.rows, ...(await load("task_page=2")).tasks.rows].map(row => row.id);
    expect(after).toEqual(before);
  });
  it("scopes every count and row to live write access and installation without writes", async () => {
    await job("visible-admin");
    await job("visible-writer", 200);
    await job("read-only", 300);
    await job("other-installation", 100, 11);
    await job("not-accessible", 400);
    await job("discovery", 100, 10, "done", now, { kind: "discover" });
    await e.DB.prepare("UPDATE jobs SET repository=NULL,full_name=NULL WHERE id='discovery'").run();
    await audit(100, "admin"); await audit(200, "writer"); await audit(300, "secret-read-only"); await audit(400, "secret-hidden");
    await cleanup("visible-cleanup"); await cleanup("other-cleanup", 100, 11); await cleanup("read-cleanup", 300);
    const snapshot = async () => (await e.DB.prepare("SELECT id,state,updated FROM jobs ORDER BY id").all()).results;
    const before = await snapshot();
    const upstream = api();
    const data = await load("", upstream);
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(data.repositories.map((r) => [r.id, r.admin])).toEqual([[100, true], [200, false]]);
    expect(data.overview.totalJobs).toBe(2);
    expect(data.overview.totalCleanups).toBe(1);
    expect(data.tasks.rows.map((r) => r.id).sort()).toEqual(["visible-admin", "visible-writer"]);
    expect(data.activity.rows.map((r) => r.actor).sort()).toEqual(["admin", "writer"]);
    expect(data.cleanups[0]).toMatchObject({ id: "visible-cleanup", fullName: "owner/one", admin: true });
    expect(JSON.stringify(data)).not.toContain("never expose");
    expect(await snapshot()).toEqual(before);
    expect((await e.DB.prepare("SELECT count(*) AS count FROM repo_settings").first())?.count).toBe(0);
  });

  it("uses a 30-day updated window and actual due/lease state, without success estimates", async () => {
    await job("old", 100, 10, "done", now - 31 * 86400_000);
    await job("due", 100, 10, "pending", now, { due: now });
    await job("delayed", 100, 10, "pending", now, { due: now + 1 });
    await job("leased", 100, 10, "running", now, { lease: now + 1 });
    await job("stale", 100, 10, "running", now, { lease: now });
    await cleanup("expired-preview", 100, 10, "planned", now);
    const data = await load();
    expect(data.overview).toMatchObject({ since: now - 30 * 86400_000, until: now,
      totalJobs: 4, jobStates: { pending: 2, running: 2, done: 0 }, duePending: 1, leasedRunning: 1, staleRunning: 1,
      cleanupStates: { expired: 1, planned: 0 } });
    expect(data.tasks.rows).toHaveLength(5);
    expect(data.cleanups[0].state).toBe("expired");
    expect((await e.DB.prepare("SELECT state FROM cleanups").first())?.state).toBe("planned");
  });

  it("defaults transferred settings and hides old-owner text while preserving same-owner rename", async () => {
    await putSettings(e, 10, 100, "previous/one", { issuesEnabled: false, prsEnabled: false, commentsEnabled: true,
      commentPrompt: "previous owner private prompt", triageEnabled: true, allowedLabels: ["private"] }, "previous");
    await job("transferred-history", 100, 10, "done", now, { fullName: "previous/one" });
    await audit(100, "previous-owner");
    await putSettings(e, 9, 200, "OWNER/old-name", { issuesEnabled: false, prsEnabled: true, commentsEnabled: true,
      commentPrompt: "same owner prompt", triageEnabled: true, allowedLabels: ["bug"] }, "writer");
    await job("renamed-history", 200, 10, "done", now, { fullName: "OWNER/old-name" });
    const data = await load();
    expect(data.repositories[0].settings).toMatchObject({ commentsEnabled: false, commentPrompt: "", triageEnabled: false });
    expect(data.repositories[0].lastActivity).toBeNull();
    expect(data.repositories[1].settings.commentPrompt).toBe("same owner prompt");
    expect(data.tasks.rows.map((r) => r.id)).toEqual(["renamed-history"]);
    expect(data.activity.rows).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("previous owner");
    expect((await e.DB.prepare("SELECT comment_prompt FROM repo_settings WHERE repository=100").first())?.comment_prompt)
      .toBe("previous owner private prompt");
  });

  it("filters literal searches and paginates retained jobs and audit rows with bounded results", async () => {
    for (let i = 0; i < 60; i++) {
      await job(`job-${String(i).padStart(2, "0")}`, i % 2 ? 200 : 100, 10, i % 3 ? "failed" : "done", now - i,
        { kind: i % 4 ? "label" : "initialize" });
      await audit(100, `actor-${i}`, '{"changed":["comments_enabled"]}', now - i);
    }
    const data = await load("task_page=2&activity_page=2");
    expect(data.tasks.rows).toHaveLength(ADMIN_PAGE_SIZE);
    expect(data.tasks).toMatchObject({ hasPrevious: true, hasNext: true });
    expect(data.activity.rows).toHaveLength(ADMIN_PAGE_SIZE);
    expect(data.activity).toMatchObject({ hasPrevious: true, hasNext: true });
    const ordered = [
      ...Array.from({ length: 30 }, (_, n) => 58 - n * 2),
      ...Array.from({ length: 30 }, (_, n) => 59 - n * 2),
    ].map(n => `job-${String(n).padStart(2, "0")}`);
    expect(data.tasks.rows.map(row => row.id)).toEqual(ordered.slice(25, 50));
    const filtered = await load("repository=100&status=failed&kind=label&q=job-");
    expect(filtered.tasks.rows.every((r) => r.repository === 100 && r.state === "failed" && r.kind === "label")).toBe(true);
    expect(filtered.tasks.rows.length).toBeGreaterThan(0);
    expect((await load("q=%25")).tasks.rows).toEqual([]);
    expect((await load("q=%27%20OR%201%3D1--")).tasks.rows).toEqual([]);
    await expect(load("repository=300")).rejects.toMatchObject({ status: 404 });
  });

  it("marks repository pages partial and performs no more than 25 permission checks", async () => {
    const repos = new Map(Array.from({ length: 60 }, (_, i) => [i + 1, `owner/repo-${i + 1}`] as const));
    const permissions = Object.fromEntries([...repos.keys()].map((id) => [id, { admin: true }]));
    const upstream = api(permissions, repos);
    const data = await load("repo_page=2", upstream, repos);
    expect(upstream).toHaveBeenCalledTimes(25);
    expect(data.scope).toMatchObject({ page: 2, totalAccessible: 60, checked: 25, authorized: 25, partial: true, hasNext: true, hasPrevious: true });
    expect(data.repositories.map((r) => r.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 26));
    expect(upstream.mock.calls.some(([path]) => path === "/repos/owner/repo-1")).toBe(false);
  });

  it("reports capped history and cleanup previews explicitly while SQL counts all authorized rows", async () => {
    await e.DB.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<10001)
      INSERT INTO jobs(id,installation,repository,full_name,kind,state,result,created,due,updated)
      SELECT 'bounded-'||n,10,100,'owner/one','label','failed',?, ?,?,?-n FROM seq`)
      .bind("x".repeat(2500), now, now, now).run();
    await e.DB.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<10001)
      INSERT INTO audit_log(repository,actor,via,action,detail,created)
      SELECT 100,'admin','web','settings.update','invalid json',? FROM seq`).bind(now).run();
    for (let i = 0; i < 26; i++) await cleanup(`bounded-cleanup-${i}`);
    const data = await load("task_page=400&activity_page=400");
    expect(data.overview.totalJobs).toBe(10001);
    expect(data.tasks).toMatchObject({ hasNext: false, truncated: true });
    expect(data.activity).toMatchObject({ hasNext: false, truncated: true });
    expect(data.tasks.rows).toHaveLength(25);
    expect(data.activity.rows).toHaveLength(25);
    expect(data.tasks.rows.every((r) => r.result?.length === 2000)).toBe(true);
    expect(data.activity.rows.every((r) => JSON.stringify(r.detail) === "{}")).toBe(true);
    expect(data.cleanups).toHaveLength(25);
    expect(data.cleanupsHasMore).toBe(true);
  });

  it("fails closed on malformed/mismatched permission responses and upstream quota errors", async () => {
    await job("private");
    const one = new Map([[100, "owner/one"]]);
    const mismatch = vi.fn<ReturnType<typeof github>>(async () => ({ id: 999, full_name: "owner/one", permissions: { admin: true } }));
    expect((await load("", mismatch, one)).repositories).toEqual([]);
    const denied = vi.fn<ReturnType<typeof github>>(async () => { throw new ApiError(404, false); });
    expect((await load("", denied, one)).overview.totalJobs).toBe(0);
    const quota = vi.fn<ReturnType<typeof github>>(async () => { throw new ApiError(403, true, 60_000, true); });
    await expect(load("", quota, one)).rejects.toMatchObject({ status: 403, quota: true });
    const invalid = vi.fn<ReturnType<typeof github>>(async () => ({ permissions: { admin: true } }));
    await expect(load("", invalid, one)).rejects.toThrow("Invalid identifier");
    const transferred = vi.fn<ReturnType<typeof github>>(async () => ({ id: 100, full_name: "new-owner/one", permissions: { admin: true } }));
    expect((await load("", transferred, one)).repositories).toEqual([]);
  });

  it("validates integer, enum, duplicate and text filters before any network requests", async () => {
    for (const query of ["repo_page=0", "task_page=401", "activity_page=2.5", "repository=-1", "repository=9007199254740992",
      "kind=cleanup", "status=success", "q=%00", `q=${"x".repeat(101)}`, "task_page=1&task_page=2"]) {
      const upstream = api();
      await expect(load(query, upstream)).rejects.toThrow(/Invalid/);
      expect(upstream).not.toHaveBeenCalled();
    }
    expect(parseAdminFilters(new URLSearchParams("status=&kind=&repository="))).toMatchObject({
      repoPage: 1, taskPage: 1, activityPage: 1, filters: { q: "", status: undefined, kind: undefined, repository: undefined },
    });
  });
});
