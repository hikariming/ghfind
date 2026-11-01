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
  rateLimitHeaders: vi.fn(),
  releaseRoastLock: vi.fn(),
  setCachedRoast: vi.fn(),
  updateRoast: vi.fn(),
  waitForCachedRoast: vi.fn(),
  anonymousSessionPrincipal: vi.fn(),
  generateRoastV13: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getArchivedRoast: mocks.getArchivedRoast,
  getCanonicalScoreWriteIdentity: mocks.getCanonicalScoreWriteIdentity,
  getCurrentCanonicalQuickScan: mocks.getCurrentCanonicalQuickScan,
  getLegacyReadFallbackRoast: mocks.getLegacyReadFallbackRoast,
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
  getCompletionWithFallback: vi.fn(),
  roastV13LlmConfig: () => null,
  LlmQuotaError: class LlmQuotaError extends Error {},
  LlmTimeoutError: class LlmTimeoutError extends Error {},
}));
vi.mock("@/lib/roast-v13/chain", () => ({ generateRoastV13: mocks.generateRoastV13 }));
// These tests exercise the in-request chain. A deployment with a ROAST_JOB
// binding attaches instead; that path is covered in roast-durable.test.ts.
vi.mock("@/lib/roast-job", () => ({ roastJob: () => null }));

import { POST } from "./route";

const scan = {
  metrics: { username: "DemoDev", profile_url: "https://github.com/DemoDev", avatar_url: null },
  scoring: { final_score: 71, tier: "人上人", tier_label: "trusted", sub_scores: {}, base_score: 71, total_penalty: 0, red_flags: [] },
} as unknown as ScanResult;

describe("POST /api/roast quick score contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_ROAST_CLI_API_KEY;
    delete process.env.ROAST_GENERATOR;
    mocks.checkRoastRequestRateLimit.mockResolvedValue({ success: true });
    mocks.checkRoastRateLimit.mockResolvedValue({ success: true });
    mocks.checkRoastRequestNetworkRateLimit.mockResolvedValue({ success: true });
    mocks.checkRoastNetworkRateLimit.mockResolvedValue({ success: true });
    mocks.rateLimitHeaders.mockReturnValue({});
    mocks.anonymousSessionPrincipal.mockReturnValue("anon:session-fixture");
    mocks.defaultLlmConfig.mockReturnValue({ baseURL: "https://llm.example.test", apiKey: "key", model: "model" });
    mocks.fallbackLlmConfig.mockReturnValue(null);
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue(null);
    mocks.getLegacyReadFallbackRoast.mockResolvedValue(null);
    mocks.getCanonicalScoreWriteIdentity.mockResolvedValue({ scannedAt: 1, token: "token" });
    mocks.getCachedRoast.mockResolvedValue(null);
    mocks.getArchivedRoast.mockResolvedValue(null);
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

  it("carries the previous-release roast when live generation fails", async () => {
    mocks.getLegacyReadFallbackRoast.mockResolvedValue({
      username: "demodev",
      final_score: 64,
      tier: "人上人",
      tags: { zh: [], en: [] },
      roast_line: { zh: "旧版一句", en: "Old line" },
      report: "## 旧版锐评\n只读回放。",
    });
    mocks.chat.mockImplementation(async function* () {
      throw new Error("provider unavailable");
    });

    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));
    const body = await new Response(response.body).text();

    expect(response.status).toBe(200);
    expect(body).toContain("roast_failed");
    expect(body).toContain("旧版锐评");
    expect(body).toContain('"final_score":64');
  });

  it("accepts an interactive roast without the machine API quota", async () => {
    mocks.anonymousSessionPrincipal.mockReturnValue("anon:session-fixture");
    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));

    expect(response.status).toBe(200);
    await new Response(response.body).text();
    expect(mocks.checkRoastRequestRateLimit).not.toHaveBeenCalled();
    expect(mocks.checkRoastRequestNetworkRateLimit).not.toHaveBeenCalled();
    expect(mocks.checkRoastRateLimit).not.toHaveBeenCalled();
    expect(mocks.checkRoastNetworkRateLimit).not.toHaveBeenCalled();
  });

  it("does not let an unverified browser spend platform model credit", async () => {
    mocks.anonymousSessionPrincipal.mockReturnValue(null);
    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "turnstile_failed",
      useByoKey: true,
    });
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.acquireRoastLock).not.toHaveBeenCalled();
  });

  it("uses the signed browser session without shared NAT budgets", async () => {
    mocks.anonymousSessionPrincipal.mockReturnValue("anon:session-fixture");
    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.10" },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));

    expect(response.status).toBe(200);
    await new Response(response.body).text();
    expect(mocks.checkRoastRequestRateLimit).not.toHaveBeenCalled();
    expect(mocks.checkRoastRequestNetworkRateLimit).not.toHaveBeenCalled();
    expect(mocks.checkRoastRateLimit).not.toHaveBeenCalled();
    expect(mocks.checkRoastNetworkRateLimit).not.toHaveBeenCalled();
  });

  it("serves a compatible roast cache even when the browser asks to refresh a fresh scan", async () => {
    const snapshotHash = "a".repeat(64);
    mocks.defaultLlmConfig.mockReturnValue(null);
    // Within the 24h manual rescan cooldown: refresh is not honored, cache replays.
    mocks.getCanonicalScoreWriteIdentity.mockResolvedValue({ scannedAt: Date.now() - 60_000, token: "token" });
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue({ scan, snapshotHash });
    mocks.getCachedRoast.mockResolvedValue({
      report: "## 锐评\n工作扎实。",
      snapshot_hash: snapshotHash,
      delta: 0,
      tags: { zh: [], en: [] },
      final_score: 71,
      tier: "人上人",
      roast_line: { zh: "工作扎实。", en: "Solid work." },
    });

    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scan, refresh: true, lang: "zh" }),
    }));

    expect(response.status).toBe(200);
    await new Response(response.body).text();
    expect(mocks.checkRoastRateLimit).not.toHaveBeenCalled();
    expect(mocks.acquireRoastLock).not.toHaveBeenCalled();
  });

  it("honors refresh past the 24h cooldown by skipping a compatible roast cache", async () => {
    const snapshotHash = "a".repeat(64);
    mocks.defaultLlmConfig.mockReturnValue({ baseURL: "https://llm.example.test", apiKey: "key", model: "model" });
    mocks.getCanonicalScoreWriteIdentity.mockResolvedValue({
      scannedAt: Date.now() - 25 * 60 * 60 * 1000,
      token: "token",
    });
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue({ scan, snapshotHash });
    mocks.getCachedRoast.mockResolvedValue({
      report: "## 锐评\n旧稿。",
      snapshot_hash: snapshotHash,
      delta: 0,
      tags: { zh: [], en: [] },
      final_score: 71,
      tier: "人上人",
      roast_line: { zh: "旧稿。", en: "Old draft." },
    });

    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scan, refresh: true, lang: "zh" }),
    }));

    expect(response.status).toBe(200);
    await new Response(response.body).text();
    // Stale refresh skips cache/archive and takes the generation path.
    expect(mocks.getCachedRoast).not.toHaveBeenCalled();
    expect(mocks.acquireRoastLock).toHaveBeenCalled();
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

  it("releases the generation lock when a machine caller is over quota", async () => {
    process.env.GITHUB_ROAST_CLI_API_KEY = "test-key";
    mocks.checkRoastRateLimit.mockResolvedValue({ success: false, reset: Date.now() + 1000 });

    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));

    expect(response.status).toBe(429);
    expect(mocks.releaseRoastLock).toHaveBeenCalledWith("DemoDev", "zh");
    expect(mocks.chat).not.toHaveBeenCalled();
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

  it("writes the v13 chain report when the generator flag is on", async () => {
    process.env.ROAST_GENERATOR = "v13";
    mocks.generateRoastV13.mockResolvedValue({
      tags: { zh: ["标签"], en: ["Tag"] },
      roastLine: { zh: "一句很具体的锐评。", en: "A very specific roast." },
      report: "## DemoDev — 71.00/100  ·  人上人 (trusted)\n\n**一句话结论**: v13 正文。\n",
      copy: {},
      steps: [{ step: "writer", ms: 10, inChars: 100, outChars: 50, ok: true }],
      draftIssues: [],
      finalIssues: [],
      dropped: [],
    });
    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));
    const body = await new Response(response.body).text();
    expect(body).toContain("v13 正文");
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.updateRoast).toHaveBeenCalledWith(
      "DemoDev",
      expect.stringContaining("v13 正文"),
      "zh",
      expect.anything(),
      { tags: { zh: ["标签"], en: ["Tag"] }, roastLine: { zh: "一句很具体的锐评。", en: "A very specific roast." } },
    );
  });

  it("falls back to the v12 stream when the v13 chain fails", async () => {
    process.env.ROAST_GENERATOR = "v13";
    mocks.generateRoastV13.mockRejectedValue(Object.assign(new Error("writer returned no usable JSON"), { steps: [] }));
    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));
    const body = await new Response(response.body).text();
    expect(body).toContain("工作扎实");
    expect(mocks.updateRoast).toHaveBeenCalledWith("DemoDev", expect.stringContaining("工作扎实"), "zh", expect.anything(), expect.anything());
  });

  it("keeps interactive roasts on v12 when v13 is scoped to background jobs", async () => {
    process.env.ROAST_GENERATOR = "v13";
    process.env.ROAST_V13_SCOPE = "background";
    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));
    await new Response(response.body).text();
    expect(mocks.generateRoastV13).not.toHaveBeenCalled();
    delete process.env.ROAST_V13_SCOPE;
  });

  it("keeps the v12 path when the generator flag is off", async () => {
    const response = await POST(new NextRequest("https://example.test/api/roast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scan, lang: "zh" }),
    }));
    await new Response(response.body).text();
    expect(mocks.generateRoastV13).not.toHaveBeenCalled();
    expect(mocks.updateRoast).toHaveBeenCalled();
  });
});
