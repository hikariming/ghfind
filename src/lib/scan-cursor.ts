/**
 * Optional inventory cursors for the TypeScript scan path.
 *
 * The book lives beside the public snapshot. It does not change snapshot
 * JSON, coverage values, source_status, score version, or collection version.
 * `GHFIND_SCAN_INCREMENTAL_ENABLED` defaults off. Accepted on values match
 * the Go worker: `1`, `true`, and `on` (case-insensitive).
 *
 * Inventory is the only resumable source. Its watermark is the newest
 * `pushedAt`. Pull requests, commit years, and workflow landings stay full
 * pulls. The cursor is written only after the public scan row commits.
 */
import type { Client } from "@libsql/client/web";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "./scan-run-types";

/** Cursor row format. Independent of the public collection version. */
export const SCAN_CURSOR_SCHEMA_VERSION = 1;

/** Job-status freshness window. Same 7 days as Go `defaultStatusTTL`. */
export const SCAN_CURSOR_STATUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** #580 manual rescan cooldown. Same 24 hours as Go `roastFreshness`. */
export const SCAN_CURSOR_ROAST_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export type ScanReconcileReason =
  | ""
  | "cursor_missing"
  | "cursor_corrupt"
  | "collection_version"
  | "incremental_run_count"
  | "cursor_age"
  | "cursor_schema";

/** One owned public repo as stored in the cursor book. */
export interface CursorRepo {
  id: string;
  name: string;
  fullName: string;
  size: number;
  stars: number;
  forks: number;
  openIssues: number;
  description: string | null;
  pushedAt: string | null;
  language: string | null;
  topics: string[];
}

export interface ScanCursorWatermark {
  source: "repos";
  watermark: string;
  collection: string;
  incrementalRuns: number;
  reconciledAt: string;
  updatedAt: string;
  repos: CursorRepo[];
  /** Fork total from the last full inventory read. Incremental pages do not replace it. */
  forkCount: number;
}

export interface ScanCursorBook {
  username: string;
  schema: number;
  repos: ScanCursorWatermark | null;
  /** Row `updated_at` from the last load. Not stored inside `book`. */
  revision: number;
}

export interface ScanCursorPlan {
  full: boolean;
  since: string;
  reason: ScanReconcileReason;
  prev: ScanCursorWatermark | null;
}

/** Staged book for the scan that just finished. Written only after persist succeeds. */
export interface PendingScanCursors {
  book: ScanCursorBook;
  plan: ScanCursorPlan;
  /** Merged inventory page. A full read replaces; an incremental read upserts. */
  repos: CursorRepo[];
  forkCount: number;
  /** True when this page is a full reconcile of inventory. */
  reconciled: boolean;
  now: Date;
}

export class ScanCursorConflictError extends Error {
  constructor() {
    super("scan cursor changed");
    this.name = "ScanCursorConflictError";
  }
}

type EnvLike = Record<string, string | undefined>;

/** `1` / `true` / `on`, case-insensitive. Anything else, including empty, stays off. */
export function scanIncrementalEnabled(env: EnvLike = process.env): boolean {
  switch ((env.GHFIND_SCAN_INCREMENTAL_ENABLED ?? "").trim().toLowerCase()) {
    case "1":
    case "true":
    case "on":
      return true;
    default:
      return false;
  }
}

/** Seven days of daily rescans, then a full reconcile. Not tuned per account. */
export function scanIncrementalReconcileEveryN(): number {
  const days = Math.floor(SCAN_CURSOR_STATUS_TTL_MS / SCAN_CURSOR_ROAST_FRESHNESS_MS);
  return days < 1 ? 1 : days;
}

export function emptyCursorBook(username: string): ScanCursorBook {
  return {
    username: username.toLowerCase(),
    schema: SCAN_CURSOR_SCHEMA_VERSION,
    repos: null,
    revision: 0,
  };
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function cursorAfterWatermark(itemTime: string, watermark: string): boolean {
  const item = parseTimestamp(itemTime);
  const bound = parseTimestamp(watermark);
  if (item == null || bound == null) return false;
  return item > bound;
}

/** Equal timestamps are not before the watermark. Same-second siblings stay. */
export function cursorBeforeWatermark(itemTime: string | null | undefined, watermark: string): boolean {
  const item = parseTimestamp(itemTime);
  const bound = parseTimestamp(watermark);
  if (item == null || bound == null) return true;
  return item < bound;
}

function watermarkValid(mark: ScanCursorWatermark | null): mark is ScanCursorWatermark {
  if (!mark || mark.source !== "repos" || !mark.watermark.trim()) return false;
  if (parseTimestamp(mark.watermark) == null) return false;
  if (mark.collection && mark.collection !== PUBLIC_SCAN_COLLECTION_VERSION) return false;
  return true;
}

/**
 * Full inventory when the cursor is missing, corrupt, the wrong schema, the
 * wrong collection version, the incremental streak hits StatusTTL / 24h, or
 * the last full read is at least StatusTTL old.
 */
export function decideScanReconcile(
  book: ScanCursorBook,
  now: Date,
  options: { schemaMismatch?: boolean } = {},
): ScanReconcileReason {
  if (options.schemaMismatch || book.schema !== SCAN_CURSOR_SCHEMA_VERSION) {
    return "cursor_schema";
  }
  const mark = book.repos;
  if (!mark) return "cursor_missing";
  if (mark.collection && mark.collection !== PUBLIC_SCAN_COLLECTION_VERSION) {
    return "collection_version";
  }
  if (!watermarkValid(mark)) {
    const raw = book.repos?.watermark ?? "";
    return raw.trim() ? "cursor_corrupt" : "cursor_missing";
  }
  if (mark.incrementalRuns >= scanIncrementalReconcileEveryN()) {
    return "incremental_run_count";
  }
  const anchor = mark.reconciledAt || mark.updatedAt;
  const updated = parseTimestamp(anchor);
  if (updated != null && now.getTime() - updated >= SCAN_CURSOR_STATUS_TTL_MS) {
    return "cursor_age";
  }
  return "";
}

export function planInventoryCursor(book: ScanCursorBook, now: Date, schemaMismatch = false): ScanCursorPlan {
  const reason = decideScanReconcile(book, now, { schemaMismatch });
  const full = reason !== "";
  return {
    full,
    since: full || !book.repos ? "" : book.repos.watermark,
    reason,
    prev: book.repos,
  };
}

/** Stable dedupe key. Numeric GitHub id wins; full name is the fallback. */
export function repoCursorKey(repo: Pick<CursorRepo, "id" | "fullName" | "name">): string {
  const id = repo.id.trim();
  if (id) return `id:${id}`;
  const name = (repo.fullName || repo.name).trim().toLowerCase();
  return name ? `name:${name}` : "";
}

/**
 * Upsert a delta into the previous page. Never deletes. Newest `pushedAt`
 * first; same-second siblings both stay, ordered by repo id.
 */
export function mergeInventoryRepos(previous: CursorRepo[], delta: CursorRepo[]): CursorRepo[] {
  const byKey = new Map<string, CursorRepo>();
  for (const repo of previous) {
    const key = repoCursorKey(repo);
    if (key) byKey.set(key, repo);
  }
  for (const repo of delta) {
    const key = repoCursorKey(repo);
    if (key) byKey.set(key, repo);
  }
  return [...byKey.values()].sort(compareReposNewestFirst);
}

function compareReposNewestFirst(a: CursorRepo, b: CursorRepo): number {
  const left = parseTimestamp(a.pushedAt);
  const right = parseTimestamp(b.pushedAt);
  if (left != null && right != null && left !== right) return right - left;
  if ((left != null) !== (right != null)) return left != null ? -1 : 1;
  return repoCursorKey(b).localeCompare(repoCursorKey(a));
}

export function cursorWatermarkFromRepos(
  repos: CursorRepo[],
  prev: ScanCursorWatermark | null,
  reconciled: boolean,
  now: Date,
  forkCount: number,
): ScanCursorWatermark {
  const updatedAt = now.toISOString();
  let newest = "";
  for (const repo of repos) {
    if (!repo.pushedAt) continue;
    if (!newest || cursorAfterWatermark(repo.pushedAt, newest)) newest = repo.pushedAt;
  }
  return {
    source: "repos",
    watermark: newest,
    collection: PUBLIC_SCAN_COLLECTION_VERSION,
    incrementalRuns: reconciled ? 0 : (prev?.incrementalRuns ?? 0) + 1,
    reconciledAt: reconciled ? updatedAt : prev?.reconciledAt || prev?.updatedAt || updatedAt,
    updatedAt,
    repos,
    forkCount: reconciled ? forkCount : (prev?.forkCount ?? forkCount),
  };
}

interface StoredBook {
  username?: string;
  schema?: number;
  repos?: ScanCursorWatermark | null;
}

function isWatermark(value: unknown): value is ScanCursorWatermark {
  if (!value || typeof value !== "object") return false;
  const mark = value as ScanCursorWatermark;
  return mark.source === "repos" && typeof mark.watermark === "string" && Array.isArray(mark.repos);
}

/** A row that does not decode, or whose schema is not current, is a missing book. */
export function decodeCursorBook(username: string, raw: string, revision: number): {
  book: ScanCursorBook;
  schemaMismatch: boolean;
} {
  const empty = emptyCursorBook(username);
  empty.revision = revision;
  let parsed: StoredBook;
  try {
    parsed = JSON.parse(raw) as StoredBook;
  } catch {
    return { book: empty, schemaMismatch: true };
  }
  if (parsed.schema !== SCAN_CURSOR_SCHEMA_VERSION) {
    return { book: empty, schemaMismatch: true };
  }
  empty.repos = isWatermark(parsed.repos) ? parsed.repos : null;
  return { book: empty, schemaMismatch: false };
}

export function encodeCursorBook(book: ScanCursorBook): string {
  const stored: StoredBook = {
    username: book.username.toLowerCase(),
    schema: SCAN_CURSOR_SCHEMA_VERSION,
    repos: book.repos,
  };
  return JSON.stringify(stored);
}

const CREATE_CURSOR_TABLE = `CREATE TABLE IF NOT EXISTS scan_source_cursors (
  username TEXT PRIMARY KEY,
  book TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;

let cursorSchemaReady: Promise<void> | null = null;

/**
 * Create the cursor table on first use. Production D1 skips the shared
 * `ensureSchema` batch, so this statement runs on the scan client itself.
 * `CREATE TABLE IF NOT EXISTS` is additive and does not touch
 * `public_scan_runs`. A failed create is not cached, so the next scan retries.
 */
export function ensureScanCursorSchema(db: Client): Promise<void> {
  if (!cursorSchemaReady) {
    cursorSchemaReady = db.execute(CREATE_CURSOR_TABLE).then(
      () => undefined,
      (error) => {
        cursorSchemaReady = null;
        throw error;
      },
    );
  }
  return cursorSchemaReady;
}

/** Test hook. Production keeps the table after the first successful create. */
export function resetScanCursorSchemaForTests(): void {
  cursorSchemaReady = null;
}

export async function loadScanCursors(db: Client, username: string): Promise<{
  book: ScanCursorBook;
  schemaMismatch: boolean;
}> {
  await ensureScanCursorSchema(db);
  const result = await db.execute({
    sql: `SELECT book, updated_at FROM scan_source_cursors WHERE username = ?`,
    args: [username.toLowerCase()],
  });
  const row = result.rows[0];
  if (!row) return { book: emptyCursorBook(username), schemaMismatch: false };
  const revision = Number(row.updated_at) || 0;
  return decodeCursorBook(username, String(row.book ?? ""), revision);
}

export async function saveScanCursors(db: Client, book: ScanCursorBook): Promise<void> {
  await ensureScanCursorSchema(db);
  const username = book.username.toLowerCase();
  const encoded = encodeCursorBook({ ...book, username, schema: SCAN_CURSOR_SCHEMA_VERSION });
  let now = Date.now();
  if (now <= book.revision) now = book.revision + 1;
  if (book.revision === 0) {
    const inserted = await db.execute({
      sql: `INSERT INTO scan_source_cursors (username, book, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(username) DO NOTHING`,
      args: [username, encoded, now],
    });
    if (Number(inserted.rowsAffected ?? 0) === 0) throw new ScanCursorConflictError();
    return;
  }
  const updated = await db.execute({
    sql: `UPDATE scan_source_cursors
          SET book = ?, updated_at = ?
          WHERE username = ? AND updated_at = ?`,
    args: [encoded, now, username, book.revision],
  });
  if (Number(updated.rowsAffected ?? 0) === 0) throw new ScanCursorConflictError();
}

/**
 * Write the staged book. A compare-and-swap conflict reloads once and writes
 * again. A second failure is logged and does not fail the scan: the public
 * row already committed.
 */
export async function commitPendingCursors(db: Client, pending: PendingScanCursors): Promise<void> {
  const username = pending.book.username.trim().toLowerCase();
  if (!username || pending.repos.length === 0) return;
  const mark = cursorWatermarkFromRepos(
    pending.repos,
    pending.reconciled ? pending.plan.prev : pending.book.repos,
    pending.reconciled,
    pending.now,
    pending.forkCount,
  );
  const book: ScanCursorBook = {
    ...pending.book,
    username,
    schema: SCAN_CURSOR_SCHEMA_VERSION,
    repos: mark,
  };
  try {
    await saveScanCursors(db, book);
  } catch (error) {
    if (!(error instanceof ScanCursorConflictError)) throw error;
    const fresh = await loadScanCursors(db, username);
    try {
      await saveScanCursors(db, { ...book, revision: fresh.book.revision });
    } catch (retryError) {
      console.error("scan_cursor_commit_failed", {
        username,
        category: retryError instanceof ScanCursorConflictError ? "cursor_conflict" : "cursor_write",
      });
    }
  }
}
