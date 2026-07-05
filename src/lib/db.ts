/**
 * Turso (libSQL) persistence for the leaderboard + percentile.
 *
 * Optional, like {@link ./redis}: if `TURSO_DATABASE_URL` is unset, every function
 * no-ops (returns null/empty) so the app runs fine without it. Stores one latest
 * row per scanned account plus append-only score snapshots for long-term progress.
 * The score itself is still computed deterministically by `lib/score.ts`; this
 * layer only persists the result for cross-account ranking.
 */

import { Client, createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import {
  bypassGeneratedCaches,
  ROAST_CACHE_VERSION,
  SCORE_CACHE_VERSION,
} from "./cache-version";
import {
  normalizeCommentText,
  normalizeGitHubUsername,
  type ProfileComment,
  type ProfileCommentAuthor,
} from "./comments";
import { extractFacets, type FacetType } from "./facets";
import {
  emptyReactionCounts,
  isProfileReaction,
  type ProfileReaction,
  type ProfileReactionCounts,
  type ProfileReactionState,
} from "./reactions";
import { computeTrendingScore, rankTrending } from "./hotness";
import { VS_MIN_SCORE } from "./site";
import {
  clearCachedReactionCounts,
  getCachedReactionCounts,
  releaseLookupGate,
  setCachedReactionCounts,
  tryAcquireLookupGate,
} from "./redis";
import type { Lang } from "./lang";
import { rankSimilar } from "./similarity";
import type {
  ImpactRepo,
  RoastLine,
  ScanResult,
  SubScores,
  Tags,
  Tier,
  TopRepo,
} from "./types";
import type { LeaderboardWindow } from "./leaderboardWindow";

const EMPTY_TAGS: Tags = { zh: [], en: [] };
const HEAT_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRENDING_LOOKUP_WINDOW_MS = 7 * HEAT_LOOKUP_WINDOW_MS;
const MIN_RECORDED_LOOKUP_COUNT = 1;

// User-selectable leaderboard time window. Every board shares one meaning: the
// candidate pool is "accounts looked up within this window" (and the recent-heat
// figure is counted over the same window). "all" keeps the original behaviour —
// no recency filter, cumulative heat. The windowed count comes from
// `account_lookup_limits` (one row per unique IP per account, holding its most
// recent counted lookup), which the idx_account_lookup_limits_counted_user
// covering index serves index-only.
export type { LeaderboardWindow };
const LEADERBOARD_WINDOW_MS: Record<Exclude<LeaderboardWindow, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Resolve a window into the recent-lookup cutoff (feeds the windowed heat count
 * and the trending score's recency component) and whether to restrict the board
 * to accounts active within it. "all" preserves the legacy 7-week trending
 * recency window and applies no active filter.
 */
function resolveLeaderboardWindow(window: LeaderboardWindow, now: number) {
  if (window === "all") {
    return { recentCutoff: now - TRENDING_LOOKUP_WINDOW_MS, activeOnly: false };
  }
  return { recentCutoff: now - LEADERBOARD_WINDOW_MS[window], activeOnly: true };
}
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
          // Leaderboard & sitemap all filter `hidden = 0 AND final_score >= ?`,
          // so a composite index lets one seek cover both conditions.
          `CREATE INDEX IF NOT EXISTS idx_scores_hidden_score
             ON scores(hidden, final_score DESC)`,
          `CREATE TABLE IF NOT EXISTS score_snapshots (
             id            TEXT PRIMARY KEY,
             username      TEXT NOT NULL,
             display_name  TEXT,
             avatar_url    TEXT,
             profile_url   TEXT,
             final_score   REAL NOT NULL,
             tier          TEXT NOT NULL,
             tags          TEXT,
             roast_line    TEXT,
             bot_score     REAL,
             sub_scores    TEXT,
             score_version TEXT NOT NULL,
             roast_version TEXT NOT NULL,
             roast_lang    TEXT NOT NULL CHECK(roast_lang IN ('zh', 'en')),
             generated_at  INTEGER NOT NULL
           )`,
          `CREATE INDEX IF NOT EXISTS idx_score_snapshots_username_generated
             ON score_snapshots(username, generated_at DESC)`,
          // Raw developer-profile snapshots — the data moat. The full scan
          // (repos w/ topics + language breakdown, contributed repos, metrics,
          // pinned, orgs) is otherwise only cached in Redis for 24h. This is a
          // slow-path archive, decoupled from the leaderboard hot-path `scores`
          // table, so domain classification can be (re)derived later without
          // re-crawling GitHub. JSON columns: cheap to write, denormalized into
          // a developer⟷repo graph in a later phase if needed.
          `CREATE TABLE IF NOT EXISTS profile_snapshots (
             id            TEXT PRIMARY KEY,
             username      TEXT NOT NULL,
             scanned_at    INTEGER NOT NULL,
             top_repos     TEXT,
             impact_repos  TEXT,
             verified_prs  TEXT,
             metrics       TEXT,
             pinned_repos  TEXT,
             organizations TEXT,
             scan_version  TEXT
           )`,
          `CREATE INDEX IF NOT EXISTS idx_profile_snapshots_username_scanned
             ON profile_snapshots(username, scanned_at DESC)`,
          // Legacy: AI-generated anonymous danmaku for the detail page. The
          // feature was removed; this table is no longer read or written and is
          // kept only so existing databases (which may hold rows) stay valid.
          `CREATE TABLE IF NOT EXISTS profile_danmaku (
             username   TEXT PRIMARY KEY,
             lines      TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             version    TEXT
           )`,
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
          // Covering index for the windowed-heat subquery
          // (WHERE last_counted_at >= ? GROUP BY username): both columns live in
          // the index so the per-window unique-visitor count is computed
          // index-only, without touching the table.
          `CREATE INDEX IF NOT EXISTS idx_account_lookup_limits_counted_user
             ON account_lookup_limits(last_counted_at, username)`,
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
          `CREATE TABLE IF NOT EXISTS profile_comments (
             id                TEXT PRIMARY KEY,
             target_username   TEXT NOT NULL,
             body              TEXT NOT NULL,
             author_kind       TEXT NOT NULL,
             author_github_id  INTEGER,
             author_login      TEXT,
             author_avatar_url TEXT,
             hidden            INTEGER NOT NULL DEFAULT 0,
             created_at        INTEGER NOT NULL
           )`,
          `CREATE INDEX IF NOT EXISTS idx_profile_comments_target_created
             ON profile_comments(target_username, created_at DESC)`,
          `CREATE TABLE IF NOT EXISTS profile_reactions (
             target_username  TEXT NOT NULL,
             voter_github_id  INTEGER NOT NULL,
             voter_login      TEXT NOT NULL,
             reaction         TEXT NOT NULL,
             created_at       INTEGER NOT NULL,
             updated_at       INTEGER NOT NULL,
             PRIMARY KEY (target_username, voter_github_id)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_profile_reactions_target_reaction
             ON profile_reactions(target_username, reaction)`,
          // Discovery facets — the queryable classification layer for the
          // /developers directory. Derived from profile_snapshots (the data moat)
          // by lib/facets.ts: one row per (developer, facet). facet_type is
          // 'language' | 'org'; facet_value is the bucket ("Rust", "huggingface").
          // weight lets us pick a dev's primary language later. Rewritten wholesale
          // per developer on each new scan, so it self-heals as scores refresh.
          `CREATE TABLE IF NOT EXISTS developer_facets (
             username    TEXT NOT NULL,
             facet_type  TEXT NOT NULL,
             facet_value TEXT NOT NULL,
             weight      REAL NOT NULL DEFAULT 0,
             PRIMARY KEY (username, facet_type, facet_value)
           )`,
          // Serves the two directory reads index-first: the per-bucket developer
          // list (WHERE facet_type = ? AND facet_value = ?) seeks straight to a
          // bucket, and the category counts (GROUP BY facet_value) scan one
          // contiguous range per type.
          `CREATE INDEX IF NOT EXISTS idx_developer_facets_lookup
             ON developer_facets(facet_type, facet_value, username)`,
          // PK (versus) matchups — one row per canonical (lowercased, sorted)
          // pair. Holds the deterministic result plus the cached bilingual LLM
          // verdict + self-improvement advice (JSON {zh,en}); feeds the /vs page,
          // the profile "battles" section, the trending board, and the sitemap.
          `CREATE TABLE IF NOT EXISTS vs_matchups (
             handle_a       TEXT NOT NULL,
             handle_b       TEXT NOT NULL,
             winner         TEXT,
             bucket         TEXT NOT NULL,
             gap            REAL NOT NULL,
             score_a        REAL NOT NULL,
             score_b        REAL NOT NULL,
             verdict        TEXT,
             advice         TEXT,
             verdict_source TEXT,
             view_count     INTEGER NOT NULL DEFAULT 0,
             created_at     INTEGER NOT NULL,
             updated_at     INTEGER NOT NULL,
             PRIMARY KEY (handle_a, handle_b)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_vs_matchups_a ON vs_matchups(handle_a, updated_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_vs_matchups_b ON vs_matchups(handle_b, updated_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_vs_matchups_hot ON vs_matchups(view_count DESC)`,
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
  const normalizedUsername = username.toLowerCase();
  const ipHash = heatIpHash(ip);
  // Redis shield in front of the Turso write transaction: repeats of the same
  // (username, ip) inside the window are answered by one Redis call instead of
  // holding a Turso connection. Turso's own gate below stays the source of
  // truth (covers Redis-unconfigured/flushed cases); the Redis key is kept even
  // when Turso declines, which can delay a re-count by up to one extra window
  // after a Redis flush — fine for a best-effort heat counter.
  const gateKey = `heat:gate:${normalizedUsername}:${ipHash}`;
  if (!(await tryAcquireLookupGate(gateKey, HEAT_LOOKUP_WINDOW_MS / 1000))) {
    return false;
  }
  try {
    await ensureSchema(db);
    const now = Date.now();
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
          ipHash,
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
    // Give the count back: a failed Turso write must not suppress this pair's
    // heat for a whole window.
    await releaseLookupGate(gateKey);
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
 * Persist a raw developer-profile snapshot — the data moat. Stores the full scan
 * (repos with topics + language breakdown, contributed repos, verified-impact PRs
 * with file paths, the complete metrics blob, pinned repos, orgs) that otherwise
 * lives only in the 24h Redis cache. Append-only: one row per scan, so the
 * profile history is preserved for later domain classification / analysis.
 *
 * Fire-and-forget: any failure is logged and swallowed so it never blocks the
 * scoring/roast flow (mirrors {@link recordScore} / {@link updateRoast}).
 */
export async function recordProfileSnapshot(scan: ScanResult): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    const username = scan.metrics.username.toLowerCase();
    await db.execute({
      sql: `INSERT INTO profile_snapshots
              (id, username, scanned_at, top_repos, impact_repos, verified_prs,
               metrics, pinned_repos, organizations, scan_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        randomUUID(),
        username,
        Date.now(),
        JSON.stringify(scan.top_repos ?? []),
        JSON.stringify(scan.impact_repos ?? []),
        JSON.stringify(scan.verified_impact_prs ?? []),
        JSON.stringify(scan.metrics),
        JSON.stringify(scan.pinned_repos ?? []),
        JSON.stringify(scan.organizations ?? []),
        SCORE_CACHE_VERSION,
      ],
    });
    // Derive + persist the discovery facets from the same scan, so every path
    // that sediments a snapshot also refreshes the /developers directory. Kept
    // inside the same best-effort try (independent statement — a facet failure is
    // logged and swallowed just like the snapshot write).
    await recordDeveloperFacets(
      username,
      extractFacets({
        top_repos: scan.top_repos,
        organizations: scan.organizations,
        impact_repos: scan.impact_repos,
      }),
    );
  } catch (e) {
    console.error("recordProfileSnapshot failed:", e);
  }
}

/** Hard cap on how many developers any one directory bucket returns. The reader
 *  only ever wants the head of a language/org, and a bounded LIMIT keeps the
 *  query (and its cached payload) cheap no matter how large a bucket grows. */
export const DEVELOPERS_PER_FACET_LIMIT = 250;
/** Public floor for the directory — mirrors the leaderboard/sitemap index floor
 *  so "top Rust developers" means the same calibre as the main boards. */
const FACET_MIN_SCORE = 60;

/**
 * Replace a developer's facet rows wholesale (delete-then-insert in one
 * transaction) so a re-scan can't leave stale buckets behind — e.g. a dev who
 * dropped a language keeps no phantom row. No-op without Turso; best-effort like
 * the rest of this module. Called from {@link recordProfileSnapshot} and the
 * facet backfill.
 */
export async function recordDeveloperFacets(
  username: string,
  facets: { type: FacetType; value: string; weight: number }[],
): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    const normalized = username.toLowerCase();
    // One atomic round trip: batch() runs the delete + all inserts in a single
    // implicit transaction. This replaces a multi-statement transaction() whose
    // per-statement round trips made bulk backfill (and every scan's facet write)
    // needlessly slow against a high-latency remote DB.
    await db.batch(
      [
        {
          sql: `DELETE FROM developer_facets WHERE username = ?`,
          args: [normalized],
        },
        ...facets.map((f) => ({
          sql: `INSERT OR REPLACE INTO developer_facets
                  (username, facet_type, facet_value, weight)
                VALUES (?, ?, ?, ?)`,
          args: [normalized, f.type, f.value, f.weight] as (string | number)[],
        })),
      ],
      "write",
    );
  } catch (e) {
    console.error("recordDeveloperFacets failed:", e);
  }
}

/** True if any profile snapshot already exists for this account — lets the
 * head-user backfill skip accounts it has already sedimented (resumable). */
export async function hasProfileSnapshot(username: string): Promise<boolean> {
  const db = getClient();
  if (!db) return false;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT 1 FROM profile_snapshots WHERE username = ? LIMIT 1`,
      args: [username.toLowerCase()],
    });
    return res.rows.length > 0;
  } catch (e) {
    console.error("hasProfileSnapshot failed:", e);
    return false;
  }
}

/** Numeric metrics pulled out of the stored `metrics` blob for the specialty
 * "brag cards" (contributor / PR / trajectory / signature-work). All coerced to
 * safe numbers so a card never renders `NaN` for a scan cached before a field
 * existed. */
export interface ProfileCardMetrics {
  account_age_years: number;
  created_at: string | null;
  followers: number;
  public_repos: number;
  total_stars: number;
  max_stars: number;
  original_repo_count: number;
  merged_pr_count: number;
  impact_pr_count: number;
  verified_impact_pr_count: number;
  core_impact_pr_count: number;
  impact_repo_count: number;
  max_impact_repo_stars: number;
  last_year_contributions: number;
  contribution_years_active: number;
}

/** Parsed view of the latest profile snapshot, for the detail page's evidence
 * blocks (contributions, featured work, stack, orgs). Read-only/slow path —
 * decoupled from the lean `getAccountDetail` hot read. */
export interface ProfileSnapshotView {
  top_repos: TopRepo[];
  impact_repos: ImpactRepo[];
  pinned_repos: string[];
  organizations: string[];
  bio: string | null;
  company: string | null;
  metrics: ProfileCardMetrics;
  scanned_at: number;
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Latest sedimented profile snapshot for an account, or null if none exists
 * (low-score/old accounts never backfilled). Fire-and-forget tolerant. */
export async function getProfileSnapshot(
  username: string,
  opts: { includeStale?: boolean } = {},
): Promise<ProfileSnapshotView | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT top_repos, impact_repos, pinned_repos, organizations, metrics, scanned_at
            FROM profile_snapshots
            WHERE username = ?
              ${opts.includeStale ? "" : "AND scan_version = ?"}
            ORDER BY scanned_at DESC
            LIMIT 1`,
      args: opts.includeStale
        ? [username.toLowerCase()]
        : [username.toLowerCase(), SCORE_CACHE_VERSION],
    });
    const r = res.rows[0];
    if (!r) return null;
    let bio: string | null = null;
    let company: string | null = null;
    let m: Record<string, unknown> = {};
    try {
      m = JSON.parse((r.metrics as string) || "{}") as Record<string, unknown>;
      bio = typeof m.bio === "string" && m.bio ? m.bio : null;
      company = typeof m.company === "string" && m.company ? m.company : null;
    } catch {
      // leave bio/company null, metrics blank
    }
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const metrics: ProfileCardMetrics = {
      account_age_years: num(m.account_age_years),
      created_at: typeof m.created_at === "string" ? m.created_at : null,
      followers: num(m.followers),
      public_repos: num(m.public_repos),
      total_stars: num(m.total_stars),
      max_stars: num(m.max_stars),
      original_repo_count: num(m.original_repo_count),
      merged_pr_count: num(m.merged_pr_count),
      impact_pr_count: num(m.impact_pr_count),
      verified_impact_pr_count: num(m.verified_impact_pr_count),
      core_impact_pr_count: num(m.core_impact_pr_count),
      impact_repo_count: num(m.impact_repo_count),
      max_impact_repo_stars: num(m.max_impact_repo_stars),
      last_year_contributions: num(m.last_year_contributions),
      contribution_years_active: num(m.contribution_years_active),
    };
    return {
      top_repos: parseJsonArray<TopRepo>(r.top_repos),
      impact_repos: parseJsonArray<ImpactRepo>(r.impact_repos),
      pinned_repos: parseJsonArray<string>(r.pinned_repos),
      organizations: parseJsonArray<string>(r.organizations),
      bio,
      company,
      metrics,
      scanned_at: Number(r.scanned_at),
    };
  } catch (e) {
    console.error("getProfileSnapshot failed:", e);
    return null;
  }
}

/**
 * Distinct usernames that have at least one profile snapshot, paginated for the
 * facet backfill. `profile_snapshots` is append-only (many rows per user), so
 * DISTINCT collapses to one per account; ordering by username keeps offset-based
 * batches stable across calls. Returns [] without Turso.
 */
export async function listSnapshotUsernames(
  limit = 500,
  offset = 0,
): Promise<string[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT DISTINCT username FROM profile_snapshots
            ORDER BY username
            LIMIT ? OFFSET ?`,
      args: [Math.max(1, Math.min(2000, limit)), Math.max(0, offset)],
    });
    return res.rows.map((r) => String(r.username));
  } catch (e) {
    console.error("listSnapshotUsernames failed:", e);
    return [];
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
    const normalizedUsername = username.toLowerCase();
    const generatedAt = Date.now();
    await db.execute({
      sql: `UPDATE scores SET ${col} = ?, ${versionCol} = ? WHERE username = ?`,
      args: [roast, ROAST_CACHE_VERSION, normalizedUsername],
    });
    await db.execute({
      sql: `INSERT INTO score_snapshots
              (id, username, display_name, avatar_url, profile_url, final_score, tier,
               tags, roast_line, score_version, roast_version, roast_lang, bot_score,
               sub_scores, generated_at)
            SELECT ?, username, display_name, avatar_url, profile_url, final_score, tier,
                   tags, roast_line, COALESCE(score_version, ?), ?, ?, bot_score,
                   sub_scores, ?
            FROM scores
            WHERE username = ?`,
      args: [
        randomUUID(),
        SCORE_CACHE_VERSION,
        ROAST_CACHE_VERSION,
        lang,
        generatedAt,
        normalizedUsername,
      ],
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
              (SELECT COUNT(*) FROM scores WHERE hidden = 0 AND score_version = ? AND final_score < ?) AS below,
              (SELECT COUNT(*) FROM scores WHERE hidden = 0 AND score_version = ?) AS total`,
      args: [SCORE_CACHE_VERSION, score, SCORE_CACHE_VERSION],
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

/**
 * Global score ranking for `score`: `rank` (1-based, by `final_score` desc),
 * `total` ranked accounts, and `below` (accounts scoring strictly lower).
 *
 * Excludes hidden accounts so the rank lines up with what the score leaderboard
 * shows. `rank` = (accounts scoring strictly higher) + 1. Returns null when there
 * is no one to compare against (≤1 ranked account), matching `beatPercent`.
 */
export async function getRank(
  score: number,
): Promise<{ rank: number; total: number; below: number } | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT
              SUM(CASE WHEN final_score > ? THEN 1 ELSE 0 END) AS above,
              SUM(CASE WHEN final_score < ? THEN 1 ELSE 0 END) AS below,
              COUNT(*) AS total
            FROM scores WHERE hidden = 0 AND score_version = ?`,
      args: [score, score, SCORE_CACHE_VERSION],
    });
    const row = res.rows[0];
    if (!row) return null;
    const total = Number(row.total);
    if (total <= 1) return null;
    return { rank: Number(row.above) + 1, total, below: Number(row.below) };
  } catch (e) {
    console.error("getRank failed:", e);
    return null;
  }
}

export interface FacetRank {
  facetType: FacetType;
  /** The bucket value, e.g. "Rust" — also the display string and URL segment. */
  facetValue: string;
  /** 1-based position within the bucket (ties share, mirroring {@link getRank}). */
  rank: number;
  total: number;
  /** The developer immediately above — powers the "上一位 @x →" hook. */
  ahead: { username: string; final_score: number } | null;
}

/**
 * Where `username` ranks inside their strongest language bucket on the
 * /developers directory — the "you're #12 on the Rust board, one spot behind
 * @yyy" hook that turns a profile into a transit station.
 *
 * Uses the dev's highest-weight `language` facet and the exact same filters as
 * {@link getDevelopersByFacet} (hidden = 0, final_score ≥ FACET_MIN_SCORE) so the
 * rank matches the board the link lands on. Returns null when the dev has no
 * language facet, is below the directory floor, or the bucket has ≤1 ranked dev.
 * Every join is an index seek via idx_developer_facets_lookup. Best-effort like
 * the rest of this module.
 */
export async function getFacetRank(
  username: string,
  score: number,
): Promise<FacetRank | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const uname = username.toLowerCase();
    // The dev's primary language (the directory only ranks devs above the floor,
    // so a below-floor dev has no meaningful position to show).
    if (score < FACET_MIN_SCORE) return null;
    const topRes = await db.execute({
      sql: `SELECT facet_value FROM developer_facets
            WHERE username = ? AND facet_type = 'language'
            ORDER BY weight DESC LIMIT 1`,
      args: [uname],
    });
    const facetValue = topRes.rows[0]?.facet_value;
    if (typeof facetValue !== "string" || !facetValue) return null;
    // rank + total, and the nearest dev above, in one round trip.
    const [rankRes, aheadRes] = await db.batch(
      [
        {
          sql: `SELECT
                  SUM(CASE WHEN s.final_score > ? THEN 1 ELSE 0 END) AS above,
                  COUNT(*) AS total
                FROM developer_facets AS f
                JOIN scores AS s ON s.username = f.username
                WHERE f.facet_type = 'language'
                  AND f.facet_value = ?
                  AND s.hidden = 0
                  AND s.final_score >= ?`,
          args: [score, facetValue, FACET_MIN_SCORE],
        },
        {
          sql: `SELECT s.username, s.final_score
                FROM developer_facets AS f
                JOIN scores AS s ON s.username = f.username
                WHERE f.facet_type = 'language'
                  AND f.facet_value = ?
                  AND s.hidden = 0
                  AND s.final_score > ?
                ORDER BY s.final_score ASC
                LIMIT 1`,
          args: [facetValue, score],
        },
      ],
      "read",
    );
    const row = rankRes.rows[0];
    if (!row) return null;
    const total = Number(row.total);
    if (total <= 1) return null;
    const aheadRow = aheadRes.rows[0];
    return {
      facetType: "language",
      facetValue,
      rank: Number(row.above) + 1,
      total,
      ahead: aheadRow
        ? {
            username: String(aheadRow.username),
            final_score: Number(aheadRow.final_score),
          }
        : null,
    };
  } catch (e) {
    console.error("getFacetRank failed:", e);
    return null;
  }
}

/** Total number of accounts ever evaluated (for the "N developers" counter). */
export async function getScoreCount(): Promise<number | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM scores WHERE score_version = ?",
      args: [SCORE_CACHE_VERSION],
    });
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
  window: LeaderboardWindow = "all",
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const now = Date.now();
    const { recentCutoff, activeOnly } = resolveLeaderboardWindow(window, now);
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
            WHERE s.hidden = 0 AND s.score_version = ? AND s.final_score >= ?
            ${activeOnly ? "AND recent.recent_lookup_count > 0" : ""}`,
      args: [recentCutoff, SCORE_CACHE_VERSION, minScore],
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
            WHERE hidden = 0 AND score_version = ? AND final_score >= ?
            ORDER BY final_score DESC`,
      args: [SCORE_CACHE_VERSION, minScore],
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
  window: LeaderboardWindow = "all",
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const { recentCutoff, activeOnly } = resolveLeaderboardWindow(window, Date.now());
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
            WHERE s.hidden = 0 AND s.score_version = ? AND s.final_score >= ?
            ${activeOnly ? "AND recent.recent_lookup_count > 0" : ""}
            ORDER BY s.final_score DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [recentCutoff, SCORE_CACHE_VERSION, minScore, limit],
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
  window: LeaderboardWindow = "all",
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const { recentCutoff, activeOnly } = resolveLeaderboardWindow(window, Date.now());
    // "all" ranks by cumulative lookups; a window ranks by the unique-visitor
    // count within that window so the order matches the heat figure shown.
    const heatOrder = activeOnly ? "recent_lookup_count DESC" : "lookup_count DESC";
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
            WHERE s.hidden = 0 AND s.score_version = ? AND s.final_score >= ?
            ${activeOnly ? "AND recent.recent_lookup_count > 0" : ""}
            ORDER BY ${heatOrder}, s.final_score DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [recentCutoff, SCORE_CACHE_VERSION, minScore, limit],
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
export async function getProgressLeaderboard(
  limit = 100,
  window: LeaderboardWindow = "all",
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const { recentCutoff, activeOnly } = resolveLeaderboardWindow(window, Date.now());
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
              AND s.score_version = ?
              AND s.prev_score IS NOT NULL
              AND s.final_score > s.prev_score
              ${activeOnly ? "AND recent.recent_lookup_count > 0" : ""}
            ORDER BY (s.final_score - s.prev_score) DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [recentCutoff, SCORE_CACHE_VERSION, limit],
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

/** One bucket in the /developers directory: a language/org and how many
 *  qualifying (public, at/above the floor) developers it holds. */
export interface FacetCategory {
  value: string;
  count: number;
}

/**
 * Directory categories for a facet type ("language" | "org"), each with its
 * qualifying-developer count, busiest bucket first. Powers the /developers
 * landing grid. Counts join to `scores` so hidden/low-score accounts don't
 * inflate a bucket. Read behind a long-TTL cache (the GROUP BY is the expensive
 * part) — see lib/developers.ts.
 */
export async function getFacetCategories(
  facetType: FacetType,
  limit = 100,
): Promise<FacetCategory[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT f.facet_value AS value, COUNT(*) AS count
            FROM developer_facets AS f
            JOIN scores AS s ON s.username = f.username
            WHERE f.facet_type = ?
              AND s.hidden = 0
              AND s.score_version = ?
              AND s.final_score >= ?
            GROUP BY f.facet_value
            ORDER BY count DESC, f.facet_value ASC
            LIMIT ?`,
      args: [facetType, SCORE_CACHE_VERSION, FACET_MIN_SCORE, Math.max(1, Math.min(500, limit))],
    });
    return res.rows.map((r) => ({ value: String(r.value), count: Number(r.count) }));
  } catch (e) {
    console.error("getFacetCategories failed:", e);
    return [];
  }
}

/**
 * The head of one directory bucket: public developers tagged with
 * (facetType, facetValue), ranked by final_score. Returns the same
 * {@link LeaderboardEntry} shape the boards use, so the directory reuses the
 * leaderboard card renderer unchanged. All-time and score-sorted (no time
 * window), and hard-capped at {@link DEVELOPERS_PER_FACET_LIMIT}. Every join is
 * an index seek (facet index → scores PK → account_stats PK), so the query stays
 * cheap regardless of bucket size; reads go through a cache (lib/developers.ts).
 */
export async function getDevelopersByFacet(
  facetType: FacetType,
  facetValue: string,
  limit = DEVELOPERS_PER_FACET_LIMIT,
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db || !facetValue) return [];
  try {
    await ensureSchema(db);
    const capped = Math.max(1, Math.min(DEVELOPERS_PER_FACET_LIMIT, limit));
    const res = await db.execute({
      sql: `SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
                   s.final_score, s.tier, s.tags,
                   MAX(COALESCE(stats.lookup_count, 0), ${MIN_RECORDED_LOOKUP_COUNT}) AS lookup_count,
                   stats.last_lookup_at AS last_lookup_at
            FROM developer_facets AS f
            JOIN scores AS s ON s.username = f.username
            LEFT JOIN account_stats AS stats ON stats.username = s.username
            WHERE f.facet_type = ?
              AND f.facet_value = ?
              AND s.hidden = 0
              AND s.score_version = ?
              AND s.final_score >= ?
            ORDER BY s.final_score DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [facetType, facetValue, SCORE_CACHE_VERSION, FACET_MIN_SCORE, capped],
    });
    const now = Date.now();
    return res.rows.map((r) => toLeaderboardEntry(r as unknown as LeaderboardRow, now));
  } catch (e) {
    console.error("getDevelopersByFacet failed:", e);
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
            WHERE username = ? AND hidden = 0 AND score_version = ?
            LIMIT 1`,
      args: [username.toLowerCase(), SCORE_CACHE_VERSION],
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

/** A scored account surfaced by the Omnibox autocomplete (already in the DB). */
export interface UserSuggestion {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  final_score: number;
  tier: Tier;
}

/**
 * Prefix-search already-scored, non-hidden accounts for the Omnibox typeahead —
 * so a handle we've already judged is offered directly (with its score) for both
 * roast and PK. Prefix match on the lowercased `username` PK is index-friendly;
 * ties break by score so the strongest match leads.
 */
export async function searchScoredUsers(
  query: string,
  limit = 6,
): Promise<UserSuggestion[]> {
  const db = getClient();
  if (!db) return [];
  const q = query.trim().replace(/^@/, "").toLowerCase();
  if (!q) return [];
  try {
    await ensureSchema(db);
    // Escape LIKE wildcards in user input so `_`/`%` are matched literally.
    const like = `${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const res = await db.execute({
      sql: `SELECT username, display_name, avatar_url, final_score, tier
            FROM scores
            WHERE hidden = 0 AND score_version = ? AND username LIKE ? ESCAPE '\\'
            ORDER BY final_score DESC
            LIMIT ?`,
      args: [SCORE_CACHE_VERSION, like, limit],
    });
    return res.rows.map((r) => ({
      username: String(r.username),
      display_name: (r.display_name as string | null) ?? null,
      avatar_url: (r.avatar_url as string | null) ?? null,
      final_score: Number(r.final_score),
      tier: String(r.tier) as Tier,
    }));
  } catch (e) {
    console.error("searchScoredUsers failed:", e);
    return [];
  }
}

/** Parse a JSON `{zh,en}` column, returning null when the column is empty/null
 *  (so callers can tell "no LLM verdict yet" from an empty one). */
function parseNullableRoastLine(raw: unknown): RoastLine | null {
  if (typeof raw !== "string" || !raw) return null;
  return parseRoastLine(raw);
}

/** A stored PK matchup (canonical lowercased+sorted pair). */
export interface VsMatchup {
  handleA: string;
  handleB: string;
  winner: string | null;
  bucket: string;
  gap: number;
  scoreA: number;
  scoreB: number;
  /** Bilingual LLM savage verdict; null until generated. */
  verdict: RoastLine | null;
  /** Bilingual self-improvement advice; null until generated. */
  advice: RoastLine | null;
  verdictSource: string | null;
  viewCount: number;
  createdAt: number;
  updatedAt: number;
}

function mapMatchupRow(r: Record<string, unknown>): VsMatchup {
  return {
    handleA: String(r.handle_a),
    handleB: String(r.handle_b),
    winner: (r.winner as string | null) ?? null,
    bucket: String(r.bucket),
    gap: Number(r.gap),
    scoreA: Number(r.score_a),
    scoreB: Number(r.score_b),
    verdict: parseNullableRoastLine(r.verdict),
    advice: parseNullableRoastLine(r.advice),
    verdictSource: (r.verdict_source as string | null) ?? null,
    viewCount: Number(r.view_count ?? 0),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export interface MatchupInput {
  /** Canonical (lowercased, dictionary-sorted) handles. */
  a: string;
  b: string;
  winner: string | null;
  bucket: string;
  gap: number;
  scoreA: number;
  scoreB: number;
  verdict?: RoastLine | null;
  advice?: RoastLine | null;
  source?: "template" | "llm" | null;
}

/**
 * Upsert a matchup. A null verdict/advice never overwrites an existing one
 * (COALESCE), so re-recording the base result on later views can't wipe a
 * generated LLM verdict; `verdict_source` only advances when a verdict is set.
 * `created_at` and `view_count` are preserved on conflict. Best-effort.
 */
export async function recordMatchup(m: MatchupInput): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    const now = Date.now();
    await db.execute({
      sql: `INSERT INTO vs_matchups
              (handle_a, handle_b, winner, bucket, gap, score_a, score_b, verdict, advice, verdict_source, view_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(handle_a, handle_b) DO UPDATE SET
              winner         = excluded.winner,
              bucket         = excluded.bucket,
              gap            = excluded.gap,
              score_a        = excluded.score_a,
              score_b        = excluded.score_b,
              verdict        = COALESCE(excluded.verdict, vs_matchups.verdict),
              advice         = COALESCE(excluded.advice, vs_matchups.advice),
              verdict_source = CASE WHEN excluded.verdict IS NOT NULL
                                    THEN excluded.verdict_source ELSE vs_matchups.verdict_source END,
              updated_at     = excluded.updated_at`,
      args: [
        m.a.toLowerCase(),
        m.b.toLowerCase(),
        m.winner,
        m.bucket,
        m.gap,
        m.scoreA,
        m.scoreB,
        m.verdict ? JSON.stringify(m.verdict) : null,
        m.advice ? JSON.stringify(m.advice) : null,
        m.source ?? null,
        now,
        now,
      ],
    });
  } catch (e) {
    console.error("recordMatchup failed:", e);
  }
}

/** Increment a matchup's human view count (fed by the client verdict ping). */
export async function bumpMatchupView(a: string, b: string): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    await db.execute({
      sql: `UPDATE vs_matchups SET view_count = view_count + 1
            WHERE handle_a = ? AND handle_b = ?`,
      args: [a.toLowerCase(), b.toLowerCase()],
    });
  } catch (e) {
    console.error("bumpMatchupView failed:", e);
  }
}

/** One matchup by canonical pair (null if never recorded). */
export async function getMatchup(a: string, b: string): Promise<VsMatchup | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT * FROM vs_matchups WHERE handle_a = ? AND handle_b = ? LIMIT 1`,
      args: [a.toLowerCase(), b.toLowerCase()],
    });
    const r = res.rows[0];
    return r ? mapMatchupRow(r as Record<string, unknown>) : null;
  } catch (e) {
    console.error("getMatchup failed:", e);
    return null;
  }
}

/** A user's recent battles (either side), newest first. */
export async function getUserMatchups(username: string, limit = 8): Promise<VsMatchup[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const u = username.toLowerCase();
    const n = Math.max(1, Math.min(50, limit));
    const res = await db.execute({
      sql: `SELECT * FROM vs_matchups
            WHERE handle_a = ? OR handle_b = ?
            ORDER BY updated_at DESC LIMIT ?`,
      args: [u, u, n],
    });
    return res.rows.map((r) => mapMatchupRow(r as Record<string, unknown>));
  } catch (e) {
    console.error("getUserMatchups failed:", e);
    return [];
  }
}

/** Trending battles for the /vs board — LLM-judged, both sides above the floor,
 *  hottest first. */
export async function getTrendingMatchups(limit = 40): Promise<VsMatchup[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const n = Math.max(1, Math.min(100, limit));
    const res = await db.execute({
      sql: `SELECT * FROM vs_matchups
            WHERE verdict_source = 'llm' AND score_a >= ? AND score_b >= ?
            ORDER BY view_count DESC, updated_at DESC LIMIT ?`,
      args: [VS_MIN_SCORE, VS_MIN_SCORE, n],
    });
    return res.rows.map((r) => mapMatchupRow(r as Record<string, unknown>));
  } catch (e) {
    console.error("getTrendingMatchups failed:", e);
    return [];
  }
}

/** Indexable matchups for the sitemap: has an LLM verdict and both sides clear
 *  the floor. */
export async function getIndexableMatchups(): Promise<
  { a: string; b: string; updatedAt: number }[]
> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT handle_a, handle_b, updated_at FROM vs_matchups
            WHERE verdict IS NOT NULL AND score_a >= ? AND score_b >= ?`,
      args: [VS_MIN_SCORE, VS_MIN_SCORE],
    });
    return res.rows.map((r) => ({
      a: String(r.handle_a),
      b: String(r.handle_b),
      updatedAt: Number(r.updated_at),
    }));
  } catch (e) {
    console.error("getIndexableMatchups failed:", e);
    return [];
  }
}

/** Full persisted record for one account's detail page (null if absent/hidden/stale). */
export async function getAccountDetail(
  username: string,
  opts: { includeStale?: boolean } = {},
): Promise<AccountDetail | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT username, display_name, avatar_url, profile_url, final_score, tier,
                   tags, roast_line, sub_scores, roast, roast_en, scanned_at
            FROM scores
            WHERE username = ? AND hidden = 0
              ${opts.includeStale ? "" : "AND score_version = ?"}
            LIMIT 1`,
      args: opts.includeStale
        ? [username.toLowerCase()]
        : [username.toLowerCase(), SCORE_CACHE_VERSION],
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
              AND s.score_version = ?
              AND s.username != ?
              AND s.final_score BETWEEN ? AND ?
            ORDER BY s.final_score DESC
            LIMIT ?`,
      args: [
        SCORE_CACHE_VERSION,
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

interface CreateProfileCommentInput {
  targetUsername: string;
  text: string;
  author: ProfileCommentAuthor;
  authorGithubId?: number;
}

function toProfileComment(row: Record<string, unknown>): ProfileComment {
  const authorLogin =
    typeof row.author_login === "string" && row.author_login
      ? row.author_login
      : null;
  const authorAvatarUrl =
    typeof row.author_avatar_url === "string" && row.author_avatar_url
      ? row.author_avatar_url
      : null;
  const author: ProfileCommentAuthor =
    row.author_kind === "github" && authorLogin
      ? { type: "github", username: authorLogin, avatarUrl: authorAvatarUrl }
      : { type: "anonymous" };

  return {
    id: String(row.id),
    targetUsername: String(row.target_username),
    author,
    text: String(row.body),
    createdAt: Number(row.created_at),
  };
}

export async function getProfileComments(
  targetUsername: string,
  limit = 24,
): Promise<ProfileComment[]> {
  const db = getClient();
  if (!db) return [];
  const target = normalizeGitHubUsername(targetUsername);
  if (!target) return [];
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT id, target_username, body, author_kind, author_login,
                   author_avatar_url, created_at
            FROM (
              SELECT rowid AS sort_rowid, id, target_username, body, author_kind,
                     author_login, author_avatar_url, created_at
              FROM profile_comments
              WHERE target_username = ? AND hidden = 0
              ORDER BY created_at DESC, rowid DESC
              LIMIT ?
            )
            ORDER BY created_at ASC, sort_rowid ASC`,
      args: [target, Math.max(1, Math.min(100, limit))],
    });
    return res.rows.map((row) => toProfileComment(row as Record<string, unknown>));
  } catch (e) {
    console.error("getProfileComments failed:", e);
    return [];
  }
}

export async function createProfileComment(
  input: CreateProfileCommentInput,
): Promise<ProfileComment | null> {
  const db = getClient();
  if (!db) return null;
  const target = normalizeGitHubUsername(input.targetUsername);
  const text = normalizeCommentText(input.text);
  if (!target || !text) return null;

  const githubAuthor =
    input.author.type === "github"
      ? normalizeGitHubUsername(input.author.username)
      : null;
  const authorKind = githubAuthor ? "github" : "anonymous";
  const authorAvatarUrl =
    input.author.type === "github" ? input.author.avatarUrl ?? null : null;
  const now = Date.now();
  const id = randomUUID();

  try {
    await ensureSchema(db);
    await db.execute({
      sql: `INSERT INTO profile_comments
              (id, target_username, body, author_kind, author_github_id,
               author_login, author_avatar_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        target,
        text,
        authorKind,
        authorKind === "github" ? input.authorGithubId ?? null : null,
        githubAuthor,
        authorKind === "github" ? authorAvatarUrl : null,
        now,
      ],
    });
    return {
      id,
      targetUsername: target,
      author: githubAuthor
        ? { type: "github", username: githubAuthor, avatarUrl: authorAvatarUrl }
        : { type: "anonymous" },
      text,
      createdAt: now,
    };
  } catch (e) {
    console.error("createProfileComment failed:", e);
    return null;
  }
}

interface SetProfileReactionInput {
  targetUsername: string;
  voterGithubId: number;
  voterLogin: string;
  reaction: ProfileReaction;
}

interface RemoveProfileReactionInput {
  targetUsername: string;
  voterGithubId: number;
}

function validGithubId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Cache-aside read of a profile's global reaction tallies. A hit skips the
 *  GROUP BY entirely — the hot path for crawlers and logged-out visitors. */
async function readReactionCounts(
  db: Client,
  target: string,
): Promise<ProfileReactionCounts> {
  const cached = await getCachedReactionCounts(target);
  if (cached) return cached;
  const counts = emptyReactionCounts();
  const res = await db.execute({
    sql: `SELECT reaction, COUNT(*) AS count
          FROM profile_reactions
          WHERE target_username = ?
          GROUP BY reaction`,
    args: [target],
  });
  for (const row of res.rows) {
    if (isProfileReaction(row.reaction)) counts[row.reaction] = Number(row.count) || 0;
  }
  await setCachedReactionCounts(target, counts);
  return counts;
}

export async function getProfileReactionState(
  targetUsername: string,
  viewerGithubId?: number,
): Promise<ProfileReactionState> {
  const db = getClient();
  const target = normalizeGitHubUsername(targetUsername);
  if (!db || !target) return { counts: emptyReactionCounts(), viewerReaction: null };

  try {
    await ensureSchema(db);
    const [counts, viewerResult] = await Promise.all([
      readReactionCounts(db, target),
      validGithubId(viewerGithubId ?? 0)
        ? db.execute({
            sql: `SELECT reaction
                  FROM profile_reactions
                  WHERE target_username = ? AND voter_github_id = ?`,
            args: [target, viewerGithubId!],
          })
        : Promise.resolve(null),
    ]);

    const viewerValue = viewerResult?.rows[0]?.reaction;
    return {
      counts,
      viewerReaction: isProfileReaction(viewerValue) ? viewerValue : null,
    };
  } catch (e) {
    console.error("getProfileReactionState failed:", e);
    return { counts: emptyReactionCounts(), viewerReaction: null };
  }
}

export async function setProfileReaction(
  input: SetProfileReactionInput,
): Promise<ProfileReactionState | null> {
  const db = getClient();
  const target = normalizeGitHubUsername(input.targetUsername);
  const voterLogin = normalizeGitHubUsername(input.voterLogin);
  if (
    !db ||
    !target ||
    !voterLogin ||
    !validGithubId(input.voterGithubId) ||
    !isProfileReaction(input.reaction)
  ) {
    return null;
  }

  try {
    await ensureSchema(db);
    const now = Date.now();
    await db.execute({
      sql: `INSERT INTO profile_reactions
              (target_username, voter_github_id, voter_login, reaction, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(target_username, voter_github_id) DO UPDATE SET
              voter_login = excluded.voter_login,
              reaction = excluded.reaction,
              updated_at = excluded.updated_at`,
      args: [target, input.voterGithubId, voterLogin, input.reaction, now, now],
    });
    await clearCachedReactionCounts(target);
    return getProfileReactionState(target, input.voterGithubId);
  } catch (e) {
    console.error("setProfileReaction failed:", e);
    return null;
  }
}

export async function removeProfileReaction(
  input: RemoveProfileReactionInput,
): Promise<ProfileReactionState | null> {
  const db = getClient();
  const target = normalizeGitHubUsername(input.targetUsername);
  if (!db || !target || !validGithubId(input.voterGithubId)) return null;

  try {
    await ensureSchema(db);
    await db.execute({
      sql: `DELETE FROM profile_reactions
            WHERE target_username = ? AND voter_github_id = ?`,
      args: [target, input.voterGithubId],
    });
    await clearCachedReactionCounts(target);
    return getProfileReactionState(target, input.voterGithubId);
  } catch (e) {
    console.error("removeProfileReaction failed:", e);
    return null;
  }
}
