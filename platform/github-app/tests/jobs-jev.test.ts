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
import { Job, putJob, runJob } from "../src/jobs";
import { DEFAULT_SETTINGS, putSettings } from "../src/settings";
import { JEV_ENDPOINT, JEV_MODEL } from "../src/jev";
import { LABELS } from "../src/review";

declare const TEST_SQL: string[];
const e: Env = {
  ...(env as Env),
  TRIAGE_PROVIDER: "jev",
  OPENROUTER_API_KEY: "test-openrouter-key",
  LLM_API_KEY: undefined,
};
const repo = "AsperforMias/test-bot";
const issuePath = `/repos/${repo}/issues/1`;
const delivery = "jev-opened-delivery";
const routes: {
  url: string;
  method: string;
  status: number;
  response: unknown;
  body?: unknown;
}[] = [];
const calls: { url: string; method: string; body?: unknown }[] = [];
let decisionStatus = 200;
const route = (
  path: string,
  response: unknown,
  method = "GET",
  status = 200,
  body?: unknown,
) =>
  routes.push({
    url: `https://api.github.com${path}`,
    method,
    status,
    response,
    body,
  });

beforeAll(async () => {
  for (const sql of TEST_SQL) await e.DB.prepare(sql).run();
});
beforeEach(async () => {
  await e.DB.exec(
    "DELETE FROM jobs; DELETE FROM repo_settings; DELETE FROM triage_labels; DELETE FROM author_comment_once; DELETE FROM noscore_comment_budget;",
  );
  await putSettings(
    e,
    10,
    100,
    repo,
    {
      ...DEFAULT_SETTINGS,
      triageEnabled: true,
      allowedLabels: ["bug", "deleted"],
      commentsEnabled: false,
    },
    "admin",
  );
  await putJob(e, {
    id: delivery,
    installation: 10,
    repository: 100,
    full_name: repo,
    pr: 1,
    kind: "label",
  });
  route(
    "/app/installations/10/access_tokens",
    { token: "test-installation-token" },
    "POST",
    201,
  );
  route("/repositories/100", { id: 100, full_name: repo, archived: false });
  route(`/repos/${repo}/labels?per_page=100&page=1`, [
    ...LABELS.map((name) => ({
      name,
      color: "123456",
      description: "review label",
    })),
    { name: "bug", description: "Reports broken software behavior" },
  ]);
  route(issuePath, {
    state: "open",
    title: "Synthetic crash on startup",
    body: "App crashes immediately on startup instead of opening.",
    user: { login: "AsperforMias", id: 5 },
  });
  route(`${issuePath}/labels?per_page=100&page=1`, []);
  route(`${issuePath}/labels`, {}, "POST", 200, { labels: [LABELS[2]] });
  calls.splice(0);
  decisionStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input),
        method = init.method || "GET";
      const body =
        typeof init.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined;
      calls.push({ url, method, body });
      if (url === JEV_ENDPOINT)
        return decisionStatus === 200
          ? Response.json({
              model: JEV_MODEL,
              answers: { label_0: { type: "noul", noul: 0.98 } },
            })
          : Response.json(
              { error: "authentication failure" },
              { status: decisionStatus },
            );
      const index = routes.findIndex(
        (entry) =>
          entry.url === url &&
          entry.method === method &&
          (entry.body === undefined ||
            JSON.stringify(entry.body) === JSON.stringify(body)),
      );
      if (index < 0)
        throw new Error("Unexpected network request in Jev job regression");
      const entry = routes.splice(index, 1)[0];
      return Response.json(entry.response, { status: entry.status });
    }),
  );
});
afterEach(() => {
  expect(routes.splice(0)).toEqual([]);
  vi.unstubAllGlobals();
});

describe("job classifier capability separation", () => {
  it("uses Jev without a comment LLM key and records acknowledged exact allowed labels", async () => {
    expect(e.LLM_API_KEY).toBeUndefined();
    route(`${issuePath}/labels`, {}, "POST", 200, { labels: ["bug"] });
    await runJob(e, delivery);
    expect(
      await e.DB.prepare("SELECT * FROM jobs WHERE id=?")
        .bind(delivery)
        .first<Job>(),
    ).toMatchObject({ state: "done", result: LABELS[2], attempts: 0 });
    expect(
      (
        await e.DB.prepare(
          "SELECT number,label FROM triage_labels WHERE repository=100",
        ).all()
      ).results,
    ).toEqual([{ number: 1, label: "bug" }]);
    const decisions = calls.filter((call) => call.url === JEV_ENDPOINT);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].body).toMatchObject({
      model: JEV_MODEL,
      questions: {
        label_0: {
          type: "noul",
          criteria: { true: "Reports broken software behavior" },
        },
      },
    });
    expect(
      calls.some(
        (call) =>
          call.url.includes("chat/completions") ||
          call.url.includes("/comments"),
      ),
    ).toBe(false);
    expect(
      calls
        .filter(
          (call) =>
            call.url === `https://api.github.com${issuePath}/labels` &&
            call.method === "POST",
        )
        .map((call) => call.body),
    ).toEqual([{ labels: [LABELS[2]] }, { labels: ["bug"] }]);
  });
  it("keeps the normal review result and adds no intent labels when Jev authentication fails", async () => {
    decisionStatus = 401;
    await runJob(e, delivery);
    expect(
      await e.DB.prepare("SELECT * FROM jobs WHERE id=?")
        .bind(delivery)
        .first<Job>(),
    ).toMatchObject({ state: "done", result: LABELS[2], attempts: 0 });
    expect(
      (await e.DB.prepare("SELECT * FROM triage_labels").all()).results,
    ).toEqual([]);
    expect(calls.filter((call) => call.url === JEV_ENDPOINT)).toHaveLength(1);
    expect(
      calls.some(
        (call) =>
          call.url.includes("chat/completions") ||
          call.url.includes("/comments"),
      ),
    ).toBe(false);
    expect(
      calls
        .filter(
          (call) =>
            call.url === `https://api.github.com${issuePath}/labels` &&
            call.method === "POST",
        )
        .map((call) => call.body),
    ).toEqual([{ labels: [LABELS[2]] }]);
  });
});
