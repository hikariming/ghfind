import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  acquireRoastLock: vi.fn(),
  buildRoastMessages: vi.fn(),
  checkBotId: vi.fn(),
  checkRoastRateLimit: vi.fn(),
  checkRoastRequestRateLimit: vi.fn(),
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
}));

vi.mock("botid/server", () => ({ checkBotId: mocks.checkBotId }));
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
  checkRoastRequestRateLimit: mocks.checkRoastRequestRateLimit,
  clearCachedRoast: vi.fn(),
  getCachedRoast: mocks.getCachedRoast,
  getCachedScan: mocks.getCachedScan,
  rateLimitHeaders: mocks.rateLimitHeaders,
  releaseRoastLock: mocks.releaseRoastLock,
  setCachedRoast: mocks.setCachedRoast,
  waitForCachedRoast: mocks.waitForCachedRoast,
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
    mocks.checkBotId.mockResolvedValue({ isBot: false, isVerifiedBot: false });
    mocks.checkRoastRequestRateLimit.mockResolvedValue({ success: true });
    mocks.checkRoastRateLimit.mockResolvedValue({ success: true });
    mocks.rateLimitHeaders.mockReturnValue({});
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
