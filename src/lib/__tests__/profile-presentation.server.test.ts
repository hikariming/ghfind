import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  filterExistingRepoKeys: vi.fn(),
  getAccountDetail: vi.fn(),
  getCachedScan: vi.fn(),
  getCurrentCanonicalQuickScan: vi.fn(),
  getProfileCommonProjectsCached: vi.fn(),
  getFacetRank: vi.fn(),
  getMatchup: vi.fn(),
  getPercentileCached: vi.fn(),
  getProfileSnapshot: vi.fn(),
  getRankCached: vi.fn(),
  getSimilarAccounts: vi.fn(),
  getTrendingMatchups: vi.fn(),
  getUserMatchups: vi.fn(),
  getWeeklyBaselines: vi.fn(),
  resolveWeeklyDelta: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  filterExistingRepoKeys: mocks.filterExistingRepoKeys,
  getAccountDetail: mocks.getAccountDetail,
  getCurrentCanonicalQuickScan: mocks.getCurrentCanonicalQuickScan,
  getMatchup: mocks.getMatchup,
  getProfileSnapshot: mocks.getProfileSnapshot,
  getSimilarAccounts: mocks.getSimilarAccounts,
  getTrendingMatchups: mocks.getTrendingMatchups,
  getUserMatchups: mocks.getUserMatchups,
  getWeeklyBaselines: mocks.getWeeklyBaselines,
  resolveWeeklyDelta: mocks.resolveWeeklyDelta,
}));
vi.mock("@/lib/developers", () => ({ getFacetRankCached: mocks.getFacetRank }));
vi.mock("@/lib/project-discovery", () => ({
  getProfileCommonProjectsCached: mocks.getProfileCommonProjectsCached,
}));
vi.mock("@/lib/rank", () => ({
  getPercentileCached: mocks.getPercentileCached,
  getRankCached: mocks.getRankCached,
}));
vi.mock("@/lib/redis", () => ({ getCachedScan: mocks.getCachedScan }));

import {
  getGoLiveProfileScan,
  getGoProfileCardPresentation,
  getGoProfilePresentation,
  getGoTrendingVsMatchups,
  getGoVsPresentation,
} from "@/lib/go-profile.server";

const subScores = {
  account_maturity: 9,
  original_project_quality: 14,
  contribution_quality: 21,
  ecosystem_impact: 12,
  community_influence: 5,
  activity_authenticity: 26.7,
};

const detail = {
  username: "fixture-account-049",
  display_name: "The fixture-account-049",
  avatar_url: null,
  profile_url: "https://github.com/fixture-account-049",
  final_score: 77.7,
  tier: "人上人",
  tags: { zh: [], en: [] },
  sub_scores: subScores,
  roast_line: { zh: "z", en: "e" },
  roast: null,
  roast_en: null,
  score_version: "v9",
  legacy_read_fallback: false,
  score_source_collection_version: "v4",
  score_source_snapshot_hash: "a".repeat(64),
  scanned_at: 1000,
  prev_score: 70,
  prev_scanned_at: 111,
};

const canonicalScan = (overrides: Record<string, unknown> = {}) => ({
  snapshotHash: "a".repeat(64),
  scan: {
    scoring: {
      sub_scores: subScores,
      base_score: 87.7,
      total_penalty: 10,
      final_score: 77.7,
      red_flags: [{ flag: "mostly_forks", penalty: 10, detail: "Mostly forks" }],
      ...overrides,
    },
  },
} as unknown as ScanResult);

const snapshot = {
  top_repos: [
    { name: "hello", owner_login: "fixture-account-049", stars: 3, forks: 0, open_issues: 0, size: 1 },
    { name: "world", name_with_owner: "fixture-account-049/world", stars: 2, forks: 0, open_issues: 0, size: 1 },
  ],
  impact_repos: [{ repo: "vercel/next.js", stars: 1, commits: 1, prs: 1 }],
  signature_work: null,
  pinned_repos: [],
  organizations: [],
  bio: null,
  company: null,
  metrics: {},
  scanned_at: 900,
};

const commonItem = (repoKey: string, avgScore: number) => ({
  repo: { repo_key: repoKey, name_with_owner: repoKey, language: "Go" },
  avgScore,
});

const matchup = {
  handleA: "fixture-account-049",
  handleB: "fixture-account-065",
  winner: "fixture-account-065",
  bucket: "crush",
  gap: 12,
  scoreA: 77.7,
  scoreB: 89.7,
  verdict: null,
  advice: null,
  verdictSource: null,
  viewCount: 3,
  createdAt: 1,
  updatedAt: 2,
};

const similarEntry = (username: string) => ({
  username,
  display_name: null,
  avatar_url: null,
  profile_url: null,
  final_score: 75,
  tier: "人上人",
  tags: { zh: [], en: [] },
  lookup_count: 1,
  recent_lookup_count: 0,
  trending_score: 75,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAccountDetail.mockResolvedValue(detail);
  mocks.getProfileSnapshot.mockResolvedValue(snapshot);
  mocks.getRankCached.mockResolvedValue({ rank: 12, total: 100, below: 80 });
  mocks.getPercentileCached.mockResolvedValue({ below: 90, total: 120 });
  mocks.getSimilarAccounts.mockResolvedValue(["s1", "s2", "s3", "s4"].map(similarEntry));
  mocks.getProfileCommonProjectsCached.mockResolvedValue([[], [], []]);
  mocks.getUserMatchups.mockResolvedValue([matchup]);
  mocks.getFacetRank.mockResolvedValue({
    facetType: "language",
    facetValue: "Go",
    rank: 3,
    total: 42,
    ahead: null,
  });
  mocks.getWeeklyBaselines.mockResolvedValue(new Map([["fixture-account-049", 70.2]]));
  mocks.resolveWeeklyDelta.mockReturnValue(7.5);
  mocks.filterExistingRepoKeys.mockResolvedValue(new Set(["fixture-account-049/world"]));
  mocks.getMatchup.mockResolvedValue(matchup);
  mocks.getTrendingMatchups.mockResolvedValue([matchup]);
  mocks.getCachedScan.mockResolvedValue(null);
  mocks.getCurrentCanonicalQuickScan.mockResolvedValue(null);
});

describe("getGoProfilePresentation", () => {
  it("assembles the full presentation with the Go handler's limits and shapes", async () => {
    mocks.getProfileCommonProjectsCached.mockResolvedValueOnce([
      [commonItem("a/low", 70), commonItem("a/high", 90)],
      [commonItem("a/high", 90), commonItem("b/mid", 80)],
      [],
    ]);

    const presentation = await getGoProfilePresentation("fixture-account-049");

    expect(presentation).not.toBeNull();
    expect(presentation?.detail).toMatchObject({ username: "fixture-account-049", score_version: "v9" });
    expect(presentation?.snapshot).toEqual(snapshot);
    expect(presentation?.rank).toEqual({ rank: 12, total: 100, below: 80 });
    expect(presentation?.percentile).toEqual({ beat: 75, total: 120, rank: 12 });
    expect(presentation?.delta).toBe(7.5);
    expect(presentation?.similar).toHaveLength(4);
    expect(presentation?.battles).toEqual([matchup]);
    expect(presentation?.facetRank).toMatchObject({ facetValue: "Go", rank: 3 });
    expect(presentation?.existing_repo_keys).toEqual(["fixture-account-049/world"]);
    // Per-candidate batches sort by avgScore desc and dedupe across candidates.
    expect(presentation?.common_projects).toEqual([
      commonItem("a/high", 90),
      commonItem("a/low", 70),
      commonItem("b/mid", 80),
    ]);

    expect(mocks.getSimilarAccounts).toHaveBeenCalledWith("fixture-account-049", 77.7, subScores, 6);
    expect(mocks.getUserMatchups).toHaveBeenCalledWith("fixture-account-049", 8);
    expect(mocks.getFacetRank).toHaveBeenCalledWith("fixture-account-049", 77.7);
    // Common projects consider only the first 3 similar developers, read in
    // one per-profile call (one cache entry, one database round trip).
    expect(mocks.getProfileCommonProjectsCached).toHaveBeenCalledExactlyOnceWith(
      "fixture-account-049",
      ["s1", "s2", "s3"],
      6,
    );
    expect(mocks.filterExistingRepoKeys).toHaveBeenCalledWith([
      "fixture-account-049/hello",
      "fixture-account-049/world",
      "vercel/next.js",
    ]);
    expect(mocks.resolveWeeklyDelta).toHaveBeenCalledWith({
      currentScore: 77.7,
      snapshotBaseline: 70.2,
      prevScore: 70,
      prevScannedAt: 111,
    });
  });

  it("passes the canonical scan's score breakdown through the local presentation", async () => {
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue(canonicalScan());

    const presentation = await getGoProfilePresentation("fixture-account-049");

    expect(presentation?.detail.score_breakdown).toEqual({
      base_score: 87.7,
      total_penalty: 10,
      applied_penalty: 10,
      red_flags: [{ flag: "mostly_forks", penalty: 10, detail: "Mostly forks" }],
      risk_assessment: null,
      risk_notes: [],
      complete: true,
    });
    expect(mocks.getCurrentCanonicalQuickScan).toHaveBeenCalledWith("fixture-account-049");
  });

  it("preserves a complete v9-policy breakdown with the restored 40-point cap", async () => {
    const final = 47.7;
    mocks.getAccountDetail.mockResolvedValue({ ...detail, final_score: final });
    const flags = [
      { flag: "no_original_work", penalty: 10, detail: "No originals" },
      { flag: "follow_farming", penalty: 10, detail: "Follow imbalance" },
      { flag: "templated_pr_flooding", penalty: 20, detail: "Flood" },
      { flag: "possible_star_inflation", penalty: 5, detail: "Stars" },
    ];
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue(canonicalScan({
      final_score: final, total_penalty: 40, red_flags: flags,
      risk_assessment: {
        version: "v9", applied_penalty: 40, risk_score: 100, level: "high",
        confidence: 50, signals: [], coverage: { repo: 1, merged_pr: 1, all_pr: 1 },
      },
      risk_notes: [],
    }));
    const presentation = await getGoProfilePresentation("fixture-account-049");
    expect(presentation?.detail.score_breakdown).toMatchObject({
      complete: true, total_penalty: 40, applied_penalty: 40,
      risk_assessment: { version: "v9", risk_score: 100 }, red_flags: flags,
    });
  });

  it.each([
    ["missing red flags", { red_flags: undefined }],
    ["dimension sum disagrees with base", { sub_scores: { ...subScores, activity_authenticity: 26.8 } }],
    ["score row dimension disagrees with scan", { sub_scores: { ...subScores, activity_authenticity: 26.6 } }],
    ["penalty total disagrees with red flags", { total_penalty: 9 }],
    ["final score formula disagrees with base and penalty", { final_score: 76.7 }],
  ])("does not expose an unverified breakdown when %s", async (_reason, overrides) => {
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue(canonicalScan(overrides));

    const presentation = await getGoProfilePresentation("fixture-account-049");

    expect(presentation?.detail.score_breakdown).toBeUndefined();
  });

  it("pins the optional score_version to null in the public contract", async () => {
    mocks.getAccountDetail.mockResolvedValue({ ...detail, score_version: undefined });

    const presentation = await getGoProfilePresentation("fixture-account-049");

    expect(presentation?.detail.score_version).toBeNull();
  });

  it("skips facet rank and weekly delta for legacy read-fallback rows", async () => {
    mocks.getAccountDetail.mockResolvedValue({
      ...detail,
      score_version: "v5",
      legacy_read_fallback: true,
    });

    const presentation = await getGoProfilePresentation("fixture-account-049");

    expect(presentation?.facetRank).toBeNull();
    expect(presentation?.delta).toBeNull();
    expect(mocks.getFacetRank).not.toHaveBeenCalled();
    expect(mocks.getWeeklyBaselines).not.toHaveBeenCalled();
  });

  it("returns null for invalid handles without touching the database", async () => {
    await expect(getGoProfilePresentation("bad--handle")).resolves.toBeNull();
    expect(mocks.getAccountDetail).not.toHaveBeenCalled();
  });

  it("returns null when no readable score row exists", async () => {
    mocks.getAccountDetail.mockResolvedValue(null);
    await expect(getGoProfilePresentation("ghost")).resolves.toBeNull();
  });

  it("returns null when the common-projects cache loader unexpectedly rejects", async () => {
    mocks.getProfileCommonProjectsCached.mockRejectedValue(new Error("turso down"));
    await expect(getGoProfilePresentation("fixture-account-049")).resolves.toBeNull();
  });
});

describe("getGoProfileCardPresentation", () => {
  it("returns what cards render without any discovery read", async () => {
    const card = await getGoProfileCardPresentation("fixture-account-049");

    expect(card).toEqual({
      detail: expect.objectContaining({ username: "fixture-account-049", score_version: "v9" }),
      snapshot,
      rank: { rank: 12, total: 100, below: 80 },
      percentile: { beat: 75, total: 120, rank: 12 },
      delta: 7.5,
    });
    // Similar accounts, common projects (and their KV entry), battles, facet
    // rank, the repo-link check and the scan breakdown are profile-page only.
    expect(mocks.getSimilarAccounts).not.toHaveBeenCalled();
    expect(mocks.getProfileCommonProjectsCached).not.toHaveBeenCalled();
    expect(mocks.getUserMatchups).not.toHaveBeenCalled();
    expect(mocks.getFacetRank).not.toHaveBeenCalled();
    expect(mocks.filterExistingRepoKeys).not.toHaveBeenCalled();
    expect(mocks.getCurrentCanonicalQuickScan).not.toHaveBeenCalled();
  });

  it("returns null for invalid handles and unknown accounts", async () => {
    await expect(getGoProfileCardPresentation("bad--handle")).resolves.toBeNull();
    mocks.getAccountDetail.mockResolvedValue(null);
    await expect(getGoProfileCardPresentation("ghost")).resolves.toBeNull();
  });
});

describe("getGoVsPresentation", () => {
  it("returns per-side details plus the stored matchup", async () => {
    mocks.getAccountDetail.mockImplementation(async (username: string) =>
      username === "fixture-account-049" ? detail : null,
    );

    const vs = await getGoVsPresentation("fixture-account-049", "fixture-account-065");

    expect(vs?.a).toMatchObject({ username: "fixture-account-049", score_version: "v9" });
    expect(vs?.b).toBeNull();
    expect(vs?.matchup).toEqual(matchup);
    expect(mocks.getMatchup).toHaveBeenCalledWith("fixture-account-049", "fixture-account-065");
  });

  it("rejects invalid handles before any read", async () => {
    await expect(getGoVsPresentation("fixture-account-049", "-nope")).resolves.toBeNull();
    expect(mocks.getAccountDetail).not.toHaveBeenCalled();
  });
});

describe("getGoTrendingVsMatchups", () => {
  it("reads the trending board with the Go limit", async () => {
    await expect(getGoTrendingVsMatchups()).resolves.toEqual([matchup]);
    expect(mocks.getTrendingMatchups).toHaveBeenCalledWith(40);
  });
});

describe("getGoLiveProfileScan", () => {
  it("serves only the already-cached scan for a normalized handle", async () => {
    const scan = { metrics: { username: "fixture-account-049" } } as unknown as ScanResult;
    mocks.getCachedScan.mockResolvedValue(scan);

    await expect(getGoLiveProfileScan("@fixture-account-049")).resolves.toBe(scan);
    expect(mocks.getCachedScan).toHaveBeenCalledWith("fixture-account-049");
  });

  it("returns null for invalid handles", async () => {
    await expect(getGoLiveProfileScan("not a handle")).resolves.toBeNull();
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
  });
});
