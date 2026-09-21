/**
 * Backfill D1 `scores` rows for the talent-import checkpoints.
 *
 * The checkpoints in scripts/talent-import/out/people/*.json hold metrics +
 * scoring for users that were never published through publishCompleteQuickScan,
 * so https://ghfind.com/u/<login> 404s. Local scripts cannot reach D1 directly,
 * so — like seed-talent.mts — this script only emits reviewable SQL; a human
 * applies it with wrangler:
 *
 *   node --import tsx scripts/talent-backfill-scores.mts
 *   pnpm exec wrangler d1 execute ghfind --remote --env production \
 *     --file scripts/talent-import/out/backfill-scores.sql
 *
 * The emitted statements reproduce publishCompleteQuickScan (src/lib/db.ts)
 * statement-for-statement:
 *   1. scores guarded upsert (upsertCanonicalScoreGuarded insert/overwrite
 *      branches, folded into INSERT ... ON CONFLICT with the same WHERE guard),
 *      plus the roast columns updateRoast would set afterwards (tags,
 *      roast_line, roast/roast_en with ROAST_CACHE_VERSION) and the
 *      followers/total_stars lift from recordProfileSnapshot's
 *      updateInfluenceStats.
 *   2. public_scan_runs archival INSERT ... WHERE NOT EXISTS (same columns,
 *      quick_scan = snapshot, sha256 snapshot hash).
 *   3. profile_snapshots append (recordProfileSnapshot) — repo arrays the
 *      checkpoints never stored are written as []; the id is derived
 *      deterministically from the username so re-runs stay idempotent.
 *   4. account_stats ensureAccountStats upsert.
 *
 * Every value is derived by running the real materializeCanonicalScore from
 * src/lib/score-materialization on a reconstructed ScanResult, so the stored
 * score is exactly what the current scorer produces from the checkpoint
 * metrics. Users whose checkpoint fails that canonical validation are skipped
 * and reported.
 */
import "./_env.mjs";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

import { materializeCanonicalScore } from "../src/lib/score-materialization";
import { ROAST_CACHE_VERSION, SCORE_CACHE_VERSION } from "../src/lib/cache-version";
import {
  PUBLIC_SCAN_COLLECTION_VERSION,
  PUBLIC_SCAN_REQUIRED_SOURCES,
  type PublicScanSourceStatus,
} from "../src/lib/scan-run-types";
import type { RawMetrics, ScanResult, Scoring } from "../src/lib/types";
import { buildCtx, buildRoastLine, buildRoastReport, buildTags } from "./roast-gen.mts";

const PEOPLE_DIR = new URL("./talent-import/out/people/", import.meta.url);
const OUT_SQL = new URL("./talent-import/out/backfill-scores.sql", import.meta.url);

// upsertCanonicalScoreGuarded only records prev_score when rescan gap >= 1h
// (PROGRESS_MIN_GAP_MS in src/lib/db.ts).
const PROGRESS_MIN_GAP_MS = 60 * 60 * 1000;

// PUBLIC_SCAN_COMPLETE_SOURCES in src/lib/db.ts.
const COMPLETE_SOURCES: PublicScanSourceStatus = Object.fromEntries(
  PUBLIC_SCAN_REQUIRED_SOURCES.map((source) => [source, "complete"]),
);

interface Checkpoint {
  login: string;
  fetched_at: number;
  metrics: RawMetrics;
  scoring: Scoring;
}

const q = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid numeric field");
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
};

// profile_snapshots is append-only with no natural unique key; a deterministic
// id makes the backfill re-runnable without duplicating rows.
function deterministicSnapshotId(username: string): string {
  const hex = createHash("sha256").update(`talent-backfill:${username}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildStatements(cp: Checkpoint): string[] {
  const scannedAt = cp.fetched_at;
  if (!Number.isSafeInteger(scannedAt) || scannedAt <= 0) {
    throw new Error(`invalid fetched_at: ${String(cp.fetched_at)}`);
  }
  const metrics = cp.metrics;
  // Rebuild the ScanResult the quick collector would have produced. The
  // checkpoints predate persistence of top_repos / recent_prs / flood_pr_titles
  // / impact_repos / verified_impact_prs / pinned_repos / organizations, so
  // those arrays are empty. scoring is recomputed by the current scorer — the
  // same replacement materializeCanonicalScore performs — so the stored
  // snapshot, its hash, and the scores row are mutually consistent.
  const scan: ScanResult = {
    metrics,
    top_repos: [],
    recent_prs: [],
    flood_pr_titles: [],
    impact_repos: [],
    verified_impact_prs: [],
    pinned_repos: [],
    organizations: [],
    scoring: cp.scoring,
  };
  const snapshot = JSON.stringify(scan);
  const snapshotHash = createHash("sha256").update(snapshot).digest("hex");
  const materialized = materializeCanonicalScore({
    snapshot,
    snapshotHash,
    username: metrics.username,
    scoreVersion: SCORE_CACHE_VERSION,
    collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    scannedAt,
    mode: "quick",
    sourceStatus: COMPLETE_SOURCES,
  });
  if (!materialized) {
    throw new Error("checkpoint failed canonical scan validation (materializeCanonicalScore returned null)");
  }
  // scan carries the recomputed v10 scoring; re-serialize so the stored
  // snapshot matches the materialized score bit-for-bit.
  const canonicalScan = materialized.scan;
  const canonicalSnapshot = JSON.stringify(canonicalScan);
  const canonicalSnapshotHash = createHash("sha256").update(canonicalSnapshot).digest("hex");

  const entry = materialized.scoreEntry;
  const username = entry.username;
  const scoring = canonicalScan.scoring;

  const ctx = buildCtx({
    username: metrics.username,
    displayName: metrics.name,
    m: metrics,
    scoring,
    topRepos: [],
    impactRepos: [],
    orgs: [],
    orgDisplay: "",
  });
  const tags = buildTags(ctx);
  const roastLine = buildRoastLine(ctx);
  const roastZh = buildRoastReport(ctx, "zh");
  const roastEn = buildRoastReport(ctx, "en");

  const tagsJson = JSON.stringify(tags);
  const roastLineJson = JSON.stringify(roastLine);
  const subScoresJson = JSON.stringify(entry.sub_scores);
  const riskAssessmentJson = JSON.stringify(entry.risk_assessment ?? null);
  const riskNotesJson = JSON.stringify(entry.risk_notes ?? []);
  const sourceStatusJson = JSON.stringify(COMPLETE_SOURCES);
  const metricsJson = JSON.stringify(metrics);
  const scoreWriteToken = randomUUID();

  // upsertCanonicalScoreGuarded: insert branch columns plus the roast artifacts
  // updateRoast attaches and the influence columns recordProfileSnapshot lifts.
  // The ON CONFLICT guard mirrors the overwrite branch's WHERE clause: only a
  // missing/non-canonical/older row is replaced, so re-running is a no-op once
  // the canonical row exists.
  const scoreColumns = [
    "username", "display_name", "avatar_url", "profile_url", "final_score", "tier",
    "tags", "roast_line", "roast", "roast_version", "roast_en", "roast_en_version",
    "risk_assessment", "risk_notes", "score_version", "score_write_token",
    "score_source_collection_version", "score_source_snapshot_hash",
    "bot_score", "sub_scores", "followers", "total_stars", "scanned_at",
  ];
  const scoreValues = [
    username,
    entry.display_name,
    entry.avatar_url,
    entry.profile_url,
    entry.final_score,
    entry.tier,
    tagsJson,
    roastLineJson,
    roastZh,
    ROAST_CACHE_VERSION,
    roastEn,
    ROAST_CACHE_VERSION,
    riskAssessmentJson,
    riskNotesJson,
    materialized.provenance.scoreVersion,
    scoreWriteToken,
    materialized.provenance.collectionVersion,
    canonicalSnapshotHash,
    entry.bot_score,
    subScoresJson,
    metrics.followers ?? null,
    metrics.total_stars ?? null,
    entry.scanned_at,
  ];
  const updateColumns = scoreColumns.filter(
    (column) => column !== "username" && column !== "scanned_at",
  );
  const scoresSql = `INSERT INTO scores
  (${scoreColumns.join(", ")})
VALUES (${scoreValues.map(q).join(", ")})
ON CONFLICT(username) DO UPDATE SET
  prev_score = CASE WHEN excluded.scanned_at - scores.scanned_at >= ${PROGRESS_MIN_GAP_MS} THEN scores.final_score ELSE scores.prev_score END,
  prev_scanned_at = CASE WHEN excluded.scanned_at - scores.scanned_at >= ${PROGRESS_MIN_GAP_MS} THEN scores.scanned_at ELSE scores.prev_scanned_at END,
  ${updateColumns.map((column) => `${column} = excluded.${column}`).join(",\n  ")},
  scanned_at = excluded.scanned_at
WHERE scores.score_version IS NOT ${q(materialized.provenance.scoreVersion)}
  OR scores.score_source_collection_version IS NOT ${q(materialized.provenance.collectionVersion)}
  OR scores.score_source_snapshot_hash IS NULL
  OR length(scores.score_source_snapshot_hash) != 64
  OR scores.score_source_snapshot_hash GLOB '*[^0-9a-f]*'
  OR scores.scanned_at < excluded.scanned_at;`;

  // ensureAccountStats.
  const accountStatsSql = `INSERT INTO account_stats (username, lookup_count, first_lookup_at, last_lookup_at)
VALUES (${q(username)}, 1, ${q(scannedAt)}, ${q(scannedAt)})
ON CONFLICT(username) DO UPDATE SET
  lookup_count = MAX(account_stats.lookup_count, excluded.lookup_count);`;

  // publishCompleteQuickScan's archival run insert (NOT EXISTS dedupe included).
  const runId = randomUUID();
  const publicScanRunSql = `INSERT INTO public_scan_runs
  (id, username, score_version, collection_version, state, coverage,
   source_status, quick_scan, snapshot, snapshot_hash,
   started_at, completed_at, updated_at)
SELECT ${q(runId)}, ${q(username)}, ${q(SCORE_CACHE_VERSION)}, ${q(PUBLIC_SCAN_COLLECTION_VERSION)}, 'complete_public', 'complete_public',
  ${q(sourceStatusJson)}, ${q(canonicalSnapshot)}, ${q(canonicalSnapshot)}, ${q(canonicalSnapshotHash)},
  ${q(scannedAt)}, ${q(scannedAt)}, ${q(scannedAt)}
WHERE NOT EXISTS (
  SELECT 1 FROM public_scan_runs
  WHERE username = ${q(username)} AND score_version = ${q(SCORE_CACHE_VERSION)} AND collection_version = ${q(PUBLIC_SCAN_COLLECTION_VERSION)}
    AND state = 'complete_public' AND snapshot_hash = ${q(canonicalSnapshotHash)} AND started_at = ${q(scannedAt)}
);`;

  // recordProfileSnapshot. scanned_at uses the checkpoint's fetched_at (the
  // production writer stamps Date.now(); the checkpoint time keeps this
  // idempotent and reflects when the data was actually collected).
  const profileSnapshotSql = `INSERT INTO profile_snapshots
  (id, username, scanned_at, top_repos, impact_repos, verified_prs,
   metrics, pinned_repos, organizations, signature_work, scan_version)
SELECT ${q(deterministicSnapshotId(username))}, ${q(username)}, ${q(scannedAt)},
  '[]', '[]', '[]', ${q(metricsJson)}, '[]', '[]', 'null', ${q(SCORE_CACHE_VERSION)}
WHERE NOT EXISTS (
  SELECT 1 FROM profile_snapshots WHERE id = ${q(deterministicSnapshotId(username))}
);`;

  return [scoresSql, accountStatsSql, publicScanRunSql, profileSnapshotSql];
}

const files = readdirSync(PEOPLE_DIR).filter((name) => name.endsWith(".json")).sort();
const skipped = new Map<string, string[]>();
let processed = 0;
const chunks: string[] = [
  "-- talent-backfill-scores: publishCompleteQuickScan-equivalent rows for talent-import checkpoints.",
  `-- score_version=${SCORE_CACHE_VERSION} collection_version=${PUBLIC_SCAN_COLLECTION_VERSION} roast_version=${ROAST_CACHE_VERSION}`,
  "-- apply with: pnpm exec wrangler d1 execute ghfind --remote --env production --file scripts/talent-import/out/backfill-scores.sql",
];

for (const file of files) {
  const login = file.slice(0, -".json".length);
  let cp: Checkpoint;
  try {
    const parsed = JSON.parse(readFileSync(new URL(file, PEOPLE_DIR), "utf8")) as Partial<Checkpoint>;
    if (!parsed || typeof parsed !== "object") throw new Error("checkpoint is not an object");
    if (!parsed.metrics || typeof parsed.metrics !== "object") throw new Error("missing metrics");
    if (!parsed.scoring || typeof parsed.scoring !== "object") throw new Error("missing scoring");
    cp = parsed as Checkpoint;
  } catch (error) {
    const reason = `unreadable checkpoint (${error instanceof Error ? error.message : String(error)})`;
    skipped.set(reason, [...(skipped.get(reason) ?? []), login]);
    continue;
  }
  try {
    const statements = buildStatements(cp);
    chunks.push(`-- @${cp.login}\n${statements.join("\n\n")}`);
    processed += 1;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    skipped.set(reason, [...(skipped.get(reason) ?? []), login]);
  }
}

writeFileSync(OUT_SQL, `${chunks.join("\n\n")}\n`);

console.log(`processed: ${processed}/${files.length}`);
let skippedTotal = 0;
for (const [reason, logins] of skipped) {
  skippedTotal += logins.length;
  console.log(`skipped (${logins.length}): ${reason}${logins.length <= 10 ? ` -> ${logins.join(", ")}` : ""}`);
}
if (skippedTotal === 0) console.log("skipped: 0");
console.log(`sql: ${OUT_SQL.pathname}`);
console.log(`next: pnpm exec wrangler d1 execute ghfind --remote --env production --file scripts/talent-import/out/backfill-scores.sql`);
