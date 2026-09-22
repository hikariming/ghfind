import { env, SELF } from "cloudflare:test";
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import worker, { verifySignature, webhook } from "../src/index";
import { putJob, runJob, Job, dispatch, mentionsBot } from "../src/jobs";
import {
  LABELS,
  scoreToLabel,
  scoreComment,
  syncComment,
  COMMENT_MARKER,
} from "../src/review";
import { ui } from "../src/ui";
import { ApiError, jsonRequest, appJWT, github } from "../src/github";

declare const TEST_SQL: string[];
const testEnv = env as Env;
interface Expectation {
  url: string;
  method: string;
  body?: string;
  status: number;
  response: string;
  headers?: Record<string, string>;
}
const pending: Expectation[] = [];
const fetchMock = {
  activate() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const at = pending.findIndex(
          (x) =>
            x.url === url &&
            x.method === method &&
            (x.body === undefined || x.body === init?.body),
        );
        if (at < 0) throw new Error(`Unexpected request: ${method} ${url}`);
        const x = pending.splice(at, 1)[0];
        return new Response(x.status === 204 ? null : x.response, {
          status: x.status,
          headers: x.headers,
        });
      }),
    );
  },
  disableNetConnect() {},
  deactivate() {
    vi.unstubAllGlobals();
  },
  assertNoPendingInterceptors() {
    expect(pending.splice(0)).toEqual([]);
  },
  get(origin: string) {
    return {
      intercept(match: { path: string; method?: string; body?: string }) {
        return {
          reply(
            status: number,
            response: string,
            options?: { headers: Record<string, string> },
          ) {
            pending.push({
              url: origin + match.path,
              method: match.method ?? "GET",
              body: match.body,
              status,
              response,
              headers: options?.headers,
            });
          },
        };
      },
    };
  },
};
const api = "https://api.github.com";
const repo = "AsperforMias/test-bot";
const signature = async (body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(testEnv.WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return (
    "sha256=" +
    Buffer.from(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    ).toString("hex")
  );
};
async function event(type: string, payload: unknown, id = "delivery-1") {
  const body = JSON.stringify(payload);
  return new Request("https://bot.example/webhook", {
    method: "POST",
    headers: {
      "x-github-event": type,
      "x-github-delivery": id,
      "x-hub-signature-256": await signature(body),
    },
    body,
  });
}
const prEvent = {
  action: "opened",
  number: 1,
  installation: { id: 10, node_id: "installation" },
  repository: { id: 100, full_name: repo, owner: { login: "AsperforMias" } },
};
const intercept = (path: string, body: unknown, status = 200, method = "GET") =>
  fetchMock
    .get(api)
    .intercept({ path, method })
    .reply(status, JSON.stringify(body));
function commentWrite(score: unknown = 82.7) {
  intercept(`/repos/${repo}/issues/1/comments?per_page=100&page=1`, []);
  fetchMock
    .get(api)
    .intercept({
      path: `/repos/${repo}/issues/1/comments`,
      method: "POST",
      body: JSON.stringify({
        body: scoreComment("AsperforMias", score, "ghfind-review-test"),
      }),
    })
    .reply(201, "{}");
}
function scope() {
  intercept(
    "/app/installations/10/access_tokens",
    { token: "installation-test-token" },
    201,
    "POST",
  );
  intercept("/repositories/100", { id: 100, full_name: repo, archived: false });
}
const labelList = () =>
  LABELS.map((name) => ({
    name,
    color: "123456",
    description: "Owner settings",
  }));
async function job(id = "job-1") {
  return testEnv.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(id)
    .first<Job>();
}
async function add(id = "job-1", kind: "label" | "initialize" = "label") {
  await putJob(testEnv, {
    id,
    installation: 10,
    repository: 100,
    full_name: repo,
    pr: 1,
    kind,
  });
}
beforeAll(async () => {
  for (const sql of TEST_SQL) await testEnv.DB.prepare(sql).run();
});
beforeEach(async () => {
  await testEnv.DB.exec("DELETE FROM jobs; DELETE FROM sessions;");
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
  fetchMock.deactivate();
  vi.restoreAllMocks();
});

describe("GitHub App delivery", () => {
  it("honors rate-limit headers without waiting for a stalled error body", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("{"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 429, headers: { "retry-after": "90" } },
    );
    await expect(
      jsonRequest(
        "https://example.test",
        {},
        Date.now() + 100,
        async () => response,
      ),
    ).rejects.toMatchObject({ status: 429, retry: true, delay: 90000 });
    expect(cancelled).toBe(true);
  });

  it("discovers selected repositories using installation token and durable jobs", async () => {
    await putJob(testEnv, {
      id: "discover-1",
      installation: 10,
      kind: "discover",
    });
    intercept("/app/installations/10", {
      account: { login: "AsperforMias" },
      suspended_at: null,
    });
    intercept(
      "/app/installations/10/access_tokens",
      { token: "discovery-token" },
      201,
      "POST",
    );
    intercept("/installation/repositories?per_page=100&page=1", {
      repositories: [
        { id: 100, full_name: repo },
        { id: 101, full_name: "AsperforMias/archived", archived: true },
      ],
    });
    await runJob(testEnv, "discover-1");
    expect((await job("discover-1"))?.state).toBe("done");
    expect((await job("discover-1:repo:100"))?.kind).toBe("initialize");
    expect(await job("discover-1:repo:101")).toBeNull();
  });
  it("starts execution budget when a queued job is claimed, not when the event arrived", async () => {
    await add("job-1", "initialize");
    await testEnv.DB.prepare("UPDATE jobs SET created=? WHERE id=?")
      .bind(Date.now() - 3600000, "job-1")
      .run();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("done");
  });
  it("requires the session user to be repository admin for retries", async () => {
    await add();
    await testEnv.DB.prepare("UPDATE jobs SET state='failed' WHERE id=?")
      .bind("job-1")
      .run();
    const e = { ...testEnv, APP_CLIENT_ID: "client-test" };
    const login = await ui(
      new Request("https://bot.example/login?installation_id=10"),
      e,
    );
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    fetchMock
      .get("https://github.com")
      .intercept({ path: "/login/oauth/access_token", method: "POST" })
      .reply(200, JSON.stringify({ access_token: "user-test-token" }));
    const callback = await ui(
      new Request(`https://bot.example/callback?code=test&state=${state}`, {
        headers: { cookie: `ghfind_bot_state=${state}` },
      }),
      e,
    );
    const cookie = callback.headers.get("set-cookie")!.split(";")[0];
    const csrf = cookie.split("=")[1];
    intercept("/user/installations/10/repositories?per_page=100&page=1", {
      repositories: [{ id: 100, full_name: repo }],
    });
    intercept(`/repos/${repo}`, { permissions: { admin: false } });
    const denied = await ui(
      new Request("https://bot.example/retry?installation_id=10", {
        method: "POST",
        headers: { cookie, origin: "https://bot.example" },
        body: new URLSearchParams({ csrf, id: "job-1" }),
      }),
      e,
    );
    expect(denied.status).toBe(403);
    expect((await job())?.state).toBe("failed");
    intercept("/user/installations/11/repositories?per_page=100&page=1", {
      repositories: [],
    });
    const other = await ui(
      new Request("https://bot.example/setup?installation_id=11", {
        headers: { cookie },
      }),
      e,
    );
    expect(await other.text()).not.toContain(repo);
    const stored = await testEnv.DB.prepare(
      "SELECT value FROM sessions WHERE id LIKE 'session:%'",
    ).first<{ value: string }>();
    expect(stored?.value).not.toContain("user-test-token");
  });
  it("rejects cross-installation job retry even for an administrator elsewhere", async () => {
    await add();
    await testEnv.DB.prepare("UPDATE jobs SET state='failed' WHERE id=?")
      .bind("job-1")
      .run();
    const e = { ...testEnv, APP_CLIENT_ID: "client-test" };
    const login = await ui(
      new Request("https://bot.example/login?installation_id=11"),
      e,
    );
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    fetchMock
      .get("https://github.com")
      .intercept({ path: "/login/oauth/access_token", method: "POST" })
      .reply(200, JSON.stringify({ access_token: "user-test-token" }));
    const cb = await ui(
      new Request(`https://bot.example/callback?code=test&state=${state}`, {
        headers: { cookie: `ghfind_bot_state=${state}` },
      }),
      e,
    );
    const cookie = cb.headers.get("set-cookie")!.split(";")[0];
    intercept("/user/installations/11/repositories?per_page=100&page=1", {
      repositories: [{ id: 200, full_name: "AsperforMias/other" }],
    });
    const denied = await ui(
      new Request("https://bot.example/retry?installation_id=11", {
        method: "POST",
        headers: { cookie, origin: "https://bot.example" },
        body: new URLSearchParams({ csrf: cookie.split("=")[1], id: "job-1" }),
      }),
      e,
    );
    expect(denied.status).toBe(404);
  });

  it.each([
    [0, LABELS[0]],
    [39.99, LABELS[0]],
    [40, LABELS[1]],
    [69.99, LABELS[1]],
    [70, LABELS[2]],
    [89.99, LABELS[2]],
    [90, LABELS[3]],
    [100, LABELS[3]],
    [NaN, LABELS[4]],
    [-1, LABELS[4]],
    [101, LABELS[4]],
    [null, LABELS[4]],
    ["90", LABELS[4]],
  ])("score %s -> %s", (score, label) =>
    expect(scoreToLabel(score)).toBe(label),
  );
  it("verifies exact raw-body signatures", async () => {
    const body = '{"x":1}';
    expect(
      await verifySignature(
        body,
        await signature(body),
        testEnv.WEBHOOK_SECRET,
      ),
    ).toBe(true);
    expect(
      await verifySignature(
        body + " ",
        await signature(body),
        testEnv.WEBHOOK_SECRET,
      ),
    ).toBe(false);
    expect(await verifySignature(body, "sha256=zz", "secret")).toBe(false);
  });
  it("rejects unsigned requests before admission", async () => {
    const r = await SELF.fetch("https://bot.example/webhook", {
      method: "POST",
      body: JSON.stringify(prEvent),
    });
    expect(r.status).toBe(401);
    expect(await job("delivery-1")).toBeNull();
  });
  it("accepts real minimal PR installation shape and deduplicates delivery", async () => {
    expect(
      (await webhook(await event("pull_request", prEvent), testEnv)).status,
    ).toBe(202);
    expect(
      (await webhook(await event("pull_request", prEvent), testEnv)).status,
    ).toBe(202);
    expect(
      (
        await testEnv.DB.prepare("SELECT count(*) n FROM jobs").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
  });
  it("ignores accounts outside rollout and non-opened events", async () => {
    await webhook(
      await event("pull_request", { ...prEvent, action: "synchronize" }),
      testEnv,
    );
    await webhook(
      await event("pull_request", {
        ...prEvent,
        repository: { ...prEvent.repository, owner: { login: "someone-else" } },
      }),
      testEnv,
    );
    expect(await job("delivery-1")).toBeNull();
  });
  it("generates a bounded signed App JWT", () => {
    const token = appJWT(testEnv).split(".");
    const claims = JSON.parse(Buffer.from(token[1], "base64url").toString());
    expect(claims.iss).toBe("123");
    expect(claims.exp - claims.iat).toBe(600);
    expect(token[2].length).toBeGreaterThan(100);
  });
  it("initializes only missing labels and preserves custom settings", async () => {
    await add("job-1", "initialize");
    scope();
    intercept(
      `/repos/${repo}/labels?per_page=100&page=1`,
      labelList().slice(0, 4),
    );
    fetchMock
      .get(api)
      .intercept({
        path: `/repos/${repo}/labels`,
        method: "POST",
        body: JSON.stringify({
          name: LABELS[4],
          color: "c3c7ce",
          description: "ghfind author score missing (not zero)",
        }),
      })
      .reply(201, "{}");
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("done");
  });
  it("upgrades legacy bot colors while preserving customized labels", async () => {
    await add("job-1", "initialize");
    scope();
    intercept(
      `/repos/${repo}/labels?per_page=100&page=1`,
      LABELS.map((name, i) => ({
        name,
        color: i === 1 ? "123456" : "ededed",
        description:
          i === 4
            ? "ghfind author score missing (not zero)"
            : "ghfind author score; see https://ghfind.com",
      })),
    );
    for (const [i, color] of [
      [0, "d9dee3"],
      [2, "e2c0a2"],
      [3, "ded0a6"],
      [4, "c3c7ce"],
    ] as const)
      fetchMock
        .get(api)
        .intercept({
          path: `/repos/${repo}/labels/${encodeURIComponent(LABELS[i])}`,
          method: "PATCH",
          body: JSON.stringify({ color }),
        })
        .reply(200, "{}");
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("done");
  });
  it("labels an opened PR once and preserves unrelated labels", async () => {
    await add();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/issues/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, [
      { name: "bug" },
      { name: LABELS[0] },
    ]);
    intercept(`/repos/${repo}/issues/1/labels`, {}, 200, "POST");
    intercept(
      `/repos/${repo}/issues/1/labels/${encodeURIComponent(LABELS[0])}`,
      null,
      204,
      "DELETE",
    );
    commentWrite(82.7);
    await runJob(testEnv, "job-1");
    expect((await job())?.result).toBe(LABELS[2]);
    expect((await job())?.score).toBe("82.7");
    await runJob(testEnv, "job-1");
  });
  it("does not write when target label is already applied", async () => {
    await add();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/issues/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, [
      { name: LABELS[2] },
      { name: "bug" },
    ]);
    commentWrite(82.7);
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("done");
  });
  it("reconciles an ambiguous successful write before replaying", async () => {
    await add();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/issues/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, []);
    intercept(`/repos/${repo}/issues/1/labels`, {}, 502, "POST");
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("pending");
    expect((await job())?.attempts).toBe(1);
    await testEnv.DB.prepare("UPDATE jobs SET due=0 WHERE id=?")
      .bind("job-1")
      .run();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/issues/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, [
      { name: LABELS[2] },
    ]);
    commentWrite(82.7);
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("done");
  });
  it("fails closed if repository-scoped token cannot be issued after removal", async () => {
    await add();
    intercept("/app/installations/10/access_tokens", {}, 422, "POST");
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("failed");
  });
  it("cancels pending work on uninstall", async () => {
    await add();
    await webhook(
      await event("installation", {
        action: "deleted",
        installation: {
          id: 10,
          app_id: 123,
          account: { login: "AsperforMias" },
        },
      }),
      testEnv,
    );
    expect((await job())?.state).toBe("cancelled");
  });
  it("persists Retry-After without sleeping in the webhook", async () => {
    await add();
    fetchMock
      .get(api)
      .intercept({
        path: "/app/installations/10/access_tokens",
        method: "POST",
      })
      .reply(429, "{}", { headers: { "retry-after": "70" } });
    const before = Date.now();
    await runJob(testEnv, "job-1");
    expect((await job())!.due).toBeGreaterThanOrEqual(before + 70000);
  });
  it("terminates after seven retries", async () => {
    await add();
    await testEnv.DB.prepare("UPDATE jobs SET attempts=7 WHERE id=?")
      .bind("job-1")
      .run();
    intercept("/app/installations/10/access_tokens", {}, 502, "POST");
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("failed");
  });
  it("recovers expired leases but does not steal active jobs", async () => {
    await add("job-1", "initialize");
    await testEnv.DB.prepare(
      "UPDATE jobs SET state='running',lease=? WHERE id=?",
    )
      .bind(Date.now() + 600000, "job-1")
      .run();
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("running");
    await testEnv.DB.prepare("UPDATE jobs SET lease=0 WHERE id=?")
      .bind("job-1")
      .run();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("done");
  });
  it("uses unavailable after score deadline while reserving GitHub time", async () => {
    await add();
    await testEnv.DB.prepare("UPDATE jobs SET started=? WHERE id=?")
      .bind(Date.now() - 250000, "job-1")
      .run();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/issues/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, []);
    fetchMock
      .get(api)
      .intercept({
        path: `/repos/${repo}/issues/1/labels`,
        method: "POST",
        body: JSON.stringify({ labels: [LABELS[4]] }),
      })
      .reply(200, "{}");
    commentWrite(null);
    await runJob(testEnv, "job-1");
    expect((await job())?.result).toBe(LABELS[4]);
    const follow = await job("rescore-1-10-100-1");
    const last = await job("rescore-2-10-100-1");
    expect(follow?.state).toBe("pending");
    expect(follow?.due).toBeGreaterThan(Date.now() + 15 * 60_000);
    expect(follow?.due).toBeLessThan(Date.now() + 25 * 60_000);
    expect(last?.state).toBe("pending");
    expect(last?.due).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect(last?.due).toBeLessThan(Date.now() + 65 * 60_000);
    expect(await job("rescore-3-10-100-1")).toBeNull();
  });
  it("does not reschedule no-score when the account does not exist", async () => {
    await add();
    vi.spyOn(testEnv.SCORE, "fetch").mockResolvedValue(
      new Response("{}", { status: 404 }),
    );
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/issues/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, []);
    fetchMock
      .get(api)
      .intercept({
        path: `/repos/${repo}/issues/1/labels`,
        method: "POST",
        body: JSON.stringify({ labels: [LABELS[4]] }),
      })
      .reply(200, "{}");
    commentWrite(null);
    await runJob(testEnv, "job-1");
    expect((await job())?.result).toBe(LABELS[4]);
    expect(await job("rescore-1-10-100-1")).toBeNull();
  });
  it("does not schedule another automatic rescore after 60 minutes", async () => {
    await add("rescore-2-10-100-1");
    await testEnv.DB.prepare("UPDATE jobs SET started=? WHERE id=?")
      .bind(Date.now() - 250000, "rescore-2-10-100-1")
      .run();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/issues/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, [
      { name: LABELS[4] },
    ]);
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, [
      { name: LABELS[4] },
    ]);
    commentWrite(null);
    await runJob(testEnv, "rescore-2-10-100-1");
    expect((await job("rescore-2-10-100-1"))?.result).toBe(LABELS[4]);
    expect(await job("rescore-3-10-100-1")).toBeNull();
  });
  it("replaces no-score when a follow-up score arrives", async () => {
    await add("rescore-1-10-100-1");
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/issues/1`, {
      state: "open",
      user: { login: "AsperforMias", id: 5 },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, [
      { name: LABELS[4] },
    ]);
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, [
      { name: LABELS[4] },
    ]);
    fetchMock
      .get(api)
      .intercept({
        path: `/repos/${repo}/issues/1/labels`,
        method: "POST",
        body: JSON.stringify({ labels: [LABELS[2]] }),
      })
      .reply(200, "{}");
    intercept(
      `/repos/${repo}/issues/1/labels/${encodeURIComponent(LABELS[4])}`,
      null,
      204,
      "DELETE",
    );
    intercept(`/repos/${repo}/issues/1/comments?per_page=100&page=1`, [
      {
        id: 9,
        user: { login: "ghfind-review-test[bot]", type: "Bot" },
        body: scoreComment("AsperforMias", null),
      },
    ]);
    fetchMock
      .get(api)
      .intercept({
        path: "/repos/AsperforMias/test-bot/issues/comments/9",
        method: "PATCH",
        body: JSON.stringify({ body: scoreComment("AsperforMias", 82.7) }),
      })
      .reply(200, "{}");
    await runJob(testEnv, "rescore-1-10-100-1");
    expect((await job("rescore-1-10-100-1"))?.result).toBe(LABELS[2]);
  });
  it("lets a repository admin mention the bot to rescore no-score", async () => {
    expect(mentionsBot("@ghfind-review-test again", "ghfind-review-test")).toBe(
      true,
    );
    expect(mentionsBot("not a mention", "ghfind-review-test")).toBe(false);
    intercept(
      "/app/installations/10/access_tokens",
      { token: "installation-test-token" },
      201,
      "POST",
    );
    intercept(`/repos/${repo}/collaborators/AsperforMias/permission`, {
      permission: "admin",
    });
    intercept(`/repos/${repo}/issues/7/labels?per_page=100&page=1`, [
      { name: LABELS[4] },
    ]);
    const payload = {
      action: "created",
      installation: { id: 10 },
      repository: prEvent.repository,
      issue: { number: 7, user: { login: "other-person", type: "User" } },
      comment: {
        body: "Please @ghfind-review-test rescore",
        user: { login: "AsperforMias", type: "User" },
      },
    };
    expect(
      (await webhook(await event("issue_comment", payload), testEnv)).status,
    ).toBe(202);
    expect((await job("mention-delivery-1"))?.pr).toBe(7);
    expect((await job("mention-delivery-1"))?.state).toBe("pending");
    intercept(
      "/app/installations/10/access_tokens",
      { token: "installation-test-token" },
      201,
      "POST",
    );
    intercept(`/repos/${repo}/issues/7/labels?per_page=100&page=1`, [
      { name: LABELS[4] },
    ]);
    expect(
      (
        await webhook(
          await event(
            "issue_comment",
            {
              ...payload,
              issue: { number: 7, user: { login: "AsperforMias", type: "User" } },
            },
            "author",
          ),
          testEnv,
        )
      ).status,
    ).toBe(202);
    expect((await job("mention-author"))?.pr).toBe(7);
  });
  it("ignores mentions from non-admins and from the bot", async () => {
    intercept(
      "/app/installations/10/access_tokens",
      { token: "installation-test-token" },
      201,
      "POST",
    );
    intercept(`/repos/${repo}/collaborators/AsperforMias/permission`, {
      permission: "write",
    });
    const mention = {
      action: "created",
      installation: { id: 10 },
      repository: prEvent.repository,
      issue: { number: 7, user: { login: "other-person", type: "User" } },
      comment: {
        body: "@ghfind-review-test",
        user: { login: "AsperforMias", type: "User" },
      },
    };
    await webhook(await event("issue_comment", mention, "writer"), testEnv);
    await webhook(
      await event(
        "issue_comment",
        {
          ...mention,
          comment: {
            body: "@ghfind-review-test",
            user: { login: "ghfind-review-test[bot]", type: "Bot" },
          },
        },
        "bot",
      ),
      testEnv,
    );
    expect(await job("mention-writer")).toBeNull();
    expect(await job("mention-bot")).toBeNull();
  });
  it("blocks callbacks without matching browser state", async () => {
    expect(
      (await SELF.fetch("https://bot.example/callback?code=test&state=other"))
        .status,
    ).toBe(403);
  });
  it("does not expose jobs from an installation ID without authentication", async () => {
    await add();
    const r = await SELF.fetch("https://bot.example/setup?installation_id=10");
    expect(await r.text()).not.toContain(repo);
  });
  it("rejects archived labels without overwriting owner configuration", async () => {
    await add("job-1", "initialize");
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, [
      { name: LABELS[0], archived: true },
    ]);
    await runJob(testEnv, "job-1");
    expect((await job())?.result).toContain("Unarchive");
  });
  it("times out and cancels a stalled body", async () => {
    let cancelled = false;
    await expect(
      jsonRequest(
        "https://example.test",
        {},
        Date.now() + 20,
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("{"));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(cancelled).toBe(true);
  });
  it("keeps HTTP retries outside single-request transport", async () => {
    intercept("/test", {}, 500);
    await expect(jsonRequest(api + "/test")).rejects.toMatchObject({
      status: 500,
      retry: true,
    });
  });
  it("supports a paused rollout without discarding durable work", async () => {
    await add();
    const paused = { ...testEnv, ENABLED: "false" } as Env;
    await runJob(paused, "job-1");
    await dispatch(paused);
    expect((await job())?.state).toBe("pending");
    expect(
      (await worker.fetch(await event("pull_request", prEvent), paused)).status,
    ).toBe(503);
  });
});

describe("Issue support and score comments", () => {
  it("admits issue.number and ignores non-opened and PR-shaped issue events", async () => {
    const payload = { ...prEvent, number: undefined, issue: { number: 7 } };
    expect(
      (await webhook(await event("issues", payload), testEnv)).status,
    ).toBe(202);
    expect((await job("delivery-1"))?.pr).toBe(7);
    await webhook(
      await event("issues", { ...payload, action: "edited" }, "edited"),
      testEnv,
    );
    await webhook(
      await event(
        "issues",
        { ...payload, issue: { number: 7, pull_request: {} } },
        "pr-shaped",
      ),
      testEnv,
    );
    expect(await job("edited")).toBeNull();
    expect(await job("pr-shaped")).toBeNull();
  });
  it.each([
    [39.99, "0 ≤ score < 40"],
    [40, "40 ≤ score < 70"],
    [70, "70 ≤ score < 90"],
    [90, "90 ≤ score ≤ 100"],
    [100, "90 ≤ score ≤ 100"],
  ])("renders exact boundary %s", (score, range) => {
    expect(scoreComment("AsperforMias", score)).toContain(range);
    expect(scoreComment("AsperforMias", score)).toContain(
      "https://ghfind.com/en/u/AsperforMias",
    );
  });
  it("renders unavailable without presenting a zero score", () => {
    const body = scoreComment("AsperforMias", null);
    expect(body).toContain("No score");
    expect(body).toContain("`@ghfind-review`");
    expect(body).toContain("不会 @ 任何人");
    expect(body).not.toContain("0 / 100");
    expect(body).not.toMatch(/@(?!ghfind-review\b)[A-Za-z0-9-]/);
    expect(scoreComment("AsperforMias", 82.7)).not.toContain("重新评分");
  });
  it("recovers an ambiguous comment creation without posting a duplicate", async () => {
    const body = scoreComment("AsperforMias", 82.7);
    intercept(`/repos/${repo}/issues/1/comments?per_page=100&page=1`, []);
    intercept(`/repos/${repo}/issues/1/comments`, {}, 502, "POST");
    await expect(
      syncComment(
        github("test"),
        repo,
        1,
        "AsperforMias",
        82.7,
        "ghfind-review-test",
      ),
    ).rejects.toBeInstanceOf(ApiError);
    intercept(`/repos/${repo}/issues/1/comments?per_page=100&page=1`, [
      {
        id: 123,
        user: { login: "ghfind-review-test[bot]", type: "Bot" },
        body,
      },
    ]);
    await syncComment(
      github("test"),
      repo,
      1,
      "AsperforMias",
      82.7,
      "ghfind-review-test",
    );
  });
  it("paginates, ignores spoofed user markers and updates only its own comment", async () => {
    const fake = {
      id: 1,
      user: { login: "someone", type: "User" },
      body: COMMENT_MARKER,
    };
    intercept(
      `/repos/${repo}/issues/1/comments?per_page=100&page=1`,
      Array(100).fill(fake),
    );
    intercept(`/repos/${repo}/issues/1/comments?per_page=100&page=2`, [
      {
        id: 123,
        user: { login: "ghfind-review-test[bot]", type: "Bot" },
        body: COMMENT_MARKER,
      },
    ]);
    intercept(`/repos/${repo}/issues/comments/123`, {}, 200, "PATCH");
    await syncComment(
      github("test"),
      repo,
      1,
      "AsperforMias",
      82.7,
      "ghfind-review-test",
    );
  });
  it("fails before commenting when label reconciliation fails", async () => {
    await add();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/issues/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, []);
    intercept(`/repos/${repo}/issues/1/labels`, {}, 403, "POST");
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("failed");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).includes("/comments")),
    ).toBe(false);
  });
});
