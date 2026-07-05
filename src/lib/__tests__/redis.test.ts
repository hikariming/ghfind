import { afterEach, describe, expect, it, vi } from "vitest";

describe("stale score refresh guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed when Redis is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", undefined);
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", undefined);
    vi.resetModules();

    const { beginStaleScoreRefresh } = await import("../redis");

    await expect(beginStaleScoreRefresh("stale-user", "203.0.113.9")).resolves.toEqual({
      allowed: false,
      reason: "redis_unavailable",
    });
  });
});
