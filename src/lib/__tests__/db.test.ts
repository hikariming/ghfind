import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROAST_CACHE_VERSION, SCORE_CACHE_VERSION } from "../cache-version";
import type { ScoreEntry } from "../db";
import type { ScanResult } from "../types";

let db: typeof import("../db");
let persist: typeof import("../score-persist");
let tmpDir: string;

const entry: ScoreEntry = {
  username: "RockChinQ",
  display_name: "Rock",
  avatar_url: null,
  profile_url: "https://github.com/RockChinQ",
  final_score: 95.2,
  tier: "夯",
  tags: { zh: ["开源狠人"], en: ["oss beast"] },
  roast_line: { zh: "强到没法吐槽。", en: "Too good to roast." },
  bot_score: 0,
  sub_scores: {
    account_maturity: 10,
    original_project_quality: 18,
    contribution_quality: 27,
    ecosystem_impact: 20,
    community_influence: 8,
    activity_authenticity: 12.2,
  },
  scanned_at: 1_800_000_000_000,
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ghroast-db-"));
  process.env.TURSO_DATABASE_URL = `file:${join(tmpDir, "test.db")}`;
  delete process.env.TURSO_AUTH_TOKEN;
  db = await import("../db");
  persist = await import("../score-persist");
});

afterAll(() => {
  delete process.env.TURSO_DATABASE_URL;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getArchivedRoast", () => {
  it("replays archived reports by username and language", async () => {
    await db.recordScore(entry);
    await db.updateRoast("RockChinQ", "## 中文报告", "zh");
    await db.updateRoast("RockChinQ", "## English report", "en");

    await expect(db.getArchivedRoast("rockchinq", "zh")).resolves.toMatchObject({
      username: "rockchinq",
      final_score: 95.2,
      tier: "夯",
      tags: entry.tags,
      report: "## 中文报告",
    });
    await expect(db.getArchivedRoast("RockChinQ", "en")).resolves.toMatchObject({
      report: "## English report",
    });
  });

  it("does not replay archived reports from a stale roast version", async () => {
    await db.recordScore({ ...entry, username: "stale-roast" });
    await db.updateRoast("stale-roast", "## stale report", "zh");

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE scores SET roast_version = ? WHERE username = ?`,
      args: [`${ROAST_CACHE_VERSION}-old`, "stale-roast"],
    });

    await expect(db.getArchivedRoast("stale-roast", "zh")).resolves.toBeNull();
  });

  it("does not replay archived reports from rows without cache versions", async () => {
    await db.recordScore({ ...entry, username: "legacy-roast" });
    await db.updateRoast("legacy-roast", "## legacy report", "zh");

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE scores
            SET score_version = NULL, roast_version = NULL
            WHERE username = ?`,
      args: ["legacy-roast"],
    });

    await expect(db.getArchivedRoast("legacy-roast", "zh")).resolves.toBeNull();
  });
});

describe("current score reads", () => {
  it("does not expose stale score rows as current account details", async () => {
    await db.recordScore({ ...entry, username: "stale-score" });

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE scores SET score_version = ? WHERE username = ?`,
      args: [`${SCORE_CACHE_VERSION}-old`, "stale-score"],
    });

    await expect(db.getAccountDetail("stale-score")).resolves.toBeNull();
    await expect(
      db.getAccountDetail("stale-score", { includeStale: true }),
    ).resolves.toMatchObject({
      username: "stale-score",
      final_score: entry.final_score,
    });
  });

  it("does not expose stale profile snapshots as current evidence", async () => {
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `INSERT INTO profile_snapshots
              (id, username, scanned_at, top_repos, impact_repos, verified_prs,
               metrics, pinned_repos, organizations, scan_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        "stale-snapshot-id",
        "stale-snapshot",
        1,
        "[]",
        "[]",
        "[]",
        "{}",
        "[]",
        "[]",
        `${SCORE_CACHE_VERSION}-old`,
      ],
    });

    await expect(db.getProfileSnapshot("stale-snapshot")).resolves.toBeNull();
    await expect(
      db.getProfileSnapshot("stale-snapshot", { includeStale: true }),
    ).resolves.toMatchObject({ scanned_at: 1 });
  });

  it("excludes stale score rows from public score surfaces", async () => {
    await db.recordScore({ ...entry, username: "current-public", final_score: 91 });
    await db.recordScore({ ...entry, username: "stale-public", final_score: 100 });

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE scores SET score_version = ? WHERE username = ?`,
      args: [`${SCORE_CACHE_VERSION}-old`, "stale-public"],
    });

    const board = await db.getLeaderboard(20, 90);
    expect(board.map((e) => e.username)).toContain("current-public");
    expect(board.map((e) => e.username)).not.toContain("stale-public");

    await expect(db.getScoreBrief("stale-public")).resolves.toBeNull();
    await expect(db.searchScoredUsers("stale-public")).resolves.toEqual([]);
  });

  it("can refresh a stale score row with deterministic scan output", async () => {
    await db.recordScore({ ...entry, username: "auto-refresh", final_score: 40 });

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE scores SET score_version = ? WHERE username = ?`,
      args: [`${SCORE_CACHE_VERSION}-old`, "auto-refresh"],
    });

    const scan: ScanResult = {
      metrics: {
        username: "auto-refresh",
        profile_url: "https://github.com/auto-refresh",
        avatar_url: null,
        name: "Auto Refresh",
        bio: null,
        company: null,
        account_age_years: 3,
        created_at: "2023-01-01T00:00:00Z",
        followers: 2,
        following: 0,
        public_repos: 1,
        fetched_repo_count: 1,
        original_repo_count: 1,
        nonempty_original_repo_count: 1,
        fork_repo_count: 0,
        empty_original_repo_count: 0,
        total_stars: 10,
        max_stars: 10,
        merged_pr_count: 2,
        total_pr_count: 2,
        issues_created: 0,
        last_year_contributions: 10,
        activity_type_count: 2,
        contribution_years_active: 2,
        days_since_last_activity: 1,
        recent_merged_pr_sample: 2,
        recent_trivial_pr_count: 0,
        external_trivial_pr_count: 0,
        max_impact_repo_stars: 0,
        impact_pr_count: 0,
        impact_depth_raw: 0,
        star_inflation_suspect: false,
        closed_unmerged_pr_count: 0,
        pr_rejection_rate: 0,
        recent_pr_sample: 2,
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
      pinned_repos: [],
      organizations: [],
      scoring: {
        sub_scores: entry.sub_scores,
        base_score: 73.5,
        red_flags: [],
        total_penalty: 0,
        final_score: 73.5,
        tier: "人上人",
        tier_label: "人上人",
      },
    };

    await persist.recordDeterministicScan(scan, entry.scanned_at + 1);

    await expect(db.getAccountDetail("auto-refresh")).resolves.toMatchObject({
      username: "auto-refresh",
      final_score: 73.5,
      roast_line: { zh: "", en: "" },
    });
    await expect(db.getProfileSnapshot("auto-refresh")).resolves.toMatchObject({
      top_repos: [],
      metrics: expect.objectContaining({ total_stars: 10, merged_pr_count: 2 }),
    });
  });
});

describe("score snapshots", () => {
  it("stores one generated-at stub when a completed roast is persisted", async () => {
    const username = "roast-snapshot";
    const before = Date.now();
    await db.recordScore({ ...entry, username, final_score: 90 });
    await db.updateRoast(username, "## first report", "zh");
    await db.recordScore({
      ...entry,
      username,
      final_score: 96.1,
      scanned_at: entry.scanned_at + 2 * 60 * 60 * 1000,
    });
    await db.updateRoast(username, "## second report", "en");
    const after = Date.now();

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const res = await client.execute({
      sql: `SELECT COUNT(*) AS n,
                   MIN(generated_at) AS first_generated_at,
                   MAX(generated_at) AS last_generated_at,
                   GROUP_CONCAT(roast_lang, ',') AS langs
            FROM score_snapshots
            WHERE username = ?`,
      args: [username],
    });

    expect(Number(res.rows[0]?.n)).toBe(2);
    expect(Number(res.rows[0]?.first_generated_at)).toBeGreaterThanOrEqual(before);
    expect(Number(res.rows[0]?.last_generated_at)).toBeLessThanOrEqual(after);
    expect(String(res.rows[0]?.langs).split(",").sort()).toEqual(["en", "zh"]);
  });
});

describe("profile comments", () => {
  it("stores anonymous and GitHub comments for a profile", async () => {
    const anonymous = await db.createProfileComment({
      targetUsername: "Torvalds",
      text: "硬核 🔥",
      author: { type: "anonymous" },
    });
    const github = await db.createProfileComment({
      targetUsername: "torvalds",
      text: "Legend status",
      author: {
        type: "github",
        username: "yyx990803",
        avatarUrl: "https://avatars.githubusercontent.com/u/499550",
      },
      authorGithubId: 499550,
    });

    expect(anonymous).toMatchObject({
      targetUsername: "torvalds",
      author: { type: "anonymous" },
      text: "硬核 🔥",
    });
    expect(github).toMatchObject({
      targetUsername: "torvalds",
      author: {
        type: "github",
        username: "yyx990803",
        avatarUrl: "https://avatars.githubusercontent.com/u/499550",
      },
      text: "Legend status",
    });

    await expect(db.getProfileComments("TORVALDS")).resolves.toMatchObject([
      { author: { type: "anonymous" }, text: "硬核 🔥" },
      { author: { type: "github", username: "yyx990803" }, text: "Legend status" },
    ]);
  });
});

describe("profile reactions", () => {
  it("stores one durable reaction per GitHub user and target profile", async () => {
    await db.setProfileReaction({
      targetUsername: "React-Target",
      voterGithubId: 101,
      voterLogin: "alice",
      reaction: "like",
    });
    await db.setProfileReaction({
      targetUsername: "react-target",
      voterGithubId: 202,
      voterLogin: "bob",
      reaction: "poop",
    });

    await expect(db.getProfileReactionState("REACT-TARGET", 101)).resolves.toEqual({
      counts: { like: 1, poop: 1, kick: 0, fire: 0, salute: 0, clown: 0 },
      viewerReaction: "like",
    });
  });

  it("atomically replaces an existing reaction instead of adding another vote", async () => {
    const state = await db.setProfileReaction({
      targetUsername: "react-target",
      voterGithubId: 101,
      voterLogin: "alice-renamed",
      reaction: "fire",
    });

    expect(state).toEqual({
      counts: { like: 0, poop: 1, kick: 0, fire: 1, salute: 0, clown: 0 },
      viewerReaction: "fire",
    });
  });

  it("removes only the authenticated user's reaction", async () => {
    const state = await db.removeProfileReaction({
      targetUsername: "REACT-TARGET",
      voterGithubId: 101,
    });

    expect(state).toEqual({
      counts: { like: 0, poop: 1, kick: 0, fire: 0, salute: 0, clown: 0 },
      viewerReaction: null,
    });
  });
});

describe("getTrendingLeaderboard", () => {
  it("counts unique lookups from the last seven days only", async () => {
    const now = Date.now();
    await db.recordScore({ ...entry, username: "fresh", final_score: 92, scanned_at: now });
    await db.recordScore({ ...entry, username: "stale", final_score: 100, scanned_at: now - 1 });

    await db.recordAccountLookup("fresh", "203.0.113.1");
    await db.recordAccountLookup("fresh", "203.0.113.2");
    await db.recordAccountLookup("fresh", "203.0.113.2"); // same visitor, same 24h window
    await db.recordAccountLookup("stale", "203.0.113.3");

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE account_lookup_limits
            SET last_counted_at = ?
            WHERE username = ?`,
      args: [now - 8 * 24 * 60 * 60 * 1000, "stale"],
    });
    await client.execute({
      sql: `UPDATE account_stats
            SET last_lookup_at = ?
            WHERE username = ?`,
      args: [now - 8 * 24 * 60 * 60 * 1000, "stale"],
    });

    const entries = await db.getTrendingLeaderboard(10);
    const fresh = entries.find((e) => e.username === "fresh");
    const stale = entries.find((e) => e.username === "stale");

    expect(fresh?.recent_lookup_count).toBe(2);
    expect(stale?.recent_lookup_count).toBe(0);
    expect(fresh?.trending_score).toBeGreaterThan(0);
    expect(entries[0]?.username).toBe("fresh");
  });
});

describe("getRank", () => {
  it("ranks by score desc over a shared population", async () => {
    await db.recordScore({ ...entry, username: "rank-low", final_score: 11 });
    await db.recordScore({ ...entry, username: "rank-mid", final_score: 22 });
    await db.recordScore({ ...entry, username: "rank-high", final_score: 33 });

    const low = await db.getRank(11);
    const mid = await db.getRank(22);
    const high = await db.getRank(33);
    expect(low && mid && high).toBeTruthy();
    // A higher score earns a smaller (better) rank number.
    expect(high!.rank).toBeLessThan(mid!.rank);
    expect(mid!.rank).toBeLessThan(low!.rank);
    // Every query measures the same population, and `below` tracks the score.
    expect(high!.total).toBe(low!.total);
    expect(high!.total).toBeGreaterThanOrEqual(3);
    expect(high!.below).toBeGreaterThan(mid!.below);
  });

  it("excludes hidden accounts from the ranking", async () => {
    const before = await db.getRank(22);
    await db.recordScore({ ...entry, username: "rank-hidden", final_score: 99 });
    await db.hideUser("rank-hidden");
    const after = await db.getRank(22);
    // A hidden high score neither inflates the total nor worsens the rank.
    expect(after!.total).toBe(before!.total);
    expect(after!.rank).toBe(before!.rank);
  });
});
