import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getArchivedRoast: vi.fn(),
  getPercentile: vi.fn(),
  recordScore: vi.fn(),
  updateRoast: vi.fn(),
  chatStream: vi.fn(),
  defaultLlmConfig: vi.fn(),
  acquireRoastLock: vi.fn(),
  checkRoastRateLimit: vi.fn(),
  getCachedRoast: vi.fn(),
  getCachedScan: vi.fn(),
  releaseRoastLock: vi.fn(),
  setCachedRoast: vi.fn(),
  waitForCachedRoast: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getArchivedRoast: mocks.getArchivedRoast,
  getPercentile: mocks.getPercentile,
  recordScore: mocks.recordScore,
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
    chatStream: mocks.chatStream,
    defaultLlmConfig: mocks.defaultLlmConfig,
  };
});

vi.mock("@/lib/redis", () => ({
  acquireRoastLock: mocks.acquireRoastLock,
  checkRoastRateLimit: mocks.checkRoastRateLimit,
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
  buildRoastJudgeMessages: () => [],
  buildRoastMessages: () => [],
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

async function* streamText(text: string): AsyncGenerator<string> {
  yield text;
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
  mocks.getCachedScan.mockResolvedValue(null);
  mocks.getCachedRoast.mockResolvedValue(null);
  mocks.getArchivedRoast.mockResolvedValue(null);
  mocks.checkRoastRateLimit.mockResolvedValue({ success: true });
  mocks.acquireRoastLock.mockResolvedValue(true);
  mocks.waitForCachedRoast.mockResolvedValue(null);
  mocks.getPercentile.mockResolvedValue({ below: 5, total: 10 });
  mocks.recordScore.mockResolvedValue(undefined);
  mocks.updateRoast.mockResolvedValue(undefined);
  mocks.setCachedRoast.mockResolvedValue(undefined);
  mocks.releaseRoastLock.mockResolvedValue(undefined);
  mocks.chatStream
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
  });
});
