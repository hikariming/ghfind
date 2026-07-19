import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkBotId: vi.fn(),
  checkVerdictRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(),
  getAccountDetail: vi.fn(),
  recordMatchup: vi.fn(),
  bumpMatchupView: vi.fn(),
}));

vi.mock("botid/server", () => ({ checkBotId: mocks.checkBotId }));

vi.mock("@/lib/db", () => ({
  getAccountDetail: mocks.getAccountDetail,
  recordMatchup: mocks.recordMatchup,
  bumpMatchupView: mocks.bumpMatchupView,
}));

vi.mock("@/lib/redis", () => ({
  checkVerdictRateLimit: mocks.checkVerdictRateLimit,
  rateLimitHeaders: mocks.rateLimitHeaders,
  acquireVerdictLock: vi.fn(),
  getCachedVerdict: vi.fn(),
  releaseVerdictLock: vi.fn(),
  setCachedVerdict: vi.fn(),
  waitForCachedVerdict: vi.fn(),
}));

import { POST } from "./route";

describe("vs verdict cost guardrail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkVerdictRateLimit.mockResolvedValue({ success: false });
    mocks.rateLimitHeaders.mockReturnValue({});
  });

  it("rate-limits before BotID and all Turso reads or writes", async () => {
    const response = await POST(
      new NextRequest("https://example.test/api/vs-verdict", {
        method: "POST",
        body: JSON.stringify({ a: "alice", b: "bob" }),
      }),
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ verdict: null, reason: "rate_limited" });
    expect(mocks.checkBotId).not.toHaveBeenCalled();
    expect(mocks.getAccountDetail).not.toHaveBeenCalled();
    expect(mocks.recordMatchup).not.toHaveBeenCalled();
    expect(mocks.bumpMatchupView).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 before BotID and all Turso reads when protection is unavailable", async () => {
    mocks.checkVerdictRateLimit.mockResolvedValue({ success: false, unavailable: true, retryAfter: 15 });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "15" });

    const response = await POST(
      new NextRequest("https://example.test/api/vs-verdict", {
        method: "POST",
        body: JSON.stringify({ a: "alice", b: "bob" }),
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
    await expect(response.json()).resolves.toEqual({ verdict: null, reason: "rate_limit_unavailable" });
    expect(mocks.checkBotId).not.toHaveBeenCalled();
    expect(mocks.getAccountDetail).not.toHaveBeenCalled();
  });
});
