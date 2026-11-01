import { env } from "cloudflare:test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ui } from "../src/ui";
import { seal } from "../src/secrets";
import { DEFAULT_SETTINGS, putSettings } from "../src/settings";
import { dispatchCleanups } from "../src/cleanup";
import { JEV_ENDPOINT, JEV_MODEL } from "../src/jev";

declare const TEST_SQL: string[];
const origin = "https://bot.example";
const repository = "owner/repo";
const url = `${origin}/admin/intent-preview?installation_id=10&repository=100`;
const sampleTitle = 'Synthetic <script>alert("title")</script>';
const sampleBody =
  'PRIVATE_SYNTHETIC_BODY </textarea><script>alert("body")</script>';
const key = "private-test-provider-key";
const e: Env = {
  ...(env as Env),
  TRIAGE_PROVIDER: "jev",
  OPENROUTER_API_KEY: key,
};
const requests: { url: string; method: string; body?: string }[] = [];
let accessible = true;
let administrator = true;
let outage = false;
let liveRepositoryId = 100;
let liveFullName = repository;
let csrf: string;
let cookie: string;
const form = (extra: Record<string, string> = {}) =>
  new URLSearchParams({
    csrf,
    preview_kind: "issue",
    preview_title: sampleTitle,
    preview_body: sampleBody,
    ...extra,
  });
const post = (
  body = form(),
  headers: Record<string, string> = { origin },
  authenticated = true,
  target = url,
) =>
  ui(
    new Request(target, {
      method: "POST",
      headers: {
        ...(authenticated ? { cookie } : {}),
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body,
    }),
    e,
  );
const modelCalls = () =>
  requests.filter((request) => request.url === JEV_ENDPOINT);
const count = async (table: string) =>
  (await e.DB.prepare(`SELECT count(*) n FROM ${table}`).first<{
    n: number;
  }>())!.n;

beforeAll(async () => {
  for (const sql of TEST_SQL) await e.DB.prepare(sql).run();
});
beforeEach(async () => {
  await e.DB.exec(
    "DELETE FROM sessions; DELETE FROM repo_settings; DELETE FROM jobs; DELETE FROM triage_labels; DELETE FROM cleanups; DELETE FROM cleanup_items; DELETE FROM audit_log; DELETE FROM api_rate;",
  );
  await putSettings(
    e,
    10,
    100,
    repository,
    {
      ...DEFAULT_SETTINGS,
      allowedLabels: ["bug", "deleted"],
      triageEnabled: false,
      commentsEnabled: false,
    },
    "admin",
  );
  csrf = crypto.randomUUID();
  cookie = `ghfind_bot_session=${csrf}`;
  await e.DB.prepare("INSERT INTO sessions(id,value,expires) VALUES(?,?,?)")
    .bind(
      `session:${csrf}`,
      await seal(e, "test-user-token"),
      Date.now() + 3600000,
    )
    .run();
  requests.splice(0);
  accessible = true;
  administrator = true;
  outage = false;
  liveRepositoryId = 100;
  liveFullName = repository;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const requested = String(input),
        method = init.method || "GET";
      requests.push({
        url: requested,
        method,
        body: typeof init.body === "string" ? init.body : undefined,
      });
      if (requested === JEV_ENDPOINT && method === "POST")
        return outage
          ? Response.json(
              { error: `${key} PRIVATE_PROVIDER_ERROR_DETAIL ${sampleBody}` },
              { status: 503 },
            )
          : Response.json({
              model: JEV_MODEL,
              answers: { label_0: { type: "noul", noul: 0.95 } },
            });
      if (method !== "GET") throw new Error("Unexpected GitHub mutation");
      if (requested === "https://api.github.com/user/installations?per_page=100&page=1")
        return Response.json({ installations: [{ id: 10, account: { login: "synthetic" } }] });
      if (
        requested ===
        "https://api.github.com/user/installations/10/repositories?per_page=100&page=1"
      )
        return Response.json({
          repositories: accessible ? [{ id: 100, full_name: repository }] : [],
        });
      if (requested === `https://api.github.com/repos/${repository}`)
        return Response.json({
          id: liveRepositoryId,
          full_name: liveFullName,
          permissions: { admin: administrator, push: true },
        });
      if (
        requested ===
        `https://api.github.com/repos/${repository}/labels?per_page=100&page=1`
      )
        return Response.json([
          { name: "bug", description: "Broken software", color: "112233" },
          { name: "not-allowed", description: "Anything" },
        ]);
      throw new Error("Unexpected network request");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("intent preview authorization and cost isolation", () => {
  it("rejects anonymous, cross-origin, missing-origin, CSRF-invalid and GET requests before model calls", async () => {
    expect((await post(form(), { origin }, false)).status).toBe(403);
    expect(
      (await post(form(), { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await post(form(), {})).status).toBe(403);
    expect((await post(form({ csrf: "invalid" }))).status).toBe(403);
    expect(
      (await ui(new Request(url, { headers: { cookie } }), e)).status,
    ).toBe(405);
    expect(requests).toEqual([]);
    expect(await count("api_rate")).toBe(0);
  });
  it("checks installation scope and live administrator status on every submission", async () => {
    accessible = false;
    expect((await post()).status).toBe(404);
    accessible = true;
    administrator = false;
    expect((await post()).status).toBe(403);
    administrator = true;
    expect((await post()).status).toBe(200);
    administrator = false;
    expect((await post()).status).toBe(403);
    expect(modelCalls()).toHaveLength(1);
    expect(
      requests.filter(
        (request) =>
          request.url === `https://api.github.com/repos/${repository}`,
      ),
    ).toHaveLength(3);
  });
  it.each([
    { reason: "transferred owner", id: 100, fullName: "new-owner/repo" },
    { reason: "wrong repository identifier", id: 200, fullName: repository },
  ])(
    "rejects stale installation metadata after $reason before preview or toggle side effects",
    async ({ id, fullName }) => {
      const settingsBefore = await e.DB.prepare(
        "SELECT * FROM repo_settings WHERE repository=100",
      ).first();
      liveRepositoryId = id;
      liveFullName = fullName;
      // The live response still grants admin: identity and owner must be checked too.
      expect(administrator).toBe(true);
      expect((await post()).status).toBe(403);
      const toggleUrl = `${origin}/admin/toggle?installation_id=10&repository=100`;
      expect(
        (
          await post(
            new URLSearchParams({ csrf, enabled: "off" }),
            { origin },
            true,
            toggleUrl,
          )
        ).status,
      ).toBe(403);
      expect(
        await e.DB.prepare(
          "SELECT * FROM repo_settings WHERE repository=100",
        ).first(),
      ).toEqual(settingsBefore);
      expect(modelCalls()).toHaveLength(0);
      for (const table of ["api_rate", "audit_log", "jobs", "triage_labels"])
        expect(await count(table)).toBe(0);
      expect(requests).toHaveLength(6);
      expect(requests.filter(request => request.url === "https://api.github.com/user/installations?per_page=100&page=1")).toHaveLength(2);
      expect(
        requests.every(
          (request) =>
            request.method === "GET" &&
            (request.url === "https://api.github.com/user/installations?per_page=100&page=1" ||
              request.url.endsWith("/repositories?per_page=100&page=1") ||
              request.url === `https://api.github.com/repos/${repository}`),
        ),
      ).toBe(true);
    },
  );
  it("uses current saved candidates, escapes samples, and creates no jobs, labels, audit or email writes", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<script>alert("body")');
    expect(html.includes(key)).toBe(false);
    expect(modelCalls()).toHaveLength(1);
    const sent = JSON.parse(modelCalls()[0].body!);
    expect(Object.keys(sent.questions)).toEqual(["label_0"]);
    expect(sent.questions.label_0.criteria.true).toBe("Broken software");
    expect(JSON.stringify(sent)).not.toMatch(/deleted|not-allowed/);
    expect(
      requests.filter(
        (request) =>
          request.url.startsWith("https://api.github.com") &&
          request.method !== "GET",
      ),
    ).toEqual([]);
    for (const table of [
      "jobs",
      "triage_labels",
      "audit_log",
      "cleanups",
      "author_subscriptions",
      "email_receipts",
    ]) {
      if (
        await e.DB.prepare(
          "SELECT name FROM sqlite_schema WHERE name=? AND type='table'",
        )
          .bind(table)
          .first()
      )
        expect(await count(table)).toBe(0);
    }
    const rows = await e.DB.prepare(
      "SELECT key,slot,count FROM api_rate",
    ).all();
    expect(JSON.stringify(rows.results)).not.toContain(
      "PRIVATE_SYNTHETIC_BODY",
    );
  });
  it("accepts bounded multilingual samples whose form encoding exceeds 64 KiB", async () => {
    const input = form({
      preview_title: "界".repeat(256),
      preview_body: "界".repeat(8000),
    });
    expect(input.toString().length).toBeGreaterThan(65536);
    expect((await post(input)).status).toBe(200);
    expect(modelCalls()).toHaveLength(1);
    const sent = JSON.parse(modelCalls()[0].body!);
    expect(sent.state.body.length).toBe(8000);
    expect(sent.state.title.length).toBe(256);
  });
  it("retains the minute limit across scheduled cleanup and rejects a second paid call", async () => {
    // Freeze the minute so a boundary cannot make this assertion flaky.
    vi.spyOn(Date, "now").mockReturnValue(1791374405000);
    await e.DB.prepare("UPDATE sessions SET expires=?")
      .bind(Date.now() + 3600000)
      .run();
    expect((await post()).status).toBe(200);
    await dispatchCleanups(e);
    expect(await count("api_rate")).toBe(1);
    expect((await post()).status).toBe(429);
    expect(modelCalls()).toHaveLength(1);
  });
  it("redacts outage detail and consumes the same rate budget for a failed model call", async () => {
    outage = true;
    const failed = await post();
    expect(failed.status).toBe(503);
    const html = await failed.text();
    expect(html.includes(key)).toBe(false);
    expect(html.includes("PRIVATE_PROVIDER_ERROR_DETAIL")).toBe(false);
    expect((await post()).status).toBe(429);
    expect(modelCalls()).toHaveLength(1);
  });
});
