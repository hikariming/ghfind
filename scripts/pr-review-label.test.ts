import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEW_LABELS, fetchScore, main, scoreToLabel, setupReviewLabels, syncReviewLabel } from "./pr-review-label.mjs";

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

  it("rejects a differently cased target returned by GitHub before PR writes", async () => {
    const fetch = vi.fn(async () => Response.json({ name: "REVIEW-LEVEL: HIGH" }));
    vi.stubGlobal("fetch", fetch);
    await expect(syncReviewLabel(repository, 42, target, "test-token")).rejects.toThrow(/exactly.*review-level: high.*case-sensitive/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([targetURL, expect.objectContaining({ method: "GET" })]);
  });

  it("keeps old labels when adding the target fails, without retries", async () => {
    const fixture = githubFixture(["review-level: low", "bug"], { method: "POST", status: 403 });
    await expect(syncReviewLabel(repository, 42, target, "test-token")).rejects.toThrow(/403/);
    expect(fixture.labels).toEqual(new Set(["review-level: low", "bug"]));
    expect(fixture.fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(fixture.writes).toEqual([]);
  });

  it("reports deletion failures and leaves the new target in place", async () => {
    vi.useFakeTimers();
    const fixture = githubFixture(["review-level: low"], { method: "DELETE", status: 500 });
    const result = expect(syncReviewLabel(repository, 42, target, "test-token")).rejects.toThrow(/500/);
    await vi.runAllTimersAsync();
    await result;
    expect(fixture.labels).toEqual(new Set(["review-level: low", target]));
    expect(fixture.fetch.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(8);
  });

  it.each(["POST", "DELETE"])("confirms a successful %s after its response is lost without repeating the write", async (method) => {
    const fixture = githubFixture(["review-level: low", "bug"]);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const response = await fixture.fetch(url, init);
      if (init.method === method) throw new TypeError("connection reset after committing the write");
      return response;
    }));
    await syncReviewLabel(repository, 42, target, "test-token");
    expect(fixture.labels).toEqual(new Set([target, "bug"]));
    expect(fixture.fetch.mock.calls.filter(([, init]) => init.method === method)).toHaveLength(1);
  });

  it.each(["errored", "stalled"])("finishes successful writes when response cleanup is %s", async (mode) => {
    vi.useFakeTimers();
    const fixture = githubFixture(["review-level: low", "bug"]);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const response = await fixture.fetch(url, init);
      if (init.method === "GET") return response;
      return new Response(new ReadableStream({
        start(controller) {
          if (mode === "errored") controller.error(new TypeError("terminated"));
        },
        cancel: () => new Promise<void>(() => {}),
      }), { status: 200 });
    }));
    let settled = false;
    const result = syncReviewLabel(repository, 42, target, "test-token")
      .catch((error: unknown) => error)
      .finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(await result).toBeUndefined();
    expect(fixture.labels).toEqual(new Set([target, "bug"]));
    expect(fixture.writes).toEqual([`add ${target}`, "remove review-level: low"]);
    expect(fixture.fetch).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a write only when confirmation shows it has not taken effect", async () => {
    vi.useFakeTimers();
    const fixture = githubFixture(["review-level: low"]);
    let attempts = 0;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "POST" && ++attempts === 1) throw new TypeError("connection reset");
      return fixture.fetch(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const result = syncReviewLabel(repository, 42, target, "test-token");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(attempts).toBe(1);
    expect(fixture.labels.has(target)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(attempts).toBe(2);
    expect(fixture.labels).toEqual(new Set([target]));
  });

  it("shares retries between a failed write and its confirmation requests", async () => {
    vi.useFakeTimers();
    const fixture = githubFixture(["review-level: low"]);
    let post = 0;
    let confirmations = 0;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "POST") { post++; throw new TypeError("lost response"); }
      if (post && url.startsWith(`${labelsURL}?`)) {
        confirmations++;
        return new Response(null, { status: 503 });
      }
      return fixture.fetch(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const result = expect(syncReviewLabel(repository, 42, target, "test-token")).rejects.toThrow(/503/);
    await vi.runAllTimersAsync();
    await result;
    expect(post).toBe(1);
    expect(confirmations).toBe(8);
    expect(fixture.labels).toEqual(new Set(["review-level: low"]));
  });

  it.each([
    [429, { "retry-after": "30" }, "", 30_000],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000090" }, "", 90_000],
    [403, {}, "You have exceeded a secondary rate limit", 60_000],
    [429, { "retry-after": "invalid" }, "", 60_000],
  ])("honors GitHub rate-limit response %s %j", async (status, headers, body, delay) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const fixture = githubFixture([target]);
    const fetch = vi.fn().mockResolvedValueOnce(new Response(body, { status, headers }))
      .mockImplementation(fixture.fetch);
    vi.stubGlobal("fetch", fetch);
    const result = syncReviewLabel(repository, 42, target, "test-token");
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    [403, { "retry-after": "30" }, 30_000],
    [403, { "retry-after": "Tue, 14 Nov 2023 22:13:50 GMT" }, 30_000],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000090" }, 90_000],
    [403, { "retry-after": "30", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000090" }, 90_000],
    [429, { "retry-after": "30" }, 30_000],
    [503, { "retry-after": "30" }, 30_000],
  ])("preserves HTTP %s server delays with a broken or unfinished body: %j", async (status, headers, delay) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const fixture = githubFixture([target]);
    for (const broken of [true, false]) {
      vi.setSystemTime(1_700_000_000_000);
      const response = new Response(new ReadableStream({
        start(controller) {
          if (broken) controller.error(new TypeError("terminated"));
          else controller.enqueue(new TextEncoder().encode('{"message":"secondary rate'));
        },
        cancel: () => new Promise<void>(() => {}),
      }), { status, headers });
      const readBody = vi.spyOn(response, "text");
      const fetch = vi.fn().mockResolvedValueOnce(response).mockImplementation(fixture.fetch);
      vi.stubGlobal("fetch", fetch);
      const result = syncReviewLabel(repository, 42, target, "test-token").catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(readBody).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it.each([true, false])("retries a failed 403 body without rate-limit headers (interrupted: %s)", async (interrupted) => {
    vi.useFakeTimers();
    const fixture = githubFixture([target]);
    const response = new Response(new ReadableStream({
      start(controller) {
        if (interrupted) controller.error(new TypeError("terminated"));
        else controller.enqueue(new TextEncoder().encode('{"message":"secondary rate'));
      },
    }), { status: 403 });
    const fetch = vi.fn().mockResolvedValueOnce(response).mockImplementation(fixture.fetch);
    vi.stubGlobal("fetch", fetch);
    const result = syncReviewLabel(repository, 42, target, "test-token").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync((interrupted ? 5_000 : 65_000) - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off persistent secondary limits beyond one minute", async () => {
    vi.useFakeTimers();
    const fixture = githubFixture([target]);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("secondary rate limit", { status: 403 }))
      .mockResolvedValueOnce(new Response("secondary rate limit", { status: 403 }))
      .mockImplementation(fixture.fetch);
    vi.stubGlobal("fetch", fetch);
    const result = syncReviewLabel(repository, 42, target, "test-token");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await result;
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

  it.each([400, 401, 403, 404, 422])("does not retry HTTP %s", async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchScore("octocat")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable for malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON")));
    expect(await fetchScore("octocat")).toBeNull();
  });

  it("exhausts seven retries on network failures", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValue(new Error("connection reset"));
    vi.stubGlobal("fetch", fetch);
    const result = fetchScore("octocat");
    await vi.runAllTimersAsync();
    expect(await result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it("uses exactly 5, 10, 20, 20, 20, 20, 20 seconds without jitter and creates fresh signals", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const result = fetchScore("octocat");
    await vi.advanceTimersByTimeAsync(0);
    for (const [i, delay] of [5_000, 10_000, 20_000, 20_000, 20_000, 20_000, 20_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetch).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(i + 2);
    }
    expect(await result).toBeNull();
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(new Set(calls.map(([, init]) => init?.signal)).size).toBe(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([408, 429, 500, 502, 503, 504])("recovers from HTTP %s", async (status) => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(Response.json({ final_score: 70 }));
    vi.stubGlobal("fetch", fetch);
    const result = fetchScore("octocat");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBe(70);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["30", "Tue, 14 Nov 2023 22:13:50 GMT"])("honors Retry-After %s beyond the ordinary 20-second cap", async (retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": retryAfter } }))
      .mockResolvedValueOnce(Response.json({ final_score: 70 }));
    vi.stubGlobal("fetch", fetch);
    const result = fetchScore("octocat");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(70);
  });

  it("returns unavailable when the server delay exceeds the score budget", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { "Retry-After": "600" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchScore("octocat")).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts an outstanding request at the four-minute score deadline", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return new Promise(() => {});
    }));
    const result = expect(fetchScore("octocat")).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(239_999);
    expect(signals).toHaveLength(4);
    expect(signals.at(-1)?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])("aborts after 60 seconds while waiting for %s", async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal;
    let requests = 0;
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      if (++requests > 1) return Promise.resolve(new Response(null, { status: 404 }));
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
    expect(signal!.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["headers", "body"])("starts recovery at the deadline even when %s ignores abort", async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal;
    const body = { final_score: 70 };
    let requests = 0;
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      if (++requests > 1) return Promise.resolve(new Response(null, { status: 404 }));
      signal = init.signal!;
      const late = () => new Promise((resolve) => {
        setTimeout(() => resolve(phase === "headers" ? Response.json(body) : body), 65_000);
      });
      return phase === "headers" ? late() : Promise.resolve({ ok: true, json: late });
    });
    vi.stubGlobal("fetch", fetch);
    let settled = false;
    const result = fetchScore("octocat").then((score) => {
      settled = true;
      return score;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(true);
    expect(await result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("repository label onboarding", () => {
  it("checks every page and initializes only missing labels, preserving custom configuration on reruns", async () => {
    const custom = { name: "review-level: low", color: "123abc", description: "Owner's custom description" };
    const labels = [...Array.from({ length: 100 }, (_, i) => ({ name: `custom-${i}` })), custom];
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toMatch(/^https:\/\/api.github.com\/repos\/another-owner\/another-repo\/labels/);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer owner-token");
      if (init.method === "GET") {
        const page = Number(new URL(url).searchParams.get("page"));
        return Response.json(labels.slice((page - 1) * 100, page * 100));
      }
      expect(init.method).toBe("POST");
      const label = JSON.parse(String(init.body));
      writes.push(label);
      labels.push(label);
      return Response.json(label, { status: 201 });
    }));
    const env = { GITHUB_REPOSITORY: "another-owner/another-repo", GITHUB_TOKEN: "owner-token" };
    await expect(main(env, ["--check-labels"])).rejects.toThrow(
      "missing repository labels: review-level: medium, review-level: high, review-level: xhigh, review-level: unavailable",
    );
    expect(writes).toEqual([]);
    await main(env, ["--init-labels"]);
    await main(env, ["--init-labels"]);
    await main(env, ["--check-labels"]);
    expect(writes).toHaveLength(4);
    expect(labels.at(100)).toEqual(custom);
  });

  it.each([false, true])("rejects differently cased labels during setup, initialize=%s", async (initialize) => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "POST") return new Response(null, { status: 422 });
      return Response.json(REVIEW_LABELS.map((name) => ({ name: name.toUpperCase() })));
    });
    vi.stubGlobal("fetch", fetch);
    await expect(setupReviewLabels("example/project", "token", initialize)).rejects.toThrow(
      initialize ? /HTTP 422/ : /missing repository labels: review-level: low, review-level: medium, review-level: high, review-level: xhigh, review-level: unavailable.*case-sensitive/,
    );
    expect(fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(initialize ? 1 : 0);
    expect(fetch.mock.calls.some(([, init]) => init.method === "PATCH")).toBe(false);
  });

  it.each(["lost response", "concurrent create"])("confirms creation after %s without overwriting", async (mode) => {
    let created = false;
    const writes = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "GET") return Response.json(REVIEW_LABELS.slice(created ? 0 : 1).map((name) => ({ name })));
      writes();
      created = true;
      if (mode === "lost response") throw new TypeError("connection lost");
      return new Response(null, { status: 422 });
    }));
    await setupReviewLabels("example/project", "token", true);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 422])("reports HTTP %s without treating API failure as an empty repository", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
    await expect(setupReviewLabels("example/project", "token", true)).rejects.toThrow(`HTTP ${status}`);
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

  it("reports all missing labels and owner setup links before scoring or PR writes", async () => {
    const env = await eventEnvironment();
    const fetch = vi.fn(async () => Response.json([{ name: "review-level: high" }]));
    vi.stubGlobal("fetch", fetch);
    await expect(main(env)).rejects.toThrow(
      /review-level: low, review-level: medium, review-level: xhigh, review-level: unavailable.*https:\/\/github.com\/base-owner\/project\/labels.*--init-labels/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(expect.arrayContaining([
      "https://api.github.com/repos/base-owner/project/labels?per_page=100&page=1",
    ]));
  });

  it.each([
    [0, "review-level: low"], [40, "review-level: medium"],
    [70, "review-level: high"], [90, "review-level: xhigh"],
    [null, "review-level: unavailable"],
  ])("labels the event PR using the author's score %s", async (score, target) => {
    const env = await eventEnvironment();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://ghfind.com/api/score/pr-author") {
        return score === null ? new Response(null, { status: 404 }) : Response.json({ final_score: score });
      }
      const base = "https://api.github.com/repos/base-owner/project";
      if (url === `${base}/labels?per_page=100&page=1`) return Response.json(REVIEW_LABELS.map((name) => ({ name })));
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
    expect(fetch).toHaveBeenCalledTimes(5);
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

  it("shares seven retries across score and GitHub calls without restarting the successful score step", async () => {
    const env = await eventEnvironment();
    vi.useFakeTimers();
    let scores = 0;
    let github = 0;
    const githubTimes: number[] = [];
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith("https://ghfind.com/")) {
        return ++scores <= 2 ? new Response(null, { status: 503 }) : Response.json({ final_score: 70 });
      }
      if (url.includes("/labels?")) return Response.json(REVIEW_LABELS.map((name) => ({ name })));
      github++;
      githubTimes.push(Date.now());
      return new Response(null, { status: 503 });
    });
    vi.stubGlobal("fetch", fetch);
    const result = expect(main(env)).rejects.toThrow(/503/);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await vi.runAllTimersAsync();
    await result;
    expect(scores).toBe(3);
    expect(github).toBe(6);
    expect(githubTimes.slice(1).map((time, i) => time - githubTimes[i])).toEqual([20_000, 20_000, 20_000, 20_000, 20_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 503])("still attempts unavailable labeling after score retries are exhausted, GitHub status %s", async (status) => {
    const env = await eventEnvironment();
    vi.useFakeTimers();
    let scores = 0;
    let github = 0;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith("https://ghfind.com/")) {
        scores++;
        return new Response(null, { status: 503 });
      }
      if (url.includes("/repos/base-owner/project/labels?")) return Response.json(REVIEW_LABELS.map((name) => ({ name })));
      github++;
      if (status === 503) return new Response(null, { status });
      if (url.includes("/repos/base-owner/project/labels/")) return Response.json({ name: "review-level: unavailable" });
      if (init.method === "POST") expect(JSON.parse(String(init.body))).toEqual({ labels: ["review-level: unavailable"] });
      return Response.json([]);
    });
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const execution = main(env);
    const result = status === 200 ? expect(execution).resolves.toBeUndefined() : expect(execution).rejects.toThrow(/503/);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await vi.runAllTimersAsync();
    await result;
    expect(scores).toBe(8);
    expect(github).toBe(status === 200 ? 3 : 1);
  });

  it.each(["headers", "body", "rate-limit", "slow-preflight", "github-timeout"])(
    "reserves GitHub time after score failure: %s", async (mode) => {
      const env = await eventEnvironment();
      vi.useFakeTimers();
      vi.setSystemTime(0);
      let scores = 0;
      const labels = new Set<string>();
      const githubTimes: number[] = [];
      const signals: AbortSignal[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
        if (url.startsWith("https://ghfind.com/")) {
          scores++;
          signals.push(init.signal!);
          if (mode === "rate-limit") return new Response(null, { status: 429, headers: { "Retry-After": "600" } });
          if (mode === "body") return { ok: true, json: () => new Promise(() => {}) };
          return new Promise(() => {});
        }
        if (url.includes("/repos/base-owner/project/labels?")) {
          if (mode === "slow-preflight") await new Promise((resolve) => setTimeout(resolve, 50_000));
          return Response.json(REVIEW_LABELS.map((name) => ({ name })));
        }
        githubTimes.push(Date.now());
        if (mode === "github-timeout") {
          if (githubTimes.length === 1) return new Response(null, { status: 503 });
          return new Promise(() => {});
        }
        // Three slow, successful GitHub calls must fit after the score deadline.
        await new Promise((resolve) => setTimeout(resolve, 50_000));
        if (url.includes("/repos/base-owner/project/labels/")) return Response.json({ name: "review-level: unavailable" });
        if (init.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({ labels: ["review-level: unavailable"] });
          labels.add("review-level: unavailable");
        }
        return Response.json([...labels].map((name) => ({ name })));
      }));
      const execution = main(env);
      const result = mode === "github-timeout"
        ? expect(execution).rejects.toThrow(/8-minute/)
        : expect(execution).resolves.toBeUndefined();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      await vi.runAllTimersAsync();
      await result;
      if (mode === "github-timeout") {
        expect(Date.now()).toBe(480_000);
        expect(labels.size).toBe(0);
      } else {
        expect(labels).toEqual(new Set(["review-level: unavailable"]));
        expect(githubTimes).toHaveLength(3);
        expect(Date.now()).toBeLessThan(480_000);
      }
      if (mode === "rate-limit") {
        expect(scores).toBe(1);
        expect(githubTimes[0]).toBeLessThan(240_000);
      } else {
        expect(githubTimes[0]).toBe(240_000);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
      }
      expect(vi.getTimerCount()).toBe(0);
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
