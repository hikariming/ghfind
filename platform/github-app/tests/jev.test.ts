import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/github";
import {
  classifyJev,
  JEV_ENDPOINT,
  JEV_BASE_URL,
  JEV_MODEL,
  jevConfigured,
  jevRequest,
  parseJev,
} from "../src/jev";
import { classifyIntent, triage } from "../src/triage";
declare const TEST_SQL: string[];
beforeAll(async () => {
  for (const sql of TEST_SQL) await (env as Env).DB.prepare(sql).run();
});
const KEY = "local-test-key";
const candidates = [
  { name: "问题", description: "Asks how to configure existing software" },
  { name: "bug", description: "Reports broken behavior" },
];
const allowed = candidates.map((label) => label.name);
const definitions = new Map(candidates.map((label) => [label.name, label]));
const jevEnv: Env = {
  ...(env as Env),
  TRIAGE_PROVIDER: "jev",
  OPENROUTER_API_KEY: KEY,
};
const response = (probabilities = [0.97, 0.1]) => ({
  model: `${JEV_MODEL}-20260917`,
  answers: Object.fromEntries(
    probabilities.map((noul, index) => [
      `label_${index}`,
      { type: "noul", noul },
    ]),
  ),
  usage: { input_tokens: 300, output_tokens: 30, cost: 0.0000126 },
});
afterEach(() => vi.unstubAllGlobals());
function mock(value: unknown, status = 200) {
  const fetcher = vi.fn(async () => Response.json(value, { status }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const preview = (
  settings: Env = jevEnv,
  names = allowed,
  labels: Map<string, Record<string, unknown>> = definitions,
) =>
  classifyIntent(
    settings,
    { title: "Proxy configuration", body: "How do I set an existing proxy?" },
    names,
    labels,
    Date.now() + 5000,
  );

describe("Jev intent decisions", () => {
  it("targets only the configured HTTPS API root with the Decisions path", async () => {
    const fetcher = mock(response());
    for (const [base, endpoint] of [
      ["", JEV_ENDPOINT],
      ["   ", JEV_ENDPOINT],
      [JEV_BASE_URL, JEV_ENDPOINT],
      [` ${JEV_BASE_URL}/ `, JEV_ENDPOINT],
      [
        "https://decisions.example.test/api///",
        "https://decisions.example.test/api/alpha/decisions",
      ],
      [
        "https://decisions.example.test:8443/custom/v1",
        "https://decisions.example.test:8443/custom/v1/alpha/decisions",
      ],
    ]) {
      const settings = { ...jevEnv, JEV_BASE_URL: base };
      expect(jevConfigured(settings)).toBe(true);
      expect((await preview(settings)).labels).toEqual(["问题"]);
      const [url, init] = fetcher.mock.calls.at(-1) as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(endpoint);
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Bearer ${KEY}`,
      );
      expect(JSON.parse(String(init.body)).model).toBe(JEV_MODEL);
    }
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("rejects unsafe or malformed operator URLs before sending credentials", async () => {
    const fetcher = mock(response());
    for (const base of [
      "http://decisions.example.test/api",
      "//decisions.example.test/api",
      "not-a-url",
      "https:decisions.example.test/api",
      "https://user:private@decisions.example.test/api",
      "https://user@decisions.example.test/api",
      "https://@decisions.example.test/api",
      "https://decisions.example.test/api?token=private",
      "https://decisions.example.test/api?",
      "https://decisions.example.test/api#private",
      "https://decisions.example.test/api#",
      "https://decisions.example.test/a pi",
      "https://decisions.example.test/a\npi",
      "https:\\decisions.example.test/api",
    ]) {
      const settings = { ...jevEnv, JEV_BASE_URL: base };
      expect(jevConfigured(settings)).toBe(false);
      await expect(preview(settings)).rejects.toThrow("Invalid Jev base URL");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed on endpoint redirects without forwarding credentials", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://other.example.test/collect" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      preview({
        ...jevEnv,
        JEV_BASE_URL: "https://decisions.example.test/api",
      }),
    ).rejects.toMatchObject({ status: 307 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([
      "https://decisions.example.test/api/alpha/decisions",
      expect.objectContaining({ redirect: "manual" }),
    ]);
  });

  it("uses Decisions Noul questions with authoritative definitions and opaque IDs", async () => {
    const fetcher = mock(response());
    const result = await preview();
    expect(result).toMatchObject({
      provider: "jev",
      labels: ["问题"],
      threshold: 0.8,
      probabilities: [
        { name: "问题", probability: 0.97 },
        { name: "bug", probability: 0.1 },
      ],
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(JEV_ENDPOINT);
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Bearer ${KEY}`,
    );
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe(JEV_MODEL);
    expect(sent).not.toHaveProperty("messages");
    expect(sent.questions.label_0).toMatchObject({
      type: "noul",
      criteria: { true: candidates[0].description },
    });
    expect(sent.questions.label_0.instructions).toContain("authoritative");
    expect(sent.questions.label_0.instructions).toContain(
      candidates[0].description,
    );
    expect(sent.questions.label_0.instructions).not.toContain(
      candidates[0].name,
    );
    expect(Object.keys(sent.questions)).toEqual(["label_0", "label_1"]);
  });

  it("preserves PR title and body as state for independent label decisions", () => {
    const sent = jevRequest(
      JEV_MODEL,
      {
        title: "Export public APIs",
        body: "Adds exports and corrects the API authoring rule.\n- [ ] Documentation update required",
        pull_request: {},
      },
      candidates,
    );
    expect(sent.state).toEqual({ kind: "pull request", title: "Export public APIs", body: "Adds exports and corrects the API authoring rule.\n- [ ] Documentation update required" });
    expect(Object.values(sent.questions).map((question) => question.criteria.true)).toEqual(candidates.map((label) => label.description));
    expect(parseJev(response([0.91, 0.87]), candidates, 0.8).labels).toEqual(allowed);
  });

  it("returns no labels for uncertain/negative answers and ranks at most three", () => {
    expect(parseJev(response([0.79, 0]), candidates, 0.8).labels).toEqual([]);
    const many = ["a", "b", "c", "d"].map((name) => ({
      name,
      description: name,
    }));
    expect(
      parseJev(response([0.85, 0.99, 0.9, 0.98]), many, 0.8).labels,
    ).toEqual(["b", "d", "c"]);
  });

  it("rejects missing, extra, unknown IDs, wrong model/types and invalid probabilities", () => {
    for (const value of [
      { ...response(), model: "other-model" },
      { ...response(), model: `${JEV_MODEL}-evil` },
      { ...response(), model: `${JEV_MODEL}-20260917-extra` },
      { ...response(), answers: { label_0: { type: "noul", noul: 1 } } },
      {
        ...response(),
        answers: {
          label_0: { type: "choice", noul: 1 },
          label_1: { type: "noul", noul: 1 },
        },
      },
      {
        ...response(),
        answers: {
          label_0: { type: "noul", noul: 1 },
          bug: { type: "noul", noul: 1 },
        },
      },
      response([1.01, 0]),
      response([-0.1, 0]),
      response([NaN, 0]),
      response([Infinity, 0]),
      { ...response(), usage: { input_tokens: -1, output_tokens: 30 } },
      {
        ...response(),
        usage: { input_tokens: 1, output_tokens: 30, cost: "free" },
      },
    ])
      expect(() => parseJev(value, candidates, 0.8)).toThrow();
  });

  it("requires the exact dated snapshot when one is configured", () => {
    const snapshot = `${JEV_MODEL}-20260917`;
    expect(parseJev(response(), candidates, 0.8, snapshot).model).toBe(
      snapshot,
    );
    for (const model of [
      JEV_MODEL,
      `${JEV_MODEL}-20261007`,
      `${snapshot}-extra`,
    ])
      expect(() =>
        parseJev({ ...response(), model }, candidates, 0.8, snapshot),
      ).toThrow("Unexpected Jev model");
  });

  it("bounds inputs and candidate count before any paid request", () => {
    const sent = jevRequest(
      JEV_MODEL,
      { title: "x".repeat(2000), body: "y".repeat(12000), pull_request: {} },
      candidates,
    );
    expect(sent.state.title.length).toBe(1000);
    expect(sent.state.body.length).toBe(8000);
    expect(sent.state.kind).toBe("pull request");
    expect(() => jevRequest(JEV_MODEL, {}, [])).toThrow();
    expect(() =>
      jevRequest(
        JEV_MODEL,
        {},
        Array.from({ length: 51 }, () => candidates[0]),
      ),
    ).toThrow();
  });

  it("validates configuration without invoking a generic LLM fallback", async () => {
    const fetcher = mock(response());
    for (const settings of [
      { ...jevEnv, OPENROUTER_API_KEY: "" },
      { ...jevEnv, JEV_THRESHOLD: "NaN" },
      { ...jevEnv, JEV_THRESHOLD: "0" },
      { ...jevEnv, JEV_MODEL: "openai/model" },
    ]) {
      expect(jevConfigured(settings)).toBe(false);
      await expect(preview(settings)).rejects.toThrow();
    }
    await expect(
      preview({ ...jevEnv, TRIAGE_PROVIDER: "unknown" }),
    ).rejects.toThrow();
    expect(jevConfigured(jevEnv)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("filters deleted, forbidden and admin-disallowed labels before asking Jev", async () => {
    const fetcher = mock(response([1]));
    const labels = new Map<string, Record<string, unknown>>([
      ...definitions,
      ["review: top", { name: "review: top", description: "reserved" }],
      [".", { name: "." }],
      ["..", { name: ".." }],
    ]);
    const result = await preview(
      jevEnv,
      ["问题", "问题", "deleted", "review: top", ".", ".."],
      labels,
    );
    expect(result.labels).toEqual(["问题"]);
    expect(JSON.stringify(fetcher.mock.calls[0])).not.toContain('"name":"bug"');
    expect(
      Object.keys(
        JSON.parse(
          String(
            (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body,
          ),
        ).questions,
      ),
    ).toEqual(["label_0"]);
  });

  it("keeps keys and private text out of outage errors", async () => {
    mock({ error: `${KEY} private-body` }, 503);
    const error = await classifyJev(
      jevEnv,
      { body: "private-body" },
      candidates,
      Date.now() + 5000,
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(String(error)).not.toMatch(/local-test-key|private-body/);
  });
});

describe("production Jev triage writes", () => {
  const run = (
    api: (path: string, method?: string, body?: unknown) => Promise<unknown>,
    current = new Map<string, Record<string, unknown>>(),
  ) =>
    triage(
      jevEnv,
      api,
      100,
      "owner/repo",
      7,
      { title: "title" },
      allowed,
      definitions,
      current,
      Date.now() + 5000,
    );
  it("adds exact permitted labels once and records only acknowledged writes", async () => {
    mock(response());
    const api = vi.fn(async () => ({}));
    expect(await run(api)).toBe("labeled");
    expect(api).toHaveBeenCalledExactlyOnceWith(
      "/repos/owner/repo/issues/7/labels",
      "POST",
      { labels: ["问题"] },
    );
    const rows = await jevEnv.DB.prepare(
      "SELECT label FROM triage_labels WHERE repository=100 AND number=7",
    ).all();
    expect(rows.results).toContainEqual({ label: "问题" });
    await jevEnv.DB.prepare(
      "DELETE FROM triage_labels WHERE repository=100 AND number=7",
    ).run();
  });
  it("keeps identical label names and acknowledged ledgers scoped to each repository's definitions", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(response([0.98, 0.04])))
      .mockResolvedValueOnce(Response.json(response([0.03, 0.97])));
    vi.stubGlobal("fetch", fetcher);
    const api = vi.fn(async () => ({}));
    const names = ["bug", "documentation"];
    const descriptions = [
      "Reports inaccurate documentation",
      "Reports broken program behavior",
    ];
    for (const [index, repository] of [701, 902].entries()) {
      const definitions = new Map(
        names.map((name, label) => [
          name,
          { name, description: descriptions[index === 0 ? label : 1 - label] },
        ]),
      );
      expect(
        await triage(
          jevEnv,
          api,
          repository,
          `tenant${index}/app`,
          42,
          {
            title: "Correct the installation guide",
            body: "The install command in the guide is misspelled.",
          },
          names,
          definitions,
          new Map(),
          Date.now() + 5000,
        ),
      ).toBe("labeled");
      const sent = JSON.parse(
        String(
          (fetcher.mock.calls[index] as unknown as [string, RequestInit])[1]
            .body,
        ),
      );
      expect(sent.questions.label_0.criteria.true).toBe(descriptions[index]);
      expect(Object.keys(sent.questions)).toEqual(["label_0", "label_1"]);
    }
    expect(api.mock.calls).toEqual([
      ["/repos/tenant0/app/issues/42/labels", "POST", { labels: ["bug"] }],
      [
        "/repos/tenant1/app/issues/42/labels",
        "POST",
        { labels: ["documentation"] },
      ],
    ]);
    const rows = await jevEnv.DB.prepare(
      "SELECT repository,number,label FROM triage_labels WHERE repository IN (701,902) ORDER BY repository",
    ).all();
    expect(rows.results).toEqual([
      { repository: 701, number: 42, label: "bug" },
      { repository: 902, number: 42, label: "documentation" },
    ]);
    await jevEnv.DB.prepare(
      "DELETE FROM triage_labels WHERE repository IN (701,902)",
    ).run();
  });
  it("skips replays without Jev or GitHub calls", async () => {
    const fetcher = mock(response());
    const api = vi.fn(async () => ({}));
    expect(await run(api, new Map([["bug", { name: "bug" }]]))).toBe(
      "already labeled",
    );
    expect(api).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("fails closed on provider outage and malformed answers", async () => {
    for (const [value, status] of [
      [{}, 503],
      [response([2, 0]), 200],
    ] as const) {
      mock(value, status);
      const api = vi.fn(async () => ({}));
      expect(await run(api)).toBe("failed");
      expect(api).not.toHaveBeenCalled();
    }
  });
  it("propagates GitHub quota errors and never records an ambiguous write", async () => {
    mock(response());
    const quota = new ApiError(429, true, 60000, true);
    await expect(
      run(
        vi.fn(async () => {
          throw quota;
        }),
      ),
    ).rejects.toBe(quota);
    expect(
      await run(
        vi.fn(async () => {
          throw new ApiError(502, true);
        }),
      ),
    ).toBe("failed");
    const rows = await jevEnv.DB.prepare(
      "SELECT label FROM triage_labels WHERE repository=100 AND number=7",
    ).all();
    expect(rows.results).toEqual([]);
  });
});
