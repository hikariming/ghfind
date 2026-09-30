import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { GhFind, GhFindError, GhFindPending } from "./client.js";
import type { FetchLike } from "./client.js";
import type { ScorePayload } from "./types.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Resolve `promise` while advancing fake timers (poll backoff sleeps). */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const r = (await outcome) as { value?: T; error?: unknown };
  if ("error" in r) throw r.error;
  return r.value as T;
}

function base64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** Build a fake fetch that records calls and returns scripted responses. */
function fakeFetch(
  handler: (url: string, init?: Parameters<FetchLike>[1]) => {
    ok?: boolean;
    status?: number;
    json?: unknown;
    text?: string;
    headers?: Record<string, string>;
  },
): { fetch: FetchLike; calls: { url: string; init?: Parameters<FetchLike>[1] }[] } {
  const calls: { url: string; init?: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    const headers = r.headers ?? {};
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json,
      text: async () => r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : ""),
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    };
  };
  return { fetch, calls };
}

describe("GhFind", () => {
  it("normalizes host and honors default", () => {
    expect(new GhFind({ host: "https://x.dev/", fetch: (async () => ({}) as never) }).host).toBe(
      "https://x.dev",
    );
  });

  it("getScore hits GET /api/score/{username}", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      json: { source: "quick", coverage: "quick", username: "torvalds", final_score: 99, tier: "夯", tier_key: "god" },
    }));
    const gh = new GhFind({ host: "https://ghfind.com", fetch });
    const r = await gh.getScore("torvalds");
    expect(r.source).toBe("quick");
    expect(r.final_score).toBe(99);
    expect(calls[0].url).toBe("https://ghfind.com/api/score/torvalds");
    expect(calls[0].init?.method).toBe("GET");
  });

  it("types worker-backed quick score payloads and legacy fallbacks", () => {
    const quick: ScorePayload = {
      source: "quick",
      coverage: "quick",
      cached: false,
      username: "octocat",
      display_name: null,
      avatar_url: null,
      profile_url: "https://github.com/octocat",
      final_score: 42,
      tier: "NPC",
      tier_key: "npc",
      sub_scores: {
        account_maturity: 1,
        original_project_quality: 1,
        contribution_quality: 1,
        ecosystem_impact: 1,
        community_influence: 1,
        activity_authenticity: 1,
      },
      tags: null,
      roast_line: null,
      percentile: null,
      profile: "https://ghfind.com/u/octocat",
    };
    const legacy: ScorePayload = { ...quick, source: "legacy_v5_v5_v3", coverage: "legacy", stale: true };

    expect([quick.source, legacy.source]).toEqual(["quick", "legacy_v5_v5_v3"]);
  });

  it("scan POSTs username and turnstile token", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { scoring: { final_score: 42 } } }));
    const gh = new GhFind({ host: "https://ghfind.com", turnstileToken: "tok", fetch });
    await gh.scan("octocat");
    const body = JSON.parse(calls[0].init!.body as string);
    expect(body).toEqual({ username: "octocat", turnstileToken: "tok" });
    expect(calls[0].init?.method).toBe("POST");
  });

  const pending = {
    status: 202,
    json: { username: "octocat", status: { state: "queued", phase: "queued" }, status_url: "/api/scan/status/octocat" },
    headers: { location: "/api/scan/status/octocat", "retry-after": "2" },
  };
  const running = { status: 202, json: { status: { state: "running", phase: "contribs", progress: 0.1 } } };
  const scanResult = { metrics: { username: "octocat" }, scoring: { final_score: 42 } };
  const done = { json: { status: { state: "done", phase: "publish", progress: 1 }, result: scanResult } };

  it("scan polls a 202 status Location with backoff until the result", async () => {
    const polls = [running, running, done];
    const sleeps: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
      sleeps.push(ms);
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    const { fetch, calls } = fakeFetch((url) => (url.endsWith("/api/scan") ? pending : polls.shift()!));
    const statuses: string[] = [];
    const gh = new GhFind({ host: "https://ghfind.com", fetch });

    const result = await settle(gh.scan("octocat", { onStatus: (s) => statuses.push(s.phase ?? s.state) }));

    expect(result).toEqual(scanResult);
    expect(calls.map((c) => c.url)).toEqual([
      "https://ghfind.com/api/scan",
      ...Array(3).fill("https://ghfind.com/api/scan/status/octocat"),
    ]);
    expect(sleeps).toEqual([2000, 3000, 4500]);
    expect(statuses).toEqual(["queued", "contribs", "contribs"]);
  });

  it("getScore waits for a first-time job, then reads the published score", async () => {
    let first = true;
    const score = { source: "indexed", username: "octocat", final_score: 42 };
    const { fetch, calls } = fakeFetch((url) => {
      if (!url.endsWith("/api/score/octocat")) return done;
      if (first) {
        first = false;
        return pending;
      }
      return { json: score };
    });
    const r = await settle(new GhFind({ host: "https://ghfind.com", fetch }).getScore("octocat"));
    expect(r).toEqual(score);
    expect(calls.map((c) => c.url.split("/api/")[1])).toEqual(["score/octocat", "scan/status/octocat", "score/octocat"]);
  });

  it("throws GhFindPending with the last status when the wait expires", async () => {
    const { fetch } = fakeFetch((url) => (url.includes("/api/score/") ? pending : running));
    const error = await settle(
      new GhFind({ host: "https://ghfind.com", fetch }).getScore("octocat", { waitMs: 10_000 }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhFindPending);
    expect(error).toMatchObject({
      status: 202,
      code: "scan_pending",
      statusUrl: "https://ghfind.com/api/scan/status/octocat",
      job: { state: "running", phase: "contribs", progress: 0.1 },
    });
  });

  it("waitMs 0 reports pending without polling", async () => {
    const { fetch, calls } = fakeFetch(() => pending);
    const error = await new GhFind({ fetch }).scan("octocat", { waitMs: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhFindPending);
    expect(calls).toHaveLength(1);
  });

  it("a failed job throws its error code, not pending", async () => {
    const failed = { json: { status: { state: "failed", error: "account_not_found" } } };
    const { fetch } = fakeFetch((url) => (url.endsWith("/api/scan") ? pending : failed));
    const error = await settle(new GhFind({ fetch }).scan("octocat")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhFindError);
    expect(error).not.toBeInstanceOf(GhFindPending);
    expect(error).toMatchObject({ code: "account_not_found" });
  });

  it("keeps polling a running job through a transient poll error", async () => {
    const busy = { ok: false, status: 503, json: { error: "github_unavailable", status: { state: "running" } } };
    const polls = [busy, done];
    const { fetch } = fakeFetch((url) => (url.endsWith("/api/scan") ? pending : polls.shift()!));
    expect(await settle(new GhFind({ fetch }).scan("octocat"))).toEqual(scanResult);
  });

  it("score returns only the scoring block", async () => {
    const { fetch } = fakeFetch(() => ({ json: { scoring: { final_score: 42, tier: "NPC" } } }));
    const gh = new GhFind({ fetch });
    expect(await gh.score("x")).toEqual({ final_score: 42, tier: "NPC" });
  });

  it("apiKey is sent as a bearer header on POST", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: {} }));
    const gh = new GhFind({ apiKey: "secret", fetch });
    await gh.scan("x");
    expect(calls[0].init?.headers?.authorization).toBe("Bearer secret");
  });

  it("throws GhFindError with code on non-2xx", async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 404, json: { error: "account_not_found" } }));
    const gh = new GhFind({ fetch });
    await expect(gh.getScore("nope")).rejects.toMatchObject({
      name: "GhFindError",
      status: 404,
      code: "account_not_found",
    });
  });

  it("roast parses the framed stream and header meta", async () => {
    const meta = { final_score: 88, tier: "顶级", delta: -2 };
    const stream = ["# Report", "line two", `\x1fTprogress...`, "more"].join("\n");
    const { fetch, calls } = fakeFetch((url) => {
      if (url.endsWith("/api/scan")) return { json: { scoring: {}, metrics: {} } };
      return { text: stream, headers: { "x-roast-meta": base64(JSON.stringify(meta)) } };
    });
    const gh = new GhFind({ fetch });
    const r = await gh.roast({ username: "torvalds" });
    expect(r.meta?.final_score).toBe(88);
    expect(r.progress).toEqual(["progress..."]);
    expect(r.report).toBe("# Report\nline two\nmore");
    // scan first, then roast
    expect(calls.map((c) => c.url)).toEqual([
      "https://ghfind.com/api/scan",
      "https://ghfind.com/api/roast",
    ]);
  });

  it("roast throws on an E frame", async () => {
    const { fetch } = fakeFetch(() => ({ text: `\x1fE{"error":"llm_quota"}` }));
    const gh = new GhFind({ fetch });
    await expect(gh.roast({ scan: { scoring: {} } as never })).rejects.toBeInstanceOf(GhFindError);
  });

  it("leaderboard builds query params", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { entries: [] } }));
    const gh = new GhFind({ fetch });
    await gh.leaderboard({ view: "trending", window: "7d" });
    expect(calls[0].url).toBe("https://ghfind.com/api/leaderboard?view=trending&window=7d");
  });

  it("getGitHubUser returns null on 404 and profile on 200", async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.includes("/users/ghost")
        ? { ok: false, status: 404 }
        : { json: { login: "torvalds", id: 1024025 } },
    );
    const gh = new GhFind({ fetch });
    expect(await gh.getGitHubUser("ghost")).toBeNull();
    expect((await gh.getGitHubUser("torvalds"))?.login).toBe("torvalds");
    expect(calls[0].url).toBe("https://api.github.com/users/ghost");
  });

  it("getGitHubUser throws on GitHub rate limit (not a false negative)", async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 403 }));
    const gh = new GhFind({ fetch });
    await expect(gh.userExists("x")).rejects.toMatchObject({ code: "github_rate_limited" });
  });

  it("passes an optional GitHub token as a bearer to GitHub", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { login: "x", id: 1 } }));
    const gh = new GhFind({ githubToken: "ghp_test", fetch });
    await gh.getGitHubUser("x");
    expect(calls[0].init?.headers?.authorization).toBe("Bearer ghp_test");
  });

  it("verifyExists short-circuits before calling ghfind when the user is missing", async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.includes("api.github.com") ? { ok: false, status: 404 } : { json: {} },
    );
    const gh = new GhFind({ fetch });
    await expect(gh.getScore("ghost", { verifyExists: true })).rejects.toMatchObject({
      code: "github_user_not_found",
      status: 404,
    });
    // Only GitHub was called; ghfind was never hit.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("api.github.com");
  });

  it("verifyExists proceeds to ghfind when the user exists", async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.includes("api.github.com")
        ? { json: { login: "torvalds", id: 1 } }
        : { json: { source: "indexed", final_score: 99 } },
    );
    const gh = new GhFind({ fetch });
    const r = await gh.getScore("torvalds", { verifyExists: true });
    expect(r.final_score).toBe(99);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/users/torvalds",
      "https://ghfind.com/api/score/torvalds",
    ]);
  });

  it("builds image URLs without a request", () => {
    const gh = new GhFind({ host: "https://ghfind.com", fetch: (async () => ({}) as never) });
    expect(gh.badgeUrl("torvalds", { lang: "zh" })).toBe(
      "https://ghfind.com/api/badge/torvalds?lang=zh",
    );
    expect(gh.cardUrl("torvalds")).toBe("https://ghfind.com/api/card/torvalds");
    expect(gh.vsCardUrl("a", "b")).toBe("https://ghfind.com/api/card/vs/a/b");
  });
});
