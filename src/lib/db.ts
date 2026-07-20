/**
 * Turso (libSQL) persistence for the leaderboard + percentile.
 *
 * Optional, like {@link ./redis}: most passive persistence functions no-op when
 * `TURSO_DATABASE_URL` is unset so the app can run without it. Durable public-scan
 * worker operations are the exception: they fail closed so Cron health cannot
 * report an unavailable queue as empty. Stores one latest row per scanned account
 * plus append-only score snapshots for long-term progress.
 * The score itself is still computed deterministically by `lib/score.ts`; this
 * layer only persists the result for cross-account ranking.
 */

import { Client, createClient, type Transaction } from "@libsql/client";
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
import { extractRepoGraph, type RepoGraph } from "./repo-graph";
import { projectQualityScore, type ProjectSort } from "./projects";
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
  bumpCampaignLeaderboardRevision,
  clearCachedReactionCounts,
  getCachedReactionCounts,
  releaseLookupGate,
  setCachedReactionCounts,
  tryAcquireLookupGate,
} from "./redis";
import type { Lang } from "./lang";
import { rankSimilar } from "./similarity";
import { LEGACY_READ_FALLBACK, RELEASE_VERSION_MANIFEST } from "./release-versions";
import {
  materializeCanonicalScore,
  type CanonicalScoreMaterialization,
} from "./score-materialization";
import type {
  ImpactRepo,
  RoastLine,
  ScanResult,
  SignatureWork,
  SubScores,
  Tags,
  Tier,
  TopRepo,
} from "./types";
import type { LeaderboardWindow } from "./leaderboardWindow";
import {
  PUBLIC_SCAN_COLLECTION_VERSION,
  PUBLIC_SCAN_REQUIRED_SOURCES,
  hasCompletePublicScanSources,
} from "./scan-run-types";
import type {
  PublicScanCoverage,
  PublicScanJob,
  PublicScanJobLease,
  PublicScanJobPhase,
  PublicScanCommitRepoFact,
  PublicScanCommitCandidate,
  PublicScanCommitVerificationWork,
  PublicScanOwnedRepoFact,
  PublicScanPrFact,
  PublicScanRun,
  PublicScanRunState,
  PublicScanSourceStatus,
  PublicScanStepOutcome,
} from "./scan-run-types";

const EMPTY_TAGS: Tags = { zh: [], en: [] };
const PUBLIC_PROFILE_SCORE_VERSIONS = RELEASE_VERSION_MANIFEST.compatibility
  .publicScoreReadOrder as [string, string];
const HEAT_LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRENDING_LOOKUP_WINDOW_MS = 7 * HEAT_LOOKUP_WINDOW_MS;
const MIN_RECORDED_LOOKUP_COUNT = 1;

function hasLegacyReadFallbackReport(row: Record<string, unknown>): boolean {
  return (
    row.score_version === LEGACY_READ_FALLBACK.score &&
    ((row.roast_version === LEGACY_READ_FALLBACK.roast &&
      typeof row.roast === "string" &&
      row.roast.length > 0) ||
      (row.roast_en_version === LEGACY_READ_FALLBACK.roast &&
        typeof row.roast_en === "string" &&
        row.roast_en.length > 0))
  );
}

/**
 * A stored v5/v5 score/report pair is safe to show as a stale profile even
 * when its old collector snapshot is no longer retained. This deliberately
 * proves only the persisted presentation artifact. Callers that need a full
 * ScanResult must use the stricter snapshot verifier below.
 */
function isLegacyReadFallbackProfile(row: Record<string, unknown>): boolean {
  return hasLegacyReadFallbackReport(row);
}

function parseVerifiedLegacyReadFallbackRun(
  run: PublicScanRun,
  username: string,
  finalScore: number,
): ScanResult | null {
  if (
    run.scoreVersion !== LEGACY_READ_FALLBACK.score ||
    run.collectionVersion !== LEGACY_READ_FALLBACK.collection ||
    !run.snapshot ||
    !run.snapshotHash ||
    !hasCompletePublicScanSources(run.sourceStatus) ||
    createHash("sha256").update(run.snapshot).digest("hex") !== run.snapshotHash
  ) {
    return null;
  }
  try {
    const snapshot = JSON.parse(run.snapshot) as Partial<ScanResult>;
    if (
      typeof snapshot.metrics?.username !== "string" ||
      snapshot.metrics.username.trim().toLowerCase() !== username ||
      typeof snapshot.scoring?.final_score !== "number" ||
      !Number.isFinite(snapshot.scoring.final_score) ||
      snapshot.scoring.final_score !== finalScore ||
      !Array.isArray(snapshot.top_repos) ||
      !Array.isArray(snapshot.recent_prs) ||
      !Array.isArray(snapshot.flood_pr_titles)
    ) {
      return null;
    }
    return snapshot as ScanResult;
  } catch {
    return null;
  }
}

/**
 * A full v5 scan payload may be served only when its score row and a complete
 * v3 factual snapshot agree on the same account/version contract. This is
 * read-only: it never upgrades, queues, re-scores, or invokes an LLM.
 */
async function getVerifiedLegacyReadFallbackScan(
  db: Client,
  row: Record<string, unknown>,
): Promise<ScanResult | null> {
  if (!hasLegacyReadFallbackReport(row)) return null;
  const username = typeof row.username === "string" ? row.username.trim().toLowerCase() : "";
  const finalScore = Number(row.final_score);
  if (!username || !Number.isFinite(finalScore)) return null;
  try {
    const result = await db.execute({
      sql: `SELECT * FROM public_scan_runs
            WHERE username = ?
              AND score_version = ?
              AND collection_version = ?
              AND state = 'complete_public'
              AND coverage = 'complete_public'
              AND snapshot IS NOT NULL
              AND snapshot_hash IS NOT NULL
              AND completed_at IS NOT NULL
            ORDER BY completed_at DESC, id DESC
            LIMIT 8`,
      args: [
        username,
        LEGACY_READ_FALLBACK.score,
        LEGACY_READ_FALLBACK.collection,
      ],
    });
    for (const run of result.rows) {
      const scan = parseVerifiedLegacyReadFallbackRun(
        mapPublicScanRun(run as Record<string, unknown>),
        username,
        finalScore,
      );
      if (scan) return scan;
    }
    return null;
  } catch {
    return null;
  }
}

function logPublicScanDbFailure(operation: string, error: unknown): void {
  console.error(
    "public_scan.db_failure",
    JSON.stringify({
      operation,
      errorType: error instanceof Error ? error.constructor.name : "Unknown",
    }),
  );
}

function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column name|column .* already exists/i.test(message);
}

async function addColumnIfMissing(
  db: Client,
  table: string,
  definition: string,
): Promise<void> {
  try {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (error) {
    if (!isDuplicateColumnError(error)) throw error;
  }
}

export class PublicScanStorageError extends Error {
  constructor(readonly operation: string) {
    super("public scan storage unavailable");
    this.name = "PublicScanStorageError";
  }
}

function throwPublicScanStorageFailure(operation: string, error: unknown): never {
  if (error instanceof PublicScanStorageError) throw error;
  logPublicScanDbFailure(operation, error);
  throw new PublicScanStorageError(operation);
}

function requirePublicScanDb(operation: string): Client {
  const db = getClient();
  if (!db) throwPublicScanStorageFailure(operation, new Error("DatabaseUnavailable"));
  return db;
}

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
             score_write_token TEXT,
             score_source_collection_version TEXT,
             score_source_snapshot_hash TEXT,
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
             signature_work TEXT,
             scan_version  TEXT
           )`,
          `CREATE INDEX IF NOT EXISTS idx_profile_snapshots_username_scanned
             ON profile_snapshots(username, scanned_at DESC)`,
          // Durable public-history scans. Redis remains the fast cache, but it
          // cannot be the source of truth for a job that may outlive a Vercel
          // invocation or resume from a later Cron run. These rows carry the
          // resumable cursor, source coverage, and final immutable snapshot in
          // Turso instead.
          `CREATE TABLE IF NOT EXISTS public_scan_runs (
             id                 TEXT PRIMARY KEY,
             username           TEXT NOT NULL,
             score_version      TEXT NOT NULL,
             collection_version TEXT NOT NULL,
             state              TEXT NOT NULL CHECK(state IN ('queued', 'running', 'complete_public', 'partial_public', 'failed')),
             coverage           TEXT NOT NULL CHECK(coverage IN ('partial_public', 'complete_public')),
             source_status      TEXT NOT NULL DEFAULT '{}',
             quick_scan         TEXT,
             snapshot           TEXT,
             snapshot_hash      TEXT,
             started_at         INTEGER NOT NULL,
             completed_at       INTEGER,
             updated_at         INTEGER NOT NULL,
             last_error         TEXT
           )`,
          `CREATE INDEX IF NOT EXISTS idx_public_scan_runs_user_version
             ON public_scan_runs(username, score_version, collection_version, updated_at DESC)`,
          // Fact collection evolves independently from the deterministic score.
          // Keep the score-version index for audit, but reads/admission use the
          // collection-only index so a formula release does not retrigger a
          // historical GitHub crawl for every prolific account.
          `CREATE INDEX IF NOT EXISTS idx_public_scan_runs_user_collection
             ON public_scan_runs(username, collection_version, updated_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_public_scan_runs_user_collection_started
             ON public_scan_runs(username, collection_version, started_at DESC, id DESC)`,
          // Stale-read fallback selects the last valid completed snapshot for
          // one exact collection contract. Keep that read bounded even when an
          // account has accumulated several historical runs.
          `CREATE INDEX IF NOT EXISTS idx_public_scan_runs_user_collection_completed
             ON public_scan_runs(username, collection_version, completed_at DESC, id DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_public_scan_runs_state
             ON public_scan_runs(state, updated_at)`,
          `CREATE TABLE IF NOT EXISTS public_scan_jobs (
             id                 TEXT PRIMARY KEY,
             run_id             TEXT NOT NULL,
             username           TEXT NOT NULL,
             score_version      TEXT NOT NULL,
             collection_version TEXT NOT NULL,
             state              TEXT NOT NULL CHECK(state IN ('queued', 'running', 'failed', 'complete')),
             phase              TEXT NOT NULL,
             payload            TEXT NOT NULL DEFAULT '{}',
             attempt_count      INTEGER NOT NULL DEFAULT 0,
             next_run_at        INTEGER NOT NULL,
             lease_token        TEXT,
             lease_expires_at   INTEGER,
             created_at         INTEGER NOT NULL,
             updated_at         INTEGER NOT NULL
           )`,
          // Only one active collection run can consume GitHub quota for a
          // username/version pair. Completed and failed jobs stay inspectable.
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_public_scan_jobs_active_user_version
             ON public_scan_jobs(username, score_version, collection_version)
             WHERE state IN ('queued', 'running')`,
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_public_scan_jobs_active_user_collection
             ON public_scan_jobs(username, collection_version)
             WHERE state IN ('queued', 'running')`,
          `CREATE INDEX IF NOT EXISTS idx_public_scan_jobs_ready
             ON public_scan_jobs(state, next_run_at)`,
          `CREATE INDEX IF NOT EXISTS idx_public_scan_jobs_collection_ready
             ON public_scan_jobs(collection_version, state, next_run_at)`,
          // Process-wide execution slots and API budgets live in Turso rather
          // than Redis. A Redis outage must never turn a deployment or a queue
          // replay into an unbounded GitHub crawl.
          `CREATE TABLE IF NOT EXISTS public_scan_execution_leases (
             slot             INTEGER PRIMARY KEY,
             job_id           TEXT,
             lease_token      TEXT,
             lease_expires_at INTEGER NOT NULL DEFAULT 0
           )`,
          `CREATE TABLE IF NOT EXISTS public_scan_rate_windows (
             bucket           TEXT NOT NULL,
             window_started   INTEGER NOT NULL,
             count            INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY(bucket, window_started)
           )`,
          `CREATE TABLE IF NOT EXISTS public_scan_step_metrics (
             collection_version TEXT NOT NULL,
             phase              TEXT NOT NULL,
             outcome            TEXT NOT NULL CHECK(outcome IN ('continued', 'complete', 'failed_retrying', 'failed_terminal', 'slot_busy')),
             step_count         INTEGER NOT NULL DEFAULT 0,
             total_duration_ms  INTEGER NOT NULL DEFAULT 0,
             max_duration_ms    INTEGER NOT NULL DEFAULT 0,
             updated_at         INTEGER NOT NULL,
             PRIMARY KEY(collection_version, phase, outcome)
           )`,
          `CREATE TABLE IF NOT EXISTS public_scan_cron_metrics (
             singleton            INTEGER PRIMARY KEY CHECK(singleton = 1),
             last_started_at       INTEGER,
             last_success_at       INTEGER,
             last_duration_ms      INTEGER,
             last_processed        INTEGER NOT NULL DEFAULT 0,
             last_failed_steps     INTEGER NOT NULL DEFAULT 0,
             consecutive_failures  INTEGER NOT NULL DEFAULT 0,
             updated_at            INTEGER NOT NULL
           )`,
          `CREATE TABLE IF NOT EXISTS public_scan_pr_facts (
             run_id             TEXT NOT NULL,
             pull_request_id    TEXT NOT NULL,
             source             TEXT NOT NULL CHECK(source IN ('native_merged', 'workflow_landed', 'closed')),
             repo_key           TEXT,
             owner_login        TEXT,
             stars              INTEGER NOT NULL DEFAULT 0,
             is_private         INTEGER NOT NULL DEFAULT 0,
             is_fork            INTEGER NOT NULL DEFAULT 0,
             created_at         TEXT,
             merged_at          TEXT,
             closed_at          TEXT,
             title              TEXT,
             additions          INTEGER,
             deletions          INTEGER,
             changed_files      INTEGER,
             labels             TEXT,
             PRIMARY KEY(run_id, pull_request_id)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_public_scan_pr_facts_run_repo
             ON public_scan_pr_facts(run_id, repo_key)`,
          `CREATE TABLE IF NOT EXISTS public_scan_commit_repo_facts (
             run_id             TEXT NOT NULL,
             repo_key           TEXT NOT NULL,
             owner_login        TEXT,
             stars              INTEGER NOT NULL DEFAULT 0,
             is_private         INTEGER NOT NULL DEFAULT 0,
             is_fork            INTEGER NOT NULL DEFAULT 0,
             commits            INTEGER NOT NULL DEFAULT 0,
             active_years       INTEGER NOT NULL DEFAULT 0,
             first_committed_at TEXT,
             last_committed_at  TEXT,
             source             TEXT NOT NULL,
             evidence_shas      TEXT NOT NULL DEFAULT '[]',
             PRIMARY KEY(run_id, repo_key)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_public_scan_commit_facts_run
             ON public_scan_commit_repo_facts(run_id)`,
          // Search only discovers public commit candidates. Keep candidates
          // separate until the corresponding repository default branch has been
          // enumerated and verified; search results alone are never score facts.
          `CREATE TABLE IF NOT EXISTS public_scan_commit_candidates (
             run_id       TEXT NOT NULL,
             sha          TEXT NOT NULL,
             repo_key     TEXT NOT NULL,
             owner_login  TEXT,
             stars        INTEGER NOT NULL DEFAULT 0,
             is_private   INTEGER NOT NULL DEFAULT 0,
             is_fork      INTEGER NOT NULL DEFAULT 0,
             authored_at  TEXT,
             PRIMARY KEY(run_id, sha, repo_key)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_public_scan_commit_candidates_run_repo
             ON public_scan_commit_candidates(run_id, repo_key, authored_at)`,
          // One row is one repository/time range to verify through the default
          // branch REST endpoint. Ranges split further if pagination would hit
          // GitHub's result ceiling; completed rows form the materialized commit
          // aggregate for the run.
          `CREATE TABLE IF NOT EXISTS public_scan_commit_verification_work (
             run_id              TEXT NOT NULL,
             repo_key            TEXT NOT NULL,
             range_from          TEXT NOT NULL,
             range_to            TEXT NOT NULL,
             owner_login         TEXT,
             stars               INTEGER NOT NULL DEFAULT 0,
             is_private          INTEGER NOT NULL DEFAULT 0,
             is_fork             INTEGER NOT NULL DEFAULT 0,
             page                INTEGER NOT NULL DEFAULT 1,
             state               TEXT NOT NULL CHECK(state IN ('queued', 'complete', 'superseded')),
             commit_count        INTEGER NOT NULL DEFAULT 0,
             first_committed_at  TEXT,
             last_committed_at   TEXT,
             active_years        TEXT NOT NULL DEFAULT '[]',
             evidence_shas       TEXT NOT NULL DEFAULT '[]',
             PRIMARY KEY(run_id, repo_key, range_from, range_to)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_public_scan_commit_work_ready
             ON public_scan_commit_verification_work(run_id, state, repo_key)`,
          `CREATE TABLE IF NOT EXISTS public_scan_owned_repo_facts (
             run_id       TEXT NOT NULL,
             repo_key     TEXT NOT NULL,
             name         TEXT NOT NULL,
             owner_login  TEXT,
             stars        INTEGER NOT NULL DEFAULT 0,
             forks        INTEGER NOT NULL DEFAULT 0,
             open_issues  INTEGER NOT NULL DEFAULT 0,
             size         INTEGER NOT NULL DEFAULT 0,
             language     TEXT,
             description  TEXT,
             pushed_at    TEXT,
             topics       TEXT NOT NULL DEFAULT '[]',
             PRIMARY KEY(run_id, repo_key)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_public_scan_owned_repos_run_stars
             ON public_scan_owned_repo_facts(run_id, stars DESC)`,
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
          // Event cohorts are labels over the canonical score population, not a
          // second score store. One account can join many campaigns while its
          // latest score/profile continues to live in `scores`.
          `CREATE TABLE IF NOT EXISTS campaign_participants (
             campaign  TEXT NOT NULL,
             username  TEXT NOT NULL,
             joined_at INTEGER NOT NULL,
             PRIMARY KEY (campaign, username)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_campaign_participants_user
             ON campaign_participants(username, campaign)`,
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
          // Follows — a signed-in user watching other handles. Powers the
          // homepage "following" module (score changes of the accounts you
          // watch). Follower keyed by GitHub numeric id (stable across renames),
          // target by lowercased handle so it joins straight onto `scores`.
          `CREATE TABLE IF NOT EXISTS follows (
             follower_github_id INTEGER NOT NULL,
             target_username    TEXT NOT NULL,
             created_at         INTEGER NOT NULL,
             PRIMARY KEY (follower_github_id, target_username)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_follows_target ON follows(target_username)`,
          // Repositories as first-class entities — the normalized project layer
          // derived from profile_snapshots (top_repos + impact_repos) by
          // lib/repo-graph.ts. Promotes repos out of the per-scan JSON blobs so
          // the project pages / project ranking can aggregate by repo instead of
          // re-parsing every snapshot. `repo_key` is lowercased "owner/name";
          // metadata is best-effort (contributor-only repos carry null
          // language/description until their owner is scanned). Upserted per scan.
          `CREATE TABLE IF NOT EXISTS repos (
             repo_key        TEXT PRIMARY KEY,
             name_with_owner TEXT NOT NULL,
             owner_login     TEXT NOT NULL,
             name            TEXT NOT NULL,
             description     TEXT,
             stars           INTEGER NOT NULL DEFAULT 0,
             forks           INTEGER,
             language        TEXT,
             topics          TEXT,
             updated_at      INTEGER NOT NULL
           )`,
          `CREATE INDEX IF NOT EXISTS idx_repos_stars ON repos(stars DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_repos_owner ON repos(owner_login)`,
          // The developer⟷repo edge. relation = 'owner' (their own/attributed
          // work) | 'contributor' (landed commits/PRs). Powers both directions:
          // a repo's contributor list (WHERE repo_key = ?) and a developer's
          // projects (WHERE username = ?). weight ranks a repo's devs — stars for
          // owners, commit+PR volume for contributors. Rewritten per developer on
          // each scan so it self-heals as profiles refresh.
          `CREATE TABLE IF NOT EXISTS repo_developers (
             repo_key   TEXT NOT NULL,
             username   TEXT NOT NULL,
             relation   TEXT NOT NULL CHECK(relation IN ('owner','contributor')),
             commits    INTEGER,
             prs        INTEGER,
             weight     REAL NOT NULL DEFAULT 0,
             updated_at INTEGER NOT NULL,
             PRIMARY KEY (repo_key, username, relation)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_repo_developers_user ON repo_developers(username)`,
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
        "score_write_token TEXT",
        "score_source_collection_version TEXT",
        "score_source_snapshot_hash TEXT",
        "roast_version TEXT",
        "roast_en_version TEXT",
        // Previous scan's score + timestamp, kept for the 进步榜 (progress board).
        // Populated by recordScore on a genuinely later re-scan; NULL until then.
        "prev_score REAL",
        "prev_scanned_at INTEGER",
        // Influence signals lifted out of the profile_snapshots.metrics JSON so
        // the VIP-outreach candidate query can rank by them in SQL. Written by
        // recordProfileSnapshot; NULL until a snapshot lands.
        "followers INTEGER",
        "total_stars INTEGER",
      ]) {
        await addColumnIfMissing(db, "scores", col);
      }
      await addColumnIfMissing(
        db,
        "public_scan_commit_repo_facts",
        "active_years INTEGER NOT NULL DEFAULT 0",
      );
      await addColumnIfMissing(
        db,
        "public_scan_commit_verification_work",
        "active_years TEXT NOT NULL DEFAULT '[]'",
      );
      for (const table of [
        "public_scan_commit_repo_facts",
        "public_scan_commit_candidates",
        "public_scan_commit_verification_work",
      ]) {
        for (const column of ["is_private", "is_fork"]) {
          await addColumnIfMissing(db, table, `${column} INTEGER NOT NULL DEFAULT 0`);
        }
      }
      await addColumnIfMissing(db, "profile_snapshots", "signature_work TEXT");
      // One durable collection invocation is intentionally conservative. Each
      // invocation is bounded, then a later request-after task or Cron run
      // resumes it; a single slot keeps the GitHub Search and GraphQL quotas
      // predictable when many stale profiles are discovered after a version
      // bump.
      await db.batch(
        [{
          sql: `INSERT OR IGNORE INTO public_scan_execution_leases
                (slot, lease_expires_at) VALUES (1, 0)`,
          args: [],
        }],
        "write",
      );
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
 * Attach an account to a public event cohort without duplicating its score.
 * The relation may be written before a first-time account has finished its
 * roast; it becomes visible on the event board as soon as `scores` is written.
 */
export async function recordCampaignParticipant(
  campaign: string,
  username: string,
): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `INSERT INTO campaign_participants (campaign, username, joined_at)
            VALUES (?, ?, ?)
            ON CONFLICT(campaign, username) DO NOTHING`,
      args: [campaign, username.toLowerCase(), Date.now()],
    });
    if (Number(result.rowsAffected ?? 0) === 1) {
      await bumpCampaignLeaderboardRevision(campaign);
    }
  } catch (e) {
    console.error("recordCampaignParticipant failed:", e);
  }
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

export interface ScoreWriteIdentity {
  scannedAt: number;
  token: string;
}

export interface RoastArtifacts {
  tags: Tags;
  roastLine: RoastLine;
}

type CanonicalScoreUpsertResult =
  | { status: "written" | "same"; identity: ScoreWriteIdentity }
  | { status: "superseded"; identity: null };

function isCanonicalSnapshotHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function scoreWriteIdentity(row: Record<string, unknown>): ScoreWriteIdentity | null {
  const scannedAt = Number(row.scanned_at);
  const token = typeof row.score_write_token === "string" ? row.score_write_token : "";
  return Number.isSafeInteger(scannedAt) && scannedAt > 0 && token
    ? { scannedAt, token }
    : null;
}

async function ensureAccountStatsTx(
  tx: Transaction,
  username: string,
  scannedAt: number,
): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO account_stats (username, lookup_count, first_lookup_at, last_lookup_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(username) DO UPDATE SET
            lookup_count = MAX(account_stats.lookup_count, excluded.lookup_count)`,
    args: [username, MIN_RECORDED_LOOKUP_COUNT, scannedAt, scannedAt],
  });
}

async function upsertCanonicalScoreTx(
  tx: Transaction,
  materialized: CanonicalScoreMaterialization,
): Promise<CanonicalScoreUpsertResult> {
  const entry = materialized.scoreEntry;
  const provenance = materialized.provenance;
  const username = entry.username.toLowerCase();
  const tags = JSON.stringify(entry.tags ?? EMPTY_TAGS);
  const roastLine = JSON.stringify(entry.roast_line ?? EMPTY_ROAST_LINE);
  const subScores = JSON.stringify(entry.sub_scores);
  const current = await tx.execute({
    sql: `SELECT username, final_score, tier, sub_scores, score_version,
                 score_write_token, score_source_collection_version,
                 score_source_snapshot_hash, scanned_at
          FROM scores WHERE username = ? LIMIT 1`,
    args: [username],
  });
  const row = current.rows[0] as Record<string, unknown> | undefined;
  const token = randomUUID();

  if (!row) {
    await tx.execute({
      sql: `INSERT INTO scores
              (username, display_name, avatar_url, profile_url, final_score, tier, tags,
               roast_line, score_version, score_write_token,
               score_source_collection_version, score_source_snapshot_hash,
               bot_score, sub_scores, scanned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        username,
        entry.display_name,
        entry.avatar_url,
        entry.profile_url,
        entry.final_score,
        entry.tier,
        tags,
        roastLine,
        provenance.scoreVersion,
        token,
        provenance.collectionVersion,
        provenance.snapshotHash,
        entry.bot_score,
        subScores,
        entry.scanned_at,
      ],
    });
    await ensureAccountStatsTx(tx, username, entry.scanned_at);
    return { status: "written", identity: { scannedAt: entry.scanned_at, token } };
  }

  const existingIdentity = scoreWriteIdentity(row);
  const previousScannedAt = Number(row.scanned_at);
  const existingIsCanonical =
    row.score_version === provenance.scoreVersion &&
    row.score_source_collection_version === provenance.collectionVersion &&
    isCanonicalSnapshotHash(row.score_source_snapshot_hash);
  const sameSnapshot =
    existingIsCanonical &&
    row.score_source_snapshot_hash === provenance.snapshotHash;
  if (sameSnapshot) {
    if (!Number.isSafeInteger(previousScannedAt) || previousScannedAt <= 0) {
      throw new Error("invalid canonical score timestamp");
    }
    if (entry.scanned_at > previousScannedAt) {
      await tx.execute({
        sql: `UPDATE scores SET score_write_token = ?, scanned_at = ?
              WHERE username = ? AND score_version = ?
                AND score_source_collection_version = ?
                AND score_source_snapshot_hash = ?`,
        args: [
          token,
          entry.scanned_at,
          username,
          provenance.scoreVersion,
          provenance.collectionVersion,
          provenance.snapshotHash,
        ],
      });
      await ensureAccountStatsTx(tx, username, entry.scanned_at);
      return {
        status: "written",
        identity: { scannedAt: entry.scanned_at, token },
      };
    }
    if (existingIdentity) return { status: "same", identity: existingIdentity };
    await tx.execute({
      sql: `UPDATE scores SET score_write_token = ?
            WHERE username = ? AND score_version = ?
              AND score_source_collection_version = ?
              AND score_source_snapshot_hash = ?`,
      args: [
        token,
        username,
        provenance.scoreVersion,
        provenance.collectionVersion,
        provenance.snapshotHash,
      ],
    });
    return {
      status: "same",
      identity: { scannedAt: previousScannedAt, token },
    };
  }

  // Only a newer canonical row may reject this write. A legacy/current-version
  // row without complete provenance is not evidence and must never block a
  // trusted v4 snapshot merely because its request timestamp is later.
  if (existingIsCanonical) {
    if (!Number.isSafeInteger(previousScannedAt) || previousScannedAt <= 0) {
      throw new Error("invalid canonical score timestamp");
    }
    if (entry.scanned_at <= previousScannedAt) {
      return { status: "superseded", identity: null };
    }
  }

  await tx.execute({
    sql: `UPDATE scores SET
            prev_score = CASE WHEN ? - scanned_at >= ? THEN final_score ELSE prev_score END,
            prev_scanned_at = CASE WHEN ? - scanned_at >= ? THEN scanned_at ELSE prev_scanned_at END,
            display_name = ?, avatar_url = ?, profile_url = ?, final_score = ?, tier = ?,
            tags = ?, roast_line = ?, score_version = ?, score_write_token = ?,
            score_source_collection_version = ?, score_source_snapshot_hash = ?,
            bot_score = ?, sub_scores = ?, scanned_at = ?,
            roast = NULL, roast_version = NULL, roast_en = NULL, roast_en_version = NULL
          WHERE username = ?`,
    args: [
      entry.scanned_at,
      PROGRESS_MIN_GAP_MS,
      entry.scanned_at,
      PROGRESS_MIN_GAP_MS,
      entry.display_name,
      entry.avatar_url,
      entry.profile_url,
      entry.final_score,
      entry.tier,
      tags,
      roastLine,
      provenance.scoreVersion,
      token,
      provenance.collectionVersion,
      provenance.snapshotHash,
      entry.bot_score,
      subScores,
      entry.scanned_at,
      username,
    ],
  });
  await ensureAccountStatsTx(tx, username, entry.scanned_at);
  return { status: "written", identity: { scannedAt: entry.scanned_at, token } };
}

/**
 * Upsert an account's latest score and return the identity required to attach
 * its generated report. Older writes are ignored instead of replacing newer
 * scans. Best-effort; never throws to the caller.
 */
export async function recordScore(entry: ScoreEntry): Promise<ScoreWriteIdentity | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const username = entry.username.toLowerCase();
    const token = randomUUID();
    const written = await db.execute({
      sql: `INSERT INTO scores
              (username, display_name, avatar_url, profile_url, final_score, tier, tags,
               roast_line, score_version, score_write_token, bot_score, sub_scores, scanned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
              prev_score      = CASE WHEN excluded.scanned_at - scores.scanned_at >= ?
                                     THEN scores.final_score ELSE scores.prev_score END,
              prev_scanned_at = CASE WHEN excluded.scanned_at - scores.scanned_at >= ?
                                     THEN scores.scanned_at ELSE scores.prev_scanned_at END,
              roast         = CASE WHEN scores.score_version = excluded.score_version
                                        AND scores.final_score = excluded.final_score
                                        AND scores.sub_scores = excluded.sub_scores
                                   THEN scores.roast ELSE NULL END,
              roast_version = CASE WHEN scores.score_version = excluded.score_version
                                        AND scores.final_score = excluded.final_score
                                        AND scores.sub_scores = excluded.sub_scores
                                   THEN scores.roast_version ELSE NULL END,
              roast_en         = CASE WHEN scores.score_version = excluded.score_version
                                           AND scores.final_score = excluded.final_score
                                           AND scores.sub_scores = excluded.sub_scores
                                      THEN scores.roast_en ELSE NULL END,
              roast_en_version = CASE WHEN scores.score_version = excluded.score_version
                                           AND scores.final_score = excluded.final_score
                                           AND scores.sub_scores = excluded.sub_scores
                                      THEN scores.roast_en_version ELSE NULL END,
              display_name = excluded.display_name,
              avatar_url   = excluded.avatar_url,
              profile_url  = excluded.profile_url,
              final_score  = excluded.final_score,
              tier         = excluded.tier,
              tags         = excluded.tags,
              roast_line   = excluded.roast_line,
              score_version = excluded.score_version,
              score_write_token = excluded.score_write_token,
              score_source_collection_version = NULL,
              score_source_snapshot_hash = NULL,
              bot_score    = excluded.bot_score,
              sub_scores   = excluded.sub_scores,
              scanned_at   = excluded.scanned_at
            WHERE excluded.scanned_at > scores.scanned_at`,
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
        token,
        entry.bot_score,
        JSON.stringify(entry.sub_scores),
        entry.scanned_at,
        PROGRESS_MIN_GAP_MS,
        PROGRESS_MIN_GAP_MS,
      ],
    });
    if (Number(written.rowsAffected ?? 0) !== 1) return null;
    await db.execute({
      sql: `INSERT INTO account_stats (username, lookup_count, first_lookup_at, last_lookup_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
              lookup_count = MAX(account_stats.lookup_count, excluded.lookup_count)`,
      args: [username, MIN_RECORDED_LOOKUP_COUNT, entry.scanned_at, entry.scanned_at],
    });
    const campaigns = await db.execute({
      sql: `SELECT campaign FROM campaign_participants WHERE username = ?`,
      args: [username],
    });
    await Promise.all(
      campaigns.rows.map((row) => bumpCampaignLeaderboardRevision(String(row.campaign))),
    );
    return { scannedAt: entry.scanned_at, token };
  } catch (e) {
    console.error("recordScore failed:", e);
    return null;
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
               metrics, pinned_repos, organizations, signature_work, scan_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(scan.signature_work ?? null),
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
    // Normalize the same scan into the repo graph (repos + repo_developers), so
    // every snapshot also refreshes the project layer that powers project pages
    // and the project ranking. Independent best-effort write, like facets above.
    await recordRepoGraph(
      username,
      extractRepoGraph({ top_repos: scan.top_repos, impact_repos: scan.impact_repos }),
    );
    // Lift the two influence signals the VIP-outreach query ranks by out of the
    // metrics JSON and onto the (already-written) scores row. recordScore runs
    // before this in the roast path, so the row exists; a no-op if it doesn't.
    await updateInfluenceStats(username, scan.metrics.followers, scan.metrics.total_stars);
  } catch (e) {
    console.error("recordProfileSnapshot failed:", e);
  }
}

const PUBLIC_SCAN_PENDING_SOURCES: PublicScanSourceStatus = Object.fromEntries(
  PUBLIC_SCAN_REQUIRED_SOURCES.map((source) => [source, "pending"]),
) as PublicScanSourceStatus;
const PUBLIC_SCAN_COMPLETE_SOURCES: PublicScanSourceStatus = Object.fromEntries(
  PUBLIC_SCAN_REQUIRED_SOURCES.map((source) => [source, "complete"]),
) as PublicScanSourceStatus;

function parsePublicScanSourceStatus(raw: unknown): PublicScanSourceStatus {
  if (typeof raw !== "string" || !raw) return { ...PUBLIC_SCAN_PENDING_SOURCES };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const output: PublicScanSourceStatus = {};
    for (const [source, state] of Object.entries(parsed)) {
      if (
        state === "pending" ||
        state === "complete" ||
        state === "unavailable" ||
        state === "failed"
      ) {
        output[source] = state;
      }
    }
    return { ...PUBLIC_SCAN_PENDING_SOURCES, ...output };
  } catch {
    return { ...PUBLIC_SCAN_PENDING_SOURCES };
  }
}

function mapPublicScanRun(row: Record<string, unknown>): PublicScanRun {
  return {
    id: String(row.id),
    username: String(row.username),
    scoreVersion: String(row.score_version),
    collectionVersion: String(row.collection_version),
    state: String(row.state) as PublicScanRunState,
    coverage: String(row.coverage) as PublicScanCoverage,
    sourceStatus: parsePublicScanSourceStatus(row.source_status),
    quickScan: typeof row.quick_scan === "string" ? row.quick_scan : null,
    snapshot: typeof row.snapshot === "string" ? row.snapshot : null,
    snapshotHash: typeof row.snapshot_hash === "string" ? row.snapshot_hash : null,
    startedAt: Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    updatedAt: Number(row.updated_at),
    lastError: typeof row.last_error === "string" ? row.last_error : null,
  };
}

function mapPublicScanJob(row: Record<string, unknown>): PublicScanJob {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    username: String(row.username),
    scoreVersion: String(row.score_version),
    collectionVersion: String(row.collection_version),
    state: String(row.state) as PublicScanJob["state"],
    phase: String(row.phase) as PublicScanJobPhase,
    payload: typeof row.payload === "string" ? row.payload : "{}",
    attemptCount: Number(row.attempt_count),
    nextRunAt: Number(row.next_run_at),
    leaseToken: typeof row.lease_token === "string" ? row.lease_token : null,
    leaseExpiresAt: row.lease_expires_at == null ? null : Number(row.lease_expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Atomically publish a complete bounded quick scan and its deterministic score.
 * Large/partial scans are rejected by the materializer and must use the durable
 * worker path instead.
 */
export async function publishCompleteQuickScan(
  scan: ScanResult,
  scannedAt = Date.now(),
): Promise<ScoreWriteIdentity | null> {
  const snapshot = JSON.stringify(scan);
  const snapshotHash = createHash("sha256").update(snapshot).digest("hex");
  const materialized = materializeCanonicalScore({
    snapshot,
    snapshotHash,
    username: scan.metrics.username,
    scoreVersion: SCORE_CACHE_VERSION,
    collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    scannedAt,
    mode: "quick",
    sourceStatus: PUBLIC_SCAN_COMPLETE_SOURCES,
  });
  if (!materialized) return null;

  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const tx = await db.transaction("write");
    try {
      const existingRun = await tx.execute({
        sql: `SELECT id FROM public_scan_runs
              WHERE username = ? AND score_version = ? AND collection_version = ?
                AND state = 'complete_public' AND snapshot_hash = ? AND started_at = ?
              LIMIT 1`,
        args: [
          materialized.scoreEntry.username,
          SCORE_CACHE_VERSION,
          PUBLIC_SCAN_COLLECTION_VERSION,
          snapshotHash,
          scannedAt,
        ],
      });
      if (!existingRun.rows[0]) {
        await tx.execute({
          sql: `INSERT INTO public_scan_runs
                  (id, username, score_version, collection_version, state, coverage,
                   source_status, quick_scan, snapshot, snapshot_hash,
                   started_at, completed_at, updated_at)
                VALUES (?, ?, ?, ?, 'complete_public', 'complete_public', ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            randomUUID(),
            materialized.scoreEntry.username,
            SCORE_CACHE_VERSION,
            PUBLIC_SCAN_COLLECTION_VERSION,
            JSON.stringify(PUBLIC_SCAN_COMPLETE_SOURCES),
            snapshot,
            snapshot,
            snapshotHash,
            scannedAt,
            scannedAt,
            scannedAt,
          ],
        });
      }
      const scoreWrite = await upsertCanonicalScoreTx(tx, materialized);
      if (scoreWrite.status === "superseded") {
        await tx.rollback();
        return null;
      }
      await tx.commit();
      await recordProfileSnapshot(materialized.scan);
      return scoreWrite.identity;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    logPublicScanDbFailure("publish_quick_score", error);
    return null;
  }
}

/**
 * Idempotently materialize the current deterministic score from an already
 * persisted complete v4 run. This repairs pre-deployment runs without another
 * GitHub crawl; non-canonical collections and partial/corrupt snapshots fail
 * closed.
 */
export async function ensureCanonicalScoreForPublicRun(
  run: PublicScanRun,
): Promise<ScoreWriteIdentity | null> {
  if (
    run.collectionVersion !== PUBLIC_SCAN_COLLECTION_VERSION ||
    run.state !== "complete_public" ||
    run.coverage !== "complete_public" ||
    !run.snapshot ||
    !run.snapshotHash ||
    !hasCompletePublicScanSources(run.sourceStatus)
  ) {
    return null;
  }
  const materialized = materializeCanonicalScore({
    snapshot: run.snapshot,
    snapshotHash: run.snapshotHash,
    username: run.username,
    scoreVersion: SCORE_CACHE_VERSION,
    collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    scannedAt: run.startedAt,
    mode: "durable",
    sourceStatus: run.sourceStatus,
  });
  if (!materialized) return null;

  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    // Healthy cache hits should not serialize behind a write transaction. A
    // strictly older identity still enters the transaction so the canonical
    // scan timestamp and CAS token can advance together.
    const existing = await db.execute({
      sql: `SELECT scanned_at, score_write_token
            FROM scores
            WHERE username = ?
              AND hidden = 0
              AND score_version = ?
              AND score_source_collection_version = ?
              AND score_source_snapshot_hash = ?
            LIMIT 1`,
      args: [
        run.username.toLowerCase(),
        SCORE_CACHE_VERSION,
        PUBLIC_SCAN_COLLECTION_VERSION,
        run.snapshotHash,
      ],
    });
    const existingIdentity = existing.rows[0]
      ? scoreWriteIdentity(existing.rows[0] as Record<string, unknown>)
      : null;
    if (existingIdentity && existingIdentity.scannedAt >= run.startedAt) {
      return existingIdentity;
    }

    const tx = await db.transaction("write");
    try {
      const scoreWrite = await upsertCanonicalScoreTx(tx, materialized);
      if (scoreWrite.status === "superseded") {
        await tx.rollback();
        return null;
      }
      await tx.commit();
      if (scoreWrite.status === "written") {
        await recordProfileSnapshot(materialized.scan);
      }
      return scoreWrite.identity;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    logPublicScanDbFailure("ensure_run_score", error);
    return null;
  }
}

export interface BackfillCanonicalScoresPageInput {
  apply: boolean;
  limit: number;
  cursor: string | null;
}

export interface BackfillCanonicalScoresPageResult {
  dryRun: boolean;
  processed: number;
  eligible: number;
  materialized: number;
  skipped: number;
  rejected: number;
  failed: number;
  nextCursor: string | null;
}

interface CanonicalScoreBackfillCursor {
  completedAt: number;
  runId: string;
  watermark: number;
}

function encodeCanonicalScoreBackfillCursor(
  cursor: CanonicalScoreBackfillCursor,
): string {
  return `bfs1.${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`;
}

function decodeCanonicalScoreBackfillCursor(
  raw: string | null,
): CanonicalScoreBackfillCursor | null | undefined {
  if (raw === null) return null;
  if (!raw.startsWith("bfs1.") || raw.length > 512) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(raw.slice("bfs1.".length), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      !Number.isSafeInteger(value.completedAt) ||
      Number(value.completedAt) < 0 ||
      !Number.isSafeInteger(value.watermark) ||
      Number(value.watermark) <= 0 ||
      typeof value.runId !== "string" ||
      !/^[a-zA-Z0-9-]{0,128}$/.test(value.runId) ||
      (Number(value.completedAt) === 0) !== (value.runId === "")
    ) {
      return undefined;
    }
    return {
      completedAt: Number(value.completedAt),
      runId: value.runId,
      watermark: Number(value.watermark),
    };
  } catch {
    return undefined;
  }
}

/**
 * Recompute the current deterministic score from the latest complete canonical
 * collection snapshot for each account. The cursor contains only completion
 * time, a fixed page watermark, and a run UUID; account identifiers never leave
 * this storage boundary.
 */
export async function backfillCanonicalScoresPage(
  input: BackfillCanonicalScoresPageInput,
): Promise<BackfillCanonicalScoresPageResult | null> {
  const db = getClient();
  if (!db) return null;
  if (
    typeof input.apply !== "boolean" ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.cursor !== null && typeof input.cursor !== "string")
  ) {
    throw new Error("invalid canonical score backfill input");
  }
  const limit = input.limit;
  const decodedCursor = decodeCanonicalScoreBackfillCursor(input.cursor);
  if (decodedCursor === undefined) {
    throw new Error("invalid canonical score backfill cursor");
  }
  const cursor: CanonicalScoreBackfillCursor = decodedCursor ?? {
    completedAt: 0,
    runId: "",
    watermark: Date.now(),
  };

  await ensureSchema(db);
  const result = await db.execute({
    sql: `SELECT r.id, r.username, r.snapshot, r.snapshot_hash, r.source_status,
                 r.started_at, r.completed_at
          FROM public_scan_runs r
          WHERE r.collection_version = ?
            AND r.state = 'complete_public'
            AND r.coverage = 'complete_public'
            AND r.snapshot IS NOT NULL
            AND r.snapshot_hash IS NOT NULL
            AND r.completed_at IS NOT NULL
            AND r.completed_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM public_scan_runs newer
              WHERE newer.username = r.username
                AND newer.collection_version = r.collection_version
                AND newer.state = 'complete_public'
                AND newer.coverage = 'complete_public'
                AND newer.snapshot IS NOT NULL
                AND newer.snapshot_hash IS NOT NULL
                AND newer.completed_at IS NOT NULL
                AND newer.completed_at <= ?
                AND (
                  newer.started_at > r.started_at OR
                  (newer.started_at = r.started_at AND newer.id > r.id)
                )
            )
            AND (
              r.completed_at > ? OR
              (r.completed_at = ? AND r.id > ?)
            )
          ORDER BY r.completed_at ASC, r.id ASC
          LIMIT ?`,
    args: [
      PUBLIC_SCAN_COLLECTION_VERSION,
      cursor.watermark,
      cursor.watermark,
      cursor.completedAt,
      cursor.completedAt,
      cursor.runId,
      limit + 1,
    ],
  });
  const pageRows = result.rows.slice(0, limit) as Record<string, unknown>[];
  const response: BackfillCanonicalScoresPageResult = {
    dryRun: !input.apply,
    processed: 0,
    eligible: 0,
    materialized: 0,
    skipped: 0,
    rejected: 0,
    failed: 0,
    nextCursor: null,
  };
  let lastProcessedCursor = cursor;
  let stoppedOnFailure = false;

  for (const row of pageRows) {
    response.processed += 1;
    const rowCursor: CanonicalScoreBackfillCursor = {
      completedAt: Number(row.completed_at),
      runId: String(row.id),
      watermark: cursor.watermark,
    };
    const materialized = materializeCanonicalScore({
      snapshot: String(row.snapshot ?? ""),
      snapshotHash: String(row.snapshot_hash ?? ""),
      username: String(row.username ?? ""),
      scoreVersion: SCORE_CACHE_VERSION,
      collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      scannedAt: Number(row.started_at),
      mode: "durable",
      sourceStatus: parsePublicScanSourceStatus(row.source_status),
    });
    if (!materialized) {
      response.rejected += 1;
      lastProcessedCursor = rowCursor;
      continue;
    }
    response.eligible += 1;

    const existing = await db.execute({
      sql: `SELECT score_version, score_source_collection_version,
                   score_source_snapshot_hash, scanned_at
            FROM scores WHERE username = ? LIMIT 1`,
      args: [materialized.scoreEntry.username],
    });
    const existingRow = existing.rows[0] as Record<string, unknown> | undefined;
    const alreadyMaterialized =
      existingRow?.score_version === SCORE_CACHE_VERSION &&
      existingRow.score_source_collection_version === PUBLIC_SCAN_COLLECTION_VERSION &&
      existingRow.score_source_snapshot_hash === materialized.provenance.snapshotHash &&
      Number(existingRow.scanned_at) >= materialized.scoreEntry.scanned_at;
    const protectedByNewerCanonical =
      existingRow?.score_version === SCORE_CACHE_VERSION &&
      existingRow.score_source_collection_version === PUBLIC_SCAN_COLLECTION_VERSION &&
      isCanonicalSnapshotHash(existingRow.score_source_snapshot_hash) &&
      Number(existingRow.scanned_at) >= materialized.scoreEntry.scanned_at;
    if (alreadyMaterialized || protectedByNewerCanonical) {
      response.skipped += 1;
      lastProcessedCursor = rowCursor;
      continue;
    }
    if (!input.apply) {
      lastProcessedCursor = rowCursor;
      continue;
    }

    try {
      const tx = await db.transaction("write");
      try {
        const scoreWrite = await upsertCanonicalScoreTx(tx, materialized);
        if (scoreWrite.status === "superseded") {
          await tx.rollback();
          response.skipped += 1;
          lastProcessedCursor = rowCursor;
          continue;
        }
        await tx.commit();
        response.materialized += 1;
        lastProcessedCursor = rowCursor;
      } catch (error) {
        await tx.rollback().catch(() => {});
        throw error;
      }
    } catch {
      response.failed += 1;
      stoppedOnFailure = true;
      break;
    }
  }

  if (stoppedOnFailure || result.rows.length > limit) {
    response.nextCursor = encodeCanonicalScoreBackfillCursor(lastProcessedCursor);
  }
  return response;
}

export interface EnqueuedPublicScan {
  run: PublicScanRun;
  job: PublicScanJob;
  created: boolean;
}

/** Cost admission applies only when a request would create new durable work.
 * The bucket is already a one-way hash at every HTTP/MCP boundary. */
export interface PublicScanAdmission {
  bucket: string;
  limit: number;
  windowMs: number;
  maxActiveJobs: number;
}

export interface RejectedPublicScanEnqueue {
  created: false;
  rejection: "queue_full" | "admission_limited";
  retryAt: number;
}

export type PublicScanEnqueueResult = EnqueuedPublicScan | RejectedPublicScanEnqueue;

/**
 * Create one durable public-history scan per username/collection version. Score
 * versions are stored for audit, but changing score formulas must re-evaluate
 * persisted facts rather than repeat the expensive GitHub collection.
 */
export async function enqueuePublicScan(
  username: string,
  input: {
    scoreVersion: string;
    collectionVersion: string;
    admission?: PublicScanAdmission;
  },
): Promise<PublicScanEnqueueResult | null> {
  const db = getClient();
  if (!db) return null;
  const normalized = username.toLowerCase();
  try {
    await ensureSchema(db);
    const now = Date.now();
    const tx = await db.transaction("write");
    try {
      const existing = await tx.execute({
        sql: `SELECT j.*
              FROM public_scan_jobs j
              WHERE j.username = ?
                AND j.collection_version = ?
                AND j.state IN ('queued', 'running')
              ORDER BY j.created_at DESC
              LIMIT 1`,
        args: [normalized, input.collectionVersion],
      });
      if (existing.rows[0]) {
        const job = mapPublicScanJob(existing.rows[0] as Record<string, unknown>);
        const runResult = await tx.execute({
          sql: `SELECT * FROM public_scan_runs WHERE id = ? LIMIT 1`,
          args: [job.runId],
        });
        await tx.commit();
        const runRow = runResult.rows[0];
        if (!runRow) return null;
        return { run: mapPublicScanRun(runRow as Record<string, unknown>), job, created: false };
      }

      const admission = input.admission;
      if (admission) {
        const active = await tx.execute({
          sql: `SELECT COUNT(*) AS count FROM public_scan_jobs
                WHERE collection_version = ?
                  AND state IN ('queued', 'running')`,
          args: [input.collectionVersion],
        });
        const activeCount = Number((active.rows[0] as Record<string, unknown> | undefined)?.count) || 0;
        const maxActiveJobs = Math.max(1, Math.floor(admission.maxActiveJobs));
        if (activeCount >= maxActiveJobs) {
          await tx.commit();
          return { created: false, rejection: "queue_full", retryAt: now + 60_000 };
        }

        const windowMs = Math.max(1_000, Math.floor(admission.windowMs));
        const windowStarted = Math.floor(now / windowMs) * windowMs;
        const rate = await tx.execute({
          sql: `INSERT INTO public_scan_rate_windows (bucket, window_started, count)
                VALUES (?, ?, 1)
                ON CONFLICT(bucket, window_started) DO UPDATE SET count = count + 1
                  WHERE public_scan_rate_windows.count < ?`,
          args: [admission.bucket, windowStarted, Math.max(1, Math.floor(admission.limit))],
        });
        if (Number(rate.rowsAffected ?? 0) !== 1) {
          await tx.commit();
          return {
            created: false,
            rejection: "admission_limited",
            retryAt: windowStarted + windowMs,
          };
        }
      }

      const runId = randomUUID();
      const jobId = randomUUID();
      const sourceStatus = JSON.stringify(PUBLIC_SCAN_PENDING_SOURCES);
      await tx.execute({
        sql: `INSERT INTO public_scan_runs
                (id, username, score_version, collection_version, state, coverage,
                 source_status, started_at, updated_at)
              VALUES (?, ?, ?, ?, 'queued', 'partial_public', ?, ?, ?)`,
        args: [runId, normalized, input.scoreVersion, input.collectionVersion, sourceStatus, now, now],
      });
      await tx.execute({
        sql: `INSERT INTO public_scan_jobs
                (id, run_id, username, score_version, collection_version, state, phase,
                 payload, next_run_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'queued', 'quick', '{}', ?, ?, ?)`,
        args: [jobId, runId, normalized, input.scoreVersion, input.collectionVersion, now, now, now],
      });
      await tx.commit();
      return {
        run: {
          id: runId,
          username: normalized,
          scoreVersion: input.scoreVersion,
          collectionVersion: input.collectionVersion,
          state: "queued",
          coverage: "partial_public",
          sourceStatus: { ...PUBLIC_SCAN_PENDING_SOURCES },
          quickScan: null,
          snapshot: null,
          snapshotHash: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          lastError: null,
        },
        job: {
          id: jobId,
          runId,
          username: normalized,
          scoreVersion: input.scoreVersion,
          collectionVersion: input.collectionVersion,
          state: "queued",
          phase: "quick",
          payload: "{}",
          attemptCount: 0,
          nextRunAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
          createdAt: now,
          updatedAt: now,
        },
        created: true,
      };
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    logPublicScanDbFailure("enqueue", error);
    return null;
  }
}

export async function getLatestPublicScanRun(
  username: string,
  input: { scoreVersion?: string; collectionVersion: string },
): Promise<PublicScanRun | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT * FROM public_scan_runs
            WHERE username = ? AND collection_version = ?
            ORDER BY started_at DESC, id DESC
            LIMIT 1`,
      args: [username.toLowerCase(), input.collectionVersion],
    });
    const row = result.rows[0];
    return row ? mapPublicScanRun(row as Record<string, unknown>) : null;
  } catch (error) {
    logPublicScanDbFailure("get_latest_run", error);
    return null;
  }
}

/**
 * Return complete snapshots in newest-first order for one exact collection
 * contract. Callers must validate hash and payload shape before serving a row;
 * this query deliberately never crosses collection versions.
 */
export async function getCompletePublicScanRuns(
  username: string,
  collectionVersion: string,
): Promise<PublicScanRun[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT * FROM public_scan_runs
            WHERE username = ?
              AND collection_version = ?
              AND state = 'complete_public'
              AND coverage = 'complete_public'
              AND snapshot IS NOT NULL
              AND snapshot_hash IS NOT NULL
              AND completed_at IS NOT NULL
            ORDER BY completed_at DESC, id DESC`,
      args: [username.toLowerCase(), collectionVersion],
    });
    return result.rows.map((row) => mapPublicScanRun(row as Record<string, unknown>));
  } catch (error) {
    logPublicScanDbFailure("get_complete_runs", error);
    return [];
  }
}

export async function getPublicScanRun(runId: string): Promise<PublicScanRun | null> {
  const db = requirePublicScanDb("get_run");
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT * FROM public_scan_runs WHERE id = ? LIMIT 1`,
      args: [runId],
    });
    return result.rows[0]
      ? mapPublicScanRun(result.rows[0] as Record<string, unknown>)
      : null;
  } catch (error) {
    throwPublicScanStorageFailure("get_run", error);
  }
}

export interface PublicScanJobVersionCount {
  scoreVersion: string;
  collectionVersion: string;
  state: PublicScanJob["state"];
  count: number;
}

export interface PublicScanQuarantineResult {
  dryRun: boolean;
  selected: number;
  quarantined: number;
  remainingActive: number;
  deferredActive: number;
}

const MAX_PUBLIC_SCAN_QUARANTINE_BATCH = 100;
const OBSOLETE_PUBLIC_SCAN_ERROR = "obsolete collection version quarantined";

/** Aggregate-only inventory for release operations. Never returns job IDs or accounts. */
export async function getPublicScanJobVersionSummary(): Promise<
  PublicScanJobVersionCount[] | null
> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT score_version, collection_version, state, COUNT(*) AS count
            FROM public_scan_jobs
            GROUP BY score_version, collection_version, state
            ORDER BY collection_version, score_version, state`,
      args: [],
    });
    return result.rows.map((row) => ({
      scoreVersion: String(row.score_version),
      collectionVersion: String(row.collection_version),
      state: String(row.state) as PublicScanJob["state"],
      count: Number(row.count),
    }));
  } catch (error) {
    logPublicScanDbFailure("version_summary", error);
    return null;
  }
}

/**
 * Stop a bounded batch of non-canonical collection jobs from consuming quota.
 * The operation is a dry-run unless apply=true and returns counts only so an
 * operator cannot accidentally expose account or job identifiers.
 */
export async function quarantineObsoletePublicScanJobs(input: {
  canonicalCollectionVersion: string;
  apply?: boolean;
  limit?: number;
}): Promise<PublicScanQuarantineResult | null> {
  const db = getClient();
  if (!db) return null;
  const requestedLimit = Number(input.limit ?? 25);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_PUBLIC_SCAN_QUARANTINE_BATCH, Math.floor(requestedLimit)))
    : 25;
  try {
    await ensureSchema(db);
    const now = Date.now();
    if (!input.apply) {
      const [selected, remaining, deferred] = await db.batch(
        [
          {
            sql: `SELECT id
                  FROM public_scan_jobs
                  WHERE collection_version <> ?
                    AND (
                      state = 'queued'
                      OR (state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
                    )
                  ORDER BY created_at ASC
                  LIMIT ?`,
            args: [input.canonicalCollectionVersion, now, limit],
          },
          {
            sql: `SELECT COUNT(*) AS count
                  FROM public_scan_jobs
                  WHERE collection_version <> ?
                    AND state IN ('queued', 'running')`,
            args: [input.canonicalCollectionVersion],
          },
          {
            sql: `SELECT COUNT(*) AS count
                  FROM public_scan_jobs
                  WHERE collection_version <> ?
                    AND state = 'running'
                    AND lease_expires_at > ?`,
            args: [input.canonicalCollectionVersion, now],
          },
        ],
        "read",
      );
      return {
        dryRun: true,
        selected: selected.rows.length,
        quarantined: 0,
        remainingActive: Number(remaining.rows[0]?.count ?? 0),
        deferredActive: Number(deferred.rows[0]?.count ?? 0),
      };
    }

    const tx = await db.transaction("write");
    try {
      const selected = await tx.execute({
        sql: `SELECT id, run_id
              FROM public_scan_jobs
              WHERE collection_version <> ?
                AND (
                  state = 'queued'
                  OR (state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
                )
              ORDER BY created_at ASC
              LIMIT ?`,
        args: [input.canonicalCollectionVersion, now, limit],
      });
      const jobIds = selected.rows.map((row) => String(row.id));
      const runIds = selected.rows.map((row) => String(row.run_id));
      let quarantined = 0;

      if (jobIds.length > 0) {
        const jobPlaceholders = jobIds.map(() => "?").join(", ");
        const runPlaceholders = runIds.map(() => "?").join(", ");
        const updated = await tx.execute({
          sql: `UPDATE public_scan_jobs
                SET state = 'failed', lease_token = NULL, lease_expires_at = NULL,
                    updated_at = ?
                WHERE id IN (${jobPlaceholders})
                  AND collection_version <> ?
                  AND (
                    state = 'queued'
                    OR (state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
                  )`,
          args: [now, ...jobIds, input.canonicalCollectionVersion, now],
        });
        quarantined = Number(updated.rowsAffected ?? 0);
        await tx.execute({
          sql: `UPDATE public_scan_runs
                SET state = 'failed', last_error = ?, updated_at = ?
                WHERE id IN (${runPlaceholders})
                  AND collection_version <> ?
                  AND state IN ('queued', 'running', 'partial_public')`,
          args: [
            OBSOLETE_PUBLIC_SCAN_ERROR,
            now,
            ...runIds,
            input.canonicalCollectionVersion,
          ],
        });
      }

      const remaining = await tx.execute({
        sql: `SELECT COUNT(*) AS count
              FROM public_scan_jobs
              WHERE collection_version <> ?
                AND state IN ('queued', 'running')`,
        args: [input.canonicalCollectionVersion],
      });
      const deferred = await tx.execute({
        sql: `SELECT COUNT(*) AS count
              FROM public_scan_jobs
              WHERE collection_version <> ?
                AND state = 'running'
                AND lease_expires_at > ?`,
        args: [input.canonicalCollectionVersion, now],
      });
      await tx.commit();
      return {
        dryRun: false,
        selected: jobIds.length,
        quarantined,
        remainingActive: Number(remaining.rows[0]?.count ?? 0),
        deferredActive: Number(deferred.rows[0]?.count ?? 0),
      };
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    logPublicScanDbFailure("quarantine_obsolete", error);
    return null;
  }
}

/**
 * Claim a ready job with a database lease. A stale delivery can be recovered
 * after its lease expires; the next worker receives a fresh token and the old
 * worker can no longer publish progress or a final snapshot.
 */
export async function claimPublicScanJob(
  input: {
    collectionVersion: string;
    jobId?: string;
    leaseMs?: number;
  },
): Promise<PublicScanJobLease | null> {
  const db = requirePublicScanDb("claim_job");
  try {
    await ensureSchema(db);
    const now = Date.now();
    const leaseMs = input.leaseMs ?? 55_000;
    const tx = await db.transaction("write");
    try {
      // Recover work abandoned by an interrupted serverless invocation first.
      await tx.execute({
        sql: `UPDATE public_scan_jobs
              SET state = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE collection_version = ?
                AND state = 'running'
                AND lease_expires_at IS NOT NULL
                AND lease_expires_at <= ?`,
        args: [now, input.collectionVersion, now],
      });
      const candidate = await tx.execute({
        sql: input.jobId
          ? `SELECT * FROM public_scan_jobs
             WHERE id = ?
               AND collection_version = ?
               AND state = 'queued'
               AND next_run_at <= ?
             LIMIT 1`
          : `SELECT * FROM public_scan_jobs
             WHERE collection_version = ?
               AND state = 'queued'
               AND next_run_at <= ?
             ORDER BY next_run_at ASC, created_at ASC
             LIMIT 1`,
        args: input.jobId
          ? [input.jobId, input.collectionVersion, now]
          : [input.collectionVersion, now],
      });
      const row = candidate.rows[0];
      if (!row) {
        await tx.rollback();
        return null;
      }
      const candidateJob = mapPublicScanJob(row as Record<string, unknown>);
      const leaseToken = randomUUID();
      const leaseExpiresAt = now + leaseMs;
      const claimed = await tx.execute({
        sql: `UPDATE public_scan_jobs
              SET state = 'running', lease_token = ?, lease_expires_at = ?, updated_at = ?
              WHERE id = ? AND collection_version = ? AND state = 'queued'`,
        args: [leaseToken, leaseExpiresAt, now, candidateJob.id, input.collectionVersion],
      });
      if (Number(claimed.rowsAffected ?? 0) !== 1) {
        throw new Error("public scan claim candidate changed inside write transaction");
      }
      const run = await tx.execute({
        sql: `UPDATE public_scan_runs
              SET state = 'running', updated_at = ?
              WHERE id = ? AND collection_version = ?`,
        args: [now, candidateJob.runId, input.collectionVersion],
      });
      if (Number(run.rowsAffected ?? 0) !== 1) {
        throw new Error("public scan run missing while claiming job");
      }
      await tx.commit();
      return {
        leaseToken,
        job: {
          ...candidateJob,
          state: "running",
          leaseToken,
          leaseExpiresAt,
          updatedAt: now,
        },
      };
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    throwPublicScanStorageFailure("claim_job", error);
  }
}

/**
 * Return a claimed job to the ready queue when the process-wide execution slot
 * is busy. The lease CAS prevents an old worker from releasing a newer claim;
 * attempt_count and next_run_at are deliberately untouched so Cron can claim it
 * immediately after capacity becomes available.
 */
export async function releasePublicScanJobClaim(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
}): Promise<boolean> {
  const db = requirePublicScanDb("release_claim");
  try {
    await ensureSchema(db);
    const now = Date.now();
    const tx = await db.transaction("write");
    try {
      const released = await tx.execute({
        sql: `UPDATE public_scan_jobs
              SET state = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE id = ? AND run_id = ? AND state = 'running' AND lease_token = ?`,
        args: [now, input.jobId, input.runId, input.leaseToken],
      });
      if (Number(released.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }
      const run = await tx.execute({
        sql: `UPDATE public_scan_runs
              SET state = 'queued', updated_at = ?
              WHERE id = ? AND state = 'running'`,
        args: [now, input.runId],
      });
      if (Number(run.rowsAffected ?? 0) !== 1) {
        throw new Error("public scan run missing while releasing claim");
      }
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    throwPublicScanStorageFailure("release_claim", error);
  }
}

/**
 * A database-backed, process-wide execution lease. Request-after work and
 * overlapping Cron invocations may land in different serverless instances, so
 * per-process mutexes and Redis-only locks are insufficient. The single slot
 * deliberately favors predictable GitHub quota use over throughput; each
 * worker invocation is short and continues through the queue.
 */
export async function acquirePublicScanExecutionLease(input: {
  jobId: string;
  leaseToken: string;
  leaseMs?: number;
}): Promise<number | null> {
  const db = requirePublicScanDb("acquire_execution_slot");
  try {
    await ensureSchema(db);
    const now = Date.now();
    const leaseExpiresAt = now + (input.leaseMs ?? 55_000);
    const tx = await db.transaction("write");
    try {
      const candidate = await tx.execute({
        sql: `SELECT slot, lease_expires_at
              FROM public_scan_execution_leases
              WHERE slot = 1
              LIMIT 1`,
        args: [],
      });
      const slot = candidate.rows[0]?.slot;
      if (typeof slot !== "number") {
        throw new Error("public scan execution slot is missing");
      }
      if (Number(candidate.rows[0]?.lease_expires_at ?? 0) > now) {
        await tx.rollback();
        return null;
      }
      const update = await tx.execute({
        sql: `UPDATE public_scan_execution_leases
              SET job_id = ?, lease_token = ?, lease_expires_at = ?
              WHERE slot = ? AND lease_expires_at <= ?`,
        args: [input.jobId, input.leaseToken, leaseExpiresAt, slot, now],
      });
      if (Number(update.rowsAffected ?? 0) !== 1) {
        throw new Error("public scan execution slot changed inside write transaction");
      }
      await tx.commit();
      return slot;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    throwPublicScanStorageFailure("acquire_execution_slot", error);
  }
}

export async function releasePublicScanExecutionLease(input: {
  slot: number;
  jobId: string;
  leaseToken: string;
}): Promise<void> {
  const db = requirePublicScanDb("release_execution_slot");
  try {
    await ensureSchema(db);
    await db.execute({
      sql: `UPDATE public_scan_execution_leases
            SET job_id = NULL, lease_token = NULL, lease_expires_at = 0
            WHERE slot = ? AND job_id = ? AND lease_token = ?`,
      args: [input.slot, input.jobId, input.leaseToken],
    });
  } catch (error) {
    throwPublicScanStorageFailure("release_execution_slot", error);
  }
}

/**
 * Atomically reserve a bounded operation in a wall-clock window. Unlike the
 * normal public request limiter, this remains fail-closed when Redis is down
 * because durable jobs run against the same shared Turso database.
 */
export async function acquirePublicScanRateWindow(input: {
  bucket: string;
  limit: number;
  windowMs: number;
}): Promise<{ granted: boolean; retryAt: number }> {
  const now = Date.now();
  const safeWindow = Math.max(1_000, Math.floor(input.windowMs));
  const startedAt = Math.floor(now / safeWindow) * safeWindow;
  const retryAt = startedAt + safeWindow;
  const db = requirePublicScanDb("acquire_rate_window");
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `INSERT INTO public_scan_rate_windows (bucket, window_started, count)
            VALUES (?, ?, 1)
            ON CONFLICT(bucket, window_started) DO UPDATE SET count = count + 1
              WHERE public_scan_rate_windows.count < ?`,
      args: [input.bucket, startedAt, Math.max(1, Math.floor(input.limit))],
    });
    // `rowsAffected` is 0 when a full existing window rejected the increment.
    return { granted: Number(result.rowsAffected ?? 0) === 1, retryAt };
  } catch (error) {
    throwPublicScanStorageFailure("acquire_rate_window", error);
  }
}

export interface PublicScanStepObservation {
  phase: PublicScanJobPhase;
  outcome: PublicScanStepOutcome;
  durationMs: number;
}

/** Persist aggregate-only worker observations; job and account IDs never enter this table. */
export async function recordPublicScanStepMetrics(input: {
  collectionVersion: string;
  observations: PublicScanStepObservation[];
}): Promise<boolean> {
  if (input.observations.length === 0) return true;
  const db = requirePublicScanDb("metrics_write");
  const aggregated = new Map<
    string,
    { phase: PublicScanJobPhase; outcome: PublicScanStepOutcome; count: number; total: number; max: number }
  >();
  for (const observation of input.observations) {
    const duration = Number.isFinite(observation.durationMs)
      ? Math.max(0, Math.floor(observation.durationMs))
      : 0;
    const key = `${observation.phase}\0${observation.outcome}`;
    const current = aggregated.get(key);
    if (current) {
      current.count += 1;
      current.total += duration;
      current.max = Math.max(current.max, duration);
    } else {
      aggregated.set(key, {
        phase: observation.phase,
        outcome: observation.outcome,
        count: 1,
        total: duration,
        max: duration,
      });
    }
  }
  try {
    await ensureSchema(db);
    const now = Date.now();
    const tx = await db.transaction("write");
    try {
      for (const metric of aggregated.values()) {
        await tx.execute({
          sql: `INSERT INTO public_scan_step_metrics
                  (collection_version, phase, outcome, step_count, total_duration_ms, max_duration_ms, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(collection_version, phase, outcome) DO UPDATE SET
                  step_count = public_scan_step_metrics.step_count + excluded.step_count,
                  total_duration_ms = public_scan_step_metrics.total_duration_ms + excluded.total_duration_ms,
                  max_duration_ms = MAX(public_scan_step_metrics.max_duration_ms, excluded.max_duration_ms),
                  updated_at = excluded.updated_at`,
          args: [
            input.collectionVersion,
            metric.phase,
            metric.outcome,
            metric.count,
            metric.total,
            metric.max,
            now,
          ],
        });
      }
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    throwPublicScanStorageFailure("metrics_write", error);
  }
}

export async function recordPublicScanCronMetrics(input: {
  startedAt: number;
  completedAt: number;
  processed: number;
  failedSteps: number;
  success: boolean;
}): Promise<boolean> {
  const db = requirePublicScanDb("cron_metrics_write");
  try {
    await ensureSchema(db);
    const durationMs = Math.max(0, Math.floor(input.completedAt - input.startedAt));
    const values = [
      1,
      input.startedAt,
      input.success ? input.completedAt : null,
      durationMs,
      Math.max(0, Math.floor(input.processed)),
      Math.max(0, Math.floor(input.failedSteps)),
      input.success ? 0 : 1,
      input.completedAt,
    ];
    await db.execute({
      sql: `INSERT INTO public_scan_cron_metrics
              (singleton, last_started_at, last_success_at, last_duration_ms,
               last_processed, last_failed_steps, consecutive_failures, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET
              last_started_at = excluded.last_started_at,
              last_success_at = CASE WHEN ? = 1
                                     THEN excluded.last_success_at
                                     ELSE public_scan_cron_metrics.last_success_at END,
              last_duration_ms = excluded.last_duration_ms,
              last_processed = excluded.last_processed,
              last_failed_steps = excluded.last_failed_steps,
              consecutive_failures = CASE WHEN ? = 1
                                          THEN 0
                                          ELSE public_scan_cron_metrics.consecutive_failures + 1 END,
              updated_at = excluded.updated_at`,
      args: [...values, input.success ? 1 : 0, input.success ? 1 : 0],
    });
    return true;
  } catch (error) {
    throwPublicScanStorageFailure("cron_metrics_write", error);
  }
}

export interface PublicScanOperationalMetrics {
  generatedAt: number;
  canonicalCollectionVersion: string;
  queue: {
    depth: number;
    queued: number;
    running: number;
    ready: number;
    deferred: number;
    retrying: number;
    oldestAgeMs: number | null;
    byPhase: Array<{ phase: string; queued: number; running: number }>;
  };
  failures: {
    currentFailedJobs: number;
    retryingSteps: number;
    terminalSteps: number;
  };
  execution: {
    activeSlots: number;
    capacity: number;
    contentionSteps: number;
  };
  obsoleteActiveJobs: number;
  steps: Array<{
    phase: string;
    outcome: PublicScanStepOutcome;
    count: number;
    averageDurationMs: number;
    maxDurationMs: number;
  }>;
  cron: {
    lastStartedAt: number | null;
    lastSuccessAt: number | null;
    lastDurationMs: number | null;
    lastProcessed: number;
    lastFailedSteps: number;
    consecutiveFailures: number;
  };
}

/** Aggregate operational state for the authenticated release-operations endpoint. */
export async function getPublicScanOperationalMetrics(
  canonicalCollectionVersion: string,
): Promise<PublicScanOperationalMetrics | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const now = Date.now();
    const [active, failureState, obsolete, slots, steps, cron] = await db.batch(
      [
        {
          sql: `SELECT state, phase, COUNT(*) AS count, MIN(created_at) AS oldest_created_at,
                       SUM(CASE WHEN state = 'queued' AND next_run_at <= ? THEN 1 ELSE 0 END) AS ready_count,
                       SUM(CASE WHEN state = 'queued' AND next_run_at > ? THEN 1 ELSE 0 END) AS deferred_count
                FROM public_scan_jobs
                WHERE collection_version = ? AND state IN ('queued', 'running')
                GROUP BY state, phase`,
          args: [now, now, canonicalCollectionVersion],
        },
        {
          sql: `SELECT
                  SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed_jobs,
                  SUM(CASE WHEN state = 'queued' AND attempt_count > 0 THEN 1 ELSE 0 END) AS retrying_jobs
                FROM public_scan_jobs
                WHERE collection_version = ?`,
          args: [canonicalCollectionVersion],
        },
        {
          sql: `SELECT COUNT(*) AS count
                FROM public_scan_jobs
                WHERE collection_version <> ? AND state IN ('queued', 'running')`,
          args: [canonicalCollectionVersion],
        },
        {
          sql: `SELECT COUNT(*) AS count
                FROM public_scan_execution_leases
                WHERE lease_expires_at > ?`,
          args: [now],
        },
        {
          sql: `SELECT phase, outcome, step_count, total_duration_ms, max_duration_ms
                FROM public_scan_step_metrics
                WHERE collection_version = ?
                ORDER BY phase, outcome`,
          args: [canonicalCollectionVersion],
        },
        {
          sql: `SELECT last_started_at, last_success_at, last_duration_ms, last_processed,
                       last_failed_steps, consecutive_failures
                FROM public_scan_cron_metrics
                WHERE singleton = 1`,
          args: [],
        },
      ],
      "read",
    );
    const phases = new Map<string, { phase: string; queued: number; running: number }>();
    let queued = 0;
    let running = 0;
    let ready = 0;
    let deferred = 0;
    let oldestCreatedAt: number | null = null;
    for (const row of active.rows) {
      const phase = String(row.phase);
      const count = Number(row.count ?? 0);
      const item = phases.get(phase) ?? { phase, queued: 0, running: 0 };
      if (row.state === "queued") {
        item.queued += count;
        queued += count;
        ready += Number(row.ready_count ?? 0);
        deferred += Number(row.deferred_count ?? 0);
      } else if (row.state === "running") {
        item.running += count;
        running += count;
      }
      phases.set(phase, item);
      const candidate = Number(row.oldest_created_at);
      if (Number.isFinite(candidate)) {
        oldestCreatedAt = oldestCreatedAt === null ? candidate : Math.min(oldestCreatedAt, candidate);
      }
    }
    const stepMetrics = steps.rows.map((row) => {
      const count = Math.max(0, Number(row.step_count ?? 0));
      const total = Math.max(0, Number(row.total_duration_ms ?? 0));
      return {
        phase: String(row.phase),
        outcome: String(row.outcome) as PublicScanStepOutcome,
        count,
        averageDurationMs: count > 0 ? Math.round(total / count) : 0,
        maxDurationMs: Math.max(0, Number(row.max_duration_ms ?? 0)),
      };
    });
    const countOutcome = (outcome: PublicScanStepOutcome) =>
      stepMetrics
        .filter((metric) => metric.outcome === outcome)
        .reduce((total, metric) => total + metric.count, 0);
    const failureRow = failureState.rows[0];
    const cronRow = cron.rows[0];
    return {
      generatedAt: now,
      canonicalCollectionVersion,
      queue: {
        depth: queued + running,
        queued,
        running,
        ready,
        deferred,
        retrying: Number(failureRow?.retrying_jobs ?? 0),
        oldestAgeMs: oldestCreatedAt === null ? null : Math.max(0, now - oldestCreatedAt),
        byPhase: [...phases.values()].sort((left, right) => left.phase.localeCompare(right.phase)),
      },
      failures: {
        currentFailedJobs: Number(failureRow?.failed_jobs ?? 0),
        retryingSteps: countOutcome("failed_retrying"),
        terminalSteps: countOutcome("failed_terminal"),
      },
      execution: {
        activeSlots: Number(slots.rows[0]?.count ?? 0),
        capacity: 1,
        contentionSteps: countOutcome("slot_busy"),
      },
      obsoleteActiveJobs: Number(obsolete.rows[0]?.count ?? 0),
      steps: stepMetrics,
      cron: {
        lastStartedAt: cronRow?.last_started_at == null ? null : Number(cronRow.last_started_at),
        lastSuccessAt: cronRow?.last_success_at == null ? null : Number(cronRow.last_success_at),
        lastDurationMs: cronRow?.last_duration_ms == null ? null : Number(cronRow.last_duration_ms),
        lastProcessed: Number(cronRow?.last_processed ?? 0),
        lastFailedSteps: Number(cronRow?.last_failed_steps ?? 0),
        consecutiveFailures: Number(cronRow?.consecutive_failures ?? 0),
      },
    };
  } catch {
    console.error("public_scan.metrics_read_failed");
    return null;
  }
}

export async function savePublicScanJobProgress(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
  phase: PublicScanJobPhase;
  payload: string;
  sourceStatus?: PublicScanSourceStatus;
  nextRunAt?: number;
}): Promise<boolean> {
  const db = requirePublicScanDb("save_job_progress");
  try {
    await ensureSchema(db);
    const now = Date.now();
    const nextRunAt = input.nextRunAt ?? now;
    const tx = await db.transaction("write");
    try {
      const update = await tx.execute({
        sql: `UPDATE public_scan_jobs
              SET state = 'queued', phase = ?, payload = ?, next_run_at = ?,
                  lease_token = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE id = ? AND run_id = ? AND state = 'running' AND lease_token = ?
                AND lease_expires_at > ?`,
        args: [
          input.phase,
          input.payload,
          nextRunAt,
          now,
          input.jobId,
          input.runId,
          input.leaseToken,
          now,
        ],
      });
      if (Number(update.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }
      if (input.sourceStatus) {
        const run = await tx.execute({
          sql: `UPDATE public_scan_runs SET source_status = ?, updated_at = ? WHERE id = ?`,
          args: [JSON.stringify(input.sourceStatus), now, input.runId],
        });
        if (Number(run.rowsAffected ?? 0) !== 1) {
          throw new Error("public scan run missing while saving progress");
        }
      }
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    throwPublicScanStorageFailure("save_job_progress", error);
  }
}

export async function savePublicScanQuickResult(input: {
  runId: string;
  leaseToken: string;
  jobId: string;
  quickScan: string;
  sourceStatus: PublicScanSourceStatus;
}): Promise<boolean> {
  const db = requirePublicScanDb("save_quick_result");
  try {
    await ensureSchema(db);
    const tx = await db.transaction("write");
    try {
      const now = Date.now();
      const job = await tx.execute({
        sql: `SELECT id FROM public_scan_jobs
              WHERE id = ? AND run_id = ? AND state = 'running' AND lease_token = ?
                AND lease_expires_at > ?`,
        args: [input.jobId, input.runId, input.leaseToken, now],
      });
      if (!job.rows[0]) {
        await tx.rollback();
        return false;
      }
      const run = await tx.execute({
        sql: `UPDATE public_scan_runs
              SET quick_scan = ?, source_status = ?, updated_at = ?, last_error = NULL
              WHERE id = ?`,
        args: [input.quickScan, JSON.stringify(input.sourceStatus), now, input.runId],
      });
      if (Number(run.rowsAffected ?? 0) !== 1) {
        throw new Error("public scan run missing while saving quick result");
      }
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    throwPublicScanStorageFailure("save_quick_result", error);
  }
}

/**
 * Reuse the bounded synchronous probe that already established a high-history
 * account needs durable collection. This avoids paying GitHub twice before the
 * queued job starts; only an untouched `quick` job can be seeded.
 */
export async function seedPublicScanQuickResult(input: {
  jobId: string;
  runId: string;
  quickScan: string;
  sourceStatus: PublicScanSourceStatus;
}): Promise<boolean> {
  const db = getClient();
  if (!db) return false;
  try {
    await ensureSchema(db);
    const tx = await db.transaction("write");
    try {
      const now = Date.now();
      const job = await tx.execute({
        sql: `UPDATE public_scan_jobs
              SET phase = 'original_repos', payload = '{"page":1}', updated_at = ?
              WHERE id = ? AND run_id = ? AND state = 'queued' AND phase = 'quick'`,
        args: [now, input.jobId, input.runId],
      });
      if (Number(job.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }
      await tx.execute({
        sql: `UPDATE public_scan_runs
              SET quick_scan = ?, source_status = ?, updated_at = ?, last_error = NULL
              WHERE id = ?`,
        args: [input.quickScan, JSON.stringify(input.sourceStatus), now, input.runId],
      });
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    logPublicScanDbFailure("seed_quick_result", error);
    return false;
  }
}

export async function completePublicScanRun(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
  coverage: PublicScanCoverage;
  sourceStatus: PublicScanSourceStatus;
  snapshot: string;
  snapshotHash: string;
}): Promise<boolean> {
  if (
    input.coverage !== "complete_public" ||
    !input.snapshotHash ||
    createHash("sha256").update(input.snapshot).digest("hex") !== input.snapshotHash ||
    !hasCompletePublicScanSources(input.sourceStatus)
  ) {
    return false;
  }
  const db = requirePublicScanDb("complete_run");
  try {
    await ensureSchema(db);
    const tx = await db.transaction("write");
    try {
      const job = await tx.execute({
        sql: `SELECT j.id, j.username, j.score_version, j.collection_version,
                     r.username AS run_username, r.score_version AS run_score_version,
                     r.collection_version AS run_collection_version,
                     r.started_at AS run_started_at
              FROM public_scan_jobs j
              JOIN public_scan_runs r ON r.id = j.run_id
              WHERE j.id = ? AND j.run_id = ? AND j.state = 'running'
                AND j.lease_token = ? AND j.lease_expires_at > ?
                AND r.state = 'running'`,
        args: [input.jobId, input.runId, input.leaseToken, Date.now()],
      });
      const jobRow = job.rows[0] as Record<string, unknown> | undefined;
      if (
        !jobRow ||
        jobRow.username !== jobRow.run_username ||
        jobRow.score_version !== jobRow.run_score_version ||
        jobRow.collection_version !== jobRow.run_collection_version
      ) {
        await tx.rollback();
        return false;
      }

      const isCanonical =
        jobRow.score_version === SCORE_CACHE_VERSION &&
        jobRow.collection_version === PUBLIC_SCAN_COLLECTION_VERSION;
      if (isCanonical) {
        const materialized = materializeCanonicalScore({
          snapshot: input.snapshot,
          snapshotHash: input.snapshotHash,
          username: String(jobRow.username),
          scoreVersion: String(jobRow.score_version),
          collectionVersion: String(jobRow.collection_version),
          scannedAt: Number(jobRow.run_started_at),
          mode: "durable",
          sourceStatus: input.sourceStatus,
        });
        if (!materialized) {
          await tx.rollback();
          return false;
        }
        // A newer canonical score may win while this older run still completes
        // as immutable historical evidence. Invalid state throws and rolls the
        // whole completion back.
        await upsertCanonicalScoreTx(tx, materialized);
      }

      const now = Date.now();
      await tx.execute({
        sql: `UPDATE public_scan_runs
              SET state = ?, coverage = ?, source_status = ?, snapshot = ?, snapshot_hash = ?,
                  completed_at = ?, updated_at = ?, last_error = NULL
              WHERE id = ?`,
        args: [
          "complete_public" satisfies PublicScanRunState,
          input.coverage,
          JSON.stringify(input.sourceStatus),
          input.snapshot,
          input.snapshotHash,
          now,
          now,
          input.runId,
        ],
      });
      await tx.execute({
        sql: `UPDATE public_scan_jobs
              SET state = 'complete', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE id = ?`,
        args: [now, input.jobId],
      });
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    throwPublicScanStorageFailure("complete_run", error);
  }
}

export async function failPublicScanJob(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
  error: string;
  retryAt?: number;
}): Promise<boolean> {
  const db = requirePublicScanDb("fail_job");
  try {
    await ensureSchema(db);
    const now = Date.now();
    const retry = input.retryAt != null;
    const tx = await db.transaction("write");
    try {
      const update = await tx.execute({
        sql: `UPDATE public_scan_jobs
              SET state = ?, attempt_count = attempt_count + 1, next_run_at = ?,
                  lease_token = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE id = ? AND run_id = ? AND state = 'running' AND lease_token = ?
                AND lease_expires_at > ?`,
        args: [
          retry ? "queued" : "failed",
          input.retryAt ?? now,
          now,
          input.jobId,
          input.runId,
          input.leaseToken,
          now,
        ],
      });
      if (Number(update.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }
      const run = await tx.execute({
        sql: `UPDATE public_scan_runs
              SET state = ?, updated_at = ?, last_error = ? WHERE id = ?`,
        args: [retry ? "queued" : "failed", now, input.error.slice(0, 2_000), input.runId],
      });
      if (Number(run.rowsAffected ?? 0) !== 1) {
        throw new Error("public scan run missing while recording failure");
      }
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    throwPublicScanStorageFailure("fail_job", error);
  }
}

async function hasPublicScanLease(
  db: Client,
  input: { jobId: string; runId: string; leaseToken: string },
): Promise<boolean> {
  const job = await db.execute({
    sql: `SELECT id FROM public_scan_jobs
          WHERE id = ? AND run_id = ? AND state = 'running' AND lease_token = ?
            AND lease_expires_at > ?`,
    args: [input.jobId, input.runId, input.leaseToken, Date.now()],
  });
  return Boolean(job.rows[0]);
}

/**
 * Upsert one page of facts behind the active database lease. Pages can be
 * delivered more than once by the queue; `(run_id, pull_request_id)` makes that
 * replay idempotent without deleting already-collected history.
 */
export async function upsertPublicScanPrFacts(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
  facts: PublicScanPrFact[];
}): Promise<boolean> {
  if (input.facts.length === 0) return true;
  const db = requirePublicScanDb("upsert_pr_facts");
  try {
    await ensureSchema(db);
    if (!(await hasPublicScanLease(db, input))) return false;
    await db.batch(
      input.facts.map((fact) => ({
        sql: `INSERT INTO public_scan_pr_facts
                (run_id, pull_request_id, source, repo_key, owner_login, stars, is_private,
                 is_fork, created_at, merged_at, closed_at, title, additions, deletions,
                 changed_files, labels)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(run_id, pull_request_id) DO UPDATE SET
                source        = excluded.source,
                repo_key      = excluded.repo_key,
                owner_login   = excluded.owner_login,
                stars         = MAX(public_scan_pr_facts.stars, excluded.stars),
                is_private    = excluded.is_private,
                is_fork       = excluded.is_fork,
                created_at    = COALESCE(excluded.created_at, public_scan_pr_facts.created_at),
                merged_at     = COALESCE(excluded.merged_at, public_scan_pr_facts.merged_at),
                closed_at     = COALESCE(excluded.closed_at, public_scan_pr_facts.closed_at),
                title         = COALESCE(excluded.title, public_scan_pr_facts.title),
                additions     = COALESCE(excluded.additions, public_scan_pr_facts.additions),
                deletions     = COALESCE(excluded.deletions, public_scan_pr_facts.deletions),
                changed_files = COALESCE(excluded.changed_files, public_scan_pr_facts.changed_files),
                labels        = excluded.labels`,
        args: [
          input.runId,
          fact.pullRequestId,
          fact.source,
          fact.repoKey,
          fact.ownerLogin,
          Math.max(0, Math.round(fact.stars)),
          fact.isPrivate ? 1 : 0,
          fact.isFork ? 1 : 0,
          fact.createdAt,
          fact.mergedAt,
          fact.closedAt,
          fact.title,
          fact.additions,
          fact.deletions,
          fact.changedFiles,
          JSON.stringify(fact.labels),
        ] as (string | number | null)[],
      })),
      "write",
    );
    return true;
  } catch (error) {
    throwPublicScanStorageFailure("upsert_pr_facts", error);
  }
}

/** Same idempotent, lease-guarded persistence contract for commit aggregates. */
export async function upsertPublicScanCommitRepoFacts(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
  facts: PublicScanCommitRepoFact[];
}): Promise<boolean> {
  if (input.facts.length === 0) return true;
  const db = requirePublicScanDb("upsert_commit_repo_facts");
  try {
    await ensureSchema(db);
    if (!(await hasPublicScanLease(db, input))) return false;
    await db.batch(
      input.facts.map((fact) => ({
        sql: `INSERT INTO public_scan_commit_repo_facts
                (run_id, repo_key, owner_login, stars, is_private, is_fork, commits,
                 first_committed_at, last_committed_at, active_years, source, evidence_shas)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(run_id, repo_key) DO UPDATE SET
                owner_login        = COALESCE(excluded.owner_login, public_scan_commit_repo_facts.owner_login),
                stars              = MAX(public_scan_commit_repo_facts.stars, excluded.stars),
                is_private         = MAX(public_scan_commit_repo_facts.is_private, excluded.is_private),
                is_fork            = MAX(public_scan_commit_repo_facts.is_fork, excluded.is_fork),
                commits            = MAX(public_scan_commit_repo_facts.commits, excluded.commits),
                active_years       = MAX(public_scan_commit_repo_facts.active_years, excluded.active_years),
                first_committed_at = CASE
                  WHEN public_scan_commit_repo_facts.first_committed_at IS NULL THEN excluded.first_committed_at
                  WHEN excluded.first_committed_at IS NULL THEN public_scan_commit_repo_facts.first_committed_at
                  ELSE MIN(public_scan_commit_repo_facts.first_committed_at, excluded.first_committed_at)
                END,
                last_committed_at = CASE
                  WHEN public_scan_commit_repo_facts.last_committed_at IS NULL THEN excluded.last_committed_at
                  WHEN excluded.last_committed_at IS NULL THEN public_scan_commit_repo_facts.last_committed_at
                  ELSE MAX(public_scan_commit_repo_facts.last_committed_at, excluded.last_committed_at)
                END,
                source        = excluded.source,
                evidence_shas = excluded.evidence_shas`,
        args: [
          input.runId,
          fact.repoKey,
          fact.ownerLogin,
          Math.max(0, Math.round(fact.stars)),
          fact.isPrivate ? 1 : 0,
          fact.isFork ? 1 : 0,
          Math.max(0, Math.round(fact.commits)),
          fact.firstCommittedAt,
          fact.lastCommittedAt,
          Math.max(0, Math.round(fact.activeYears)),
          fact.source,
          JSON.stringify(fact.evidenceShas.slice(0, 20)),
        ] as (string | number | null)[],
      })),
      "write",
    );
    return true;
  } catch (error) {
    throwPublicScanStorageFailure("upsert_commit_repo_facts", error);
  }
}

export async function upsertPublicScanCommitCandidates(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
  candidates: PublicScanCommitCandidate[];
}): Promise<boolean> {
  if (input.candidates.length === 0) return true;
  const db = requirePublicScanDb("upsert_commit_candidates");
  try {
    await ensureSchema(db);
    if (!(await hasPublicScanLease(db, input))) return false;
    await db.batch(
      input.candidates.map((candidate) => ({
        sql: `INSERT INTO public_scan_commit_candidates
                (run_id, sha, repo_key, owner_login, stars, is_private, is_fork, authored_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(run_id, sha, repo_key) DO UPDATE SET
                owner_login = COALESCE(excluded.owner_login, public_scan_commit_candidates.owner_login),
                stars       = MAX(public_scan_commit_candidates.stars, excluded.stars),
                is_private  = MAX(public_scan_commit_candidates.is_private, excluded.is_private),
                is_fork     = MAX(public_scan_commit_candidates.is_fork, excluded.is_fork),
                authored_at = COALESCE(excluded.authored_at, public_scan_commit_candidates.authored_at)`,
        args: [
          input.runId,
          candidate.sha,
          candidate.repoKey,
          candidate.ownerLogin,
          Math.max(0, Math.round(candidate.stars)),
          candidate.isPrivate ? 1 : 0,
          candidate.isFork ? 1 : 0,
          candidate.authoredAt,
        ] as (string | number | null)[],
      })),
      "write",
    );
    return true;
  } catch (error) {
    throwPublicScanStorageFailure("upsert_commit_candidates", error);
  }
}

export async function upsertPublicScanOwnedRepoFacts(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
  facts: PublicScanOwnedRepoFact[];
}): Promise<boolean> {
  if (input.facts.length === 0) return true;
  const db = requirePublicScanDb("upsert_owned_repo_facts");
  try {
    await ensureSchema(db);
    if (!(await hasPublicScanLease(db, input))) return false;
    await db.batch(
      input.facts.map((fact) => ({
        sql: `INSERT INTO public_scan_owned_repo_facts
                (run_id, repo_key, name, owner_login, stars, forks, open_issues,
                 size, language, description, pushed_at, topics)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(run_id, repo_key) DO UPDATE SET
                name        = excluded.name,
                owner_login = COALESCE(excluded.owner_login, public_scan_owned_repo_facts.owner_login),
                stars       = MAX(public_scan_owned_repo_facts.stars, excluded.stars),
                forks       = MAX(public_scan_owned_repo_facts.forks, excluded.forks),
                open_issues = MAX(public_scan_owned_repo_facts.open_issues, excluded.open_issues),
                size        = MAX(public_scan_owned_repo_facts.size, excluded.size),
                language    = COALESCE(excluded.language, public_scan_owned_repo_facts.language),
                description = COALESCE(excluded.description, public_scan_owned_repo_facts.description),
                pushed_at   = COALESCE(excluded.pushed_at, public_scan_owned_repo_facts.pushed_at),
                topics      = excluded.topics`,
        args: [
          input.runId,
          fact.repoKey,
          fact.name,
          fact.ownerLogin,
          Math.max(0, Math.round(fact.stars)),
          Math.max(0, Math.round(fact.forks)),
          Math.max(0, Math.round(fact.openIssues)),
          Math.max(0, Math.round(fact.size)),
          fact.language,
          fact.description,
          fact.pushedAt,
          JSON.stringify(fact.topics),
        ] as (string | number | null)[],
      })),
      "write",
    );
    return true;
  } catch (error) {
    throwPublicScanStorageFailure("upsert_owned_repo_facts", error);
  }
}

export async function getPublicScanOwnedRepoFacts(runId: string): Promise<PublicScanOwnedRepoFact[]> {
  const db = requirePublicScanDb("get_owned_repo_facts");
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT * FROM public_scan_owned_repo_facts
            WHERE run_id = ? ORDER BY stars DESC, size DESC, repo_key ASC`,
      args: [runId],
    });
    return result.rows.map((row) => {
      const value = row as Record<string, unknown>;
      let topics: string[] = [];
      if (typeof value.topics === "string") {
        try {
          const parsed = JSON.parse(value.topics);
          if (Array.isArray(parsed)) {
            topics = parsed.filter((topic): topic is string => typeof topic === "string");
          }
        } catch {
          // A malformed historic row is non-fatal; retain the repo facts.
        }
      }
      return {
        repoKey: String(value.repo_key),
        name: String(value.name),
        ownerLogin: typeof value.owner_login === "string" ? value.owner_login : null,
        stars: Number(value.stars) || 0,
        forks: Number(value.forks) || 0,
        openIssues: Number(value.open_issues) || 0,
        size: Number(value.size) || 0,
        language: typeof value.language === "string" ? value.language : null,
        description: typeof value.description === "string" ? value.description : null,
        pushedAt: typeof value.pushed_at === "string" ? value.pushed_at : null,
        topics,
      };
    });
  } catch (error) {
    throwPublicScanStorageFailure("get_owned_repo_facts", error);
  }
}

/** Seed default-branch verification from the discovered public candidate set. */
export async function preparePublicScanCommitVerificationWork(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
}): Promise<boolean> {
  const db = requirePublicScanDb("prepare_commit_verification");
  try {
    await ensureSchema(db);
    if (!(await hasPublicScanLease(db, input))) return false;
    await db.execute({
      sql: `INSERT OR IGNORE INTO public_scan_commit_verification_work
              (run_id, repo_key, range_from, range_to, owner_login, stars, is_private, is_fork, state)
            SELECT run_id,
                   repo_key,
                   MIN(authored_at),
                   MAX(authored_at),
                   MAX(owner_login),
                   MAX(stars),
                   MAX(is_private),
                   MAX(is_fork),
                   'queued'
            FROM public_scan_commit_candidates
            WHERE run_id = ? AND authored_at IS NOT NULL
            GROUP BY run_id, repo_key`,
      args: [input.runId],
    });
    return true;
  } catch (error) {
    throwPublicScanStorageFailure("prepare_commit_verification", error);
  }
}

function parseEvidenceShas(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((sha): sha is string => typeof sha === "string").slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function parseActiveYears(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.from(
      new Set(
        Array.isArray(parsed)
          ? parsed
              .map((year) => Number(year))
              .filter((year) => Number.isInteger(year) && year >= 1970 && year <= 3000)
          : [],
      ),
    ).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function mapPublicScanCommitVerificationWork(
  row: Record<string, unknown>,
): PublicScanCommitVerificationWork {
  return {
    runId: String(row.run_id),
    repoKey: String(row.repo_key),
    ownerLogin: typeof row.owner_login === "string" ? row.owner_login : null,
    stars: Number(row.stars) || 0,
    isPrivate: Number(row.is_private) === 1,
    isFork: Number(row.is_fork) === 1,
    from: String(row.range_from),
    to: String(row.range_to),
    page: Number(row.page) || 1,
    state: String(row.state) as PublicScanCommitVerificationWork["state"],
    commitCount: Number(row.commit_count) || 0,
    firstCommittedAt:
      typeof row.first_committed_at === "string" ? row.first_committed_at : null,
    lastCommittedAt: typeof row.last_committed_at === "string" ? row.last_committed_at : null,
    activeYears: parseActiveYears(row.active_years),
    evidenceShas: parseEvidenceShas(row.evidence_shas),
  };
}

export async function getNextPublicScanCommitVerificationWork(
  runId: string,
): Promise<PublicScanCommitVerificationWork | null> {
  const db = requirePublicScanDb("get_commit_verification");
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT * FROM public_scan_commit_verification_work
            WHERE run_id = ? AND state = 'queued'
            ORDER BY repo_key, range_from
            LIMIT 1`,
      args: [runId],
    });
    return result.rows[0]
      ? mapPublicScanCommitVerificationWork(result.rows[0] as Record<string, unknown>)
      : null;
  } catch (error) {
    throwPublicScanStorageFailure("get_commit_verification", error);
  }
}

/**
 * Record a page exactly once by comparing the expected page number. If a
 * request-after task or Cron invocation retries after a successful write, the
 * worker reads the advanced page instead of adding the same commits twice.
 */
export async function recordPublicScanCommitVerificationPage(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
  work: PublicScanCommitVerificationWork;
  commits: { sha: string; committedAt: string | null }[];
  complete: boolean;
}): Promise<boolean> {
  const db = requirePublicScanDb("record_commit_verification");
  try {
    await ensureSchema(db);
    if (!(await hasPublicScanLease(db, input))) return false;
    const existingEvidence = input.work.evidenceShas;
    const incomingEvidence = input.commits.map((commit) => commit.sha).filter(Boolean);
    const evidence = [...new Set([...existingEvidence, ...incomingEvidence])].slice(0, 20);
    const dates = input.commits
      .map((commit) => commit.committedAt)
      .filter((date): date is string => Boolean(date));
    const activeYears = Array.from(
      new Set([
        ...input.work.activeYears,
        ...dates
          .map((date) => Number.parseInt(date.slice(0, 4), 10))
          .filter((year) => Number.isInteger(year) && year >= 1970 && year <= 3000),
      ]),
    ).sort((a, b) => a - b);
    const first = dates.length ? [...dates].sort()[0] : input.work.firstCommittedAt;
    const last = dates.length ? [...dates].sort().at(-1)! : input.work.lastCommittedAt;
    const update = await db.execute({
      sql: `UPDATE public_scan_commit_verification_work
            SET state = ?, page = ?, commit_count = commit_count + ?,
                first_committed_at = CASE
                  WHEN first_committed_at IS NULL THEN ?
                  WHEN ? IS NULL THEN first_committed_at
                  ELSE MIN(first_committed_at, ?)
                END,
                last_committed_at = CASE
                  WHEN last_committed_at IS NULL THEN ?
                  WHEN ? IS NULL THEN last_committed_at
                  ELSE MAX(last_committed_at, ?)
                END,
                active_years = ?,
                evidence_shas = ?
            WHERE run_id = ? AND repo_key = ? AND range_from = ? AND range_to = ?
              AND state = 'queued' AND page = ?`,
      args: [
        input.complete ? "complete" : "queued",
        input.complete ? input.work.page : input.work.page + 1,
        input.commits.length,
        first,
        first,
        first,
        last,
        last,
        last,
        JSON.stringify(activeYears),
        JSON.stringify(evidence),
        input.runId,
        input.work.repoKey,
        input.work.from,
        input.work.to,
        input.work.page,
      ],
    });
    return Number(update.rowsAffected ?? 0) === 1;
  } catch (error) {
    throwPublicScanStorageFailure("record_commit_verification", error);
  }
}

export async function splitPublicScanCommitVerificationWork(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
  work: PublicScanCommitVerificationWork;
  left: { from: string; to: string };
  right: { from: string; to: string };
}): Promise<boolean> {
  const db = requirePublicScanDb("split_commit_verification");
  try {
    await ensureSchema(db);
    if (!(await hasPublicScanLease(db, input))) return false;
    const tx = await db.transaction("write");
    try {
      const update = await tx.execute({
        sql: `UPDATE public_scan_commit_verification_work
              SET state = 'superseded'
              WHERE run_id = ? AND repo_key = ? AND range_from = ? AND range_to = ?
                AND state = 'queued' AND page = ?`,
        args: [input.runId, input.work.repoKey, input.work.from, input.work.to, input.work.page],
      });
      if (Number(update.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }
      await tx.batch(
        [input.left, input.right].map((range) => ({
          sql: `INSERT OR IGNORE INTO public_scan_commit_verification_work
                  (run_id, repo_key, range_from, range_to, owner_login, stars, is_private, is_fork, state)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
          args: [
            input.runId,
            input.work.repoKey,
            range.from,
            range.to,
            input.work.ownerLogin,
            input.work.stars,
            input.work.isPrivate ? 1 : 0,
            input.work.isFork ? 1 : 0,
          ] as (string | number | null)[],
        })),
      );
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (error) {
    throwPublicScanStorageFailure("split_commit_verification", error);
  }
}

/** Materialize verified default-branch work only after every range is complete. */
export async function materializePublicScanCommitRepoFacts(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
}): Promise<boolean> {
  const db = requirePublicScanDb("materialize_commit_facts");
  try {
    await ensureSchema(db);
    if (!(await hasPublicScanLease(db, input))) return false;
    const unfinished = await db.execute({
      sql: `SELECT 1 FROM public_scan_commit_verification_work
            WHERE run_id = ? AND state = 'queued' LIMIT 1`,
      args: [input.runId],
    });
    if (unfinished.rows[0]) return false;
    await db.execute({
      sql: `INSERT INTO public_scan_commit_repo_facts
              (run_id, repo_key, owner_login, stars, is_private, is_fork, commits, active_years,
               first_committed_at, last_committed_at, source, evidence_shas)
            SELECT run_id,
                   repo_key,
                   MAX(owner_login),
                   MAX(stars),
                   MAX(is_private),
                   MAX(is_fork),
                   SUM(commit_count),
                   (SELECT COUNT(DISTINCT years.value)
                    FROM public_scan_commit_verification_work AS year_rows,
                         json_each(year_rows.active_years) AS years
                    WHERE year_rows.run_id = public_scan_commit_verification_work.run_id
                      AND year_rows.repo_key = public_scan_commit_verification_work.repo_key
                      AND year_rows.state = 'complete'),
                   MIN(first_committed_at),
                   MAX(last_committed_at),
                   'default_branch_rest',
                   MAX(evidence_shas)
            FROM public_scan_commit_verification_work
            WHERE run_id = ? AND state = 'complete'
            GROUP BY run_id, repo_key
            ON CONFLICT(run_id, repo_key) DO UPDATE SET
              owner_login        = excluded.owner_login,
              stars              = excluded.stars,
              is_private         = MAX(public_scan_commit_repo_facts.is_private, excluded.is_private),
              is_fork            = MAX(public_scan_commit_repo_facts.is_fork, excluded.is_fork),
              commits            = excluded.commits,
              active_years       = excluded.active_years,
              first_committed_at = excluded.first_committed_at,
              last_committed_at  = excluded.last_committed_at,
              source             = excluded.source,
              evidence_shas      = excluded.evidence_shas`,
      args: [input.runId],
    });
    return true;
  } catch (error) {
    throwPublicScanStorageFailure("materialize_commit_facts", error);
  }
}

export interface PublicScanContributionAggregate {
  repo: string;
  stars: number;
  isPrivate: boolean;
  isFork: boolean;
  ownerLogin: string;
  commits: number;
  prs: number;
  activeYears: number;
}

export interface PublicScanPrSummary {
  nativeMergedPrs: number;
  workflowLandedPrs: number;
  workflowLandedImpactPrs: number;
}

export async function getPublicScanPrSummary(
  runId: string,
  username: string,
): Promise<PublicScanPrSummary> {
  const db = requirePublicScanDb("get_pr_summary");
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT
              SUM(CASE WHEN source = 'native_merged' THEN 1 ELSE 0 END) AS native_merged_prs,
              SUM(CASE WHEN source = 'workflow_landed' THEN 1 ELSE 0 END) AS workflow_landed_prs,
              SUM(CASE
                WHEN source = 'workflow_landed'
                 AND ((lower(COALESCE(owner_login, '')) = lower(?) AND stars >= 1000)
                      OR (lower(COALESCE(owner_login, '')) <> lower(?) AND stars >= 200))
                THEN 1 ELSE 0 END) AS workflow_landed_impact_prs
            FROM public_scan_pr_facts
            WHERE run_id = ?`,
      args: [username, username, runId],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return {
      nativeMergedPrs: Number(row?.native_merged_prs) || 0,
      workflowLandedPrs: Number(row?.workflow_landed_prs) || 0,
      workflowLandedImpactPrs: Number(row?.workflow_landed_impact_prs) || 0,
    };
  } catch (error) {
    throwPublicScanStorageFailure("get_pr_summary", error);
  }
}

export async function getPublicScanSignaturePrFacts(runId: string): Promise<PublicScanPrFact[]> {
  const db = requirePublicScanDb("get_signature_pr_facts");
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT pull_request_id, source, repo_key, owner_login, stars,
                   is_private, is_fork, created_at, merged_at, closed_at,
                   title, additions, deletions, changed_files, labels
            FROM public_scan_pr_facts
            WHERE run_id = ?
              AND (
                source IN ('native_merged', 'workflow_landed')
                OR (source = 'closed' AND lower(COALESCE(labels, '')) LIKE '%"merged"%')
              )
              AND repo_key IS NOT NULL
            ORDER BY COALESCE(merged_at, closed_at, created_at) DESC`,
      args: [runId],
    });
    return result.rows.map((row) => {
      const value = row as Record<string, unknown>;
      let labels: string[] = [];
      if (typeof value.labels === "string" && value.labels) {
        try {
          const parsed = JSON.parse(value.labels) as unknown;
          labels = Array.isArray(parsed)
            ? parsed.filter((label): label is string => typeof label === "string")
            : [];
        } catch {
          labels = [];
        }
      }
      return {
        pullRequestId: String(value.pull_request_id),
        source:
          value.source === "workflow_landed"
            ? "workflow_landed"
            : value.source === "closed"
              ? "closed"
              : "native_merged",
        repoKey: typeof value.repo_key === "string" ? value.repo_key : null,
        ownerLogin: typeof value.owner_login === "string" ? value.owner_login : null,
        stars: Number(value.stars) || 0,
        isPrivate: Number(value.is_private) === 1,
        isFork: Number(value.is_fork) === 1,
        createdAt: typeof value.created_at === "string" ? value.created_at : null,
        mergedAt: typeof value.merged_at === "string" ? value.merged_at : null,
        closedAt: typeof value.closed_at === "string" ? value.closed_at : null,
        title: typeof value.title === "string" ? value.title : null,
        additions: value.additions == null ? null : Number(value.additions),
        deletions: value.deletions == null ? null : Number(value.deletions),
        changedFiles: value.changed_files == null ? null : Number(value.changed_files),
        labels,
      };
    });
  } catch (error) {
    throwPublicScanStorageFailure("get_signature_pr_facts", error);
  }
}

/**
 * Aggregate durable PR and commit facts into the exact per-repository shape the
 * existing impact scorer consumes. The scorer remains unchanged; only its input
 * becomes complete once all collection phases have finished.
 */
export async function getPublicScanContributionAggregates(
  runId: string,
): Promise<PublicScanContributionAggregate[]> {
  const db = requirePublicScanDb("get_contribution_aggregates");
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `WITH pr AS (
              SELECT repo_key,
                     MAX(owner_login) AS owner_login,
                     MAX(stars) AS stars,
                     MAX(is_private) AS is_private,
                     MAX(is_fork) AS is_fork,
                     COUNT(*) AS prs,
                     COUNT(DISTINCT substr(COALESCE(merged_at, closed_at, created_at), 1, 4)) AS active_years
              FROM public_scan_pr_facts
              WHERE run_id = ?
                AND source IN ('native_merged', 'workflow_landed')
                AND repo_key IS NOT NULL
              GROUP BY repo_key
            ), commits AS (
              SELECT repo_key,
                     MAX(owner_login) AS owner_login,
                     MAX(stars) AS stars,
                     MAX(is_private) AS is_private,
                     MAX(is_fork) AS is_fork,
                     SUM(commits) AS commits,
                     MAX(active_years) AS active_years
              FROM public_scan_commit_repo_facts
              WHERE run_id = ?
              GROUP BY repo_key
            ), keys AS (
              SELECT repo_key FROM pr UNION SELECT repo_key FROM commits
            )
            SELECT keys.repo_key,
                   COALESCE(pr.owner_login, commits.owner_login, substr(keys.repo_key, 1, instr(keys.repo_key, '/') - 1)) AS owner_login,
                   MAX(COALESCE(pr.stars, 0), COALESCE(commits.stars, 0)) AS stars,
                   MAX(COALESCE(pr.is_private, 0), COALESCE(commits.is_private, 0)) AS is_private,
                   MAX(COALESCE(pr.is_fork, 0), COALESCE(commits.is_fork, 0)) AS is_fork,
                   COALESCE(commits.commits, 0) AS commits,
                   COALESCE(pr.prs, 0) AS prs,
                   MAX(COALESCE(pr.active_years, 0), COALESCE(commits.active_years, 0)) AS active_years
            FROM keys
            LEFT JOIN pr ON pr.repo_key = keys.repo_key
            LEFT JOIN commits ON commits.repo_key = keys.repo_key
            ORDER BY stars DESC, prs DESC, commits DESC`,
      args: [runId, runId],
    });
    return result.rows.map((row) => {
      const value = row as Record<string, unknown>;
      const repo = String(value.repo_key);
      return {
        repo,
        stars: Number(value.stars) || 0,
        isPrivate: Number(value.is_private) === 1,
        isFork: Number(value.is_fork) === 1,
        ownerLogin:
          typeof value.owner_login === "string" && value.owner_login
            ? value.owner_login
            : repo.split("/", 1)[0],
        commits: Number(value.commits) || 0,
        prs: Number(value.prs) || 0,
        activeYears: Number(value.active_years) || 0,
      };
    });
  } catch (error) {
    throwPublicScanStorageFailure("get_contribution_aggregates", error);
  }
}

/**
 * Move the `followers` / `total_stars` influence signals onto an existing scores
 * row (they otherwise live only inside the metrics JSON). UPDATE-only: a no-op
 * when the row doesn't exist, since the scores row is always written first in the
 * roast path. Shared by {@link recordProfileSnapshot} and the repo-graph
 * backfill. Best-effort like the rest of this module.
 */
export async function updateInfluenceStats(
  username: string,
  followers: number | null | undefined,
  totalStars: number | null | undefined,
): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    await db.execute({
      sql: `UPDATE scores SET followers = ?, total_stars = ? WHERE username = ?`,
      args: [followers ?? null, totalStars ?? null, username.toLowerCase()],
    });
  } catch (e) {
    console.error("updateInfluenceStats failed:", e);
  }
}

/**
 * Replace a developer's repo-graph rows wholesale (delete-then-insert in one
 * batch transaction) so a re-scan can't leave stale edges behind — a dev who
 * dropped a project keeps no phantom link. Repos themselves are upserted, never
 * deleted (they're shared across developers): stars/metadata move forward only
 * when a scan reports a higher star count or richer fields, so a
 * metadata-thin contributor scan never clobbers an owner's rich record. No-op
 * without Turso; best-effort like the rest of this module. Called from
 * {@link recordProfileSnapshot} and the repo-graph backfill.
 */
export async function recordRepoGraph(username: string, graph: RepoGraph): Promise<void> {
  const db = getClient();
  if (!db) return;
  try {
    await ensureSchema(db);
    const normalized = username.toLowerCase();
    const now = Date.now();
    await db.batch(
      [
        // Upsert each repo. On conflict, take the larger star count and only
        // overwrite optional metadata when the incoming scan actually carries it
        // (COALESCE keeps an owner's language/description from being nulled by a
        // later contributor-only scan of the same repo).
        ...graph.repos.map((r) => ({
          sql: `INSERT INTO repos
                  (repo_key, name_with_owner, owner_login, name, description, stars, forks, language, topics, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(repo_key) DO UPDATE SET
                  name_with_owner = excluded.name_with_owner,
                  owner_login     = excluded.owner_login,
                  name            = excluded.name,
                  description     = COALESCE(excluded.description, repos.description),
                  stars           = MAX(repos.stars, excluded.stars),
                  forks           = COALESCE(excluded.forks, repos.forks),
                  language        = COALESCE(excluded.language, repos.language),
                  topics          = CASE WHEN excluded.topics <> '[]' THEN excluded.topics ELSE repos.topics END,
                  updated_at      = excluded.updated_at`,
          args: [
            r.repo_key,
            r.name_with_owner,
            r.owner_login,
            r.name,
            r.description,
            r.stars,
            r.forks,
            r.language,
            JSON.stringify(r.topics ?? []),
            now,
          ] as (string | number | null)[],
        })),
        // Replace this developer's edges wholesale.
        { sql: `DELETE FROM repo_developers WHERE username = ?`, args: [normalized] },
        ...graph.links.map((l) => ({
          sql: `INSERT OR REPLACE INTO repo_developers
                  (repo_key, username, relation, commits, prs, weight, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [l.repo_key, normalized, l.relation, l.commits, l.prs, l.weight, now] as (
            | string
            | number
            | null
          )[],
        })),
      ],
      "write",
    );
  } catch (e) {
    console.error("recordRepoGraph failed:", e);
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
      sql: `SELECT 1
            FROM profile_snapshots
            WHERE username = ? AND scan_version IN (?, ?)
            LIMIT 1`,
      args: [username.toLowerCase(), ...PUBLIC_PROFILE_SCORE_VERSIONS],
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
  signature_work: SignatureWork | null;
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

function parseJsonObject<T>(raw: unknown): T | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

async function getLatestPublicScanSignatureWork(
  db: Client,
  username: string,
): Promise<SignatureWork | null> {
  try {
    const res = await db.execute({
      sql: `SELECT snapshot, snapshot_hash, source_status
            FROM public_scan_runs
            WHERE username = ?
              AND collection_version = ?
              AND state = 'complete_public'
              AND coverage = 'complete_public'
              AND snapshot IS NOT NULL
            ORDER BY completed_at DESC, updated_at DESC
            LIMIT 1`,
      args: [username.toLowerCase(), PUBLIC_SCAN_COLLECTION_VERSION],
    });
    const row = res.rows[0];
    const rawSnapshot = typeof row?.snapshot === "string" ? row.snapshot : null;
    if (
      !rawSnapshot ||
      row?.snapshot_hash !== createHash("sha256").update(rawSnapshot).digest("hex") ||
      !hasCompletePublicScanSources(parsePublicScanSourceStatus(row.source_status))
    ) {
      return null;
    }
    const snapshot = parseJsonObject<ScanResult>(rawSnapshot);
    return snapshot?.signature_work ?? null;
  } catch {
    return null;
  }
}

/** Latest sedimented profile snapshot for an account, or null if none exists
 * (low-score/old accounts never backfilled). Fire-and-forget tolerant. */
export async function getProfileSnapshot(
  username: string,
): Promise<ProfileSnapshotView | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT top_repos, impact_repos, signature_work, pinned_repos, organizations, metrics, scanned_at
            FROM profile_snapshots
            WHERE username = ? AND scan_version IN (?, ?)
            ORDER BY CASE WHEN scan_version = ? THEN 0 ELSE 1 END, scanned_at DESC
            LIMIT 1`,
      args: [
        username.toLowerCase(),
        ...PUBLIC_PROFILE_SCORE_VERSIONS,
        PUBLIC_PROFILE_SCORE_VERSIONS[0],
      ],
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
    const signatureWork =
      parseJsonObject<SignatureWork>(r.signature_work) ??
      (await getLatestPublicScanSignatureWork(db, username));
    return {
      top_repos: parseJsonArray<TopRepo>(r.top_repos),
      impact_repos: parseJsonArray<ImpactRepo>(r.impact_repos),
      signature_work: signatureWork,
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
export async function updateRoast(
  username: string,
  roast: string,
  lang: Lang,
  scoreWrite: ScoreWriteIdentity,
  artifacts?: RoastArtifacts,
): Promise<boolean> {
  const db = getClient();
  if (!db) return false;
  // Column name comes from a fixed allowlist (never from user input).
  const col = lang === "en" ? "roast_en" : "roast";
  const versionCol = lang === "en" ? "roast_en_version" : "roast_version";
  try {
    await ensureSchema(db);
    const normalizedUsername = username.toLowerCase();
    const generatedAt = Date.now();
    const tx = await db.transaction("write");
    try {
      const updated = await tx.execute({
        sql: `UPDATE scores
              SET ${col} = ?, ${versionCol} = ?,
                  tags = COALESCE(?, tags), roast_line = COALESCE(?, roast_line)
              WHERE username = ?
                AND score_version = ?
                AND score_source_collection_version = ?
                AND length(score_source_snapshot_hash) = 64
                AND score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'
                AND score_write_token = ?
                AND scanned_at = ?`,
        args: [
          roast,
          ROAST_CACHE_VERSION,
          artifacts ? JSON.stringify(artifacts.tags) : null,
          artifacts ? JSON.stringify(artifacts.roastLine) : null,
          normalizedUsername,
          SCORE_CACHE_VERSION,
          PUBLIC_SCAN_COLLECTION_VERSION,
          scoreWrite.token,
          scoreWrite.scannedAt,
        ],
      });
      if (Number(updated.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }
      const snapshot = await tx.execute({
        sql: `INSERT INTO score_snapshots
                (id, username, display_name, avatar_url, profile_url, final_score, tier,
                 tags, roast_line, score_version, roast_version, roast_lang, bot_score,
                 sub_scores, generated_at)
              SELECT ?, username, display_name, avatar_url, profile_url, final_score, tier,
                     tags, roast_line, score_version, ?, ?, bot_score, sub_scores, ?
              FROM scores
              WHERE username = ?
                AND score_version = ?
                AND score_source_collection_version = ?
                AND length(score_source_snapshot_hash) = 64
                AND score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'
                AND score_write_token = ?
                AND scanned_at = ?
                AND ${versionCol} = ?
                AND ${col} = ?`,
        args: [
          randomUUID(),
          ROAST_CACHE_VERSION,
          lang,
          generatedAt,
          normalizedUsername,
          SCORE_CACHE_VERSION,
          PUBLIC_SCAN_COLLECTION_VERSION,
          scoreWrite.token,
          scoreWrite.scannedAt,
          ROAST_CACHE_VERSION,
          roast,
        ],
      });
      if (Number(snapshot.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  } catch (e) {
    console.error("updateRoast failed:", e);
    return false;
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
            FROM scores WHERE hidden = 0`,
      args: [score, score],
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

/** One bucket of the score distribution: 0.1-point granularity (score × 10),
 *  split by hidden so both getRank (visible only) and getPercentile (everyone)
 *  semantics can be derived from the same aggregate. */
export interface ScoreHistogramRow {
  hidden: number;
  bucket: number;
  n: number;
}

/**
 * Whole-table score distribution in one aggregate scan. Runs once per cache
 * TTL (lib/rank.ts) and answers every rank/percentile lookup from memory —
 * the per-request O(table) SUM/COUNT in getRank/getPercentile was the next
 * rows_read cliff after the 2026-07 discovery incident.
 */
export async function getScoreHistogram(): Promise<ScoreHistogramRow[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const res = await db.execute(
      `SELECT hidden, CAST(ROUND(final_score * 10) AS INTEGER) AS bucket, COUNT(*) AS n
       FROM scores GROUP BY hidden, bucket`,
    );
    return res.rows.map((r) => ({
      hidden: Number(r.hidden),
      bucket: Number(r.bucket),
      n: Number(r.n),
    }));
  } catch (e) {
    console.error("getScoreHistogram failed:", e);
    return [];
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
  score_version: unknown;
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
    tags: r.score_version === SCORE_CACHE_VERSION ? parseTags(r.tags) : EMPTY_TAGS,
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
                   s.final_score, s.tier, s.tags, s.score_version,
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
            ${activeOnly ? "AND recent.recent_lookup_count > 0" : ""}`,
      args: [recentCutoff, minScore],
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
  window: LeaderboardWindow = "all",
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const { recentCutoff, activeOnly } = resolveLeaderboardWindow(window, Date.now());
    const res = await db.execute({
      sql: `SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
                   s.final_score, s.tier, s.tags, s.score_version,
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
            ${activeOnly ? "AND recent.recent_lookup_count > 0" : ""}
            ORDER BY s.final_score DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [recentCutoff, minScore, limit],
    });
    const now = Date.now();
    return res.rows.map((r) => toLeaderboardEntry(r as unknown as LeaderboardRow, now));
  } catch (e) {
    console.error("getLeaderboard failed:", e);
    return [];
  }
}

/**
 * Score board for one event cohort. Unlike the public hall of fame, this has no
 * minimum-score floor: every on-site participant belongs on the event board.
 * Scores and profile metadata still come from the canonical `scores` row.
 */
export async function getCampaignLeaderboard(
  campaign: string,
  limit = 500,
): Promise<LeaderboardEntry[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    const capped = Math.max(1, Math.min(500, limit));
    const res = await db.execute({
      sql: `SELECT s.username, s.display_name, s.avatar_url, s.profile_url,
                   s.final_score, s.tier, s.tags, s.score_version,
                   MAX(COALESCE(stats.lookup_count, 0), ${MIN_RECORDED_LOOKUP_COUNT}) AS lookup_count,
                   COALESCE(recent.recent_lookup_count, 0) AS recent_lookup_count,
                   stats.last_lookup_at AS last_lookup_at
            FROM campaign_participants AS participant
            JOIN scores AS s ON s.username = participant.username
            LEFT JOIN account_stats AS stats ON stats.username = s.username
            LEFT JOIN (
              SELECT username, COUNT(*) AS recent_lookup_count
              FROM account_lookup_limits
              WHERE last_counted_at >= ?
              GROUP BY username
            ) AS recent ON recent.username = s.username
            WHERE participant.campaign = ? AND s.hidden = 0
            ORDER BY s.final_score DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [Date.now() - TRENDING_LOOKUP_WINDOW_MS, campaign, capped],
    });
    const now = Date.now();
    return res.rows.map((row) =>
      toLeaderboardEntry(row as unknown as LeaderboardRow, now),
    );
  } catch (e) {
    console.error("getCampaignLeaderboard failed:", e);
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
                   s.final_score, s.tier, s.tags, s.score_version,
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
            ${activeOnly ? "AND recent.recent_lookup_count > 0" : ""}
            ORDER BY ${heatOrder}, s.final_score DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [recentCutoff, minScore, limit],
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
                   s.final_score, s.tier, s.tags, s.score_version, s.prev_score,
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
              ${activeOnly ? "AND recent.recent_lookup_count > 0" : ""}
            ORDER BY (s.final_score - s.prev_score) DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [recentCutoff, limit],
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
              AND s.final_score >= ?
            GROUP BY f.facet_value
            ORDER BY count DESC, f.facet_value ASC
            LIMIT ?`,
      args: [facetType, FACET_MIN_SCORE, Math.max(1, Math.min(500, limit))],
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
                   s.final_score, s.tier, s.tags, s.score_version,
                   MAX(COALESCE(stats.lookup_count, 0), ${MIN_RECORDED_LOOKUP_COUNT}) AS lookup_count,
                   stats.last_lookup_at AS last_lookup_at
            FROM developer_facets AS f
            JOIN scores AS s ON s.username = f.username
            LEFT JOIN account_stats AS stats ON stats.username = s.username
            WHERE f.facet_type = ?
              AND f.facet_value = ?
              AND s.hidden = 0
              AND s.final_score >= ?
            ORDER BY s.final_score DESC, s.scanned_at DESC
            LIMIT ?`,
      args: [facetType, facetValue, FACET_MIN_SCORE, capped],
    });
    const now = Date.now();
    return res.rows.map((r) => toLeaderboardEntry(r as unknown as LeaderboardRow, now));
  } catch (e) {
    console.error("getDevelopersByFacet failed:", e);
    return [];
  }
}

/** Canonical tier order, best → worst — for a stable tier-distribution readout. */
const TIER_ORDER: Tier[] = ["夯", "顶级", "人上人", "NPC", "拉完了"];

export interface RepoDetail {
  repo_key: string;
  name_with_owner: string;
  owner_login: string;
  name: string;
  description: string | null;
  stars: number;
  forks: number | null;
  language: string | null;
  topics: string[];
}

/** The repo owner as a scored account, when the owner has been scanned (personal
 *  repos; org-owned attributed repos have no matching scores row → null). */
export interface RepoOwnerRef {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  final_score: number;
  tier: Tier;
}

/** Aggregate quality of the developers linked to a repo — the differentiated
 *  read ("who works on this, and how good are they") the project page leads with.
 *  Computed over scored, non-hidden owners + contributors. */
export interface RepoContributorSummary {
  count: number;
  avgScore: number;
  /** Non-empty tier buckets in canonical order, for a distribution bar. */
  tierCounts: { tier: Tier; count: number }[];
}

export interface RepoOverview {
  repo: RepoDetail;
  owner: RepoOwnerRef | null;
  summary: RepoContributorSummary;
}

export interface ProjectListItem {
  repo: RepoDetail;
  contributorCount: number;
  avgScore: number;
  eliteCount: number;
  momentum: number;
  qualityScore: number;
  topContributors: RepoOwnerRef[];
}

export interface RelatedProject {
  project: ProjectListItem;
  sharedContributorCount: number;
}

function repoDetailFromRow(row: Record<string, unknown>): RepoDetail {
  return {
    repo_key: String(row.repo_key),
    name_with_owner: String(row.name_with_owner),
    owner_login: String(row.owner_login),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    stars: Number(row.stars ?? 0),
    forks: row.forks == null ? null : Number(row.forks),
    language: (row.language as string | null) ?? null,
    topics: parseJsonArray<string>(row.topics),
  };
}

async function attachTopContributors(
  db: Client,
  rows: Record<string, unknown>[],
): Promise<ProjectListItem[]> {
  const keys = rows.map((row) => String(row.repo_key));
  const topByRepo = new Map<string, RepoOwnerRef[]>();
  if (keys.length > 0) {
    const placeholders = keys.map(() => "?").join(",");
    const contributors = await db.execute({
      sql: `SELECT edges.repo_key, s.username, s.display_name, s.avatar_url,
                   s.final_score, s.tier
            FROM (
              SELECT DISTINCT repo_key, username FROM repo_developers
              WHERE repo_key IN (${placeholders})
            ) AS edges
            JOIN scores AS s ON s.username = edges.username
            WHERE s.hidden = 0 AND s.final_score >= ?
            ORDER BY edges.repo_key ASC, s.final_score DESC, s.username ASC`,
      args: [...keys, FACET_MIN_SCORE],
    });
    for (const row of contributors.rows) {
      const key = String(row.repo_key);
      const current = topByRepo.get(key) ?? [];
      if (current.length >= 3) continue;
      current.push({
        username: String(row.username),
        display_name: (row.display_name as string | null) ?? null,
        avatar_url: (row.avatar_url as string | null) ?? null,
        final_score: Number(row.final_score),
        tier: row.tier as Tier,
      });
      topByRepo.set(key, current);
    }
  }
  return rows.map((row) => {
    const contributorCount = Number(row.contributor_count ?? 0);
    const avgScore = Math.round(Number(row.avg_score ?? 0) * 10) / 10;
    return {
      repo: repoDetailFromRow(row),
      contributorCount,
      avgScore,
      eliteCount: Number(row.elite_count ?? 0),
      momentum:
        contributorCount > 0
          ? Math.round(
              (Number(row.recent_lookup_count ?? 0) / Math.sqrt(contributorCount)) * 10,
            ) / 10
          : 0,
      qualityScore: projectQualityScore(avgScore, contributorCount),
      topContributors: topByRepo.get(String(row.repo_key)) ?? [],
    };
  });
}

async function queryProjectItems(
  db: Client,
  options: {
    sort: ProjectSort;
    language?: string | null;
    repoKeys?: string[];
    limit: number;
    offset?: number;
  },
): Promise<ProjectListItem[]> {
  const cutoff = Date.now() - TRENDING_LOOKUP_WINDOW_MS;
  let result;
  if (options.repoKeys) {
    if (options.repoKeys.length === 0) return [];
    // Hot path (profile common-projects, related-projects): the key filter must
    // live INSIDE the edge subquery — filtering the outer join instead makes
    // SQLite materialize a DISTINCT over the whole repo_developers table per
    // call (the 2026-07 rows_read incident). CROSS JOIN pins the join order so
    // rows read stay proportional to the requested repos' contributor counts,
    // and the correlated lookup count only reads those contributors' rows.
    const placeholders = options.repoKeys.map(() => "?").join(",");
    result = await db.execute({
      sql: `WITH edges AS (
              SELECT repo_key, username FROM repo_developers
              WHERE repo_key IN (${placeholders})
              GROUP BY repo_key, username
            )
            SELECT r.repo_key, r.name_with_owner, r.owner_login, r.name,
                   r.description, r.stars, r.forks, r.language, r.topics,
                   COUNT(*) AS contributor_count,
                   AVG(s.final_score) AS avg_score,
                   SUM(CASE WHEN s.tier IN ('夯', '顶级') THEN 1 ELSE 0 END) AS elite_count,
                   COALESCE(SUM((
                     SELECT COUNT(*) FROM account_lookup_limits AS l
                     WHERE l.username = edges.username AND l.last_counted_at >= ?
                   )), 0) AS recent_lookup_count
            FROM edges
            CROSS JOIN repos AS r ON r.repo_key = edges.repo_key
            CROSS JOIN scores AS s ON s.username = edges.username
              AND s.hidden = 0 AND s.final_score >= ?
            ${options.language ? "WHERE lower(r.language) = lower(?)" : ""}
            GROUP BY r.repo_key`,
      args: [
        ...options.repoKeys,
        cutoff,
        FACET_MIN_SCORE,
        ...(options.language ? [options.language] : []),
      ],
    });
  } else {
    // Whole-graph aggregation (the /projects feed): inherently reads every
    // edge, so it must only run behind the Redis cache (project-discovery.ts).
    result = await db.execute({
      sql: `WITH edges AS (
            SELECT DISTINCT repo_key, username FROM repo_developers
          ), recent AS (
            SELECT username, COUNT(*) AS recent_lookups
            FROM account_lookup_limits
            WHERE last_counted_at >= ?
            GROUP BY username
          )
          SELECT r.repo_key, r.name_with_owner, r.owner_login, r.name,
                 r.description, r.stars, r.forks, r.language, r.topics,
                 COUNT(*) AS contributor_count,
                 AVG(s.final_score) AS avg_score,
                 SUM(CASE WHEN s.tier IN ('夯', '顶级') THEN 1 ELSE 0 END) AS elite_count,
                 COALESCE(SUM(recent.recent_lookups), 0) AS recent_lookup_count
          FROM repos AS r
          JOIN edges ON edges.repo_key = r.repo_key
          JOIN scores AS s ON s.username = edges.username
            AND s.hidden = 0 AND s.final_score >= ?
          LEFT JOIN recent ON recent.username = edges.username
          ${options.language ? "WHERE lower(r.language) = lower(?)" : ""}
          GROUP BY r.repo_key`,
      args: [
        cutoff,
        FACET_MIN_SCORE,
        ...(options.language ? [options.language] : []),
      ],
    });
  }
  const rows = result.rows as unknown as Record<string, unknown>[];
  const metric = (row: Record<string, unknown>) => {
    const count = Number(row.contributor_count ?? 0);
    const avg = Number(row.avg_score ?? 0);
    const quality = projectQualityScore(avg, count);
    const momentum = count > 0 ? Number(row.recent_lookup_count ?? 0) / Math.sqrt(count) : 0;
    return { quality, momentum };
  };
  rows.sort((a, b) => {
    const aMetric = metric(a);
    const bMetric = metric(b);
    const primary =
      options.sort === "stars"
        ? Number(b.stars ?? 0) - Number(a.stars ?? 0)
        : options.sort === "momentum"
          ? bMetric.momentum - aMetric.momentum || bMetric.quality - aMetric.quality
          : bMetric.quality - aMetric.quality || Number(b.stars ?? 0) - Number(a.stars ?? 0);
    return primary || String(a.repo_key).localeCompare(String(b.repo_key));
  });
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(200, options.limit));
  return attachTopContributors(db, rows.slice(offset, offset + limit));
}

export async function getProjects(options: {
  sort?: ProjectSort;
  language?: string | null;
  limit?: number;
  offset?: number;
} = {}): Promise<ProjectListItem[]> {
  const db = getClient();
  if (!db) return [];
  try {
    await ensureSchema(db);
    return await queryProjectItems(db, {
      sort: options.sort ?? "quality",
      language: options.language,
      limit: options.limit ?? 24,
      offset: options.offset,
    });
  } catch (e) {
    console.error("getProjects failed:", e);
    return [];
  }
}

export async function searchRepos(query: string, limit = 4): Promise<RepoDetail[]> {
  const db = getClient();
  const normalized = query.trim().toLowerCase();
  if (!db || !normalized) return [];
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT repo_key, name_with_owner, owner_login, name, description,
                   stars, forks, language, topics
            FROM repos
            WHERE lower(repo_key) LIKE ? OR lower(name) LIKE ?
            ORDER BY stars DESC, repo_key ASC
            LIMIT ?`,
      args: [`${normalized}%`, `${normalized}%`, Math.max(1, Math.min(20, limit))],
    });
    return result.rows.map((row) => repoDetailFromRow(row as unknown as Record<string, unknown>));
  } catch (e) {
    console.error("searchRepos failed:", e);
    return [];
  }
}

/**
 * Shared-contributor neighbors only. The same-language filler that used to live
 * here moved to project-discovery.ts so it can reuse the per-language cached
 * list — as a per-repo query it re-ran the whole-graph aggregation on every
 * repo page (the 2026-07 rows_read incident). Both queries here are index
 * seeks: target repo → its contributors (PK prefix), contributors → their other
 * repos (idx_repo_developers_user), then the repoKeys fast path above.
 */
export async function getRelatedProjects(repoKey: string, limit = 6): Promise<RelatedProject[]> {
  const db = getClient();
  const key = repoKey.trim().toLowerCase();
  if (!db || !key) return [];
  try {
    await ensureSchema(db);
    const shared = await db.execute({
      sql: `SELECT rd.repo_key, COUNT(DISTINCT rd.username) AS shared_count
            FROM (
              SELECT DISTINCT username FROM repo_developers WHERE repo_key = ?
            ) AS t
            JOIN repo_developers AS rd ON rd.username = t.username
            WHERE rd.repo_key <> ?
            GROUP BY rd.repo_key
            ORDER BY shared_count DESC, rd.repo_key ASC
            LIMIT ?`,
      args: [key, key, Math.max(1, Math.min(50, limit))],
    });
    const sharedCounts = new Map(
      shared.rows.map((row) => [String(row.repo_key), Number(row.shared_count)]),
    );
    const keys = [...sharedCounts.keys()];
    const sharedProjects = await queryProjectItems(db, {
      sort: "quality",
      repoKeys: keys,
      limit: keys.length || 1,
    });
    return sharedProjects
      .sort(
        (a, b) =>
          (sharedCounts.get(b.repo.repo_key) ?? 0) -
            (sharedCounts.get(a.repo.repo_key) ?? 0) ||
          b.qualityScore - a.qualityScore,
      )
      .slice(0, limit)
      .map((project) => ({
        project,
        sharedContributorCount: sharedCounts.get(project.repo.repo_key) ?? 0,
      }));
  } catch (e) {
    console.error("getRelatedProjects failed:", e);
    return [];
  }
}

/** The repo's primary language, for the same-language related-projects filler
 *  in project-discovery.ts. Single PK seek; null when unknown. */
export async function getRepoLanguage(repoKey: string): Promise<string | null> {
  const db = getClient();
  const key = repoKey.trim().toLowerCase();
  if (!db || !key) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT language FROM repos WHERE repo_key = ? LIMIT 1`,
      args: [key],
    });
    return (res.rows[0]?.language as string | null) ?? null;
  } catch (e) {
    console.error("getRepoLanguage failed:", e);
    return null;
  }
}

export async function getDeveloperCommonProjects(
  usernameA: string,
  usernameB: string,
  limit = 6,
): Promise<ProjectListItem[]> {
  const db = getClient();
  const a = usernameA.trim().toLowerCase();
  const b = usernameB.trim().toLowerCase();
  if (!db || !a || !b || a === b) return [];
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT repo_key
            FROM repo_developers
            WHERE username IN (?, ?)
            GROUP BY repo_key
            HAVING COUNT(DISTINCT username) = 2
            ORDER BY repo_key ASC
            LIMIT ?`,
      args: [a, b, Math.max(1, Math.min(50, limit))],
    });
    return await queryProjectItems(db, {
      sort: "quality",
      repoKeys: result.rows.map((row) => String(row.repo_key)),
      limit,
    });
  } catch (e) {
    console.error("getDeveloperCommonProjects failed:", e);
    return [];
  }
}

/**
 * Everything the project page's header + quality summary needs for one repo, in a
 * few index-seek queries: the repo row (from the normalized `repos` table), the
 * owner as a scored account (join `scores` on the repo's owner login), and the
 * contributor-quality aggregate (over `repo_developers ⋈ scores`). Returns null
 * when the repo isn't in the graph yet, so the page degrades to the plain
 * contributor list. Best-effort; never throws.
 */
export async function getRepoOverview(repoKey: string): Promise<RepoOverview | null> {
  const db = getClient();
  if (!db || !repoKey) return null;
  try {
    await ensureSchema(db);
    const key = repoKey.toLowerCase();
    const repoRes = await db.execute({
      sql: `SELECT repo_key, name_with_owner, owner_login, name, description, stars, forks, language, topics
            FROM repos WHERE repo_key = ?`,
      args: [key],
    });
    const r = repoRes.rows[0];
    if (!r) return null;
    const repo: RepoDetail = {
      repo_key: String(r.repo_key),
      name_with_owner: String(r.name_with_owner),
      owner_login: String(r.owner_login),
      name: String(r.name),
      description: (r.description as string | null) ?? null,
      stars: Number(r.stars ?? 0),
      forks: r.forks == null ? null : Number(r.forks),
      language: (r.language as string | null) ?? null,
      topics: parseJsonArray<string>(r.topics),
    };

    const [ownerRes, contribRes] = await Promise.all([
      db.execute({
        sql: `SELECT username, display_name, avatar_url, final_score, tier
              FROM scores WHERE username = ? AND hidden = 0`,
        args: [repo.owner_login],
      }),
      db.execute({
        sql: `SELECT s.tier AS tier, s.final_score AS final_score
              FROM repo_developers AS rd
              JOIN scores AS s ON s.username = rd.username
              WHERE rd.repo_key = ? AND s.hidden = 0`,
        args: [key],
      }),
    ]);

    const o = ownerRes.rows[0];
    const owner: RepoOwnerRef | null = o
      ? {
          username: String(o.username),
          display_name: (o.display_name as string | null) ?? null,
          avatar_url: (o.avatar_url as string | null) ?? null,
          final_score: Number(o.final_score ?? 0),
          tier: o.tier as Tier,
        }
      : null;

    const counts = new Map<Tier, number>();
    let scoreSum = 0;
    for (const row of contribRes.rows) {
      const tier = row.tier as Tier;
      counts.set(tier, (counts.get(tier) ?? 0) + 1);
      scoreSum += Number(row.final_score ?? 0);
    }
    const count = contribRes.rows.length;
    const summary: RepoContributorSummary = {
      count,
      avgScore: count > 0 ? Math.round((scoreSum / count) * 10) / 10 : 0,
      tierCounts: TIER_ORDER.filter((t) => counts.has(t)).map((t) => ({
        tier: t,
        count: counts.get(t)!,
      })),
    };

    return { repo, owner, summary };
  } catch (e) {
    console.error("getRepoOverview failed:", e);
    return null;
  }
}

/**
 * Of the given "owner/name" repo keys, the subset that exist as first-class rows
 * in the `repos` table — so a profile page can link a repo card to its internal
 * project page only when that page has content, and fall back to GitHub otherwise.
 * One indexed `IN` seek over the primary key; returns an empty set on any failure
 * (callers then keep the external GitHub links, the pre-Phase-B behavior).
 */
export async function filterExistingRepoKeys(keys: string[]): Promise<Set<string>> {
  const db = getClient();
  const normalized = [...new Set(keys.map((k) => k.toLowerCase()).filter(Boolean))];
  if (!db || normalized.length === 0) return new Set();
  try {
    await ensureSchema(db);
    const placeholders = normalized.map(() => "?").join(",");
    const res = await db.execute({
      sql: `SELECT repo_key FROM repos WHERE repo_key IN (${placeholders})`,
      args: normalized,
    });
    return new Set(res.rows.map((r) => String(r.repo_key)));
  } catch (e) {
    console.error("filterExistingRepoKeys failed:", e);
    return new Set();
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
  /** Score formula version that produced this persisted profile. */
  score_version?: string | null;
  /** True only for the explicit read-only v5/v5/v3 continuity path. */
  legacy_read_fallback: boolean;
  /** Canonical collection provenance; null for historical/legacy score rows. */
  score_source_collection_version: string | null;
  /** SHA-256 identity of the complete source snapshot; null for legacy rows. */
  score_source_snapshot_hash: string | null;
  scanned_at: number;
  /** Previous scan's score/time (progress-board columns); NULL until a re-scan. */
  prev_score: number | null;
  prev_scanned_at: number | null;
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
  /** Previous scan's score/time — feeds the badge's weekly-delta fallback. */
  prev_score: number | null;
  prev_scanned_at: number | null;
}

/** Minimal score lookup for the SVG badge — avoids fetching the heavy roast text. */
export async function getScoreBrief(username: string): Promise<ScoreBrief | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT username, display_name, final_score, tier, prev_score, prev_scanned_at
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
      prev_score: r.prev_score === null ? null : Number(r.prev_score),
      prev_scanned_at: r.prev_scanned_at === null ? null : Number(r.prev_scanned_at),
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
            WHERE hidden = 0 AND username LIKE ? ESCAPE '\\'
            ORDER BY final_score DESC
            LIMIT ?`,
      args: [like, limit],
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

/** Full persisted record for one account's detail page (null if absent/hidden). */
export async function getAccountDetail(username: string): Promise<AccountDetail | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT username, display_name, avatar_url, profile_url, final_score, tier,
                   tags, roast_line, sub_scores, roast, roast_en, score_version,
                   score_source_collection_version, score_source_snapshot_hash,
                   roast_version, roast_en_version, scanned_at, prev_score, prev_scanned_at
            FROM scores
            WHERE username = ? AND hidden = 0
            LIMIT 1`,
      args: [username.toLowerCase()],
    });
    const r = res.rows[0];
    if (!r) return null;
    const canonicalScore =
      r.score_version === SCORE_CACHE_VERSION &&
      r.score_source_collection_version === PUBLIC_SCAN_COLLECTION_VERSION &&
      typeof r.score_source_snapshot_hash === "string" &&
      /^[a-f0-9]{64}$/.test(r.score_source_snapshot_hash);
    const legacyReadFallback =
      !canonicalScore && isLegacyReadFallbackProfile(r as Record<string, unknown>);
    const readableArtifacts = canonicalScore || legacyReadFallback;
    const artifactRoastVersion = canonicalScore
      ? ROAST_CACHE_VERSION
      : legacyReadFallback
        ? LEGACY_READ_FALLBACK.roast
        : null;
    return {
      username: String(r.username),
      display_name: r.display_name as string | null,
      avatar_url: r.avatar_url as string | null,
      profile_url: r.profile_url as string | null,
      final_score: Number(r.final_score),
      tier: String(r.tier) as Tier,
      tags: readableArtifacts ? parseTags(r.tags) : EMPTY_TAGS,
      roast_line: readableArtifacts ? parseRoastLine(r.roast_line) : EMPTY_ROAST_LINE,
      sub_scores: parseSubScores(r.sub_scores),
      roast:
        artifactRoastVersion && r.roast_version === artifactRoastVersion
          ? ((r.roast as string | null) ?? null)
          : null,
      roast_en:
        artifactRoastVersion && r.roast_en_version === artifactRoastVersion
          ? ((r.roast_en as string | null) ?? null)
          : null,
      score_version: typeof r.score_version === "string" ? r.score_version : null,
      legacy_read_fallback: legacyReadFallback,
      score_source_collection_version:
        typeof r.score_source_collection_version === "string"
          ? r.score_source_collection_version
          : null,
      score_source_snapshot_hash:
        typeof r.score_source_snapshot_hash === "string" ? r.score_source_snapshot_hash : null,
      scanned_at: Number(r.scanned_at),
      prev_score: r.prev_score === null ? null : Number(r.prev_score),
      prev_scanned_at: r.prev_scanned_at === null ? null : Number(r.prev_scanned_at),
    };
  } catch (e) {
    console.error("getAccountDetail failed:", e);
    return null;
  }
}

/**
 * Whether an account has a stored v5/v5 profile that can be shown immediately
 * while canonical v9/v9/v4 collection runs. This does not assert that a full
 * historical scan snapshot exists, so it must never be used as a score source.
 */
export async function hasLegacyReadFallbackProfile(username: string): Promise<boolean> {
  const db = getClient();
  if (!db) return false;
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT score_version, roast, roast_en, roast_version, roast_en_version
            FROM scores
            WHERE username = ? AND hidden = 0 AND score_version = ?
            LIMIT 1`,
      args: [username.toLowerCase(), LEGACY_READ_FALLBACK.score],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return Boolean(row && isLegacyReadFallbackProfile(row));
  } catch (error) {
    console.error("hasLegacyReadFallbackProfile failed:", error);
    return false;
  }
}

/**
 * Return the complete stored v3 snapshot that proves a v5/v5 emergency read
 * fallback. This is deliberately read-only: callers may display it immediately
 * while separately requesting canonical v9/v4 collection, but must never cache
 * it as current or use it to materialize a score.
 */
export async function getLegacyReadFallbackScan(username: string): Promise<ScanResult | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT username, final_score, score_version, roast, roast_en,
                   roast_version, roast_en_version
            FROM scores
            WHERE username = ? AND hidden = 0 AND score_version = ?
            LIMIT 1`,
      args: [username.toLowerCase(), LEGACY_READ_FALLBACK.score],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? await getVerifiedLegacyReadFallbackScan(db, row) : null;
  } catch (error) {
    console.error("getLegacyReadFallbackScan failed:", error);
    return null;
  }
}

/**
 * Read one v5/v5 report without requiring a current scan or LLM configuration.
 * The caller must treat it as stale and must never cache it as a canonical v9
 * report. Full v3 snapshot provenance is intentionally not required here: a
 * profile replay does not claim to be a complete scan result.
 */
export async function getLegacyReadFallbackRoast(
  username: string,
  lang: Lang,
): Promise<ArchivedRoast | null> {
  const db = getClient();
  if (!db) return null;
  const col = lang === "en" ? "roast_en" : "roast";
  const versionCol = lang === "en" ? "roast_en_version" : "roast_version";
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT username, final_score, tier, tags, roast_line, score_version,
                   roast, roast_en, roast_version, roast_en_version
            FROM scores
            WHERE username = ? AND hidden = 0 AND score_version = ?
            LIMIT 1`,
      args: [username.toLowerCase(), LEGACY_READ_FALLBACK.score],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row || !isLegacyReadFallbackProfile(row)) return null;
    if (
      row[versionCol] !== LEGACY_READ_FALLBACK.roast ||
      typeof row[col] !== "string" ||
      !row[col]
    ) {
      return null;
    }
    return {
      username: String(row.username),
      final_score: Number(row.final_score),
      tier: String(row.tier) as Tier,
      tags: parseTags(row.tags),
      roast_line: parseRoastLine(row.roast_line),
      report: row[col],
    };
  } catch (error) {
    console.error("getLegacyReadFallbackRoast failed:", error);
    return null;
  }
}

/**
 * Last real-generation time for a handle (`scores.scanned_at`), or null when the
 * row is absent/hidden or the DB is unreadable. Cheap probe for the /api/roast
 * `refresh` guard: a client may only force a regeneration past this timestamp.
 */
export async function getScoreScannedAt(username: string): Promise<number | null> {
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT scanned_at FROM scores WHERE username = ? AND hidden = 0 LIMIT 1`,
      args: [username.toLowerCase()],
    });
    const r = res.rows[0];
    return r ? Number(r.scanned_at) : null;
  } catch (e) {
    console.error("getScoreScannedAt failed:", e);
    return null;
  }
}

/** Exact write identity for attaching a report to one canonical scan snapshot. */
export async function getCanonicalScoreWriteIdentity(
  username: string,
  snapshotHash: string,
): Promise<ScoreWriteIdentity | null> {
  if (!/^[a-f0-9]{64}$/.test(snapshotHash)) return null;
  const db = getClient();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const result = await db.execute({
      sql: `SELECT scanned_at, score_write_token
            FROM scores
            WHERE username = ?
              AND hidden = 0
              AND score_version = ?
              AND score_source_collection_version = ?
              AND score_source_snapshot_hash = ?
            LIMIT 1`,
      args: [
        username.toLowerCase(),
        SCORE_CACHE_VERSION,
        PUBLIC_SCAN_COLLECTION_VERSION,
        snapshotHash,
      ],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? scoreWriteIdentity(row) : null;
  } catch (error) {
    console.error("getCanonicalScoreWriteIdentity failed:", error);
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
              AND score_source_collection_version = ?
              AND length(score_source_snapshot_hash) = 64
              AND score_source_snapshot_hash NOT GLOB '*[^0-9a-f]*'
              AND ${versionCol} = ?
              AND ${col} IS NOT NULL
              AND ${col} != ''
            LIMIT 1`,
      args: [
        username.toLowerCase(),
        SCORE_CACHE_VERSION,
        PUBLIC_SCAN_COLLECTION_VERSION,
        ROAST_CACHE_VERSION,
      ],
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
                   s.final_score, s.tier, s.tags, s.score_version, s.sub_scores,
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

// ── Weekly delta & follows ───────────────────────────────────────────────────

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard cap per follower — keeps the homepage module and the IN-list query small. */
export const MAX_FOLLOWS = 50;

/**
 * Score-as-of-a-week-ago baselines from `score_snapshots`: for each username the
 * newest snapshot at or before `now - 7d`. Accounts younger than a week (or never
 * roasted) have no entry — callers fall back via {@link resolveWeeklyDelta}.
 */
export async function getWeeklyBaselines(
  usernames: string[],
  now = Date.now(),
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const names = [...new Set(usernames.map((u) => u.toLowerCase()).filter(Boolean))];
  if (names.length === 0) return out;
  const db = getClient();
  if (!db) return out;
  try {
    await ensureSchema(db);
    const ph = names.map(() => "?").join(",");
    // MAX(final_score) + GROUP BY dedupes the rare tie where the zh and en
    // snapshots of one generation share a generated_at (same score either way).
    const res = await db.execute({
      sql: `SELECT s.username AS username, MAX(s.final_score) AS final_score
            FROM score_snapshots s
            JOIN (
              SELECT username, MAX(generated_at) AS g
              FROM score_snapshots
              WHERE generated_at <= ? AND username IN (${ph})
              GROUP BY username
            ) m ON m.username = s.username AND m.g = s.generated_at
            GROUP BY s.username`,
      args: [now - WEEK_MS, ...names],
    });
    for (const r of res.rows) out.set(String(r.username), Number(r.final_score));
    return out;
  } catch (e) {
    console.error("getWeeklyBaselines failed:", e);
    return out;
  }
}

/**
 * The "↑x this week" delta for a card or the follow feed. Baseline preference:
 * a snapshot from ≥7d ago; else `prev_score` — valid only when the previous scan
 * itself predates the cutoff (then the score at cutoff time WAS prev_score).
 * Returns null when there is no trustworthy baseline or the change would render
 * as 0.0 anyway.
 */
export function resolveWeeklyDelta(input: {
  currentScore: number;
  snapshotBaseline?: number | null;
  prevScore?: number | null;
  prevScannedAt?: number | null;
  now?: number;
}): number | null {
  const cutoff = (input.now ?? Date.now()) - WEEK_MS;
  const baseline =
    input.snapshotBaseline ??
    (typeof input.prevScore === "number" &&
    typeof input.prevScannedAt === "number" &&
    input.prevScannedAt <= cutoff
      ? input.prevScore
      : null);
  if (baseline === null || baseline === undefined) return null;
  const delta = input.currentScore - baseline;
  return Math.abs(delta) < 0.05 ? null : delta;
}

export interface FollowedAccount {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  /** Null when the followed account's score row is hidden/gone. */
  final_score: number | null;
  tier: Tier | null;
  weekly_delta: number | null;
  followed_at: number;
}

/** Follow a handle. "limit" when the follower is at MAX_FOLLOWS; null on DB failure. */
export async function setFollow(
  followerGithubId: number,
  targetUsername: string,
): Promise<"ok" | "limit" | null> {
  const db = getClient();
  const target = normalizeGitHubUsername(targetUsername);
  if (!db || !target || !validGithubId(followerGithubId)) return null;
  try {
    await ensureSchema(db);
    const count = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM follows WHERE follower_github_id = ?`,
      args: [followerGithubId],
    });
    const existing = await db.execute({
      sql: `SELECT 1 FROM follows WHERE follower_github_id = ? AND target_username = ? LIMIT 1`,
      args: [followerGithubId, target],
    });
    if (existing.rows.length === 0 && Number(count.rows[0]?.n ?? 0) >= MAX_FOLLOWS) {
      return "limit";
    }
    await db.execute({
      sql: `INSERT INTO follows (follower_github_id, target_username, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT (follower_github_id, target_username) DO NOTHING`,
      args: [followerGithubId, target, Date.now()],
    });
    return "ok";
  } catch (e) {
    console.error("setFollow failed:", e);
    return null;
  }
}

export async function removeFollow(
  followerGithubId: number,
  targetUsername: string,
): Promise<boolean> {
  const db = getClient();
  const target = normalizeGitHubUsername(targetUsername);
  if (!db || !target || !validGithubId(followerGithubId)) return false;
  try {
    await ensureSchema(db);
    await db.execute({
      sql: `DELETE FROM follows WHERE follower_github_id = ? AND target_username = ?`,
      args: [followerGithubId, target],
    });
    return true;
  } catch (e) {
    console.error("removeFollow failed:", e);
    return false;
  }
}

export async function isFollowing(
  followerGithubId: number,
  targetUsername: string,
): Promise<boolean> {
  const db = getClient();
  const target = normalizeGitHubUsername(targetUsername);
  if (!db || !target || !validGithubId(followerGithubId)) return false;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT 1 FROM follows WHERE follower_github_id = ? AND target_username = ? LIMIT 1`,
      args: [followerGithubId, target],
    });
    return res.rows.length > 0;
  } catch (e) {
    console.error("isFollowing failed:", e);
    return false;
  }
}

/**
 * The signed-in user's follow feed: each watched handle with its current score
 * and the "this week" delta. One join for the scores plus one batched baseline
 * lookup — bounded by MAX_FOLLOWS. Null only on DB failure (vs [] for "follows
 * nobody"), so the API can tell the two apart.
 */
export async function listFollowedAccounts(
  followerGithubId: number,
): Promise<FollowedAccount[] | null> {
  const db = getClient();
  if (!db || !validGithubId(followerGithubId)) return null;
  try {
    await ensureSchema(db);
    const res = await db.execute({
      sql: `SELECT f.target_username AS username, f.created_at AS followed_at,
                   s.display_name, s.avatar_url, s.final_score, s.tier,
                   s.prev_score, s.prev_scanned_at
            FROM follows f
            LEFT JOIN scores s ON s.username = f.target_username AND s.hidden = 0
            WHERE f.follower_github_id = ?
            ORDER BY f.created_at DESC
            LIMIT ?`,
      args: [followerGithubId, MAX_FOLLOWS],
    });
    const scored = res.rows.filter((r) => r.final_score !== null).map((r) => String(r.username));
    const baselines = await getWeeklyBaselines(scored);
    const now = Date.now();
    return res.rows.map((r) => {
      const finalScore = r.final_score === null ? null : Number(r.final_score);
      return {
        username: String(r.username),
        display_name: (r.display_name as string | null) ?? null,
        avatar_url: (r.avatar_url as string | null) ?? null,
        final_score: finalScore,
        tier: r.tier === null ? null : (String(r.tier) as Tier),
        weekly_delta:
          finalScore === null
            ? null
            : resolveWeeklyDelta({
                currentScore: finalScore,
                snapshotBaseline: baselines.get(String(r.username)) ?? null,
                prevScore: r.prev_score === null ? null : Number(r.prev_score),
                prevScannedAt: r.prev_scanned_at === null ? null : Number(r.prev_scanned_at),
                now,
              }),
        followed_at: Number(r.followed_at),
      };
    });
  } catch (e) {
    console.error("listFollowedAccounts failed:", e);
    return null;
  }
}
