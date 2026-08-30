import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  acquireRoastLock: vi.fn(),
  buildRoastMessages: vi.fn(),
  checkRoastRateLimit: vi.fn(),
  checkRoastNetworkRateLimit: vi.fn(),
  checkRoastRequestRateLimit: vi.fn(),
  checkRoastRequestNetworkRateLimit: vi.fn(),
  chat: vi.fn(),
  defaultLlmConfig: vi.fn(),
  fallbackLlmConfig: vi.fn(),
  getArchivedRoast: vi.fn(),
  getCachedRoast: vi.fn(),
  getCachedScan: vi.fn(),
  getCanonicalScoreWriteIdentity: vi.fn(),
  getCurrentCanonicalQuickScan: vi.fn(),
  getLegacyReadFallbackRoast: vi.fn(),
  getRankCached: vi.fn(),
  getScoreScannedAt: vi.fn(),
  rateLimitHeaders: vi.fn(),
  releaseRoastLock: vi.fn(),
  setCachedRoast: vi.fn(),
  updateRoast: vi.fn(),
  waitForCachedRoast: vi.fn(),
  anonymousSessionPrincipal: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getArchivedRoast: mocks.getArchivedRoast,
  getCanonicalScoreWriteIdentity: mocks.getCanonicalScoreWriteIdentity,
  getCurrentCanonicalQuickScan: mocks.getCurrentCanonicalQuickScan,
  getLegacyReadFallbackRoast: mocks.getLegacyReadFallbackRoast,
  getScoreScannedAt: mocks.getScoreScannedAt,
  updateRoast: mocks.updateRoast,
}));
vi.mock("@/lib/rank", () => ({ getRankCached: mocks.getRankCached }));
vi.mock("@/lib/redis", () => ({
  acquireRoastLock: mocks.acquireRoastLock,
  checkRoastRateLimit: mocks.checkRoastRateLimit,
  checkRoastNetworkRateLimit: mocks.checkRoastNetworkRateLimit,
  checkRoastRequestRateLimit: mocks.checkRoastRequestRateLimit,
  checkRoastRequestNetworkRateLimit: mocks.checkRoastRequestNetworkRateLimit,
  clearCachedRoast: vi.fn(),
  getCachedRoast: mocks.getCachedRoast,
  getCachedScan: mocks.getCachedScan,
  rateLimitHeaders: mocks.rateLimitHeaders,
  releaseRoastLock: mocks.releaseRoastLock,
  setCachedRoast: mocks.setCachedRoast,
  waitForCachedRoast: mocks.waitForCachedRoast,
}));
vi.mock("@/lib/anonymous-session", () => ({
  anonymousSessionPrincipal: mocks.anonymousSessionPrincipal,
}));
vi.mock("@/lib/prompt", () => ({ buildRoastMessages: mocks.buildRoastMessages }));
vi.mock("@/lib/llm", () => ({
  defaultLlmConfig: mocks.defaultLlmConfig,
  fallbackLlmConfig: mocks.fallbackLlmConfig,
  chatStreamEventsWithFallback: async function* () {
    yield* mocks.chat();
  },
  LlmQuotaError: class LlmQuotaError extends Error {},
  LlmTimeoutError: class LlmTimeoutError extends Error {},
}));

import { POST } from "./route";

const scan = {
  metrics: { username: "DemoDev", profile_url: "https://github.com/DemoDev", avatar_url: null },
  scoring: { final_score: 71, tier: "人上人", tier_label: "trusted", sub_scores: {}, base_score: 71, total_penalty: 0, red_flags: [] },
} as unknown as ScanResult;

describe("POST /api/roast quick score contract", () => {
  beforeEach(() => {
    mocks.checkRoastRequestRateLimit.mockResolvedValue({ success: true });
    mocks.checkRoastRateLimit.mockResolvedValue({ success: true });
    mocks.checkRoastRequestNetworkRateLimit.mockResolvedValue({ success: true });
    mocks.checkRoastNetworkRateLimit.mockResolvedValue({ success: true });
    mocks.rateLimitHeaders.mockReturnValue({});
    mocks.anonymousSessionPrincipal.mockReturnValue(null);
    mocks.defaultLlmConfig.mockReturnValue({ baseURL: "https://llm.example.test", apiKey: "key", model: "model" });
    mocks.fallbackLlmConfig.mockReturnValue(null);
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue(null);
    mocks.getLegacyReadFallbackRoast.mockResolvedValue(null);
    mocks.getCanonicalScoreWriteIdentity.mockResolvedValue({ scannedAt: 1, token: "token" });
    mocks.getCachedRoast.mockResolvedValue(null);
    mocks.getArchivedRoast.mockResolvedValue(null);
    mocks.getScoreScannedAt.mockResolvedValue(1);
    mocks.acquireRoastLock.mockResolvedValue(true);
    mocks.updateRoast.mockResolvedValue(true);
    mocks.getRankCached.mockResolvedValue(null);
    mocks.chat.mockImplementation(async function* () {
      yield { type: "content", text: "## 锐评\n工作扎实。" };
    });
  });

  it("streams and persists a roast for a persisted quick snapshot without a scan queue", async () => {
    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));

    expect(response.status).toBe(200);
    await new Response(response.body).text();
    expect(mocks.getCanonicalScoreWriteIdentity).toHaveBeenCalledWith("DemoDev", expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(mocks.updateRoast).toHaveBeenCalled();
  });

  it("accepts an interactive roast without a BotID availability gate", async () => {
    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));

    expect(response.status).toBe(200);
    await new Response(response.body).text();
    expect(mocks.checkRoastRequestRateLimit).toHaveBeenCalled();
    expect(mocks.checkRoastRateLimit).toHaveBeenCalled();
  });

  it("uses the signed browser session while retaining the shared network budgets", async () => {
    mocks.anonymousSessionPrincipal.mockReturnValue("anon:session-fixture");
    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.10" },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));

    expect(response.status).toBe(200);
    await new Response(response.body).text();
    expect(mocks.checkRoastRequestRateLimit).toHaveBeenCalledWith("anon:session-fixture");
    expect(mocks.checkRoastRequestNetworkRateLimit).toHaveBeenCalledWith("198.51.100.10");
    expect(mocks.checkRoastRateLimit).toHaveBeenCalledWith("anon:session-fixture");
    expect(mocks.checkRoastNetworkRateLimit).toHaveBeenCalledWith("198.51.100.10");
  });

  it("keeps machine-authenticated callers on their IP budget", async () => {
    process.env.GITHUB_ROAST_CLI_API_KEY = "test-key";
    mocks.anonymousSessionPrincipal.mockReturnValue("anon:session-fixture");

    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.10",
      },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));

    expect(response.status).toBe(200);
    await new Response(response.body).text();
    expect(mocks.checkRoastRequestRateLimit).toHaveBeenCalledWith("198.51.100.10");
    expect(mocks.checkRoastRateLimit).toHaveBeenCalledWith("198.51.100.10");
  });

  it("uses the exact server quick snapshot instead of a client handoff", async () => {
    const snapshotHash = "a".repeat(64);
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue({ scan, snapshotHash });

    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scan: { ...scan, scoring: { ...scan.scoring, final_score: 1 } }, lang: "zh" }),
    }));

    expect(response.status).toBe(200);
    await new Response(response.body).text();
    expect(mocks.getCanonicalScoreWriteIdentity).toHaveBeenCalledWith("DemoDev", snapshotHash);
  });
});
