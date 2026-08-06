import { describe, it, expect } from "vitest";
import { GhFind, GhFindError } from "./client.js";
import type { FetchLike } from "./client.js";
import type { ScorePayload } from "./types.js";

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

  it("scan follows a 202 public job Location", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.endsWith("/api/scan")) {
        return {
          status: 202,
          json: { id: "job_aaaaaaaaaaaaaaaa", state: "queued" },
          headers: { location: "/api/scan/jobs/job_aaaaaaaaaaaaaaaa" },
        };
      }
      return {
        json: {
          status: { state: "completed" },
          result: { metrics: { username: "octocat" }, scoring: { final_score: 42 } },
        },
      };
    });
    const gh = new GhFind({ host: "https://ghfind.com", fetch });

    const result = await gh.scan("octocat");

    expect(result.scoring.final_score).toBe(42);
    expect(calls.map((c) => c.url)).toEqual([
      "https://ghfind.com/api/scan",
      "https://ghfind.com/api/scan/jobs/job_aaaaaaaaaaaaaaaa",
    ]);
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
