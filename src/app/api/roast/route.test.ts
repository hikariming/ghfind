import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getArchivedRoast: vi.fn(),
  getLatestPublicScanRun: vi.fn(),
  getScoreScannedAt: vi.fn(),
  getRank: vi.fn(),
  recordScore: vi.fn(),
  recordProfileSnapshot: vi.fn(),
  updateRoast: vi.fn(),
  chatStreamEvents: vi.fn(),
  checkBotId: vi.fn(async () => ({ isBot: false, isVerifiedBot: false })),
  defaultLlmConfig: vi.fn(),
  fallbackLlmConfig: vi.fn(),
  acquireRoastLock: vi.fn(),
  checkRoastRateLimit: vi.fn(),
  clearCachedRoast: vi.fn(),
  getCachedRoast: vi.fn(),
  getCachedScan: vi.fn(),
  releaseRoastLock: vi.fn(),
  setCachedRoast: vi.fn(),
  waitForCachedRoast: vi.fn(),
  buildRoastMessages: vi.fn((_scan: ScanResult, _lang?: string) => []),
  getPublicScanStatus: vi.fn(),
  publicScanAdmission: vi.fn(() => ({ bucket: "test", limit: 2, windowMs: 60_000, maxActiveJobs: 24 })),
  requiresDurablePublicScan: vi.fn(),
  resolvePublicScanFromTrustedQuickScan: vi.fn(),
  startPublicScan: vi.fn(),
  kickPublicScanDrain: vi.fn(),
}));

// Outside a real browser/Vercel request there is no BotID signal — treat every
// test request as a verified human so the gate is transparent to these suites.
vi.mock("botid/server", () => ({
  checkBotId: mocks.checkBotId,
}));

vi.mock("@/lib/db", () => ({
  getArchivedRoast: mocks.getArchivedRoast,
  getLatestPublicScanRun: mocks.getLatestPublicScanRun,
  getScoreScannedAt: mocks.getScoreScannedAt,
  recordScore: mocks.recordScore,
  recordProfileSnapshot: mocks.recordProfileSnapshot,
  updateRoast: mocks.updateRoast,
}));

vi.mock("@/lib/rank", () => ({
  getRankCached: mocks.getRank,
}));

vi.mock("@/lib/badge", () => ({
  TIER_EN: {
    夯: "GOD",
    顶级: "TOP",
    人上人: "ELITE",
    NPC: "NPC",
    拉完了: "LOW",
  },
  TIER_LABEL_EN: {
    夯: "Legendary",
    顶级: "Top developer",
    人上人: "Trusted contributor",
    NPC: "Average account",
    拉完了: "Low value",
  },
}));

vi.mock("@/lib/lang", () => ({
  normLang: (lang?: string) => (lang === "en" ? "en" : "zh"),
}));

vi.mock("@/lib/llm", () => {
  class LlmQuotaError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    LlmQuotaError,
    // The route calls the fallback wrapper; delegate to the per-call stream mock
    // using the primary config.
    chatStreamEventsWithFallback: async function* (
      configs: unknown[],
      messages: unknown,
      opts: {
        onAttempt?: (event: {
          attempt: number;
          provider: string;
          model: string;
          phase: string;
          elapsedMs: number;
          emittedContent?: boolean;
        }) => void;
      },
    ) {
      const base = { attempt: 1, provider: "llm.example.test", model: "test-model" };
      opts.onAttempt?.({ ...base, phase: "start", elapsedMs: 0 });
      let first = true;
      for await (const event of mocks.chatStreamEvents(configs[0], messages, opts)) {
        if (first) {
          first = false;
          opts.onAttempt?.({ ...base, phase: "first_event", elapsedMs: 1 });
          if (event.type === "content") {
            opts.onAttempt?.({ ...base, phase: "first_content", elapsedMs: 1 });
          }
        }
        yield event;
      }
      opts.onAttempt?.({ ...base, phase: "success", elapsedMs: 2, emittedContent: true });
    },
    chatStreamEvents: mocks.chatStreamEvents,
    defaultLlmConfig: mocks.defaultLlmConfig,
    fallbackLlmConfig: mocks.fallbackLlmConfig,
  };
});

vi.mock("@/lib/redis", () => ({
  acquireRoastLock: mocks.acquireRoastLock,
  checkRoastRateLimit: mocks.checkRoastRateLimit,
  clearCachedRoast: mocks.clearCachedRoast,
  getCachedRoast: mocks.getCachedRoast,
  getCachedScan: mocks.getCachedScan,
  releaseRoastLock: mocks.releaseRoastLock,
  setCachedRoast: mocks.setCachedRoast,
  waitForCachedRoast: mocks.waitForCachedRoast,
}));

vi.mock("@/lib/percentile", () => ({
  beatPercent: () => 50,
}));

vi.mock("@/lib/prompt", () => ({
  buildRoastMessages: mocks.buildRoastMessages,
}));

vi.mock("@/lib/report", () => ({
  reportMatchesLang: () => true,
}));

vi.mock("@/lib/identity", () => ({
  sanitizeIdentityClaims: (
    _scan: unknown,
    tags: unknown,
    roastLine: unknown,
    report: unknown,
  ) => ({ tags, roastLine, report }),
}));

vi.mock("@/lib/public-scan", () => ({
  getPublicScanStatus: mocks.getPublicScanStatus,
  publicScanAdmission: mocks.publicScanAdmission,
  requiresDurablePublicScan: mocks.requiresDurablePublicScan,
  resolvePublicScanFromTrustedQuickScan: mocks.resolvePublicScanFromTrustedQuickScan,
  startPublicScan: mocks.startPublicScan,
}));

vi.mock("@/lib/public-scan-dispatcher", () => ({
  kickPublicScanDrain: mocks.kickPublicScanDrain,
}));

vi.mock("@/lib/score", () => ({
  clampScore: (score: number) => Math.max(0, Math.min(100, score)),
  spamBotScore: () => 0,
  tierFor: (score: number) =>
    score >= 70
      ? { tier: "人上人", tier_label: "优质贡献者 · 值得信任" }
      : { tier: "NPC", tier_label: "普通账号 · 特征平庸存疑" },
}));

import { POST } from "./route";

async function* streamText(text: string): AsyncGenerator<{ type: "content"; text: string }> {
  yield { type: "content", text };
}

const scan: ScanResult = {
  metrics: {
    username: "DemoDev",
    profile_url: "https://github.com/DemoDev",
    avatar_url: "https://avatars.githubusercontent.com/u/1",
    name: "Demo Dev",
    bio: "Maintainer",
    company: null,
    account_age_years: 5,
    created_at: "2020-01-01T00:00:00Z",
    followers: 120,
    following: 20,
    public_repos: 12,
    fetched_repo_count: 12,
    original_repo_count: 8,
    nonempty_original_repo_count: 8,
    fork_repo_count: 4,
    empty_original_repo_count: 0,
    total_stars: 500,
    max_stars: 260,
    merged_pr_count: 30,
    total_pr_count: 35,
    issues_created: 12,
    last_year_contributions: 900,
    activity_type_count: 4,
    contribution_years_active: 4,
    days_since_last_activity: 2,
    recent_merged_pr_sample: 10,
    recent_trivial_pr_count: 1,
    external_trivial_pr_count: 1,
    max_impact_repo_stars: 10_000,
    impact_pr_count: 8,
    impact_depth_raw: 3,
    star_inflation_suspect: false,
    closed_unmerged_pr_count: 1,
    pr_rejection_rate: 0.03,
    recent_pr_sample: 12,
    top_repo_pr_target: null,
    top_repo_pr_share: 0,
    templated_pr_ratio: 0,
    pr_flood_suspect: false,
  },
  top_repos: [],
  recent_prs: [],
  flood_pr_titles: [],
  impact_repos: [],
  verified_impact_prs: [],
  scoring: {
    sub_scores: {
      account_maturity: 8,
      original_project_quality: 12,
      contribution_quality: 18,
      ecosystem_impact: 12,
      community_influence: 5,
      activity_authenticity: 13,
    },
    base_score: 68,
    red_flags: [],
    total_penalty: 0,
    final_score: 68,
    tier: "NPC",
    tier_label: "普通账号 · 特征平庸存疑",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.defaultLlmConfig.mockReturnValue({
    baseURL: "https://llm.example.test/v1",
    apiKey: "test-key",
    model: "test-model",
  });
  mocks.fallbackLlmConfig.mockReturnValue(null);
  mocks.getCachedScan.mockResolvedValue(null);
  mocks.getPublicScanStatus.mockResolvedValue(null);
  mocks.requiresDurablePublicScan.mockReturnValue(false);
  mocks.getCachedRoast.mockResolvedValue(null);
    mocks.getArchivedRoast.mockResolvedValue(null);
    mocks.getLatestPublicScanRun.mockResolvedValue(null);
  mocks.getScoreScannedAt.mockResolvedValue(null);
  mocks.clearCachedRoast.mockResolvedValue(undefined);
  mocks.checkRoastRateLimit.mockResolvedValue({ success: true });
  mocks.acquireRoastLock.mockResolvedValue(true);
  mocks.waitForCachedRoast.mockResolvedValue(null);
  mocks.getRank.mockResolvedValue({ rank: 4, below: 5, total: 10 });
  mocks.recordScore.mockResolvedValue(undefined);
  mocks.recordProfileSnapshot.mockResolvedValue(undefined);
  mocks.updateRoast.mockResolvedValue(undefined);
  mocks.setCachedRoast.mockResolvedValue(undefined);
  mocks.releaseRoastLock.mockResolvedValue(undefined);
  mocks.chatStreamEvents.mockReturnValueOnce(
    streamText(
      [
        "@@ADJUST 3@@",
        "@@TAGS zh=进步,维护者|en=improving,maintainer@@",
        "@@ROAST zh=稳步进步。|en=Steady improvement.@@",
        "## 毒舌点评",
        "开源活跃度在上升。",
      ].join("\n"),
    ),
  );
});

describe("roast API persistence", () => {
  it("never seeds a durable scan from an untrusted roast request body", async () => {
    mocks.requiresDurablePublicScan.mockReturnValue(true);
    mocks.startPublicScan.mockResolvedValue({
      status: "pending",
      run: { id: "server-authored-run" },
      retryAfterSeconds: 5,
    });

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "scan_enrichment_pending",
      run_id: "server-authored-run",
    });
    expect(mocks.startPublicScan).toHaveBeenCalledWith("DemoDev", expect.any(Object));
    expect(mocks.resolvePublicScanFromTrustedQuickScan).not.toHaveBeenCalled();
    expect(mocks.recordScore).not.toHaveBeenCalled();
    expect(mocks.chatStreamEvents).not.toHaveBeenCalled();
  });

  it("emits one structured summary with request, stream, lock, and provider timings", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await POST(
        new NextRequest("https://example.test/api/roast", {
          method: "POST",
          body: JSON.stringify({ scan, lang: "zh" }),
        }),
      );
      await response.text();

      const summaryCall = log.mock.calls.find(([name]) => name === "roast.summary");
      expect(summaryCall).toBeDefined();
      const summary = JSON.parse(String(summaryCall![1]));
      expect(summary).toMatchObject({
        ok: true,
        source: "generate",
        generationPath: "leader",
        lockWaitMs: 0,
      });
      expect(summary.requestTotalMs).toEqual(expect.any(Number));
      expect(summary.streamMs).toEqual(expect.any(Number));
      expect(summary.firstEventMs).toEqual(expect.any(Number));
      expect(summary.firstContentMs).toEqual(expect.any(Number));
      expect(summary.metaMs).toEqual(expect.any(Number));
      expect(summary.attempts.map((event: { phase: string }) => event.phase)).toEqual([
        "start",
        "first_event",
        "first_content",
        "success",
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("persists the score and completed roast for a fresh default generation", async () => {
    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    await expect(response.text()).resolves.toContain("开源活跃度在上升");
    expect(response.status).toBe(200);
    expect(mocks.recordScore).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "DemoDev",
        final_score: 71,
        tier: "人上人",
        tags: { zh: ["进步", "维护者"], en: ["improving", "maintainer"] },
        roast_line: { zh: "稳步进步。", en: "Steady improvement." },
      }),
    );
    expect(mocks.updateRoast).toHaveBeenCalledWith(
      "DemoDev",
      expect.stringContaining("## 毒舌点评"),
      "zh",
    );
    expect(mocks.chatStreamEvents).toHaveBeenCalledTimes(1);
  });

  it("calibrates and writes an English roast in one model call", async () => {
    mocks.chatStreamEvents.mockReset();
    mocks.chatStreamEvents.mockReturnValueOnce(
      streamText(
        [
          "@@ADJUST 3@@",
          "@@TAGS zh=进步,维护者|en=improving,maintainer@@",
          "@@ROAST zh=稳步进步。|en=Steady improvement.@@",
          "## Roast",
          "Open-source activity is rising.",
        ].join("\n"),
      ),
    );

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "en" }),
      }),
    );

    await expect(response.text()).resolves.toContain("Open-source activity is rising");
    expect(response.status).toBe(200);
    expect(mocks.chatStreamEvents).toHaveBeenCalledTimes(1);
    expect(mocks.buildRoastMessages).toHaveBeenCalledWith(
      expect.anything(),
      "en",
    );
    expect(mocks.recordScore).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "DemoDev",
        final_score: 71,
        tier: "人上人",
      }),
    );
  });

  it("ignores refresh for a still-fresh roast and replays the cache instead", async () => {
    mocks.getScoreScannedAt.mockResolvedValue(Date.now() - 60 * 60 * 1000); // 1h ago
    mocks.getCachedRoast.mockResolvedValue({
      report: "## 缓存点评\n仍然新鲜。",
      delta: 0,
      tags: { zh: ["缓存"], en: ["cached"] },
      roast_line: { zh: "缓存的。", en: "Cached." },
      final_score: 71,
      tier: "人上人",
    });

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh", refresh: true }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("仍然新鲜");
    expect(mocks.chatStreamEvents).not.toHaveBeenCalled();
    expect(mocks.clearCachedRoast).not.toHaveBeenCalled();
    expect(mocks.recordScore).not.toHaveBeenCalled();
  });

  it("honors refresh for a stale roast: skips replay paths, clears the cache, regenerates", async () => {
    mocks.getScoreScannedAt.mockResolvedValue(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    // Both replay sources would hit — refresh must skip them anyway.
    mocks.getCachedRoast.mockResolvedValue({
      report: "## 旧缓存\n过期内容。",
      delta: 0,
      tags: { zh: [], en: [] },
      roast_line: { zh: "", en: "" },
      final_score: 71,
      tier: "人上人",
    });
    mocks.getArchivedRoast.mockResolvedValue({
      username: "DemoDev",
      final_score: 71,
      tier: "人上人",
      tags: { zh: [], en: [] },
      roast_line: { zh: "", en: "" },
      report: "## 旧存档\n过期内容。",
    });

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh", refresh: true }),
      }),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("开源活跃度在上升");
    expect(text).not.toContain("过期内容");
    expect(mocks.getCachedRoast).not.toHaveBeenCalled();
    expect(mocks.getArchivedRoast).not.toHaveBeenCalled();
    expect(mocks.clearCachedRoast).toHaveBeenCalledWith("DemoDev", "zh");
    expect(mocks.recordScore).toHaveBeenCalledWith(
      expect.objectContaining({ username: "DemoDev", final_score: 71 }),
    );
  });

  it("drops malformed nested README summaries from client fallback scans", async () => {
    const malformedScan = {
      ...scan,
      top_repos: [
        {
          readme_excerpt: "Fallback summary",
          readme: {
            features: {
              prompt_summary: 42,
            },
          },
        },
      ],
    } as unknown as ScanResult;

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan: malformedScan, lang: "zh" }),
      }),
    );

    expect(response.status).toBe(200);
    // Generation runs inside the streamed response's start() callback, so
    // buildRoastMessages is only invoked once the body is
    // consumed — drain it before inspecting the mock.
    await response.text();
    const passedScan = mocks.buildRoastMessages.mock.calls[0]![0];
    expect(passedScan.top_repos[0].readme).toBeUndefined();
    expect(passedScan.top_repos[0].readme_excerpt).toBe("Fallback summary");
  });
});

describe("roast API human gate", () => {
  // The gate must key on the RESOLVED config: an incomplete byoKey falls back
  // to the operator-paid default, so it has to pass BotID exactly like no key.
  it("runs the BotID check when byoKey is present but incomplete (falls back to default)", async () => {
    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh", byoKey: {} }),
      }),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.checkBotId).toHaveBeenCalledOnce();
  });

  it("refuses an unverified bot carrying an empty byoKey instead of spending default credit", async () => {
    mocks.checkBotId.mockResolvedValueOnce({ isBot: true, isVerifiedBot: false });

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh", byoKey: {} }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "bot_detected" });
    expect(mocks.chatStreamEvents).not.toHaveBeenCalled();
  });

  it("skips the BotID check for a complete byoKey (the user pays their own bill)", async () => {
    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({
          scan,
          lang: "zh",
          byoKey: { apiKey: "user-key", baseURL: "https://user-llm.test/v1", model: "m" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.checkBotId).not.toHaveBeenCalled();
  });
});
