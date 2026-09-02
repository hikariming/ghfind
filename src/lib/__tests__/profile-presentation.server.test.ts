import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  filterExistingRepoKeys: vi.fn(),
  getAccountDetail: vi.fn(),
  getCachedScan: vi.fn(),
  getCurrentCanonicalQuickScan: vi.fn(),
  getDeveloperCommonProjects: vi.fn(),
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
  getDeveloperCommonProjects: mocks.getDeveloperCommonProjects,
  getCurrentCanonicalQuickScan: mocks.getCurrentCanonicalQuickScan,
  getFacetRank: mocks.getFacetRank,
  getMatchup: mocks.getMatchup,
  getProfileSnapshot: mocks.getProfileSnapshot,
  getSimilarAccounts: mocks.getSimilarAccounts,
  getTrendingMatchups: mocks.getTrendingMatchups,
  getUserMatchups: mocks.getUserMatchups,
  getWeeklyBaselines: mocks.getWeeklyBaselines,
  resolveWeeklyDelta: mocks.resolveWeeklyDelta,
}));
vi.mock("@/lib/rank", () => ({
  getPercentileCached: mocks.getPercentileCached,
  getRankCached: mocks.getRankCached,
}));
vi.mock("@/lib/redis", () => ({ getCachedScan: mocks.getCachedScan }));

import {
  getGoLiveProfileScan,
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
  activity_authenticity: 14,
};

const detail = {
  username: "octocat",
  display_name: "The Octocat",
  avatar_url: null,
  profile_url: "https://github.com/octocat",
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

const snapshot = {
  top_repos: [
    { name: "hello", owner_login: "octocat", stars: 3, forks: 0, open_issues: 0, size: 1 },
    { name: "world", name_with_owner: "octocat/world", stars: 2, forks: 0, open_issues: 0, size: 1 },
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
  handleA: "octocat",
  handleB: "torvalds",
  winner: "torvalds",
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
  mocks.getDeveloperCommonProjects.mockResolvedValue([]);
  mocks.getUserMatchups.mockResolvedValue([matchup]);
  mocks.getFacetRank.mockResolvedValue({
    facetType: "language",
    facetValue: "Go",
    rank: 3,
    total: 42,
    ahead: null,
  });
  mocks.getWeeklyBaselines.mockResolvedValue(new Map([["octocat", 70.2]]));
  mocks.resolveWeeklyDelta.mockReturnValue(7.5);
  mocks.filterExistingRepoKeys.mockResolvedValue(new Set(["octocat/world"]));
  mocks.getMatchup.mockResolvedValue(matchup);
  mocks.getTrendingMatchups.mockResolvedValue([matchup]);
  mocks.getCachedScan.mockResolvedValue(null);
  mocks.getCurrentCanonicalQuickScan.mockResolvedValue(null);
});

describe("getGoProfilePresentation", () => {
  it("assembles the full presentation with the Go handler's limits and shapes", async () => {
    mocks.getDeveloperCommonProjects
      .mockResolvedValueOnce([commonItem("a/low", 70), commonItem("a/high", 90)])
      .mockResolvedValueOnce([commonItem("a/high", 90), commonItem("b/mid", 80)])
      .mockResolvedValueOnce([]);

    const presentation = await getGoProfilePresentation("octocat");

    expect(presentation).not.toBeNull();
    expect(presentation?.detail).toMatchObject({ username: "octocat", score_version: "v9" });
    expect(presentation?.snapshot).toEqual(snapshot);
    expect(presentation?.rank).toEqual({ rank: 12, total: 100, below: 80 });
    expect(presentation?.percentile).toEqual({ beat: 75, total: 120, rank: 12 });
    expect(presentation?.delta).toBe(7.5);
    expect(presentation?.similar).toHaveLength(4);
    expect(presentation?.battles).toEqual([matchup]);
    expect(presentation?.facetRank).toMatchObject({ facetValue: "Go", rank: 3 });
    expect(presentation?.existing_repo_keys).toEqual(["octocat/world"]);
    // Per-candidate batches sort by avgScore desc and dedupe across candidates.
    expect(presentation?.common_projects).toEqual([
      commonItem("a/high", 90),
      commonItem("a/low", 70),
      commonItem("b/mid", 80),
    ]);

    expect(mocks.getSimilarAccounts).toHaveBeenCalledWith("octocat", 77.7, subScores, 6);
    expect(mocks.getUserMatchups).toHaveBeenCalledWith("octocat", 8);
    expect(mocks.getFacetRank).toHaveBeenCalledWith("octocat", 77.7);
    // Common projects consider only the first 3 similar developers.
    expect(mocks.getDeveloperCommonProjects).toHaveBeenCalledTimes(3);
    expect(mocks.getDeveloperCommonProjects).toHaveBeenNthCalledWith(1, "octocat", "s1", 6);
    expect(mocks.filterExistingRepoKeys).toHaveBeenCalledWith([
      "octocat/hello",
      "octocat/world",
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
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue({
      snapshotHash: "a".repeat(64),
      scan: {
        scoring: {
          base_score: 87.7,
          total_penalty: 10,
          final_score: 77.7,
          red_flags: [{ flag: "mostly_forks", penalty: 10, detail: "Mostly forks" }],
        },
      } as ScanResult,
    });

    const presentation = await getGoProfilePresentation("octocat");

    expect(presentation?.detail.score_breakdown).toEqual({
      base_score: 87.7,
      total_penalty: 10,
      applied_penalty: 10,
      red_flags: [{ flag: "mostly_forks", penalty: 10, detail: "Mostly forks" }],
      complete: true,
    });
    expect(mocks.getCurrentCanonicalQuickScan).toHaveBeenCalledWith("octocat");
  });

  it("does not expose a breakdown when the snapshot score disagrees with the score row", async () => {
    mocks.getCurrentCanonicalQuickScan.mockResolvedValue({
      snapshotHash: "a".repeat(64),
      scan: {
        scoring: {
          base_score: 87.7,
          total_penalty: 10,
          final_score: 77.6,
          red_flags: [{ flag: "mostly_forks", penalty: 10, detail: "Mostly forks" }],
        },
      } as ScanResult,
    });

    const presentation = await getGoProfilePresentation("octocat");

    expect(presentation?.detail.score_breakdown).toBeUndefined();
  });

  it("pins the optional score_version to null in the public contract", async () => {
    mocks.getAccountDetail.mockResolvedValue({ ...detail, score_version: undefined });

    const presentation = await getGoProfilePresentation("octocat");

    expect(presentation?.detail.score_version).toBeNull();
  });

  it("skips facet rank and weekly delta for legacy read-fallback rows", async () => {
    mocks.getAccountDetail.mockResolvedValue({
      ...detail,
      score_version: "v5",
      legacy_read_fallback: true,
    });

    const presentation = await getGoProfilePresentation("octocat");

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

  it("returns null when a common-projects read fails (Go returned 503)", async () => {
    mocks.getDeveloperCommonProjects.mockRejectedValue(new Error("turso down"));
    await expect(getGoProfilePresentation("octocat")).resolves.toBeNull();
  });
});

describe("getGoVsPresentation", () => {
  it("returns per-side details plus the stored matchup", async () => {
    mocks.getAccountDetail.mockImplementation(async (username: string) =>
      username === "octocat" ? detail : null,
    );

    const vs = await getGoVsPresentation("octocat", "torvalds");

    expect(vs?.a).toMatchObject({ username: "octocat", score_version: "v9" });
    expect(vs?.b).toBeNull();
    expect(vs?.matchup).toEqual(matchup);
    expect(mocks.getMatchup).toHaveBeenCalledWith("octocat", "torvalds");
  });

  it("rejects invalid handles before any read", async () => {
    await expect(getGoVsPresentation("octocat", "-nope")).resolves.toBeNull();
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
    const scan = { metrics: { username: "octocat" } } as unknown as ScanResult;
    mocks.getCachedScan.mockResolvedValue(scan);

    await expect(getGoLiveProfileScan("@octocat")).resolves.toBe(scan);
    expect(mocks.getCachedScan).toHaveBeenCalledWith("octocat");
  });

  it("returns null for invalid handles", async () => {
    await expect(getGoLiveProfileScan("not a handle")).resolves.toBeNull();
    expect(mocks.getCachedScan).not.toHaveBeenCalled();
  });
});
