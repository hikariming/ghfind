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
import { rankSimilar } from "./similarity";
import type { SubScores, Tags, Tier } from "./types";

const EMPTY_TAGS: Tags = { zh: [], en: [] };

function parseTags(raw: unknown): Tags {
  if (typeof raw !== "string" || !raw) return EMPTY_TAGS;
  try {
    const t = JSON.parse(raw) as Partial<Tags>;
    return { zh: Array.isArray(t.zh) ? t.zh : [], en: Array.isArray(t.en) ? t.en : [] };
  } catch {
    return EMPTY_TAGS;
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
             hidden       INTEGER NOT NULL DEFAULT 0,
             scanned_at   INTEGER NOT NULL
           )`,
          `CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(final_score DESC)`,
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
      for (const col of ["tags TEXT", "bot_score REAL", "sub_scores TEXT", "roast TEXT"]) {
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
}

/** Upsert an account's latest score. Best-effort; never throws to the caller. */
export async function recordScore(entry: ScoreEntry): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    await db.execute({
      sql: `INSERT INTO scores
              (username, display_name, avatar_url, profile_url, final_score, tier, tags, bot_score, sub_scores, scanned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
              display_name = excluded.display_name,
              avatar_url   = excluded.avatar_url,
              profile_url  = excluded.profile_url,
              final_score  = excluded.final_score,
              tier         = excluded.tier,
              tags         = excluded.tags,
              bot_score    = excluded.bot_score,
              sub_scores   = excluded.sub_scores,
              scanned_at   = excluded.scanned_at`,
      args: [
        entry.username.toLowerCase(),
        entry.display_name,
        entry.avatar_url,
        entry.profile_url,
        entry.final_score,
        entry.tier,
        JSON.stringify(entry.tags ?? EMPTY_TAGS),
        entry.bot_score,
        JSON.stringify(entry.sub_scores),
        entry.scanned_at,
      ],
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
export async function updateRoast(username: string, roast: string): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    await db.execute({
      sql: `UPDATE scores SET roast = ? WHERE username = ?`,
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
    return { below: Number(row.below), total: Number(row.total) };
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
      sql: `SELECT username, display_name, avatar_url, profile_url, final_score, tier, tags
            FROM scores
            WHERE hidden = 0 AND final_score >= ?
            ORDER BY final_score DESC, scanned_at DESC
            LIMIT ?`,
      args: [minScore, limit],
    });
    return res.rows.map((r) => ({
      username: String(r.username),
      display_name: r.display_name as string | null,
      avatar_url: r.avatar_url as string | null,
      profile_url: r.profile_url as string | null,
      final_score: Number(r.final_score),
      tier: String(r.tier) as Tier,
      tags: parseTags(r.tags),
    }));
  } catch (e) {
    console.error("getLeaderboard failed:", e);
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
  roast: string | null;
  scanned_at: number;
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
                   tags, sub_scores, roast, scanned_at
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
      sub_scores: parseSubScores(r.sub_scores),
      roast: (r.roast as string | null) ?? null,
      scanned_at: Number(r.scanned_at),
    };
  } catch (e) {
    console.error("getAccountDetail failed:", e);
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
      sql: `SELECT username, display_name, avatar_url, profile_url, final_score, tier, tags, sub_scores
            FROM scores
            WHERE hidden = 0
              AND username != ?
              AND final_score BETWEEN ? AND ?
            ORDER BY final_score DESC
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
    }));
    // Rank by profile distance, then drop sub_scores to match LeaderboardEntry.
    return rankSimilar(subScores, candidates, limit).map(({ sub_scores: _omit, ...e }) => e);
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
