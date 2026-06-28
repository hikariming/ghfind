/**
 * Turso (libSQL) persistence for the leaderboard + percentile.
 *
 * Optional, like {@link ./redis}: if `TURSO_DATABASE_URL` is unset, every function
 * no-ops (returns null/empty) so the app runs fine without it. Stores exactly one
 * row per scanned account (latest score). The score itself is still computed
 * deterministically by `lib/score.ts`; this layer only persists the result for
 * cross-account ranking.
 */

import { Client, createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import type { Lang } from "./lang";
import { rankSimilar } from "./similarity";
import type { RoastLine, SubScores, Tags, Tier } from "./types";

const EMPTY_TAGS: Tags = { zh: [], en: [] };
const HEAT_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_RECORDED_LOOKUP_COUNT = 1;

function parseTags(raw: unknown): Tags {
  if (typeof raw !== "string" || !raw) return EMPTY_TAGS;
  try {
    const t = JSON.parse(raw) as Partial<Tags>;
    return { zh: Array.isArray(t.zh) ? t.zh : [], en: Array.isArray(t.en) ? t.en : [] };
  } catch {
    return EMPTY_TAGS;
  }
}

const EMPTY_ROAST_LINE: RoastLine = { zh: "", en: "" };

function parseRoastLine(raw: unknown): RoastLine {
  if (typeof raw !== "string" || !raw) return EMPTY_ROAST_LINE;
  try {
    const r = JSON.parse(raw) as Partial<RoastLine>;
    return { zh: typeof r.zh === "string" ? r.zh : "", en: typeof r.en === "string" ? r.en : "" };
  } catch {
    return EMPTY_ROAST_LINE;
  }
}

const EMPTY_SUB: SubScores = {
  account_maturity: 0,
  original_project_quality: 0,
  contribution_quality: 0,
  ecosystem_impact: 0,
  community_influence: 0,
  activity_authenticity: 0,
};

function parseSubScores(raw: unknown): SubScores {
  if (typeof raw !== "string" || !raw) return EMPTY_SUB;
  try {
    const s = JSON.parse(raw) as Partial<SubScores>;
    return {
      account_maturity: Number(s.account_maturity) || 0,
      original_project_quality: Number(s.original_project_quality) || 0,
      contribution_quality: Number(s.contribution_quality) || 0,
      ecosystem_impact: Number(s.ecosystem_impact) || 0,
      community_influence: Number(s.community_influence) || 0,
      activity_authenticity: Number(s.activity_authenticity) || 0,
    };
  } catch {
    return EMPTY_SUB;
  }
}

function normalizeLookupCount(raw: unknown): number {
  return Math.max(MIN_RECORDED_LOOKUP_COUNT, Number(raw) || 0);
}

function heatIpHash(ip: string): string {
  const salt =
    process.env.AUTH_SECRET ?? process.env.TURNSTILE_SECRET_KEY ?? "github-roast-heat-v1";
  return createHash("sha256").update(salt).update("\0").update(ip).digest("hex");
}

let client: Client | null = null;
let schemaReady: Promise<void> | null = null;

function getClient(): Client | null {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) return null;
  client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN, // omit for local file: URLs
  });
  return client;
}

/** Create the table/index once per process. */
function ensureSchema(db: Client): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.batch(
        [
          `CREATE TABLE IF NOT EXISTS scores (
             username     TEXT PRIMARY KEY,
             display_name TEXT,
             avatar_url   TEXT,
             profile_url  TEXT,
             final_score  REAL NOT NULL,
             tier         TEXT NOT NULL,
             tags         TEXT,
             bot_score    REAL,
             sub_scores   TEXT,
             roast        TEXT,
             roast_line   TEXT,
             hidden       INTEGER NOT NULL DEFAULT 0,
             scanned_at   INTEGER NOT NULL
           )`,
          `CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(final_score DESC)`,
          `CREATE TABLE IF NOT EXISTS account_stats (
             username        TEXT PRIMARY KEY,
             lookup_count    INTEGER NOT NULL DEFAULT 0,
             first_lookup_at INTEGER NOT NULL,
             last_lookup_at  INTEGER NOT NULL
           )`,
          `CREATE INDEX IF NOT EXISTS idx_account_stats_heat
             ON account_stats(lookup_count DESC)`,
          `CREATE TABLE IF NOT EXISTS account_lookup_limits (
             username        TEXT NOT NULL,
             ip_hash         TEXT NOT NULL,
             last_counted_at INTEGER NOT NULL,
             PRIMARY KEY (username, ip_hash)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_account_lookup_limits_last_counted
             ON account_lookup_limits(last_counted_at)`,
          // Logged-in users (GitHub OAuth). Identity only for now; the lowercased
          // `login` lets us later link a user to their own `scores` row + comments.
          `CREATE TABLE IF NOT EXISTS users (
             github_id   INTEGER PRIMARY KEY,
             login       TEXT NOT NULL,
             name        TEXT,
             avatar_url  TEXT,
             created_at  INTEGER NOT NULL,
             last_login  INTEGER NOT NULL
           )`,
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users(login)`,
        ],
        "write",
      );
      // Migrations for tables created before these columns existed.
      // `roast` holds the Chinese report; `roast_en` the English one.
      for (const col of [
        "tags TEXT",
        "bot_score REAL",
        "sub_scores TEXT",
        "roast TEXT",
        "roast_en TEXT",
        // Bilingual one-liner {zh,en} JSON — generated in one LLM call so the
        // roast shows in the visitor's language regardless of report language.
        "roast_line TEXT",
      ]) {
        try {
          await db.execute(`ALTER TABLE scores ADD COLUMN ${col}`);
        } catch {
          // column already exists — ignore
        }
      }
    })().catch((e) => {
      schemaReady = null; // allow retry on next call
      throw e;
    });
  }
  return schemaReady;
}

export interface ScoreEntry {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  final_score: number;
  tier: Tier;
  tags: Tags;
  /** Bilingual savage one-liner {zh,en}; shown in the visitor's language. */
  roast_line: RoastLine;
  /** Hidden 0-10 spam-PR / bot likelihood — stored, never returned to clients. */
  bot_score: number;
  /** Per-dimension breakdown — persisted for "similar developers" matching. */
  sub_scores: SubScores;
  scanned_at: number;
}

export interface LeaderboardEntry {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  final_score: number;
  tier: Tier;
  tags: Tags;
  lookup_count: number;
}

const PREVIEW_SUB_SCORES: SubScores = {
  account_maturity: 10,
  original_project_quality: 18,
  contribution_quality: 26,
  ecosystem_impact: 20,
  community_influence: 8,
  activity_authenticity: 17,
};

const PREVIEW_SCANNED_AT = 1_800_000_000_000;

const PREVIEW_ACCOUNTS: AccountDetail[] = [
  {
    username: "demo-hot-legend",
    display_name: "Preview Legend",
    avatar_url: null,
    profile_url: null,
    final_score: 100,
    tier: "夯",
    tags: {
      zh: ["开源狠人", "热度爆表", "满分选手"],
      en: ["oss beast", "hot profile", "perfect score"],
    },
    sub_scores: PREVIEW_SUB_SCORES,
    roast_line: { zh: "满分预览号，挑不出毛病只能夸。", en: "A perfect preview profile — nothing left to roast." },
    roast:
      "## 本地预览数据\n\n这个账号是开发环境假数据，用来检查榜单热度布局。生产环境不会显示这些示例账号。",
    roast_en:
      "## Local preview data\n\nThis is development-only sample data for checking the leaderboard heat layout.",
    scanned_at: PREVIEW_SCANNED_AT,
  },
  {
    username: "demo-heat-runner",
    display_name: "Preview Runner",
    avatar_url: null,
    profile_url: null,
    final_score: 96.42,
    tier: "夯",
    tags: {
      zh: ["高频被查", "框架老炮", "PR 稳定"],
      en: ["frequently roasted", "framework veteran", "steady prs"],
    },
    sub_scores: {
      ...PREVIEW_SUB_SCORES,
      contribution_quality: 25,
      activity_authenticity: 16,
    },
    roast_line: { zh: "热度榜二把手，预览专用工具人。", en: "Runner-up on the heat board — a preview stand-in." },
    roast:
      "## 本地预览数据\n\n这个账号用于验证热度榜第二名和详情页跳转，不代表真实 GitHub 用户。",
    roast_en:
      "## Local preview data\n\nThis sample account validates the second heat rank and detail-page flow.",
    scanned_at: PREVIEW_SCANNED_AT - 1,
  },
  {
    username: "demo-score-smith",
    display_name: "Preview Smith",
    avatar_url: null,
    profile_url: null,
    final_score: 94.18,
    tier: "顶级",
    tags: {
      zh: ["稳定输出", "工具匠人", "社区常客"],
      en: ["steady output", "tool builder", "community regular"],
    },
    sub_scores: {
      ...PREVIEW_SUB_SCORES,
      ecosystem_impact: 18,
      community_influence: 7,
    },
    roast_line: { zh: "稳定输出的工具匠，分数排版试金石。", en: "Steady tool builder — here to test the score layout." },
    roast:
      "## 本地预览数据\n\n这个账号用于验证热度数字和评分数字在同一个右侧块里上下并列。",
    roast_en:
      "## Local preview data\n\nThis sample account validates the stacked score and heat block.",
    scanned_at: PREVIEW_SCANNED_AT - 2,
  },
  {
    username: "demo-fresh-star",
    display_name: "Preview Fresh Star",
    avatar_url: null,
    profile_url: null,
    final_score: 88.73,
    tier: "人上人",
    tags: {
      zh: ["新晋热门", "项目很亮", "增长快"],
      en: ["rising", "bright projects", "fast growth"],
    },
    sub_scores: {
      ...PREVIEW_SUB_SCORES,
      account_maturity: 7,
      contribution_quality: 22,
      ecosystem_impact: 15,
    },
    roast_line: { zh: "新晋热门，靠分页排序刷存在感。", en: "A rising star padding out the pagination demo." },
    roast:
      "## 本地预览数据\n\n这个账号用于拉开热度榜分页和排序差异。",
    roast_en:
      "## Local preview data\n\nThis sample account creates more variety in the heat ranking.",
    scanned_at: PREVIEW_SCANNED_AT - 3,
  },
  {
    username: "demo-npc-average",
    display_name: "Preview NPC",
    avatar_url: null,
    profile_url: null,
    final_score: 62.18,
    tier: "NPC",
    tags: {
      zh: ["均匀平庸", "存在感稀薄", "还没成型"],
      en: ["evenly average", "low signal", "not formed yet"],
    },
    sub_scores: {
      account_maturity: 6,
      original_project_quality: 7,
      contribution_quality: 16,
      ecosystem_impact: 7,
      community_influence: 3,
      activity_authenticity: 13,
    },
    roast_line: { zh: "过线但没亮点，标准 NPC。", en: "Past the line but unremarkable — a textbook NPC." },
    roast:
      "## 本地预览数据\n\n这个账号用于验证 NPC 档位：分数过线但没有亮点，头像框应显示笑脸围绕。",
    roast_en:
      "## Local preview data\n\nThis sample account validates the NPC tier and its smiley avatar frame.",
    scanned_at: PREVIEW_SCANNED_AT - 4,
  },
  {
    username: "demo-trash-fire",
    display_name: "Preview Trash",
    avatar_url: null,
    profile_url: null,
    final_score: 28.66,
    tier: "拉完了",
    tags: {
      zh: ["刷量疑云", "项目空心", "收藏夹开发者"],
      en: ["farm signals", "hollow repos", "bookmark dev"],
    },
    sub_scores: {
      account_maturity: 2,
      original_project_quality: 1,
      contribution_quality: 8,
      ecosystem_impact: 0,
      community_influence: 1,
      activity_authenticity: 9,
    },
    roast_line: { zh: "低分低贡献，收藏夹开发者实锤。", en: "Low score, hollow repos — a bookmark dev." },
    roast:
      "## 本地预览数据\n\n这个账号用于验证拉完了档位：低分、低贡献、低影响力，头像框应显示便便围绕。",
    roast_en:
      "## Local preview data\n\nThis sample account validates the trash tier and its poop avatar frame.",
    scanned_at: PREVIEW_SCANNED_AT - 5,
  },
];

const PREVIEW_HEAT: Record<string, number> = {
  "demo-hot-legend": 58,
  "demo-heat-runner": 612,
  "demo-score-smith": 241,
  "demo-fresh-star": 404,
  "demo-npc-average": 133,
  "demo-trash-fire": 36,
};

function previewEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.GHROAST_PREVIEW_DATA !== "0";
}

function toLeaderboardEntry(account: AccountDetail): LeaderboardEntry {
  return {
    username: account.username,
    display_name: account.display_name,
    avatar_url: account.avatar_url,
    profile_url: account.profile_url,
    final_score: account.final_score,
    tier: account.tier,
    tags: account.tags,
    lookup_count: normalizeLookupCount(PREVIEW_HEAT[account.username]),
  };
}

function previewLeaderboard(limit: number, minScore: number): LeaderboardEntry[] {
  if (!previewEnabled()) return [];
  return PREVIEW_ACCOUNTS.filter((account) => account.final_score >= minScore)
    .map(toLeaderboardEntry)
    .sort((a, b) => b.final_score - a.final_score || b.lookup_count - a.lookup_count)
    .slice(0, limit);
}

function previewHeatLeaderboard(limit: number, minScore: number): LeaderboardEntry[] {
  if (!previewEnabled()) return [];
  return PREVIEW_ACCOUNTS.filter((account) => account.final_score >= minScore)
    .map(toLeaderboardEntry)
    .sort((a, b) => b.lookup_count - a.lookup_count || b.final_score - a.final_score)
    .slice(0, limit);
}

function previewAccountDetail(username: string): AccountDetail | null {
  if (!previewEnabled()) return null;
  return (
    PREVIEW_ACCOUNTS.find(
      (account) => account.username.toLowerCase() === username.toLowerCase(),
    ) ?? null
  );
}

/**
 * Count one successful public lookup for a GitHub account.
 *
 * Returns true only when the lookup changed the public heat value. Repeated
 * successful scans for the same account from the same IP hash inside 24 hours
 * are accepted by the app, but do not increment leaderboard heat.
 */
export async function recordAccountLookup(username: string, ip: string): Promise<boolean> {
  const db = getClient();
  if (!db) return false;
  try {
    await ensureSchema(db);
    const now = Date.now();
    const normalizedUsername = username.toLowerCase();
    const tx = await db.transaction("write");
    try {
      const gate = await tx.execute({
        sql: `INSERT INTO account_lookup_limits (username, ip_hash, last_counted_at)
              VALUES (?, ?, ?)
              ON CONFLICT(username, ip_hash) DO UPDATE SET
                last_counted_at = excluded.last_counted_at
              WHERE account_lookup_limits.last_counted_at <= ?
              RETURNING last_counted_at`,
        args: [
          normalizedUsername,
          heatIpHash(ip),
          now,
          now - HEAT_LOOKUP_WINDOW_MS,
        ],
      });
      if (gate.rows.length === 0) {
        await tx.rollback();
        return false;
      }
      await tx.execute({
        sql: `INSERT INTO account_stats (username, lookup_count, first_lookup_at, last_lookup_at)
              VALUES (?, 1, ?, ?)
              ON CONFLICT(username) DO UPDATE SET
                lookup_count   = account_stats.lookup_count + 1,
                last_lookup_at = excluded.last_lookup_at`,
        args: [normalizedUsername, now, now],
      });
      await tx.commit();
      return true;
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  } catch (e) {
    console.error("recordAccountLookup failed:", e);
    return false;
  }
}

/** Upsert an account's latest score. Best-effort; never throws to the caller. */
export async function recordScore(entry: ScoreEntry): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    const username = entry.username.toLowerCase();
    await db.execute({
      sql: `INSERT INTO scores
              (username, display_name, avatar_url, profile_url, final_score, tier, tags, roast_line, bot_score, sub_scores, scanned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
              display_name = excluded.display_name,
              avatar_url   = excluded.avatar_url,
              profile_url  = excluded.profile_url,
              final_score  = excluded.final_score,
              tier         = excluded.tier,
              tags         = excluded.tags,
              roast_line   = excluded.roast_line,
              bot_score    = excluded.bot_score,
              sub_scores   = excluded.sub_scores,
              scanned_at   = excluded.scanned_at`,
      args: [
        username,
        entry.display_name,
        entry.avatar_url,
        entry.profile_url,
        entry.final_score,
        entry.tier,
        JSON.stringify(entry.tags ?? EMPTY_TAGS),
        JSON.stringify(entry.roast_line ?? EMPTY_ROAST_LINE),
        entry.bot_score,
        JSON.stringify(entry.sub_scores),
        entry.scanned_at,
      ],
    });
    await db.execute({
      sql: `INSERT INTO account_stats (username, lookup_count, first_lookup_at, last_lookup_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
              lookup_count = MAX(account_stats.lookup_count, excluded.lookup_count)`,
      args: [username, MIN_RECORDED_LOOKUP_COUNT, entry.scanned_at, entry.scanned_at],
    });
  } catch (e) {
    console.error("recordScore failed:", e);
  }
}

/**
 * Attach the finished roast markdown to an account row. Called after the LLM
 * stream completes (the full text isn't known at {@link recordScore} time, which
 * runs before streaming so the percentile reflects this scan). No-op if the row
 * doesn't exist yet (e.g. a BYO-key roast that was never recorded).
 */
export async function updateRoast(username: string, roast: string, lang: Lang): Promise<void> {
  const db = getClient();
  if (!db) return;
  // Column name comes from a fixed allowlist (never from user input).
  const col = lang === "en" ? "roast_en" : "roast";
  try {
    await ensureSchema(db);
    await db.execute({
      sql: `UPDATE scores SET ${col} = ? WHERE username = ?`,
      args: [roast, username.toLowerCase()],
    });
  } catch (e) {
    console.error("updateRoast failed:", e);
  }
}

/** Counts for percentile: accounts strictly below `score`, and the total. */
export async function getPercentile(
  score: number,
): Promise<{ below: number; total: number } | null> {
  const db = getClient();
  if (!db) {
    const preview = previewLeaderboard(Number.MAX_SAFE_INTEGER, 0);
    if (preview.length === 0) return null;
    return {
      below: preview.filter((entry) => entry.final_score < score).length,
      total: preview.length,
    };
  }
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM scores WHERE final_score < ?) AS below,
              (SELECT COUNT(*) FROM scores) AS total`,
      args: [score],
    });
    const row = res.rows[0];
    if (!row) {
      const preview = previewLeaderboard(Number.MAX_SAFE_INTEGER, 0);
      return preview.length
        ? {
            below: preview.filter((entry) => entry.final_score < score).length,
            total: preview.length,
          }
        : null;
    }
    const counts = { below: Number(row.below), total: Number(row.total) };
    if (counts.total > 0) return counts;
    const preview = previewLeaderboard(Number.MAX_SAFE_INTEGER, 0);
    return preview.length
      ? {
          below: preview.filter((entry) => entry.final_score < score).length,
          total: preview.length,
        }
      : counts;
  } catch (e) {
    console.error("getPercentile failed:", e);
    return null;
  }
}

/** Total number of accounts ever evaluated (for the "N developers" counter). */
export async function getScoreCount(): Promise<number | null> {
  const db = getClient();
  if (!db) {
    const preview = previewLeaderboard(Number.MAX_SAFE_INTEGER, 0);
    return preview.length ? preview.length : null;
  }
  try {
    await ensureSchema(db);
    const res = await db.execute("SELECT COUNT(*) AS n FROM scores");
    const count = Number(res.rows[0]?.n ?? 0);
    if (count > 0) return count;
    const preview = previewLeaderboard(Number.MAX_SAFE_INTEGER, 0);
    return preview.length ? preview.length : count;
  } catch (e) {
    console.error("getScoreCount failed:", e);
    return null;
  }
}

/** Top high-scoring accounts for the public 名人堂 board (excludes hidden). */
export async function getLeaderboard(
  limit = 100,
  minScore = 60,
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) return previewLeaderboard(limit, minScore);
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
                   s.final_score, s.tier, s.tags,
                   MAX(COALESCE(stats.lookup_count, 0), ${MIN_RECORDED_LOOKUP_COUNT}) AS lookup_count
            FROM scores AS s
            LEFT JOIN account_stats AS stats ON stats.username = s.username
            WHERE s.hidden = 0 AND s.final_score >= ?
            ORDER BY s.final_score DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [minScore, limit],
    });
    const entries = res.rows.map((r) => ({
      username: String(r.username),
      display_name: r.display_name as string | null,
      avatar_url: r.avatar_url as string | null,
      profile_url: r.profile_url as string | null,
      final_score: Number(r.final_score),
      tier: String(r.tier) as Tier,
      tags: parseTags(r.tags),
      lookup_count: normalizeLookupCount(r.lookup_count),
    }));
    return entries.length > 0 ? entries : previewLeaderboard(limit, minScore);
  } catch (e) {
    console.error("getLeaderboard failed:", e);
    return previewLeaderboard(limit, minScore);
  }
}

/** Public board sorted by successful lookup count, highest heat first. */
export async function getHeatLeaderboard(
  limit = 100,
  minScore = 60,
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) return previewHeatLeaderboard(limit, minScore);
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
                   s.final_score, s.tier, s.tags,
                   MAX(COALESCE(stats.lookup_count, 0), ${MIN_RECORDED_LOOKUP_COUNT}) AS lookup_count
            FROM scores AS s
            LEFT JOIN account_stats AS stats ON stats.username = s.username
            WHERE s.hidden = 0 AND s.final_score >= ?
            ORDER BY lookup_count DESC, s.final_score DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [minScore, limit],
    });
    const entries = res.rows.map((r) => ({
      username: String(r.username),
      display_name: r.display_name as string | null,
      avatar_url: r.avatar_url as string | null,
      profile_url: r.profile_url as string | null,
      final_score: Number(r.final_score),
      tier: String(r.tier) as Tier,
      tags: parseTags(r.tags),
      lookup_count: normalizeLookupCount(r.lookup_count),
    }));
    return entries.length > 0 ? entries : previewHeatLeaderboard(limit, minScore);
  } catch (e) {
    console.error("getHeatLeaderboard failed:", e);
    return previewHeatLeaderboard(limit, minScore);
  }
}

export interface AccountDetail {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  final_score: number;
  tier: Tier;
  tags: Tags;
  sub_scores: SubScores;
  /** Bilingual savage one-liner {zh,en}; empty for legacy rows (see `roast`). */
  roast_line: RoastLine;
  /** Chinese roast report (legacy single-language column). */
  roast: string | null;
  /** English roast report; null until an `/en` roast has been generated. */
  roast_en: string | null;
  scanned_at: number;
}

export interface ArchivedRoast {
  username: string;
  final_score: number;
  tier: Tier;
  tags: Tags;
  roast_line: RoastLine;
  report: string;
}

export interface ScoreBrief {
  username: string;
  display_name: string | null;
  final_score: number;
  tier: Tier;
}

/** Minimal score lookup for the SVG badge — avoids fetching the heavy roast text. */
export async function getScoreBrief(username: string): Promise<ScoreBrief | null> {
  const db = getClient();
  if (!db) {
    const preview = previewAccountDetail(username);
    return preview
      ? {
          username: preview.username,
          display_name: preview.display_name,
          final_score: preview.final_score,
          tier: preview.tier,
        }
      : null;
  }
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT username, display_name, final_score, tier
            FROM scores
            WHERE username = ? AND hidden = 0
            LIMIT 1`,
      args: [username.toLowerCase()],
    });
    const r = res.rows[0];
    if (!r) {
      const preview = previewAccountDetail(username);
      return preview
        ? {
            username: preview.username,
            display_name: preview.display_name,
            final_score: preview.final_score,
            tier: preview.tier,
          }
        : null;
    }
    return {
      username: String(r.username),
      display_name: r.display_name as string | null,
      final_score: Number(r.final_score),
      tier: String(r.tier) as Tier,
    };
  } catch (e) {
    console.error("getScoreBrief failed:", e);
    return null;
  }
}

/** Full persisted record for one account's detail page (null if absent/hidden). */
export async function getAccountDetail(username: string): Promise<AccountDetail | null> {
  const db = getClient();
  if (!db) return previewAccountDetail(username);
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT username, display_name, avatar_url, profile_url, final_score, tier,
                   tags, roast_line, sub_scores, roast, roast_en, scanned_at
            FROM scores
            WHERE username = ? AND hidden = 0
            LIMIT 1`,
      args: [username.toLowerCase()],
    });
    const r = res.rows[0];
    if (!r) return previewAccountDetail(username);
    return {
      username: String(r.username),
      display_name: r.display_name as string | null,
      avatar_url: r.avatar_url as string | null,
      profile_url: r.profile_url as string | null,
      final_score: Number(r.final_score),
      tier: String(r.tier) as Tier,
      tags: parseTags(r.tags),
      roast_line: parseRoastLine(r.roast_line),
      sub_scores: parseSubScores(r.sub_scores),
      roast: (r.roast as string | null) ?? null,
      roast_en: (r.roast_en as string | null) ?? null,
      scanned_at: Number(r.scanned_at),
    };
  } catch (e) {
    console.error("getAccountDetail failed:", e);
    return previewAccountDetail(username);
  }
}

/**
 * Stored roast report for replaying a previous default-model generation. The
 * language column is fixed by allowlist, so the SQL never uses user input for a
 * column name.
 */
export async function getArchivedRoast(
  username: string,
  lang: Lang,
): Promise<ArchivedRoast | null> {
  const db = getClient();
  if (!db) return null;
  const col = lang === "en" ? "roast_en" : "roast";
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT username, final_score, tier, tags, roast_line, ${col} AS report
            FROM scores
            WHERE username = ?
              AND hidden = 0
              AND ${col} IS NOT NULL
              AND ${col} != ''
            LIMIT 1`,
      args: [username.toLowerCase()],
    });
    const r = res.rows[0];
    if (!r) return null;
    return {
      username: String(r.username),
      final_score: Number(r.final_score),
      tier: String(r.tier) as Tier,
      tags: parseTags(r.tags),
      roast_line: parseRoastLine(r.roast_line),
      report: String(r.report),
    };
  } catch (e) {
    console.error("getArchivedRoast failed:", e);
    return null;
  }
}

/** Score band (± points) used to pre-filter candidates before profile ranking. */
const SIMILAR_SCORE_BAND = 10;
/** Cap on candidates scanned, so this stays cheap as the table grows. */
const SIMILAR_POOL = 300;

/**
 * Developers most similar to `username`: pre-filter by a score band (uses the
 * final_score index — the cost-safe lever), then rank that pool by 6-dim profile
 * distance and return the closest `limit`. The target's score/profile are passed
 * in (the caller already has them) to avoid a second lookup. Returns [] on any
 * failure or when the DB is unconfigured.
 */
export async function getSimilarAccounts(
  username: string,
  finalScore: number,
  subScores: SubScores,
  limit = 6,
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) {
    return previewLeaderboard(Number.MAX_SAFE_INTEGER, 0)
      .filter((entry) => entry.username.toLowerCase() !== username.toLowerCase())
      .slice(0, limit);
  }
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
                   s.final_score, s.tier, s.tags, s.sub_scores,
                   MAX(COALESCE(stats.lookup_count, 0), ${MIN_RECORDED_LOOKUP_COUNT}) AS lookup_count
            FROM scores AS s
            LEFT JOIN account_stats AS stats ON stats.username = s.username
            WHERE s.hidden = 0
              AND s.username != ?
              AND s.final_score BETWEEN ? AND ?
            ORDER BY s.final_score DESC
            LIMIT ?`,
      args: [
        username.toLowerCase(),
        finalScore - SIMILAR_SCORE_BAND,
        finalScore + SIMILAR_SCORE_BAND,
        SIMILAR_POOL,
      ],
    });
    const candidates = res.rows.map((r) => ({
      username: String(r.username),
      display_name: r.display_name as string | null,
      avatar_url: r.avatar_url as string | null,
      profile_url: r.profile_url as string | null,
      final_score: Number(r.final_score),
      tier: String(r.tier) as Tier,
      tags: parseTags(r.tags),
      sub_scores: parseSubScores(r.sub_scores),
      lookup_count: normalizeLookupCount(r.lookup_count),
    }));
    const ranked = rankSimilar(subScores, candidates, limit).map((e) => ({
      username: e.username,
      display_name: e.display_name,
      avatar_url: e.avatar_url,
      profile_url: e.profile_url,
      final_score: e.final_score,
      tier: e.tier,
      tags: e.tags,
      lookup_count: e.lookup_count,
    }));
    if (ranked.length > 0) return ranked;
    return previewLeaderboard(Number.MAX_SAFE_INTEGER, 0)
      .filter((entry) => entry.username.toLowerCase() !== username.toLowerCase())
      .slice(0, limit);
  } catch (e) {
    console.error("getSimilarAccounts failed:", e);
    return previewLeaderboard(Number.MAX_SAFE_INTEGER, 0)
      .filter((entry) => entry.username.toLowerCase() !== username.toLowerCase())
      .slice(0, limit);
  }
}

/** Remove an account from the public board (still counted in the percentile). */
export async function hideUser(username: string): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    await db.execute({
      sql: `UPDATE scores SET hidden = 1 WHERE username = ?`,
      args: [username.toLowerCase()],
    });
  } catch (e) {
    console.error("hideUser failed:", e);
  }
}

export interface UserUpsert {
  github_id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

/**
 * Upsert a logged-in GitHub user. Best-effort; no-ops without Turso. `login` is
 * stored lowercased to match the `scores.username` convention for later linking.
 */
export async function upsertUser(u: UserUpsert): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    const now = Date.now();
    await db.execute({
      sql: `INSERT INTO users (github_id, login, name, avatar_url, created_at, last_login)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(github_id) DO UPDATE SET
              login      = excluded.login,
              name       = excluded.name,
              avatar_url = excluded.avatar_url,
              last_login = excluded.last_login`,
      args: [u.github_id, u.login.toLowerCase(), u.name, u.avatar_url, now, now],
    });
  } catch (e) {
    console.error("upsertUser failed:", e);
  }
}
