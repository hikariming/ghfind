import { afterEach, describe, expect, it, vi } from "vitest";

async function loadRedis() {
  vi.resetModules();
  return import("../redis");
}

function unsetRedisEnv() {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("production rate-limit availability", () => {
  it("keeps local development usable without Redis", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "development");
    unsetRedisEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { checkRateLimit } = await loadRedis();

    await expect(checkRateLimit("198.51.100.10")).resolves.toEqual({ success: true });
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps Vercel preview deployments usable without production Redis", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    unsetRedisEnv();
    const { checkRateLimit } = await loadRedis();

    await expect(checkRateLimit("198.51.100.10")).resolves.toEqual({ success: true });
  });

  it("fails closed with a retry hint when production Redis is unconfigured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    unsetRedisEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { checkRateLimit, rateLimitHeaders } = await loadRedis();

    const result = await checkRateLimit("198.51.100.10");

    expect(result).toMatchObject({ success: false, unavailable: true, retryAfter: 15 });
    expect(rateLimitHeaders(result)).toEqual({ "Retry-After": "15" });
    expect(error).toHaveBeenCalledWith(
      "rate_limit_unavailable",
      expect.objectContaining({ limiter: "scan", reason: "missing_redis_config" }),
    );
  });

  it("fails closed when a configured Redis limiter request errors", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    const fetch = vi.fn().mockRejectedValue(new Error("redis unavailable"));
    vi.stubGlobal("fetch", fetch);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { checkRateLimit } = await loadRedis();

    await expect(checkRateLimit("198.51.100.10")).resolves.toMatchObject({
      success: false,
      unavailable: true,
      retryAfter: 15,
    });
    expect(fetch).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "rate_limit_unavailable",
      expect.objectContaining({ limiter: "scan", reason: "Error" }),
    );
  });

  it("allows an explicit emergency operator override", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("RATE_LIMIT_FAIL_OPEN", "1");
    unsetRedisEnv();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { checkRateLimit } = await loadRedis();

    await expect(checkRateLimit("198.51.100.10")).resolves.toEqual({ success: true });
    expect(error).toHaveBeenCalledWith(
      "rate_limit_unavailable",
      expect.objectContaining({ limiter: "scan", reason: "operator_fail_open_override" }),
    );
  });
});
