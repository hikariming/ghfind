import { afterEach, describe, expect, it, vi } from "vitest";
import { slidingWindowLimit } from "../../../apps/coord/src/sliding-window";
import { windowMs, type RateLimiterNamespace } from "../rate-limit-backend";

const env: { RATE_LIMITER?: RateLimiterNamespace } = {};
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env }) }));

/** In-memory stand-in for apps/coord's RateLimiter namespace: one counter map
 * per idFromName, running the real sliding-window algorithm. */
function fakeNamespace(options: { fail?: boolean } = {}) {
  const objects = new Map<string, Map<number, number>>();
  const calls: string[] = [];
  const ns: RateLimiterNamespace = {
    idFromName: (name) => name,
    get: (id) => ({
      async limit(tokens, ms) {
        const name = id as string;
        calls.push(name);
        if (options.fail) throw new Error("durable object unavailable");
        if (!objects.has(name)) objects.set(name, new Map());
        const counts = objects.get(name)!;
        return slidingWindowLimit(
          { get: (i) => counts.get(i) ?? 0, set: (i, n) => void counts.set(i, n) },
          tokens,
          ms,
          Date.now(),
        );
      },
    }),
  };
  return { ns, calls };
}

async function loadRedis() {
  vi.resetModules();
  return import("../redis");
}

function productionWithDurableObjects(ns: RateLimiterNamespace) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("GHFIND_DEPLOY_ENV", "production");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("GHFIND_RATELIMIT_BACKEND", "do");
  env.RATE_LIMITER = ns;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete env.RATE_LIMITER;
});

describe("windowMs", () => {
  it("parses the Upstash durations used in redis.ts", () => {
    expect(windowMs("60 s")).toBe(60_000);
    expect(windowMs("60 m")).toBe(3_600_000);
    expect(windowMs("1 d")).toBe(86_400_000);
  });
});

describe("Durable Object rate limiting", () => {
  it("serves production limits without Redis, with RateLimit headers", async () => {
    const { ns, calls } = fakeNamespace();
    productionWithDurableObjects(ns);
    const { checkRateLimit, rateLimitHeaders } = await loadRedis();

    const first = await checkRateLimit("198.51.100.10");
    expect(first).toMatchObject({ success: true, limit: 10, remaining: 9 });
    expect(first.unavailable).toBeUndefined();
    expect(rateLimitHeaders(first)).toMatchObject({ "RateLimit-Limit": "10", "RateLimit-Remaining": "9" });
    // Same key shape as @upstash/ratelimit: `<prefix>:<identifier>`.
    expect(calls).toEqual(["rl:scan:198.51.100.10"]);
  });

  it("blocks past the budget and answers repeat offenders in-isolate", async () => {
    vi.useFakeTimers({ now: 1_000 * 60_000 + 1_000 });
    const { ns, calls } = fakeNamespace();
    productionWithDurableObjects(ns);
    const { checkRateLimit, rateLimitHeaders } = await loadRedis();

    for (let i = 0; i < 10; i++) expect((await checkRateLimit("203.0.113.9")).success).toBe(true);
    const blocked = await checkRateLimit("203.0.113.9");
    expect(blocked).toMatchObject({ success: false, remaining: 0, reset: 1_001 * 60_000 });
    expect(rateLimitHeaders(blocked)["Retry-After"]).toBe("59");
    expect(calls).toHaveLength(11);

    // Blocked until the window ends: no further Durable Object calls.
    expect((await checkRateLimit("203.0.113.9")).success).toBe(false);
    expect(calls).toHaveLength(11);

    // A different identifier has its own budget.
    expect((await checkRateLimit("203.0.113.10")).success).toBe(true);
  });

  it("checks both burst and daily budgets for LLM routes", async () => {
    const { ns, calls } = fakeNamespace();
    productionWithDurableObjects(ns);
    const { checkRoastRateLimit } = await loadRedis();

    await expect(checkRoastRateLimit("principal-1")).resolves.toEqual({ success: true });
    expect(calls.sort()).toEqual(["rl:roast:d:principal-1", "rl:roast:m:principal-1"]);
  });

  it("fails closed in production when the Durable Object errors", async () => {
    const { ns } = fakeNamespace({ fail: true });
    productionWithDurableObjects(ns);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { checkRateLimit, checkVerdictRateLimit } = await loadRedis();

    await expect(checkRateLimit("198.51.100.10")).resolves.toMatchObject({ success: false, unavailable: true });
    await expect(checkVerdictRateLimit("198.51.100.10")).resolves.toMatchObject({ success: false, unavailable: true });
  });

  it("stays on Upstash semantics when the flag is off even if bound", async () => {
    const { ns, calls } = fakeNamespace();
    productionWithDurableObjects(ns);
    vi.stubEnv("GHFIND_RATELIMIT_BACKEND", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { checkRateLimit } = await loadRedis();

    // No Redis configured → production fails closed exactly as before.
    await expect(checkRateLimit("198.51.100.10")).resolves.toMatchObject({ unavailable: true });
    expect(calls).toHaveLength(0);
  });
});
