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
import {
  bypassGeneratedCaches,
  ROAST_CACHE_VERSION,
  SCORE_CACHE_VERSION,
} from "./cache-version";
import { computeTrendingScore, rankTrending } from "./hotness";
import type { Lang } from "./lang";
import type { PaperDims, PaperMode, PaperTierKey } from "./paper-types";
import { rankSimilar } from "./similarity";
import type { RoastLine, SubScores, Tags, Tier } from "./types";

const EMPTY_TAGS: Tags = { zh: [], en: [] };
const HEAT_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRENDING_LOOKUP_WINDOW_MS = 7 * HEAT_LOOKUP_WINDOW_MS;
const MIN_RECORDED_LOOKUP_COUNT = 1;
// Only roll the previous score forward when this much time has passed since the
// last recorded scan. Distinguishes a genuine re-scan (≥24h apart, since scans
// are cached 24h) from the same session re-recording in the other language a few
// seconds later — the latter must not clobber a real improvement.
const PROGRESS_MIN_GAP_MS = 60 * 60 * 1000;

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

function normalizeRecentLookupCount(raw: unknown): number {
  return Math.max(0, Number(raw) || 0);
}

function normalizeLastLookupAt(raw: unknown): number | null {
  return raw == null ? null : Number(raw);
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
          // arXiv 论文锐评: one row per scored paper (score fixed once computed).
          `CREATE TABLE IF NOT EXISTS papers (
             arxiv_id      TEXT PRIMARY KEY,
             title         TEXT NOT NULL,
             authors       TEXT,
             categories    TEXT,
             published     TEXT,
             citation_count INTEGER,
             influential_citation_count INTEGER,
             venue         TEXT,
             final_score   REAL NOT NULL,
             tier          TEXT NOT NULL,
             dims          TEXT,
             content_base  REAL,
             citation_bonus REAL,
             tags          TEXT,
             tldr_line     TEXT,
             hidden        INTEGER NOT NULL DEFAULT 0,
             scored_at     INTEGER NOT NULL
           )`,
          `CREATE INDEX IF NOT EXISTS idx_papers_score ON papers(final_score DESC)`,
          // Commentary per (paper, mode, lang) — populates the detail page.
          `CREATE TABLE IF NOT EXISTS paper_roasts (
             arxiv_id   TEXT NOT NULL,
             mode       TEXT NOT NULL,
             lang       TEXT NOT NULL,
             report     TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             PRIMARY KEY (arxiv_id, mode, lang)
           )`,
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
        "score_version TEXT",
        "roast_version TEXT",
        "roast_en_version TEXT",
        // Previous scan's score + timestamp, kept for the 进步榜 (progress board).
        // Populated by recordScore on a genuinely later re-scan; NULL until then.
        "prev_score REAL",
        "prev_scanned_at INTEGER",
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
  recent_lookup_count: number;
  trending_score: number;
  /** Previous recorded score — only set on the 进步榜 (progress) board. */
  prev_score?: number;
  /** final_score - prev_score — only set on the 进步榜 (progress) board. */
  delta?: number;
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
              (username, display_name, avatar_url, profile_url, final_score, tier, tags, roast_line, score_version, bot_score, sub_scores, scanned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
              prev_score      = CASE WHEN excluded.scanned_at - scores.scanned_at >= ?
                                     THEN scores.final_score ELSE scores.prev_score END,
              prev_scanned_at = CASE WHEN excluded.scanned_at - scores.scanned_at >= ?
                                     THEN scores.scanned_at ELSE scores.prev_scanned_at END,
              display_name = excluded.display_name,
              avatar_url   = excluded.avatar_url,
              profile_url  = excluded.profile_url,
              final_score  = excluded.final_score,
              tier         = excluded.tier,
              tags         = excluded.tags,
              roast_line   = excluded.roast_line,
              score_version = excluded.score_version,
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
        SCORE_CACHE_VERSION,
        entry.bot_score,
        JSON.stringify(entry.sub_scores),
        entry.scanned_at,
        PROGRESS_MIN_GAP_MS,
        PROGRESS_MIN_GAP_MS,
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
  const versionCol = lang === "en" ? "roast_en_version" : "roast_version";
  try {
    await ensureSchema(db);
    await db.execute({
      sql: `UPDATE scores SET ${col} = ?, ${versionCol} = ? WHERE username = ?`,
      args: [roast, ROAST_CACHE_VERSION, username.toLowerCase()],
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
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM scores WHERE final_score < ?) AS below,
              (SELECT COUNT(*) FROM scores) AS total`,
      args: [score],
    });
    const row = res.rows[0];
    if (!row) return null;
    const counts = { below: Number(row.below), total: Number(row.total) };
    return counts.total > 0 ? counts : null;
  } catch (e) {
    console.error("getPercentile failed:", e);
    return null;
  }
}

/** Total number of accounts ever evaluated (for the "N developers" counter). */
export async function getScoreCount(): Promise<number | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute("SELECT COUNT(*) AS n FROM scores");
    return Number(res.rows[0]?.n ?? 0);
  } catch (e) {
    console.error("getScoreCount failed:", e);
    return null;
  }
}

interface LeaderboardRow {
  username: unknown;
  display_name: unknown;
  avatar_url: unknown;
  profile_url: unknown;
  final_score: unknown;
  tier: unknown;
  tags: unknown;
  lookup_count: unknown;
  recent_lookup_count?: unknown;
  last_lookup_at?: unknown;
}

function toLeaderboardEntry(r: LeaderboardRow, now = Date.now()): LeaderboardEntry {
  const username = String(r.username);
  const final_score = Number(r.final_score);
  const lookup_count = normalizeLookupCount(r.lookup_count);
  const recent_lookup_count = normalizeRecentLookupCount(r.recent_lookup_count);
  const last_lookup_at = normalizeLastLookupAt(r.last_lookup_at);
  return {
    username,
    display_name: r.display_name as string | null,
    avatar_url: r.avatar_url as string | null,
    profile_url: r.profile_url as string | null,
    final_score,
    tier: String(r.tier) as Tier,
    tags: parseTags(r.tags),
    lookup_count,
    recent_lookup_count,
    trending_score: computeTrendingScore(
      { username, final_score, lookup_count, recent_lookup_count, last_lookup_at },
      now,
    ),
  };
}

/** Default 名人堂 board: score lifted by recent unique lookup heat. */
export async function getTrendingLeaderboard(
  limit = 100,
  minScore = 60,
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const now = Date.now();
    const res = await db.execute({
      sql: `SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
                   s.final_score, s.tier, s.tags,
                   MAX(COALESCE(stats.lookup_count, 0), ${MIN_RECORDED_LOOKUP_COUNT}) AS lookup_count,
                   COALESCE(recent.recent_lookup_count, 0) AS recent_lookup_count,
                   stats.last_lookup_at AS last_lookup_at
            FROM scores AS s
            LEFT JOIN account_stats AS stats ON stats.username = s.username
            LEFT JOIN (
              SELECT username, COUNT(*) AS recent_lookup_count
              FROM account_lookup_limits
              WHERE last_counted_at >= ?
              GROUP BY username
            ) AS recent ON recent.username = s.username
            WHERE s.hidden = 0 AND s.final_score >= ?`,
      args: [now - TRENDING_LOOKUP_WINDOW_MS, minScore],
    });
    return rankTrending(
      res.rows.map((r) => ({
        ...toLeaderboardEntry(r as unknown as LeaderboardRow, now),
        last_lookup_at: normalizeLastLookupAt(r.last_lookup_at),
      })),
      now,
    )
      .slice(0, limit)
      .map(({ last_lookup_at: _lastLookupAt, ...entry }) => entry);
  } catch (e) {
    console.error("getTrendingLeaderboard failed:", e);
    return [];
  }
}

/** One indexable profile: its canonical slug + when it was last scored. */
export interface PublicProfile {
  username: string;
  scanned_at: number;
}

/**
 * All profiles eligible for the sitemap: non-hidden and scoring at/above the
 * public index floor. Ordered by score so the highest-value pages lead. Used by
 * `app/sitemap.ts`; returns [] when Turso is unconfigured.
 */
export async function getAllPublicUsernames(minScore = 60): Promise<PublicProfile[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT username, scanned_at
            FROM scores
            WHERE hidden = 0 AND final_score >= ?
            ORDER BY final_score DESC`,
      args: [minScore],
    });
    return res.rows.map((r) => ({
      username: String(r.username),
      scanned_at: Number(r.scanned_at),
    }));
  } catch (e) {
    console.error("getAllPublicUsernames failed:", e);
    return [];
  }
}

/** Top high-scoring accounts for the public 名人堂 board (excludes hidden). */
export async function getLeaderboard(
  limit = 100,
  minScore = 60,
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
                   s.final_score, s.tier, s.tags,
                   MAX(COALESCE(stats.lookup_count, 0), ${MIN_RECORDED_LOOKUP_COUNT}) AS lookup_count,
                   COALESCE(recent.recent_lookup_count, 0) AS recent_lookup_count,
                   stats.last_lookup_at AS last_lookup_at
            FROM scores AS s
            LEFT JOIN account_stats AS stats ON stats.username = s.username
            LEFT JOIN (
              SELECT username, COUNT(*) AS recent_lookup_count
              FROM account_lookup_limits
              WHERE last_counted_at >= ?
              GROUP BY username
            ) AS recent ON recent.username = s.username
            WHERE s.hidden = 0 AND s.final_score >= ?
            ORDER BY s.final_score DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [Date.now() - TRENDING_LOOKUP_WINDOW_MS, minScore, limit],
    });
    const now = Date.now();
    return res.rows.map((r) => toLeaderboardEntry(r as unknown as LeaderboardRow, now));
  } catch (e) {
    console.error("getLeaderboard failed:", e);
    return [];
  }
}

/** Public board sorted by successful lookup count, highest heat first. */
export async function getHeatLeaderboard(
  limit = 100,
  minScore = 60,
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
                   s.final_score, s.tier, s.tags,
                   MAX(COALESCE(stats.lookup_count, 0), ${MIN_RECORDED_LOOKUP_COUNT}) AS lookup_count,
                   COALESCE(recent.recent_lookup_count, 0) AS recent_lookup_count,
                   stats.last_lookup_at AS last_lookup_at
            FROM scores AS s
            LEFT JOIN account_stats AS stats ON stats.username = s.username
            LEFT JOIN (
              SELECT username, COUNT(*) AS recent_lookup_count
              FROM account_lookup_limits
              WHERE last_counted_at >= ?
              GROUP BY username
            ) AS recent ON recent.username = s.username
            WHERE s.hidden = 0 AND s.final_score >= ?
            ORDER BY lookup_count DESC, s.final_score DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [Date.now() - TRENDING_LOOKUP_WINDOW_MS, minScore, limit],
    });
    const now = Date.now();
    return res.rows.map((r) => toLeaderboardEntry(r as unknown as LeaderboardRow, now));
  } catch (e) {
    console.error("getHeatLeaderboard failed:", e);
    return [];
  }
}

/** Public 进步榜 board: accounts whose latest score beats their previous one,
 *  biggest gain first. No minScore floor — a 20→40 climb belongs here too. */
export async function getProgressLeaderboard(limit = 100): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
                   s.final_score, s.tier, s.tags, s.prev_score,
                   MAX(COALESCE(stats.lookup_count, 0), ${MIN_RECORDED_LOOKUP_COUNT}) AS lookup_count,
                   COALESCE(recent.recent_lookup_count, 0) AS recent_lookup_count,
                   stats.last_lookup_at AS last_lookup_at
            FROM scores AS s
            LEFT JOIN account_stats AS stats ON stats.username = s.username
            LEFT JOIN (
              SELECT username, COUNT(*) AS recent_lookup_count
              FROM account_lookup_limits
              WHERE last_counted_at >= ?
              GROUP BY username
            ) AS recent ON recent.username = s.username
            WHERE s.hidden = 0
              AND s.prev_score IS NOT NULL
              AND s.final_score > s.prev_score
            ORDER BY (s.final_score - s.prev_score) DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [Date.now() - TRENDING_LOOKUP_WINDOW_MS, limit],
    });
    const now = Date.now();
    return res.rows.map((r) => {
      const entry = toLeaderboardEntry(r as unknown as LeaderboardRow, now);
      const final_score = Number(r.final_score);
      const prev_score = Number(r.prev_score);
      return {
        ...entry,
        final_score,
        prev_score,
        delta: final_score - prev_score,
      };
    });
  } catch (e) {
    console.error("getProgressLeaderboard failed:", e);
    return [];
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
  if (!db) return null;
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
    if (!r) return null;
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
  if (!db) return null;
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
    if (!r) return null;
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
    return null;
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
  if (bypassGeneratedCaches()) return null;
  const db = getClient();
  if (!db) return null;
  const col = lang === "en" ? "roast_en" : "roast";
  const versionCol = lang === "en" ? "roast_en_version" : "roast_version";
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT username, final_score, tier, tags, roast_line, ${col} AS report
            FROM scores
            WHERE username = ?
              AND hidden = 0
              AND score_version = ?
              AND ${versionCol} = ?
              AND ${col} IS NOT NULL
              AND ${col} != ''
            LIMIT 1`,
      args: [username.toLowerCase(), SCORE_CACHE_VERSION, ROAST_CACHE_VERSION],
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
  if (!db) return [];
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
      ...toLeaderboardEntry(r as unknown as LeaderboardRow),
      sub_scores: parseSubScores(r.sub_scores),
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
      recent_lookup_count: e.recent_lookup_count,
      trending_score: e.trending_score,
    }));
    return ranked;
  } catch (e) {
    console.error("getSimilarAccounts failed:", e);
    return [];
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

// ─────────────────────────── arXiv 论文锐评 ───────────────────────────

export interface PaperEntry {
  arxiv_id: string;
  title: string;
  authors: string[];
  categories: string[];
  published: string | null;
  citation_count: number | null;
  influential_citation_count: number | null;
  venue: string | null;
  final_score: number;
  tier: PaperTierKey;
  dims: PaperDims;
  content_base: number;
  citation_bonus: number;
  tags: Tags;
  tldr_line: RoastLine;
  scored_at: number;
}

export type PaperDetail = PaperEntry;

export interface PaperListEntry {
  arxiv_id: string;
  title: string;
  authors: string[];
  final_score: number;
  tier: PaperTierKey;
  tags: Tags;
  citation_count: number | null;
}

function parseStrArray(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

const EMPTY_DIMS: PaperDims = {
  novelty: 0,
  rigor: 0,
  significance: 0,
  clarity: 0,
  reproducibility: 0,
};

function parseDims(raw: unknown): PaperDims {
  if (typeof raw !== "string" || !raw) return EMPTY_DIMS;
  try {
    const d = JSON.parse(raw) as Partial<PaperDims>;
    return {
      novelty: Number(d.novelty) || 0,
      rigor: Number(d.rigor) || 0,
      significance: Number(d.significance) || 0,
      clarity: Number(d.clarity) || 0,
      reproducibility: Number(d.reproducibility) || 0,
    };
  } catch {
    return EMPTY_DIMS;
  }
}

/** Upsert a scored paper. The score is fixed once computed — callers only invoke
 *  this on a genuinely fresh score (the roast route reuses an existing one). */
export async function recordPaper(p: PaperEntry): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    await db.execute({
      sql: `INSERT INTO papers
              (arxiv_id, title, authors, categories, published, citation_count,
               influential_citation_count, venue, final_score, tier, dims,
               content_base, citation_bonus, tags, tldr_line, scored_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(arxiv_id) DO UPDATE SET
              citation_count = excluded.citation_count,
              influential_citation_count = excluded.influential_citation_count,
              venue = excluded.venue`,
      args: [
        p.arxiv_id,
        p.title,
        JSON.stringify(p.authors),
        JSON.stringify(p.categories),
        p.published,
        p.citation_count,
        p.influential_citation_count,
        p.venue,
        p.final_score,
        p.tier,
        JSON.stringify(p.dims),
        p.content_base,
        p.citation_bonus,
        JSON.stringify(p.tags),
        JSON.stringify(p.tldr_line),
        p.scored_at,
      ],
    });
  } catch (e) {
    console.error("recordPaper failed:", e);
  }
}

function rowToPaper(r: Record<string, unknown>): PaperDetail {
  return {
    arxiv_id: String(r.arxiv_id),
    title: String(r.title),
    authors: parseStrArray(r.authors),
    categories: parseStrArray(r.categories),
    published: (r.published as string | null) ?? null,
    citation_count: r.citation_count == null ? null : Number(r.citation_count),
    influential_citation_count:
      r.influential_citation_count == null ? null : Number(r.influential_citation_count),
    venue: (r.venue as string | null) ?? null,
    final_score: Number(r.final_score),
    tier: String(r.tier) as PaperTierKey,
    dims: parseDims(r.dims),
    content_base: Number(r.content_base),
    citation_bonus: Number(r.citation_bonus),
    tags: parseTags(r.tags),
    tldr_line: parseRoastLine(r.tldr_line),
    scored_at: Number(r.scored_at),
  };
}

export async function getPaper(arxivId: string): Promise<PaperDetail | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT * FROM papers WHERE arxiv_id = ? AND hidden = 0 LIMIT 1`,
      args: [arxivId],
    });
    const r = res.rows[0];
    return r ? rowToPaper(r as unknown as Record<string, unknown>) : null;
  } catch (e) {
    console.error("getPaper failed:", e);
    return null;
  }
}

/** Persist the commentary for one (paper, mode, lang) — feeds the detail page. */
export async function updatePaperRoast(
  arxivId: string,
  mode: PaperMode,
  lang: Lang,
  report: string,
): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    await db.execute({
      sql: `INSERT INTO paper_roasts (arxiv_id, mode, lang, report, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(arxiv_id, mode, lang) DO UPDATE SET
              report = excluded.report, created_at = excluded.created_at`,
      args: [arxivId, mode, lang, report, Date.now()],
    });
  } catch (e) {
    console.error("updatePaperRoast failed:", e);
  }
}

export async function getPaperRoast(
  arxivId: string,
  mode: PaperMode,
  lang: Lang,
): Promise<string | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT report FROM paper_roasts WHERE arxiv_id = ? AND mode = ? AND lang = ? LIMIT 1`,
      args: [arxivId, mode, lang],
    });
    const r = res.rows[0];
    return r ? String(r.report) : null;
  } catch (e) {
    console.error("getPaperRoast failed:", e);
    return null;
  }
}

/** Paper board: `top` = 神作榜 (highest first), `bottom` = 灌水榜 (lowest first). */
export async function getPaperLeaderboard(
  order: "top" | "bottom" = "top",
  limit = 50,
): Promise<PaperListEntry[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const dir = order === "bottom" ? "ASC" : "DESC";
    const res = await db.execute({
      sql: `SELECT arxiv_id, title, authors, final_score, tier, tags, citation_count
            FROM papers WHERE hidden = 0
            ORDER BY final_score ${dir}, scored_at DESC
            LIMIT ?`,
      args: [limit],
    });
    return res.rows.map((r) => ({
      arxiv_id: String(r.arxiv_id),
      title: String(r.title),
      authors: parseStrArray(r.authors),
      final_score: Number(r.final_score),
      tier: String(r.tier) as PaperTierKey,
      tags: parseTags(r.tags),
      citation_count: r.citation_count == null ? null : Number(r.citation_count),
    }));
  } catch (e) {
    console.error("getPaperLeaderboard failed:", e);
    return [];
  }
}

/** All indexable paper ids + last-scored time, for the sitemap. */
export async function getAllPaperIds(): Promise<{ arxiv_id: string; scored_at: number }[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const res = await db.execute(
      `SELECT arxiv_id, scored_at FROM papers WHERE hidden = 0 ORDER BY final_score DESC`,
    );
    return res.rows.map((r) => ({ arxiv_id: String(r.arxiv_id), scored_at: Number(r.scored_at) }));
  } catch (e) {
    console.error("getAllPaperIds failed:", e);
    return [];
  }
}
