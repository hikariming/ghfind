import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchScore, main, scoreToLabel, syncReviewLabel } from "./pr-review-label.mjs";

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("syncReviewLabel", () => {
  const target = "review-level: high";
  const repository = "example/project";
  const base = "https://api.github.com/repos/example/project";
  const targetURL = `${base}/labels/review-level%3A%20high`;
  const labelsURL = `${base}/issues/42/labels`;

  function githubFixture(initial: string[], failure?: { method: string; status: number }) {
    const labels = new Set(initial);
    const writes: string[] = [];
    const fetch = vi.fn(async (input: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
      if (failure?.method === method) return new Response(null, { status: failure.status });
      if (input === targetURL && method === "GET") return Response.json({ name: target });
      if (input.startsWith(`${labelsURL}?`) && method === "GET") {
        const page = Number(new URL(input).searchParams.get("page"));
        return Response.json([...labels].slice((page - 1) * 100, page * 100).map((name) => ({ name })));
      }
      if (input === labelsURL && method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ labels: [target] });
        labels.add(target);
        writes.push(`add ${target}`);
        return Response.json([...labels].map((name) => ({ name })));
      }
      if (input.startsWith(`${labelsURL}/`) && method === "DELETE") {
        const label = decodeURIComponent(input.slice(labelsURL.length + 1));
        expect(labels.has(target)).toBe(true);
        labels.delete(label);
        writes.push(`remove ${label}`);
        return Response.json([...labels].map((name) => ({ name })));
      }
      throw new Error(`Unexpected request: ${method} ${input}`);
    });
    vi.stubGlobal("fetch", fetch);
    return { labels, writes, fetch };
  }

  it("adds the target before removing all other fixed levels and preserves unrelated labels", async () => {
    const fixture = githubFixture([
      "bug", "review-level: custom", "review-level: low", "review-level: medium",
      "review-level: xhigh", "review-level: unavailable",
    ]);
    await syncReviewLabel(repository, 42, target, "test-token");
    expect(fixture.labels).toEqual(new Set(["bug", "review-level: custom", target]));
    expect(fixture.writes[0]).toBe(`add ${target}`);
    expect(fixture.writes).toHaveLength(5);
    expect(fixture.fetch.mock.calls[0][0]).toBe(targetURL);
  });

  it("is idempotent when only the target and unrelated labels exist", async () => {
    const fixture = githubFixture([target, "bug"]);
    await syncReviewLabel(repository, 42, target, "test-token");
    expect(fixture.writes).toEqual([]);
    expect(fixture.labels).toEqual(new Set([target, "bug"]));
  });

  it("cleans other levels even when the target already exists", async () => {
    const fixture = githubFixture([target, "review-level: low", "bug"]);
    await syncReviewLabel(repository, 42, target, "test-token");
    expect(fixture.writes).toEqual(["remove review-level: low"]);
    expect(fixture.labels).toEqual(new Set([target, "bug"]));
  });

  it("finds obsolete labels beyond the first page", async () => {
    const unrelated = Array.from({ length: 100 }, (_, i) => `label-${i}`);
    const fixture = githubFixture([...unrelated, "review-level: low"]);
    await syncReviewLabel(repository, 42, target, "test-token");
    expect(fixture.labels).toEqual(new Set([...unrelated, target]));
  });

  it("reports a missing target as a configuration error without creating or mutating labels", async () => {
    const fixture = githubFixture(["review-level: low"], { method: "GET", status: 404 });
    await expect(syncReviewLabel(repository, 42, target, "test-token"))
      .rejects.toThrow(/configuration.*review-level: high/i);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(fixture.writes).toEqual([]);
  });

  it("keeps old labels when adding the target fails, without retries", async () => {
    const fixture = githubFixture(["review-level: low", "bug"], { method: "POST", status: 403 });
    await expect(syncReviewLabel(repository, 42, target, "test-token")).rejects.toThrow(/403/);
    expect(fixture.labels).toEqual(new Set(["review-level: low", "bug"]));
    expect(fixture.fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(fixture.writes).toEqual([]);
  });

  it("reports deletion failures and leaves the new target in place", async () => {
    const fixture = githubFixture(["review-level: low"], { method: "DELETE", status: 500 });
    await expect(syncReviewLabel(repository, 42, target, "test-token")).rejects.toThrow(/500/);
    expect(fixture.labels).toEqual(new Set(["review-level: low", target]));
    expect(fixture.fetch.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(1);
  });
});

describe("scoreToLabel", () => {
  it.each([
    [0, "review-level: low"],
    [39.99, "review-level: low"],
    [40, "review-level: medium"],
    [69.99, "review-level: medium"],
    [70, "review-level: high"],
    [89.99, "review-level: high"],
    [90, "review-level: xhigh"],
    [100, "review-level: xhigh"],
    [null, "review-level: unavailable"],
  ])("maps score %s to %s", (score, label) => {
    expect(scoreToLabel(score)).toBe(label);
  });
});

describe("fetchScore", () => {
  it("reads final_score from the public API in one unauthenticated GET", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ final_score: 70 }));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchScore("octocat")).toBe(70);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://ghfind.com/api/score/octocat",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
    expect(new Headers(fetch.mock.calls[0][1].headers).has("authorization")).toBe(false);
  });

  it.each([null, {}, { score: 70 }, { final_score: "70" }, { final_score: null },
    { final_score: -1 }, { final_score: 101 }, { final_score: Infinity }])(
    "returns unavailable for invalid payload %j", async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      expect(await fetchScore("octocat")).toBeNull();
    },
  );

  it.each([404, 429, 500, 503])("does not retry HTTP %s", async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchScore("octocat")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable for malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON")));
    expect(await fetchScore("octocat")).toBeNull();
  });

  it("does not retry network failures", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connection reset"));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchScore("octocat")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["headers", "body"])("aborts after 60 seconds while waiting for %s", async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal;
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal!;
      const pending = () => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return phase === "headers" ? pending() : Promise.resolve({ ok: true, json: pending });
    });
    vi.stubGlobal("fetch", fetch);
    const result = fetchScore("octocat");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeNull();
    expect(signal!.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("main", () => {
  async function eventEnvironment(event: unknown = {
    action: "opened", number: 42,
    sender: { login: "someone-else" },
    pull_request: { user: { login: "pr-author" } },
  }) {
    const directory = await mkdtemp(join(tmpdir(), "pr-review-label-"));
    tempDirectories.push(directory);
    const path = join(directory, "event.json");
    await writeFile(path, JSON.stringify(event));
    return {
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_EVENT_PATH: path,
      GITHUB_REPOSITORY: "base-owner/project",
      GITHUB_TOKEN: "test-token",
      GITHUB_ACTOR: "someone-else",
    };
  }

  it.each([
    [0, "review-level: low"], [40, "review-level: medium"],
    [70, "review-level: high"], [90, "review-level: xhigh"],
    [null, "review-level: unavailable"],
  ])("labels the event PR using the author's score %s", async (score, target) => {
    const env = await eventEnvironment();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://ghfind.com/api/score/pr-author") {
        return score === null ? new Response(null, { status: 503 }) : Response.json({ final_score: score });
      }
      const base = "https://api.github.com/repos/base-owner/project";
      if (url === `${base}/labels/${encodeURIComponent(target)}`) return Response.json({ name: target });
      if (url === `${base}/issues/42/labels?per_page=100&page=1`) return Response.json([]);
      if (url === `${base}/issues/42/labels` && init.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ labels: [target] });
        return Response.json([{ name: target }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await main(env);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.at(-1)?.[1].method).toBe("POST");
  });

  it.each(["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_EVENT_PATH"])(
    "fails before calling any API when %s is missing", async (key) => {
      const env = { ...await eventEnvironment(), [key]: "" };
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(main(env)).rejects.toThrow(/required/i);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    null, {}, { action: "synchronize", number: 42, pull_request: { user: { login: "author" } } },
    { action: "opened", number: -1, pull_request: { user: { login: "author" } } },
    { action: "opened", number: 42, pull_request: { user: { login: "" } } },
  ])("rejects invalid or unsupported PR events %j before network access", async (event) => {
    const env = await eventEnvironment(event);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(main(env)).rejects.toThrow(/event/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
