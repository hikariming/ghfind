import { describe, expect, it } from "vitest";
import { checkProjectAnalysisRateLimit, rateLimitHeaders } from "../redis";

describe("project analysis rate limiting without Redis", () => {
  it("keeps a local five-per-hour safety net", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const ip = `test-${Date.now()}`;
    const results = [];
    for (let index = 0; index < 6; index += 1) {
      results.push(await checkProjectAnalysisRateLimit(ip));
    }
    expect(results.slice(0, 5).every((result) => result.success)).toBe(true);
    expect(results[5]).toMatchObject({ success: false, limit: 5, remaining: 0 });
    expect(rateLimitHeaders(results[5]!)).toMatchObject({
      "RateLimit-Limit": "5",
      "RateLimit-Remaining": "0",
    });
  });
});
