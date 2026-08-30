import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyTurnstile: vi.fn(),
  checkVerdictRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(),
  getAccountDetail: vi.fn(),
  recordMatchup: vi.fn(),
  bumpMatchupView: vi.fn(),
}));

vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }));

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

function post(body: unknown, headers?: Record<string, string>) {
  return POST(
    new NextRequest("https://example.test/api/vs-verdict", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe("vs verdict cost guardrail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkVerdictRateLimit.mockResolvedValue({ success: false });
    mocks.rateLimitHeaders.mockReturnValue({});
    mocks.verifyTurnstile.mockResolvedValue(true);
  });

  it("rate-limits before the human-check and all Turso reads or writes", async () => {
    const response = await post({ a: "alice", b: "bob" });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ verdict: null, reason: "rate_limited" });
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.getAccountDetail).not.toHaveBeenCalled();
    expect(mocks.recordMatchup).not.toHaveBeenCalled();
    expect(mocks.bumpMatchupView).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 before the human-check and all Turso reads when protection is unavailable", async () => {
    mocks.checkVerdictRateLimit.mockResolvedValue({ success: false, unavailable: true, retryAfter: 15 });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "15" });

    const response = await post({ a: "alice", b: "bob" });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
    await expect(response.json()).resolves.toEqual({ verdict: null, reason: "rate_limit_unavailable" });
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.getAccountDetail).not.toHaveBeenCalled();
  });

  it("rejects a failed human-check before any Turso read or write", async () => {
    mocks.checkVerdictRateLimit.mockResolvedValue({ success: true });
    mocks.verifyTurnstile.mockResolvedValue(false);

    const response = await post(
      { a: "alice", b: "bob" },
      { "x-turnstile-token": "bad", "cf-connecting-ip": "198.51.100.7" },
    );

    expect(response.status).toBe(403);
    expect(mocks.verifyTurnstile).toHaveBeenCalledWith("bad", "198.51.100.7");
    expect(mocks.getAccountDetail).not.toHaveBeenCalled();
    expect(mocks.recordMatchup).not.toHaveBeenCalled();
  });

  it("keeps the below-floor gate ahead of matchup writes", async () => {
    mocks.checkVerdictRateLimit.mockResolvedValue({ success: true });
    mocks.getAccountDetail.mockImplementation(async (username: string) => ({
      username,
      final_score: 10,
      sub_scores: {},
    }));

    const response = await post({ a: "alice", b: "bob" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ verdict: null, reason: "below_floor" });
    expect(mocks.recordMatchup).not.toHaveBeenCalled();
    expect(mocks.bumpMatchupView).not.toHaveBeenCalled();
  });
});
