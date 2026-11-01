import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupItems, confirmCleanup, createCleanup, getCleanup, runCleanup } from "../src/cleanup";
import { ApiError } from "../src/github";
import { LABELS } from "../src/review";
import { triage } from "../src/triage";
declare const TEST_SQL: string[];
const e = { ...env, LLM_API_KEY: "test-only", JOBS: { send: async () => {} } } as unknown as Env;
const repo = "AsperforMias/test-bot", gh = "https://api.github.com";
const human = { type: "User", login: "maintainer" }, bot = { type: "Bot", login: "ghfind-review-test[bot]" };
const event = (name: string, id = 1, actor = bot, kind = "labeled") => ({
  id, actor, event: kind, label: { name }, created_at: new Date(Date.UTC(2026, 9, 7) + id * 1000).toISOString(),
});
const pages = new Map<string, { status: number; body: unknown }>(), applied = new Set<string>();
const deleted: string[] = [], calls: string[] = [];
const read = (number: number, body: unknown, page = 1, status = 200) =>
  pages.set(`${gh}/repos/${repo}/issues/${number}/events?per_page=100&page=${page}`, { status, body });
let definitionUsed = false;
beforeAll(async () => { for (const sql of TEST_SQL) await e.DB.prepare(sql).run(); });
beforeEach(async () => {
  await e.DB.exec("DELETE FROM triage_labels; DELETE FROM cleanups; DELETE FROM cleanup_items;");
  pages.clear(); applied.clear(); deleted.splice(0); calls.splice(0); definitionUsed = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url === "https://api.stepfun.com/v1/chat/completions") return Response.json({ choices: [{ message: { content: '{"labels":["bug"]}' } }] });
    if (url === `${gh}/app/installations/10/access_tokens`) return Response.json({ token: "test-only" }, { status: 201 });
    if (method === "DELETE") { deleted.push(url); applied.delete(decodeURIComponent(url.split("/").at(-1)!)); return new Response(null, { status: 204 }); }
    if (url.includes("/issues?state=all&labels=") && url.endsWith("&per_page=1")) return Response.json(definitionUsed || applied.has(decodeURIComponent(new URL(url).searchParams.get("labels")!)) ? [{ number: 1 }] : []);
    if (url === `${gh}/repos/${repo}/labels?per_page=100&page=1`) return Response.json([{ name: LABELS[2] }]);
    if (url.includes("/issues?state=all&labels=") && url.endsWith("&per_page=100&page=1")) return Response.json(applied.has(new URL(url).searchParams.get("labels")!) ? [{ number: 1 }] : []);
    const response = pages.get(url);
    if (!response) throw new Error(`Unexpected ${method} ${url}`);
    return Response.json(response.body, { status: response.status });
  }));
});
afterEach(() => vi.unstubAllGlobals());
// A real confirmed plan in D1. Execution must re-check GitHub attribution,
// never trust a previously prepared candidate or an earlier ledger entry.
async function candidate(name: string, kind = "issue_label", count = 1) {
  const c = await createCleanup(e, 10, 100, repo, { labels: "all", comments: false, definitions: kind === "label" }, "admin", false);
  expect(c).not.toBeNull(); const id = c!.cleanup.id;
  await e.DB.prepare("UPDATE cleanups SET state='planned',expires=?,total=? WHERE id=?").bind(Date.now() + 600_000, count, id).run();
  for (let i = 0; i < count; i++) await e.DB.prepare("INSERT INTO cleanup_items(cleanup,seq,kind,number,name,comment) VALUES(?,?,?,?,?,NULL)").bind(id, i, kind, kind === "label" ? null : i + 1, name).run();
  expect(await confirmCleanup(e, 100, { token: c!.token }, "admin")).toBe("ok"); return id;
}
describe("cleanup ownership", () => {
  it("preserves a later human label when the bot write and any verification fail", async () => {
    const failedApi = vi.fn(async () => { throw new ApiError(502, true); });
    expect(await triage(e, failedApi, 100, repo, 1, { title: "Crash" }, ["bug"], new Map([["bug", { description: "Broken" }]]), new Map(), Date.now() + 60_000)).toBe("failed");
    expect((await e.DB.prepare("SELECT * FROM triage_labels").all()).results).toEqual([]);
    applied.add("bug");
    const c = await createCleanup(e, 10, 100, repo, { labels: "triage", comments: false, definitions: false }, "admin", false);
    await runCleanup(e, c!.cleanup.id);
    expect((await getCleanup(e, 100, c!.cleanup.id))?.state).toBe("done"); expect(deleted).toEqual([]); expect(applied.has("bug")).toBe(true);
  });
  it.each(["bug", LABELS[2]])("preserves %s reapplied by a human after preview", async (name) => {
    applied.add(name); await e.DB.prepare("INSERT INTO triage_labels VALUES(100,1,?,0)").bind(name).run(); const id = await candidate(name);
    read(1, [event(name), event(name, 2, human, "unlabeled"), event(name, 3, human)]); await runCleanup(e, id);
    expect(applied.has(name)).toBe(true); expect(deleted).toEqual([]); expect(await getCleanup(e, 100, id)).toMatchObject({ state: "done", skipped: 1, done: 0 });
  });
  it("uses the latest exact label event even when the response is out of order", async () => {
    const id = await candidate("bug"); read(1, [event("bug", 3, human), event("feature", 4), event("bug", 1)]); await runCleanup(e, id); expect(deleted).toEqual([]);
  });
  it.each([true, false])("checks later event pages before deletion (bot owns: %s)", async (owns) => {
    applied.add("bug"); const id = await candidate("bug");
    read(1, [event("bug"), ...Array.from({ length: 99 }, (_, i) => event("other", i + 2))]); read(1, [event("bug", 101, owns ? bot : human)], 2);
    await runCleanup(e, id); expect(deleted.length).toBe(owns ? 1 : 0); expect(applied.has("bug")).toBe(!owns);
  });
  it.each([
    { title: "no event", body: [] }, { title: "unlabeled", body: [event("bug", 1, bot, "unlabeled")] },
    { title: "other bot", body: [event("bug", 1, { type: "Bot", login: "other[bot]" })] },
    { title: "spoofed login", body: [event("bug", 1, { type: "User", login: bot.login })] },
    { title: "conflicting App", body: [{ ...event("bug"), performed_via_github_app: { slug: "other" } }] },
    { title: "unknown actor", body: [{ ...event("bug"), actor: null }] }, { title: "missing chronology", body: [{ ...event("bug"), created_at: null }] },
    { title: "invalid response", body: {} }, { title: "failed read", body: {}, status: 502 }, { title: "missing issue", body: {}, status: 404 },
  ])("skips unresolved attribution: $title", async ({ body, status }) => {
    applied.add("bug"); const id = await candidate("bug"); read(1, body, 1, status ?? 200); await runCleanup(e, id);
    expect(applied.has("bug")).toBe(true); expect(deleted).toEqual([]); expect(await getCleanup(e, 100, id)).toMatchObject({ state: "done", skipped: 1 });
  });
  it("skips histories exceeding five pages without guessing", async () => {
    const id = await candidate("bug"); for (let page = 1; page <= 5; page++) read(1, Array.from({ length: 100 }, (_, i) => event(i === 0 ? "bug" : "other", page * 100 + i)), page);
    await runCleanup(e, id); expect(deleted).toEqual([]); expect(calls.filter((x) => x.includes("/events?"))).toHaveLength(5);
  });
  it("keeps execution under forty GitHub calls for five-page histories", async () => {
    const id = await candidate("bug", "issue_label", 7);
    for (let number = 1; number <= 7; number++) for (let page = 1; page <= 5; page++) read(number, Array.from({ length: page === 5 ? 99 : 100 }, (_, i) => event(i === 0 ? "bug" : "other", page * 100 + i)), page);
    await runCleanup(e, id); expect(calls.length).toBeLessThanOrEqual(40); expect(deleted).toHaveLength(6); expect((await cleanupItems(e, id)).filter((x) => x.state === "pending")).toHaveLength(1);
    calls.splice(0); await runCleanup(e, id); expect(deleted).toHaveLength(7); expect((await getCleanup(e, 100, id))?.state).toBe("done");
  });
  it.each([true, false])("executes combined review cleanup before definitions (bot owned: %s)", async (owned) => {
    applied.add(LABELS[2]);
    const c = await createCleanup(e, 10, 100, repo, { labels: "review", comments: false, definitions: true }, "admin", false);
    await runCleanup(e, c!.cleanup.id);
    expect((await cleanupItems(e, c!.cleanup.id)).map((x) => x.kind)).toEqual(["issue_label", "label"]);
    expect(await confirmCleanup(e, 100, { token: c!.token }, "admin")).toBe("ok");
    read(1, [event(LABELS[2], 1, owned ? bot : human)]);
    await runCleanup(e, c!.cleanup.id);
    expect(deleted).toEqual(owned ? [
      `${gh}/repos/${repo}/issues/1/labels/${encodeURIComponent(LABELS[2])}`,
      `${gh}/repos/${repo}/labels/${encodeURIComponent(LABELS[2])}`,
    ] : []);
    expect(applied.has(LABELS[2])).toBe(!owned);
  });
  it.each([true, false])("deletes review definitions only when unused (in use: %s)", async (used) => {
    if (used) applied.add(LABELS[2]); definitionUsed = used; const id = await candidate(LABELS[2], "label"); await runCleanup(e, id);
    expect(deleted.length).toBe(used ? 0 : 1); expect(applied.has(LABELS[2])).toBe(used); expect(await getCleanup(e, 100, id)).toMatchObject({ done: used ? 0 : 1, skipped: used ? 1 : 0 });
  });
});
