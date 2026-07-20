import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getArchivedRoast: vi.fn(),
  getCanonicalScoreWriteIdentity: vi.fn(),
  getLegacyReadFallbackRoast: vi.fn(),
  getScoreScannedAt: vi.fn(),
  getRank: vi.fn(),
  updateRoast: vi.fn(),
  chatStreamEvents: vi.fn(),
  checkBotId: vi.fn(async () => ({ isBot: false, isVerifiedBot: false })),
  checkRoastRequestRateLimit: vi.fn(),
  defaultLlmConfig: vi.fn(),
  fallbackLlmConfig: vi.fn(),
  acquireRoastLock: vi.fn(),
  checkRoastRateLimit: vi.fn(),
  clearCachedRoast: vi.fn(),
  getCachedRoast: vi.fn(),
  getCachedScan: vi.fn(),
  rateLimitHeaders: vi.fn(),
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
  getCanonicalScoreWriteIdentity: mocks.getCanonicalScoreWriteIdentity,
  getLegacyReadFallbackRoast: mocks.getLegacyReadFallbackRoast,
  getScoreScannedAt: mocks.getScoreScannedAt,
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
  class LlmTimeoutError extends Error {}
  class LlmQuotaError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    LlmTimeoutError,
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
  checkRoastRequestRateLimit: mocks.checkRoastRequestRateLimit,
  checkRoastRateLimit: mocks.checkRoastRateLimit,
  clearCachedRoast: mocks.clearCachedRoast,
  getCachedRoast: mocks.getCachedRoast,
  getCachedScan: mocks.getCachedScan,
  releaseRoastLock: mocks.releaseRoastLock,
  rateLimitHeaders: mocks.rateLimitHeaders,
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
  tierFor: (score: number) =>
    score >= 70
      ? { tier: "人上人", tier_label: "优质贡献者 · 值得信任" }
      : { tier: "NPC", tier_label: "普通账号 · 特征平庸存疑" },
}));

import { POST } from "./route";

async function* streamText(text: string): AsyncGenerator<{ type: "content"; text: string }> {
  yield { type: "content", text };
}

async function* streamChunks(chunks: string[]): AsyncGenerator<{ type: "content"; text: string }> {
  for (const text of chunks) yield { type: "content", text };
}

async function* streamThenFail(
  text: string,
  error: Error,
): AsyncGenerator<{ type: "content"; text: string }> {
  yield { type: "content", text };
  throw error;
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

const scoreIdentity = {
  scannedAt: 1_800_000_000_000,
  token: "synthetic-score-write-token",
};
const canonicalSnapshotHash = "ab".repeat(32);

function completePublicStatus(trustedScan: ScanResult = scan) {
  return {
    status: "complete" as const,
    run: { snapshotHash: canonicalSnapshotHash },
    scan: trustedScan,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.defaultLlmConfig.mockReturnValue({
    baseURL: "https://llm.example.test/v1",
    apiKey: "test-key",
    model: "test-model",
  });
  mocks.fallbackLlmConfig.mockReturnValue(null);
  mocks.getCachedScan.mockResolvedValue(scan);
  mocks.getPublicScanStatus.mockResolvedValue(completePublicStatus());
  mocks.requiresDurablePublicScan.mockReturnValue(false);
  mocks.getCachedRoast.mockResolvedValue(null);
  mocks.getArchivedRoast.mockResolvedValue(null);
  mocks.getLegacyReadFallbackRoast.mockResolvedValue(null);
  mocks.getScoreScannedAt.mockResolvedValue(null);
  mocks.checkRoastRequestRateLimit.mockResolvedValue({ success: true });
  mocks.clearCachedRoast.mockResolvedValue(undefined);
  mocks.checkRoastRateLimit.mockResolvedValue({ success: true });
  mocks.rateLimitHeaders.mockReturnValue({});
  mocks.acquireRoastLock.mockResolvedValue(true);
  mocks.waitForCachedRoast.mockResolvedValue(null);
  mocks.getRank.mockResolvedValue({ rank: 4, below: 5, total: 10 });
  mocks.getCanonicalScoreWriteIdentity.mockResolvedValue(scoreIdentity);
  mocks.updateRoast.mockResolvedValue(true);
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
  it("replays a verified v5/v5/v3 artifact before any LLM or durable-scan work", async () => {
    mocks.getLegacyReadFallbackRoast.mockResolvedValue({
      username: "legacy-read-fixture",
      final_score: 73,
      tier: "人上人",
      tags: { zh: ["旧版"], en: ["legacy"] },
      roast_line: { zh: "旧版锐评。", en: "Legacy roast." },
      report: "## 旧版点评\nCron 不可用时仍可阅读。",
    });
    mocks.defaultLlmConfig.mockReturnValue(null);

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ username: "legacy-read-fixture", lang: "zh" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Cron 不可用时仍可阅读。");
    expect(mocks.defaultLlmConfig).not.toHaveBeenCalled();
    expect(mocks.getPublicScanStatus).not.toHaveBeenCalled();
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
    expect(mocks.chatStreamEvents).not.toHaveBeenCalled();
    expect(mocks.setCachedRoast).not.toHaveBeenCalled();
  });

  it("uses the current trusted quick scan instead of replaying v5 for a new roast request", async () => {
    mocks.getLegacyReadFallbackRoast.mockResolvedValue({
      username: "DemoDev",
      final_score: 73,
      tier: "人上人",
      tags: { zh: ["旧版"], en: ["legacy"] },
      roast_line: { zh: "旧版锐评。", en: "Legacy roast." },
      report: "## 旧版点评\n只读回放。",
    });
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "pending",
      run: { id: "active-run", username: "DemoDev" },
      retryAfterSeconds: 5,
      headStartJobId: null,
    });
    mocks.requiresDurablePublicScan.mockReturnValue(true);

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("开源活跃度在上升");
    expect(mocks.getLegacyReadFallbackRoast).not.toHaveBeenCalled();
    expect(mocks.getCanonicalScoreWriteIdentity).not.toHaveBeenCalled();
    expect(mocks.updateRoast).not.toHaveBeenCalled();
  });

  it("skips the legacy artifact when refresh explicitly requests v9 work", async () => {
    mocks.getLegacyReadFallbackRoast.mockResolvedValue({
      username: "legacy-read-fixture",
      final_score: 73,
      tier: "人上人",
      tags: { zh: ["旧版"], en: ["legacy"] },
      roast_line: { zh: "旧版锐评。", en: "Legacy roast." },
      report: "## 旧版点评\n只读回放。",
    });
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "stale",
      run: { id: "legacy-run", username: "legacy-read-fixture", collectionVersion: "v3" },
      scan,
      refreshPending: false,
      refreshRun: null,
      servedCollectionVersion: "v3",
      targetCollectionVersion: "v4",
    });

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ username: "legacy-read-fixture", lang: "zh", refresh: true }),
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.getLegacyReadFallbackRoast).not.toHaveBeenCalled();
    expect(mocks.chatStreamEvents).not.toHaveBeenCalled();
  });

  it("does not generate or queue a report from stale v3 evidence", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "stale",
      run: { id: "legacy-run", username: "DemoDev", collectionVersion: "v3" },
      scan,
      refreshPending: false,
      refreshRun: null,
      servedCollectionVersion: "v3",
      targetCollectionVersion: "v4",
    });

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "scan_enrichment_pending",
      stale: true,
      served_collection_version: "v3",
      target_collection_version: "v4",
    });
    expect(mocks.startPublicScan).not.toHaveBeenCalled();
    expect(mocks.resolvePublicScanFromTrustedQuickScan).not.toHaveBeenCalled();
    expect(mocks.chatStreamEvents).not.toHaveBeenCalled();
  });

  it("limits every roast path before durable-status and scan-cache reads", async () => {
    mocks.checkRoastRequestRateLimit.mockResolvedValue({ success: false });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "60" });

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({
          scan,
          lang: "zh",
          byoKey: { baseURL: "https://llm.example.test/v1", apiKey: "user-key", model: "test" },
        }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mocks.getPublicScanStatus).not.toHaveBeenCalled();
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
  });

  it("fails closed for BYO roast requests before durable-status and scan-cache reads", async () => {
    mocks.checkRoastRequestRateLimit.mockResolvedValue({ success: false, unavailable: true, retryAfter: 15 });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "15" });

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({
          scan,
          lang: "zh",
          byoKey: { baseURL: "https://llm.example.test/v1", apiKey: "user-key", model: "test" },
        }),
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
    await expect(response.json()).resolves.toMatchObject({ error: "rate_limit_unavailable", useByoKey: true });
    expect(mocks.getPublicScanStatus).not.toHaveBeenCalled();
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
  });

  it("rejects an untrusted body scan on the default model without creating work", async () => {
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.getPublicScanStatus.mockResolvedValue(null);
    mocks.requiresDurablePublicScan.mockReturnValue(true);

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "missing_scan" });
    expect(mocks.startPublicScan).not.toHaveBeenCalled();
    expect(mocks.resolvePublicScanFromTrustedQuickScan).not.toHaveBeenCalled();
    expect(mocks.getCanonicalScoreWriteIdentity).not.toHaveBeenCalled();
    expect(mocks.chatStreamEvents).not.toHaveBeenCalled();
  });

  it("ignores a forged body scan when a trusted server scan is available", async () => {
    const forgedScan: ScanResult = {
      ...scan,
      scoring: {
        ...scan.scoring,
        final_score: 99,
        tier: "夯",
        tier_label: "夯到爆表",
      },
    };

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan: forgedScan, lang: "zh" }),
      }),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.buildRoastMessages).toHaveBeenCalledWith(scan, "zh");
    expect(mocks.getCanonicalScoreWriteIdentity).toHaveBeenCalledWith(
      "DemoDev",
      canonicalSnapshotHash,
    );
  });

  it("allows a BYO body scan only as an immediate non-persistent roast", async () => {
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.getPublicScanStatus.mockResolvedValue(null);

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({
          scan,
          lang: "zh",
          byoKey: { baseURL: "https://llm.example.test/v1", apiKey: "user-key", model: "test" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("开源活跃度在上升");
    expect(mocks.getCanonicalScoreWriteIdentity).not.toHaveBeenCalled();
    expect(mocks.updateRoast).not.toHaveBeenCalled();
    expect(mocks.setCachedRoast).not.toHaveBeenCalled();
    expect(mocks.startPublicScan).not.toHaveBeenCalled();
  });

  it("does not advance an existing durable scan when a roast is retried", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "pending",
      run: { id: "active-run", username: "DemoDev" },
      retryAfterSeconds: 5,
      headStartJobId: null,
    });

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.kickPublicScanDrain).not.toHaveBeenCalled();
    expect(mocks.chatStreamEvents).not.toHaveBeenCalled();
  });

  it("streams a trusted provisional quick roast without creating durable work or a canonical report", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "pending",
      run: { id: "active-run", username: "DemoDev" },
      retryAfterSeconds: 5,
      headStartJobId: null,
    });
    mocks.requiresDurablePublicScan.mockReturnValue(true);

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("开源活跃度在上升");
    expect(mocks.getCanonicalScoreWriteIdentity).not.toHaveBeenCalled();
    expect(mocks.updateRoast).not.toHaveBeenCalled();
    expect(mocks.setCachedRoast).not.toHaveBeenCalled();
    expect(mocks.resolvePublicScanFromTrustedQuickScan).not.toHaveBeenCalled();
    expect(mocks.startPublicScan).not.toHaveBeenCalled();
    expect(mocks.kickPublicScanDrain).not.toHaveBeenCalled();
  });

  it("fails closed before LLM work when the canonical score identity is missing", async () => {
    mocks.getCanonicalScoreWriteIdentity.mockResolvedValue(null);
    mocks.getCachedRoast.mockResolvedValue({
      report: "## synthetic legacy cache",
      delta: 0,
      tags: { zh: [], en: [] },
      roast_line: { zh: "", en: "" },
      final_score: 99,
      tier: "夯",
    });

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "score_materialization_pending" });
    expect(mocks.getCanonicalScoreWriteIdentity).toHaveBeenCalledWith(
      "DemoDev",
      canonicalSnapshotHash,
    );
    expect(mocks.checkRoastRateLimit).not.toHaveBeenCalled();
    expect(mocks.getCachedRoast).not.toHaveBeenCalled();
    expect(mocks.acquireRoastLock).not.toHaveBeenCalled();
    expect(mocks.chatStreamEvents).not.toHaveBeenCalled();
    expect(mocks.updateRoast).not.toHaveBeenCalled();
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
        requestId: expect.any(String),
      });
      expect(summary.u).toBeUndefined();
      expect(JSON.stringify(summary)).not.toContain("DemoDev");
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

  it("does not log partial model text, account names, or raw generation errors", async () => {
    const rawMarker = "sensitive-upstream-marker";
    mocks.chatStreamEvents.mockReset();
    mocks.chatStreamEvents.mockReturnValue(
      streamThenFail(`partial output for ${scan.metrics.username}`, new Error(rawMarker)),
    );
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
      const serialized = String(summaryCall![1]);
      expect(serialized).not.toContain(scan.metrics.username);
      expect(serialized).not.toContain(rawMarker);
      expect(JSON.parse(serialized)).not.toHaveProperty("head");
      expect(mocks.getCanonicalScoreWriteIdentity).toHaveBeenCalledWith(
        "DemoDev",
        canonicalSnapshotHash,
      );
      expect(mocks.updateRoast).not.toHaveBeenCalled();
      expect(mocks.setCachedRoast).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("attaches a fresh default report to the exact materialized score identity", async () => {
    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    await expect(response.text()).resolves.toContain("开源活跃度在上升");
    expect(response.status).toBe(200);
    expect(mocks.getCanonicalScoreWriteIdentity).toHaveBeenCalledWith(
      "DemoDev",
      canonicalSnapshotHash,
    );
    expect(mocks.updateRoast).toHaveBeenCalledWith(
      "DemoDev",
      expect.stringContaining("## 毒舌点评"),
      "zh",
      scoreIdentity,
      {
        tags: { zh: ["进步", "维护者"], en: ["improving", "maintainer"] },
        roastLine: { zh: "稳步进步。", en: "Steady improvement." },
      },
    );
    expect(mocks.chatStreamEvents).toHaveBeenCalledTimes(1);
    expect(mocks.getCanonicalScoreWriteIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.chatStreamEvents.mock.invocationCallOrder[0],
    );
  });

  it("does not warm replay caches when a late report loses the score CAS", async () => {
    mocks.updateRoast.mockResolvedValue(false);
    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    await response.text();
    expect(response.status).toBe(200);
    expect(mocks.updateRoast).toHaveBeenCalledWith(
      "DemoDev",
      expect.stringContaining("## 毒舌点评"),
      "zh",
      scoreIdentity,
      expect.objectContaining({
        tags: { zh: ["进步", "维护者"], en: ["improving", "maintainer"] },
      }),
    );
    expect(mocks.setCachedRoast).not.toHaveBeenCalled();
  });

  it("softens unsupported farming claims for strong core-impact accounts", async () => {
    mocks.chatStreamEvents.mockReset();
    mocks.chatStreamEvents.mockReturnValueOnce(
      streamText(
        [
          "@@ADJUST 0@@",
          "@@TAGS zh=PR刷子,AI代笔|en=PR Spammer,PR Farmer@@",
          "@@ROAST zh=靠刷PR混到顶级档位，水分很大。|en=PR Spammer with ghostwriting.@@",
          "## 毒舌点评",
          "这是低质量贡献刷量，含水量不低，有水分，模板化刷测试覆盖率，批量刷向目标仓库，刷存在感，蹭外部项目，KPI味很重，没混上提交权限，没混上写源码的权限，没有提交权限，没有commit权限，没有commit贡献记录，贡献深度存疑，还AI代笔不嫌丢人。",
        ].join("\n"),
      ),
    );
    const strongCoreScan: ScanResult = {
      ...scan,
      metrics: {
        ...scan.metrics,
        core_impact_pr_count: 50,
        doc_like_impact_pr_count: 0,
        impact_pr_count: 600,
        impact_commit_count: 0,
        recent_external_doc_like_pr_ratio: 0,
        pr_rejection_rate: 0.08,
      },
      scoring: {
        ...scan.scoring,
        final_score: 82.4,
        tier: "顶级",
        tier_label: "顶级开发者 · 一线水准",
      },
    };
    mocks.getCachedScan.mockResolvedValue(strongCoreScan);
    mocks.getPublicScanStatus.mockResolvedValue(completePublicStatus(strongCoreScan));

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan: strongCoreScan, lang: "zh" }),
      }),
    );

    const body = await response.text();
    expect(body).toContain("模式化贡献");
    expect(body).toContain("争议点");
    expect(body).toContain("批量投向目标仓库");
    expect(body).toContain("借外部项目做曝光");
    expect(body).toContain("依赖外部项目");
    expect(body).toContain("没有直接 commit 信号");
    expect(body).toContain("但 PR 贡献样本足够扎实");
    expect(body).toContain("AI辅助");
    expect(body).not.toContain("PR刷子");
    expect(body).not.toContain("刷");
    expect(body).not.toContain("刷量");
    expect(body).not.toContain("批量刷向");
    expect(body).not.toContain("含水量");
    expect(body).not.toContain("水分");
    expect(body).not.toContain("刷存在感");
    expect(body).not.toContain("蹭外部项目");
    expect(body).not.toContain("蹭");
    expect(body).not.toContain("KPI");
    expect(body).not.toContain("没混上提交权限");
    expect(body).not.toContain("没混上写源码的权限");
    expect(body).not.toContain("没有提交权限");
    expect(body).not.toContain("没有commit权限");
    expect(body).not.toContain("没有commit贡献记录");
    expect(body).not.toContain("贡献深度存疑");
    expect(body).not.toContain("不嫌丢人");
    expect(mocks.updateRoast).toHaveBeenCalledWith(
      "DemoDev",
      expect.not.stringContaining("刷量"),
      "zh",
      scoreIdentity,
      {
        tags: { zh: ["模式PR工", "AI辅助"], en: ["Pattern PR"] },
        roastLine: {
          zh: "靠批量提PR站到顶级档位，争议点很大。",
          en: "Pattern PR with AI assistance.",
        },
      },
    );
  });

  it("removes internal score-cap phrasing from generated reports", async () => {
    mocks.chatStreamEvents.mockReset();
    mocks.chatStreamEvents.mockReturnValueOnce(
      streamText(
        [
          "@@ADJUST 0@@",
          "@@TAGS zh=普通账号|en=average@@",
          "@@ROAST zh=生态证据偏弱。|en=Weak ecosystem evidence.@@",
          "## 毒舌点评",
          "高星仓库生态影响被硬压到4/20，生态影响被压4/20，按规则扣分，被评分引擎压到了4分，被评分引擎直接压到4/20，被评分引擎压，被评分引擎封顶到低档。",
        ].join("\n"),
      ),
    );

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    const body = await response.text();
    expect(body).toContain("高星仓库生态影响只有4/20");
    expect(body).toContain("数据上吃亏");
    expect(body).toContain("这项表现偏弱");
    expect(body).not.toContain("硬压到");
    expect(body).not.toContain("被压到");
    expect(body).not.toContain("压到了");
    expect(body).not.toContain("按规则扣分");
    expect(body).not.toContain("评分引擎");
    expect(body).not.toContain("被压4/20");
    expect(body).not.toContain("被评分现偏弱");
    expect(body).not.toContain("被有4/20");
    expect(mocks.updateRoast).toHaveBeenCalledWith(
      "DemoDev",
      expect.not.stringMatching(/硬压到|按规则扣分|评分引擎/u),
      "zh",
      scoreIdentity,
      expect.objectContaining({
        tags: { zh: ["普通账号"], en: ["average"] },
      }),
    );
  });

  it("removes internal score-cap phrasing when streamed across chunks", async () => {
    mocks.chatStreamEvents.mockReset();
    mocks.chatStreamEvents.mockReturnValueOnce(
      streamChunks([
        [
          "@@ADJUST 0@@",
          "@@TAGS zh=普通账号|en=average@@",
          "@@ROAST zh=生态证据偏弱。|en=Weak ecosystem evidence.@@",
          "## 毒舌点评",
          "生态影响被评分引擎压",
        ].join("\n"),
        "到了4分，按规则扣分。",
      ]),
    );

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    const body = await response.text();
    expect(body).toContain("生态影响只有4分");
    expect(body).toContain("数据上吃亏");
    expect(body).not.toContain("评分引擎");
    expect(body).not.toContain("被压到");
    expect(body).not.toContain("压到了");
    expect(body).not.toContain("按规则扣分");
  });

  it("expands popular-repo shorthand to full owner/repo names in report text", async () => {
    mocks.chatStreamEvents.mockReset();
    mocks.chatStreamEvents.mockReturnValueOnce(
      streamText(
        [
          "@@ADJUST 0@@",
          "@@TAGS zh=生态,贡献|en=ecosystem,impact@@",
          "@@ROAST zh=生态贡献很广。|en=Wide ecosystem work.@@",
          "## 毒舌点评",
          "向15万星的dify和11万星的rust长期提交PR，别再写成裸仓库简称。",
        ].join("\n"),
      ),
    );
    const shorthandScan: ScanResult = {
      ...scan,
      impact_repos: [
        { repo: "langgenius/dify", stars: 149_000, prs: 3, commits: 0 },
        { repo: "rust-lang/rust", stars: 114_000, prs: 2, commits: 0 },
      ],
    };
    mocks.getCachedScan.mockResolvedValue(shorthandScan);
    mocks.getPublicScanStatus.mockResolvedValue(completePublicStatus(shorthandScan));

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan: shorthandScan, lang: "zh" }),
      }),
    );

    const body = await response.text();
    expect(body).toContain("15万星的langgenius/dify");
    expect(body).toContain("11万星的rust-lang/rust");
    expect(body).not.toContain("15万星的dify");
    expect(body).not.toMatch(/11万星的rust(?!-lang\/rust)/u);
  });

  it("appends varied signature evidence for same-owner small repos", async () => {
    mocks.chatStreamEvents.mockReset();
    mocks.chatStreamEvents.mockReturnValueOnce(
      streamText(
        [
          "@@ADJUST 0@@",
          "@@TAGS zh=生态,修复|en=ecosystem,fixes@@",
          "@@ROAST zh=生态贡献有细节。|en=Concrete ecosystem work.@@",
          "## 毒舌点评",
          "只写了一个普通报告，故意漏掉具体 signature work。",
        ].join("\n"),
      ),
    );
    const signatureScan: ScanResult = {
      ...scan,
      signature_work: {
        source: "all_history_public_scan",
        impact_repo_representatives: [],
        work_clusters: [
          {
            repo: "demo/main-tool",
            stars: 120,
            all_time_prs: 8,
            quality_keyword_hits: 2,
            examples: ["fix(runtime): clean stale state"],
          },
          {
            repo: "demo/control-plane",
            stars: 39,
            all_time_prs: 5,
            quality_keyword_hits: 4,
            examples: ["fix(api): revoke bound deployment capabilities"],
            org_context_repo: "demo/main-platform",
            org_context_stars: 100_000,
            substantive_low_star_signal: true,
          },
        ],
      },
    };
    mocks.getCachedScan.mockResolvedValue(signatureScan);
    mocks.getPublicScanStatus.mockResolvedValue(completePublicStatus(signatureScan));

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan: signatureScan, lang: "zh" }),
      }),
    );

    const body = await response.text();
    expect(body).toContain("**补充证据**");
    expect(body).toContain("额外可核对的活动还包括 demo/main-tool");
    expect(body).toContain("demo/control-plane: 5 个 PR 不是孤立小仓库劳动");
    expect(body).toContain("demo/main-platform");
    expect(body).not.toContain("全量公开扫描还抓到");
  });

  it("writes an English roast in one model call without accepting model score changes", async () => {
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
    expect(mocks.updateRoast).toHaveBeenCalledWith(
      "DemoDev",
      expect.stringContaining("## Roast"),
      "en",
      scoreIdentity,
      expect.objectContaining({
        roastLine: { zh: "稳步进步。", en: "Steady improvement." },
      }),
    );
  });

  it("clamps overlong top-roast lines without cutting English mid-word", async () => {
    mocks.chatStreamEvents.mockReset();
    mocks.chatStreamEvents.mockReturnValueOnce(
      streamText(
        [
          "@@ADJUST 0@@",
          "@@TAGS zh=进步,维护者|en=improving,maintainer@@",
          "@@ROAST zh=外部贡献很勤快，但自家项目像没人认领。|en=38 followers versus 81 following, 109 PRs live in other people's repos before 相关仓库贡献者s can reject, while the home project has 1 star and an ‘unmistakablyunfinishedword at the cutoff.@@",
          "## 毒舌点评",
          "开源活跃度在上升。",
        ].join("\n"),
      ),
    );

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    await response.text();
    expect(response.status).toBe(200);
    const persistenceMeta = mocks.updateRoast.mock.calls[0][4];
    const en = persistenceMeta.roastLine.en;
    expect(Array.from(en).length).toBeLessThanOrEqual(180);
    expect(en).toMatch(/[.!?…]$/u);
    expect(en).not.toMatch(/\p{Script=Han}/u);
    expect(en).toContain("maintainers");
    expect(en).not.toContain("‘");
  });

  it("replays a canonical archive with deterministic zero delta", async () => {
    mocks.getArchivedRoast.mockResolvedValue({
      username: "demodev",
      final_score: 79,
      tier: "人上人",
      tags: { zh: ["存档"], en: ["archived"] },
      roast_line: { zh: "存档锐评。", en: "Archived roast." },
      report: "## 存档点评\n正式版本内容。",
    });

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("正式版本内容");
    const encodedMeta = response.headers.get("X-Roast-Meta");
    expect(encodedMeta).not.toBeNull();
    const meta = JSON.parse(Buffer.from(encodedMeta!, "base64").toString("utf8"));
    expect(meta).toMatchObject({ final_score: 79, delta: 0 });
    expect(mocks.setCachedRoast).toHaveBeenCalledWith(
      "DemoDev",
      "zh",
      expect.objectContaining({ final_score: 79, delta: 0 }),
    );
    expect(mocks.getCanonicalScoreWriteIdentity).toHaveBeenCalledWith(
      "DemoDev",
      canonicalSnapshotHash,
    );
  });

  it("ignores refresh for a still-fresh roast and replays the cache instead", async () => {
    mocks.getScoreScannedAt.mockResolvedValue(Date.now() - 60 * 60 * 1000); // 1h ago
    mocks.getCachedRoast.mockResolvedValue({
      report: "## 缓存点评\n仍然新鲜。",
      snapshot_hash: canonicalSnapshotHash,
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
    expect(mocks.getCanonicalScoreWriteIdentity).toHaveBeenCalledWith(
      "DemoDev",
      canonicalSnapshotHash,
    );
  });

  it("rejects and clears a roast cache from a different scan snapshot", async () => {
    mocks.getCachedRoast.mockResolvedValue({
      report: "## 旧快照点评\n不能复用。",
      snapshot_hash: "cd".repeat(32),
      delta: 0,
      tags: { zh: ["旧缓存"], en: ["old-cache"] },
      roast_line: { zh: "旧缓存。", en: "Old cache." },
      final_score: 71,
      tier: "人上人",
    });

    const response = await POST(
      new NextRequest("https://example.test/api/roast", {
        method: "POST",
        body: JSON.stringify({ scan, lang: "zh" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.not.toContain("不能复用");
    expect(mocks.clearCachedRoast).toHaveBeenCalledWith("DemoDev", "zh");
    expect(mocks.chatStreamEvents).toHaveBeenCalledTimes(1);
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
    expect(mocks.getCanonicalScoreWriteIdentity).toHaveBeenCalledWith(
      "DemoDev",
      canonicalSnapshotHash,
    );
  });

  it("drops malformed nested README summaries from client fallback scans", async () => {
    mocks.getCachedScan.mockResolvedValue(null);
    mocks.getPublicScanStatus.mockResolvedValue(null);
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
        body: JSON.stringify({
          scan: malformedScan,
          lang: "zh",
          byoKey: { baseURL: "https://llm.example.test/v1", apiKey: "user-key", model: "test" },
        }),
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
