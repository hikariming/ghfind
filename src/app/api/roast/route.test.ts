import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getArchivedRoast: vi.fn(),
  getScoreScannedAt: vi.fn(),
  getRank: vi.fn(),
  recordScore: vi.fn(),
  recordProfileSnapshot: vi.fn(),
  updateRoast: vi.fn(),
  chatStreamEvents: vi.fn(),
  defaultLlmConfig: vi.fn(),
  fallbackLlmConfig: vi.fn(),
  acquireRoastLock: vi.fn(),
  checkRoastRateLimit: vi.fn(),
  clearCachedRoast: vi.fn(),
  getCachedRoast: vi.fn(),
  getCachedRoastJudge: vi.fn(),
  getCachedScan: vi.fn(),
  releaseRoastLock: vi.fn(),
  setCachedRoast: vi.fn(),
  setCachedRoastJudge: vi.fn(),
  waitForCachedRoast: vi.fn(),
  buildRoastJudgeMessages: vi.fn((_scan: ScanResult, _lang?: string) => []),
  buildRoastMessages: vi.fn((_scan: ScanResult, _lang?: string, _judge?: unknown) => []),
}));

vi.mock("@/lib/db", () => ({
  getArchivedRoast: mocks.getArchivedRoast,
  getScoreScannedAt: mocks.getScoreScannedAt,
  getRank: mocks.getRank,
  recordScore: mocks.recordScore,
  recordProfileSnapshot: mocks.recordProfileSnapshot,
  updateRoast: mocks.updateRoast,
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
    // The route calls the fallback wrapper; delegate to the per-call
    // chatStreamEvents mock (driven by mockReturnValueOnce) using the primary
    // config, preserving the existing judge-then-writer stream sequence.
    chatStreamEventsWithFallback: (
      configs: unknown[],
      messages: unknown,
      opts: unknown,
    ) => mocks.chatStreamEvents(configs[0], messages, opts),
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
  getCachedRoastJudge: mocks.getCachedRoastJudge,
  getCachedScan: mocks.getCachedScan,
  releaseRoastLock: mocks.releaseRoastLock,
  setCachedRoast: mocks.setCachedRoast,
  setCachedRoastJudge: mocks.setCachedRoastJudge,
  waitForCachedRoast: mocks.waitForCachedRoast,
}));

vi.mock("@/lib/percentile", () => ({
  beatPercent: () => 50,
}));

vi.mock("@/lib/prompt", () => ({
  buildRoastJudgeMessages: mocks.buildRoastJudgeMessages,
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
  mocks.getCachedRoast.mockResolvedValue(null);
  mocks.getCachedRoastJudge.mockResolvedValue(null);
  mocks.getArchivedRoast.mockResolvedValue(null);
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
  mocks.setCachedRoastJudge.mockResolvedValue(undefined);
  mocks.releaseRoastLock.mockResolvedValue(undefined);
  mocks.chatStreamEvents
    .mockReturnValueOnce(streamText(`{"delta":3,"reason":"ok","verdict":"正常","risk_notes":[]}`))
    .mockReturnValueOnce(
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
    expect(mocks.setCachedRoastJudge).toHaveBeenCalledWith(
      "DemoDev",
      expect.objectContaining({
        base_score: 68,
        judge: expect.objectContaining({ delta: 3 }),
      }),
    );
  });

  it("reuses a language-neutral judge result instead of recalibrating per locale", async () => {
    mocks.getCachedRoastJudge.mockResolvedValue({
      base_score: 68,
      judge: {
        delta: 3,
        reason: "cached calibration",
        verdict: "normal",
        risk_notes: [],
        final_score: 71,
        tier: "人上人",
        tier_label: "优质贡献者 · 值得信任",
      },
    });
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
    expect(mocks.buildRoastJudgeMessages).not.toHaveBeenCalled();
    expect(mocks.chatStreamEvents).toHaveBeenCalledTimes(1);
    expect(mocks.buildRoastMessages).toHaveBeenCalledWith(
      expect.anything(),
      "en",
      expect.objectContaining({
        delta: 3,
        final_score: 71,
        tier: "ELITE",
        tier_label: "Trusted contributor",
      }),
    );
    expect(mocks.recordScore).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "DemoDev",
        final_score: 71,
        tier: "人上人",
      }),
    );
    expect(mocks.setCachedRoastJudge).not.toHaveBeenCalled();
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
    // The judge/writer passes run inside the streamed response's start()
    // callback, so buildRoastMessages is only invoked once the body is
    // consumed — drain it before inspecting the mock.
    await response.text();
    const passedScan = mocks.buildRoastMessages.mock.calls[0]![0];
    expect(passedScan.top_repos[0].readme).toBeUndefined();
    expect(passedScan.top_repos[0].readme_excerpt).toBe("Fallback summary");
  });
});
