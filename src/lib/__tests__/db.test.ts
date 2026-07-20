import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROAST_CACHE_VERSION, SCORE_CACHE_VERSION } from "../cache-version";
import type { ScoreEntry, ScoreWriteIdentity } from "../db";
import { LEGACY_READ_FALLBACK } from "../release-versions";
import { PUBLIC_SCAN_COLLECTION_VERSION, type PublicScanSourceStatus } from "../scan-run-types";
import { score } from "../score";
import type { RawMetrics, ScanResult } from "../types";

let db: typeof import("../db");
let tmpDir: string;

const entry: ScoreEntry = {
  username: "archive-fixture",
  display_name: "Archive Fixture",
  avatar_url: null,
  profile_url: "https://profiles.example.invalid/archive-fixture",
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

const COMPLETE_PUBLIC_SOURCES: PublicScanSourceStatus = {
  quick: "complete",
  original_repos: "complete",
  native_prs: "complete",
  workflow_landings: "complete",
  commit_recovery: "complete",
};

function syntheticMetrics(
  username: string,
  overrides: Partial<RawMetrics> = {},
): RawMetrics {
  return {
    username,
    profile_url: `https://profiles.example.invalid/${username}`,
    avatar_url: "https://assets.example.invalid/avatar.png",
    name: "Synthetic Account",
    bio: "Synthetic database fixture",
    company: null,
    account_age_years: 4,
    created_at: "2022-01-01T00:00:00.000Z",
    followers: 20,
    following: 10,
    public_repos: 4,
    fetched_repo_count: 4,
    original_repo_count: 3,
    nonempty_original_repo_count: 3,
    fork_repo_count: 1,
    empty_original_repo_count: 0,
    total_stars: 80,
    max_stars: 50,
    merged_pr_count: 8,
    total_pr_count: 10,
    issues_created: 3,
    last_year_contributions: 320,
    activity_type_count: 3,
    contribution_years_active: 3,
    days_since_last_activity: 4,
    recent_merged_pr_sample: 8,
    recent_trivial_pr_count: 1,
    external_trivial_pr_count: 0,
    max_impact_repo_stars: 1_000,
    impact_pr_count: 2,
    impact_depth_raw: 1,
    star_inflation_suspect: false,
    closed_unmerged_pr_count: 2,
    pr_rejection_rate: 0.2,
    recent_pr_sample: 10,
    top_repo_pr_target: "fixture-owner/fixture-repository",
    top_repo_pr_share: 0.25,
    templated_pr_ratio: 0.1,
    pr_flood_suspect: false,
    ...overrides,
  };
}

function syntheticScan(
  username: string,
  metricOverrides: Partial<RawMetrics> = {},
): ScanResult {
  const metrics = syntheticMetrics(username, metricOverrides);
  return {
    metrics,
    top_repos: [],
    recent_prs: [],
    flood_pr_titles: [],
    impact_repos: [],
    verified_impact_prs: [],
    pinned_repos: [],
    organizations: [],
    scoring: score(metrics),
  };
}

function serializeScan(scan: ScanResult): { snapshot: string; snapshotHash: string } {
  const snapshot = JSON.stringify(scan);
  return {
    snapshot,
    snapshotHash: createHash("sha256").update(snapshot).digest("hex"),
  };
}

function canonicalBackfillCursor(input: {
  completedAt: number;
  runId: string;
  watermark: number;
}): string {
  return `bfs1.${Buffer.from(JSON.stringify(input)).toString("base64url")}`;
}

async function readScoreRow(username: string) {
  const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
  const result = await client.execute({
      sql: `SELECT username, final_score, score_version, score_source_collection_version,
                   score_source_snapshot_hash, scanned_at, score_write_token,
                   roast, roast_en, roast_version, roast_en_version
          FROM scores WHERE username = ? LIMIT 1`,
    args: [username.toLowerCase()],
  });
  return result.rows[0] ?? null;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ghroast-db-"));
  process.env.TURSO_DATABASE_URL = `file:${join(tmpDir, "test.db")}`;
  delete process.env.TURSO_AUTH_TOKEN;
  db = await import("../db");
});

afterAll(() => {
  delete process.env.TURSO_DATABASE_URL;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function writeScore(scoreEntry: ScoreEntry): Promise<ScoreWriteIdentity> {
  const identity = await db.recordScore(scoreEntry);
  if (!identity) throw new Error("expected synthetic score write");
  const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
  const snapshotHash = createHash("sha256")
    .update(`${scoreEntry.username}:${scoreEntry.scanned_at}:${scoreEntry.final_score}`)
    .digest("hex");
  await client.execute({
    sql: `UPDATE scores
          SET score_source_collection_version = ?, score_source_snapshot_hash = ?
          WHERE username = ? AND score_write_token = ? AND scanned_at = ?`,
    args: [
      PUBLIC_SCAN_COLLECTION_VERSION,
      snapshotHash,
      scoreEntry.username.toLowerCase(),
      identity.token,
      identity.scannedAt,
    ],
  });
  return identity;
}

async function writeLegacyReadFallback(username: string): Promise<void> {
  const identity = await db.recordScore({ ...entry, username });
  if (!identity) throw new Error("expected synthetic legacy score write");
  const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
  const scan = syntheticScan(username);
  scan.scoring.final_score = entry.final_score;
  const serialized = serializeScan(scan);
  const now = entry.scanned_at;
  await client.batch(
    [
      {
        sql: `UPDATE scores
              SET score_version = ?, score_source_collection_version = NULL,
                  score_source_snapshot_hash = NULL, roast = ?, roast_version = ?,
                  roast_en = ?, roast_en_version = ?
              WHERE username = ?`,
        args: [
          LEGACY_READ_FALLBACK.score,
          "## 旧版中文点评\n只读回放。",
          LEGACY_READ_FALLBACK.roast,
          "## Legacy English roast\nRead-only replay.",
          LEGACY_READ_FALLBACK.roast,
          username,
        ],
      },
      {
        sql: `INSERT INTO public_scan_runs
                (id, username, score_version, collection_version, state, coverage,
                 source_status, snapshot, snapshot_hash, started_at, completed_at, updated_at)
              VALUES (?, ?, ?, ?, 'complete_public', 'complete_public', ?, ?, ?, ?, ?, ?)`,
        args: [
          `legacy-read-${username}`,
          username,
          LEGACY_READ_FALLBACK.score,
          LEGACY_READ_FALLBACK.collection,
          JSON.stringify(COMPLETE_PUBLIC_SOURCES),
          serialized.snapshot,
          serialized.snapshotHash,
          now,
          now,
          now,
        ],
      },
    ],
    "write",
  );
}

describe("getArchivedRoast", () => {
  it("replays archived reports by username and language", async () => {
    const scoreWrite = await writeScore(entry);
    await db.updateRoast("archive-fixture", "## 中文报告", "zh", scoreWrite);
    await db.updateRoast("archive-fixture", "## English report", "en", scoreWrite);

    await expect(db.getArchivedRoast("ARCHIVE-FIXTURE", "zh")).resolves.toMatchObject({
      username: "archive-fixture",
      final_score: 95.2,
      tier: "夯",
      tags: entry.tags,
      report: "## 中文报告",
    });
    await expect(db.getArchivedRoast("archive-fixture", "en")).resolves.toMatchObject({
      report: "## English report",
    });
  });

  it("does not replay archived reports from a stale roast version", async () => {
    const scoreWrite = await writeScore({ ...entry, username: "stale-roast" });
    await db.updateRoast("stale-roast", "## stale report", "zh", scoreWrite);

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE scores SET roast_version = ? WHERE username = ?`,
      args: [`${ROAST_CACHE_VERSION}-old`, "stale-roast"],
    });

    await expect(db.getArchivedRoast("stale-roast", "zh")).resolves.toBeNull();
  });

  it("does not replay archived reports from rows without cache versions", async () => {
    const scoreWrite = await writeScore({ ...entry, username: "legacy-roast" });
    await db.updateRoast("legacy-roast", "## legacy report", "zh", scoreWrite);

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE scores
            SET score_version = NULL, roast_version = NULL
            WHERE username = ?`,
      args: ["legacy-roast"],
    });

    await expect(db.getArchivedRoast("legacy-roast", "zh")).resolves.toBeNull();
  });

  it("does not attach a previous-release roast to a target-release score", async () => {
    const username = "mixed-version-roast-fixture";
    const scoreWrite = await writeScore({ ...entry, username });
    await db.updateRoast(username, "## previous release report", "zh", scoreWrite);

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE scores
            SET score_version = 'v9', roast_version = 'v8'
            WHERE username = ?`,
      args: [username],
    });

    await expect(db.getArchivedRoast(username, "zh")).resolves.toBeNull();
    await expect(db.getAccountDetail(username)).resolves.toMatchObject({ roast: null });
  });

  it("serves an exact v5/v5/v3 artifact as a stale read without changing its score", async () => {
    const username = "legacy-read-fixture";
    await writeLegacyReadFallback(username);

    await expect(db.getAccountDetail(username)).resolves.toMatchObject({
      username,
      final_score: entry.final_score,
      score_version: LEGACY_READ_FALLBACK.score,
      legacy_read_fallback: true,
      tags: entry.tags,
      roast: "## 旧版中文点评\n只读回放。",
      roast_en: "## Legacy English roast\nRead-only replay.",
    });
    await expect(db.getLegacyReadFallbackRoast(username, "zh")).resolves.toMatchObject({
      username,
      final_score: entry.final_score,
      report: "## 旧版中文点评\n只读回放。",
    });
    await expect(db.getLegacyReadFallbackRoast(username, "en")).resolves.toMatchObject({
      report: "## Legacy English roast\nRead-only replay.",
    });
    await expect(db.getLegacyReadFallbackScan(username)).resolves.toMatchObject({
      metrics: { username },
      scoring: { final_score: entry.final_score },
    });
  });

  it("keeps a v5 profile readable when its old v3 snapshot is no longer usable", async () => {
    const username = "legacy-fallback-mismatch";
    await writeLegacyReadFallback(username);
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE public_scan_runs SET score_version = ? WHERE username = ?`,
      args: ["v6", username],
    });

    await expect(db.hasLegacyReadFallbackProfile(username)).resolves.toBe(true);
    await expect(db.getAccountDetail(username)).resolves.toMatchObject({
      final_score: entry.final_score,
      legacy_read_fallback: true,
      tags: entry.tags,
      roast: "## 旧版中文点评\n只读回放。",
      roast_en: "## Legacy English roast\nRead-only replay.",
    });
    await expect(db.getLegacyReadFallbackRoast(username, "zh")).resolves.toMatchObject({
      report: "## 旧版中文点评\n只读回放。",
    });
    await expect(db.getLegacyReadFallbackScan(username)).resolves.toBeNull();
  });

  it("does not turn a mismatched v3 snapshot into a complete scan", async () => {
    const username = "legacy-fallback-score-mismatch";
    await writeLegacyReadFallback(username);
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const tamperedSnapshot = syntheticScan(username);
    tamperedSnapshot.scoring.final_score = entry.final_score + 1;
    const serialized = serializeScan(tamperedSnapshot);
    await client.execute({
      sql: `UPDATE public_scan_runs SET snapshot = ?, snapshot_hash = ? WHERE username = ?`,
      args: [serialized.snapshot, serialized.snapshotHash, username],
    });

    await expect(db.getAccountDetail(username)).resolves.toMatchObject({
      final_score: entry.final_score,
      legacy_read_fallback: true,
      tags: entry.tags,
      roast: "## 旧版中文点评\n只读回放。",
      roast_en: "## Legacy English roast\nRead-only replay.",
    });
    await expect(db.getLegacyReadFallbackRoast(username, "zh")).resolves.toMatchObject({
      report: "## 旧版中文点评\n只读回放。",
    });
    await expect(db.getLegacyReadFallbackScan(username)).resolves.toBeNull();
  });

  it("clears generated reports when the deterministic score identity changes", async () => {
    const username = "score-change-fixture";
    const scoreWrite = await writeScore({ ...entry, username, final_score: 91 });
    await db.updateRoast(username, "## report before score change", "zh", scoreWrite);
    await expect(db.getAccountDetail(username)).resolves.toMatchObject({
      roast: "## report before score change",
    });

    await db.recordScore({
      ...entry,
      username,
      final_score: 92,
      scanned_at: entry.scanned_at + 1,
    });
    await expect(db.getAccountDetail(username)).resolves.toMatchObject({
      final_score: 92,
      roast: null,
      roast_en: null,
    });
  });

  it("rejects a late roast when the persisted score is not canonical", async () => {
    const username = "late-report-fixture";
    const scoreWrite = await writeScore({ ...entry, username });
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE scores
            SET score_version = ?, roast = NULL, roast_version = NULL
            WHERE username = ?`,
      args: [`${SCORE_CACHE_VERSION}-previous`, username],
    });

    await expect(db.updateRoast(username, "## late report", "zh", scoreWrite)).resolves.toBe(false);
    const stored = await client.execute({
      sql: `SELECT roast, roast_version FROM scores WHERE username = ?`,
      args: [username],
    });
    const snapshots = await client.execute({
      sql: `SELECT COUNT(*) AS count FROM score_snapshots WHERE username = ?`,
      args: [username],
    });
    expect(stored.rows[0]).toMatchObject({ roast: null, roast_version: null });
    expect(Number(snapshots.rows[0]?.count)).toBe(0);
  });

  it("rejects same-version reports and scores that arrive out of order", async () => {
    const username = "same-version-race-fixture";
    const firstWrite = await writeScore({
      ...entry,
      username,
      final_score: 80,
      scanned_at: entry.scanned_at + 10,
    });
    const secondWrite = await writeScore({
      ...entry,
      username,
      final_score: 90,
      scanned_at: entry.scanned_at + 20,
    });

    await expect(
      db.updateRoast(username, "## report from older scan", "zh", firstWrite),
    ).resolves.toBe(false);
    await expect(
      db.updateRoast(username, "## report from latest scan", "zh", secondWrite),
    ).resolves.toBe(true);
    await expect(
      db.recordScore({
        ...entry,
        username,
        final_score: 70,
        scanned_at: entry.scanned_at + 15,
      }),
    ).resolves.toBeNull();
    await expect(db.getAccountDetail(username)).resolves.toMatchObject({
      final_score: 90,
      roast: "## report from latest scan",
    });
  });
});

describe("score snapshots", () => {
  it("stores one generated-at stub when a completed roast is persisted", async () => {
    const username = "roast-snapshot";
    const before = Date.now();
    const firstWrite = await writeScore({ ...entry, username, final_score: 90 });
    await db.updateRoast(username, "## first report", "zh", firstWrite);
    const secondWrite = await writeScore({
      ...entry,
      username,
      final_score: 96.1,
      scanned_at: entry.scanned_at + 2 * 60 * 60 * 1000,
    });
    await db.updateRoast(username, "## second report", "en", secondWrite);
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

describe("canonical score materialization", () => {
  async function enqueueAndClaim(
    username: string,
    versions: { scoreVersion: string; collectionVersion: string } = {
      scoreVersion: SCORE_CACHE_VERSION,
      collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    },
  ) {
    const queued = await db.enqueuePublicScan(username, versions);
    if (!queued || "rejection" in queued) {
      throw new Error(`expected a synthetic durable job for ${username}`);
    }
    const lease = await db.claimPublicScanJob({
      jobId: queued.job.id,
      collectionVersion: versions.collectionVersion,
    });
    if (!lease) throw new Error(`expected a synthetic lease for ${username}`);
    return { queued, lease };
  }

  it("publishes a complete quick result with canonical score provenance", async () => {
    const username = "quick-materialization-fixture";
    const scannedAt = 1_910_000_000_000;
    const scan = syntheticScan(username);
    const { snapshotHash } = serializeScan(scan);

    await expect(db.publishCompleteQuickScan(scan, scannedAt)).resolves.toMatchObject({
      scannedAt,
      token: expect.any(String),
    });
    await expect(readScoreRow(username)).resolves.toMatchObject({
      username,
      final_score: score(scan.metrics).final_score,
      score_version: SCORE_CACHE_VERSION,
      score_source_collection_version: PUBLIC_SCAN_COLLECTION_VERSION,
      score_source_snapshot_hash: snapshotHash,
      scanned_at: scannedAt,
    });
  });

  it("reuses the same score identity and run for a repeated quick snapshot", async () => {
    const username = "quick-idempotency-fixture";
    const scannedAt = 1_910_000_010_000;
    const scan = syntheticScan(username);
    const { snapshotHash } = serializeScan(scan);

    const first = await db.publishCompleteQuickScan(scan, scannedAt);
    const second = await db.publishCompleteQuickScan(scan, scannedAt);
    expect(second).toEqual(first);

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const runs = await client.execute({
      sql: `SELECT COUNT(*) AS count FROM public_scan_runs
            WHERE username = ? AND collection_version = ? AND snapshot_hash = ?`,
      args: [username, PUBLIC_SCAN_COLLECTION_VERSION, snapshotHash],
    });
    expect(Number(runs.rows[0]?.count)).toBe(1);
  });

  it("publishes a repeated snapshot as the latest run after an intervening snapshot", async () => {
    const username = "quick-snapshot-ordering-fixture";
    const firstScan = syntheticScan(username, { followers: 10 });
    const interveningScan = syntheticScan(username, { followers: 20 });
    const first = serializeScan(firstScan);
    const firstScannedAt = 1_910_000_011_000;
    const interveningScannedAt = firstScannedAt + 1_000;
    const repeatedScannedAt = interveningScannedAt + 1_000;

    await expect(db.publishCompleteQuickScan(firstScan, firstScannedAt)).resolves.toBeTruthy();
    await expect(
      db.publishCompleteQuickScan(interveningScan, interveningScannedAt),
    ).resolves.toBeTruthy();
    await expect(db.publishCompleteQuickScan(firstScan, repeatedScannedAt)).resolves.toMatchObject({
      scannedAt: repeatedScannedAt,
    });

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const repeatedRuns = await client.execute({
      sql: `SELECT COUNT(*) AS count FROM public_scan_runs
            WHERE username = ? AND collection_version = ? AND snapshot_hash = ?`,
      args: [username, PUBLIC_SCAN_COLLECTION_VERSION, first.snapshotHash],
    });
    expect(Number(repeatedRuns.rows[0]?.count)).toBe(2);
    await expect(
      db.getLatestPublicScanRun(username, {
        scoreVersion: SCORE_CACHE_VERSION,
        collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      }),
    ).resolves.toMatchObject({
      snapshotHash: first.snapshotHash,
      startedAt: repeatedScannedAt,
    });
  });

  it("atomically completes a canonical durable run and materializes its score", async () => {
    const username = "durable-materialization-fixture";
    const scan = syntheticScan(username, {
      merged_pr_count: 12,
      recent_merged_pr_sample: 8,
      total_pr_count: 14,
    });
    const serialized = serializeScan(scan);
    const { queued, lease } = await enqueueAndClaim(username);

    await expect(
      db.completePublicScanRun({
        jobId: queued.job.id,
        runId: queued.run.id,
        leaseToken: lease.leaseToken,
        coverage: "complete_public",
        sourceStatus: COMPLETE_PUBLIC_SOURCES,
        ...serialized,
      }),
    ).resolves.toBe(true);
    await expect(db.getPublicScanRun(queued.run.id)).resolves.toMatchObject({
      state: "complete_public",
      coverage: "complete_public",
      snapshotHash: serialized.snapshotHash,
    });
    await expect(readScoreRow(username)).resolves.toMatchObject({
      score_version: SCORE_CACHE_VERSION,
      score_source_collection_version: PUBLIC_SCAN_COLLECTION_VERSION,
      score_source_snapshot_hash: serialized.snapshotHash,
      scanned_at: queued.run.startedAt,
    });
  });

  it("rolls back durable completion when canonical score materialization cannot commit", async () => {
    const username = "atomic-rollback-fixture";
    const serialized = serializeScan(
      syntheticScan(username, {
        merged_pr_count: 12,
        recent_merged_pr_sample: 8,
        total_pr_count: 14,
      }),
    );
    const { queued, lease } = await enqueueAndClaim(username);
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute(`CREATE TRIGGER reject_synthetic_score_insert
      BEFORE INSERT ON scores
      WHEN NEW.username = '${username}'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic score insert rejection');
      END`);

    try {
      await expect(
        db.completePublicScanRun({
          jobId: queued.job.id,
          runId: queued.run.id,
          leaseToken: lease.leaseToken,
          coverage: "complete_public",
          sourceStatus: COMPLETE_PUBLIC_SOURCES,
          ...serialized,
        }),
      ).rejects.toThrow();
    } finally {
      await client.execute("DROP TRIGGER reject_synthetic_score_insert");
    }

    await expect(readScoreRow(username)).resolves.toBeNull();
    await expect(db.getPublicScanRun(queued.run.id)).resolves.toMatchObject({
      state: "running",
      coverage: "partial_public",
      snapshot: null,
      snapshotHash: null,
    });
    await expect(
      db.failPublicScanJob({
        jobId: queued.job.id,
        runId: queued.run.id,
        leaseToken: lease.leaseToken,
        error: "synthetic cleanup",
      }),
    ).resolves.toBe(true);
  });

  it("rejects partial or damaged durable publication without writing a score", async () => {
    const username = "rejected-materialization-fixture";
    const validScan = syntheticScan(username, {
      merged_pr_count: 12,
      recent_merged_pr_sample: 8,
      total_pr_count: 14,
    });
    const valid = serializeScan(validScan);
    const { queued, lease } = await enqueueAndClaim(username);

    await expect(
      db.completePublicScanRun({
        jobId: queued.job.id,
        runId: queued.run.id,
        leaseToken: lease.leaseToken,
        coverage: "partial_public",
        sourceStatus: COMPLETE_PUBLIC_SOURCES,
        ...valid,
      }),
    ).resolves.toBe(false);
    await expect(readScoreRow(username)).resolves.toBeNull();

    const damaged = serializeScan({
      ...validScan,
      recent_prs: [{ title: "damaged synthetic fixture" }] as ScanResult["recent_prs"],
    });
    await expect(
      db.completePublicScanRun({
        jobId: queued.job.id,
        runId: queued.run.id,
        leaseToken: lease.leaseToken,
        coverage: "complete_public",
        sourceStatus: COMPLETE_PUBLIC_SOURCES,
        ...damaged,
      }),
    ).resolves.toBe(false);
    await expect(readScoreRow(username)).resolves.toBeNull();
    await expect(db.getPublicScanRun(queued.run.id)).resolves.toMatchObject({
      state: "running",
      coverage: "partial_public",
      snapshot: null,
      snapshotHash: null,
    });
    await expect(
      db.failPublicScanJob({
        jobId: queued.job.id,
        runId: queued.run.id,
        leaseToken: lease.leaseToken,
        error: "synthetic cleanup",
      }),
    ).resolves.toBe(true);
  });

  it("does not let an older canonical run overwrite a newer quick score", async () => {
    const username = "late-canonical-fixture";
    const olderScan = syntheticScan(username, {
      followers: 5,
      merged_pr_count: 12,
      recent_merged_pr_sample: 8,
      total_pr_count: 14,
    });
    const older = serializeScan(olderScan);
    const { queued, lease } = await enqueueAndClaim(username);
    const newerScan = syntheticScan(username, { followers: 200, total_stars: 500 });
    const newer = serializeScan(newerScan);
    const newerScannedAt = queued.run.startedAt + 10_000;

    await expect(db.publishCompleteQuickScan(newerScan, newerScannedAt)).resolves.toMatchObject({
      scannedAt: newerScannedAt,
    });
    await expect(
      db.completePublicScanRun({
        jobId: queued.job.id,
        runId: queued.run.id,
        leaseToken: lease.leaseToken,
        coverage: "complete_public",
        sourceStatus: COMPLETE_PUBLIC_SOURCES,
        ...older,
      }),
    ).resolves.toBe(true);

    await expect(readScoreRow(username)).resolves.toMatchObject({
      score_source_snapshot_hash: newer.snapshotHash,
      scanned_at: newerScannedAt,
    });
    await expect(db.getPublicScanRun(queued.run.id)).resolves.toMatchObject({
      state: "complete_public",
      snapshotHash: older.snapshotHash,
    });
    await expect(
      db.getLatestPublicScanRun(username, {
        scoreVersion: SCORE_CACHE_VERSION,
        collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      }),
    ).resolves.toMatchObject({ snapshotHash: newer.snapshotHash });
  });

  it("replaces a newer-timestamp legacy row with a trusted canonical snapshot", async () => {
    const username = "legacy-does-not-block-canonical-fixture";
    const canonicalScannedAt = 1_910_000_020_000;
    const scan = syntheticScan(username, { followers: 120, total_stars: 350 });
    const serialized = serializeScan(scan);
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });

    await db.recordScore({
      ...entry,
      username,
      final_score: 4,
      scanned_at: canonicalScannedAt + 60_000,
    });
    await client.execute({
      sql: `UPDATE scores
            SET roast = 'legacy report', roast_en = 'legacy report',
                roast_version = 'legacy', roast_en_version = 'legacy'
            WHERE username = ?`,
      args: [username],
    });

    await expect(db.publishCompleteQuickScan(scan, canonicalScannedAt)).resolves.toMatchObject({
      scannedAt: canonicalScannedAt,
    });
    await expect(readScoreRow(username)).resolves.toMatchObject({
      final_score: scan.scoring.final_score,
      score_version: SCORE_CACHE_VERSION,
      score_source_collection_version: PUBLIC_SCAN_COLLECTION_VERSION,
      score_source_snapshot_hash: serialized.snapshotHash,
      scanned_at: canonicalScannedAt,
      roast: null,
      roast_en: null,
      roast_version: null,
      roast_en_version: null,
    });
  });

  it("dry-runs and idempotently applies only the latest complete canonical snapshot", async () => {
    const username = "backfill-materialization-fixture";
    const historicalVersions = {
      scoreVersion: `${SCORE_CACHE_VERSION}-previous`,
      collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    };
    const backfillStartedAt = 2_100_000_000_000;
    const older = serializeScan(
      syntheticScan(username, {
        followers: 5,
        merged_pr_count: 12,
        recent_merged_pr_sample: 8,
        total_pr_count: 14,
      }),
    );
    const newer = serializeScan(
      syntheticScan(username, {
        followers: 250,
        total_stars: 600,
        merged_pr_count: 16,
        recent_merged_pr_sample: 8,
        total_pr_count: 18,
      }),
    );
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });

    const first = await enqueueAndClaim(username, historicalVersions);
    await client.execute({
      sql: "UPDATE public_scan_runs SET started_at = ? WHERE id = ?",
      args: [backfillStartedAt, first.queued.run.id],
    });
    await expect(
      db.completePublicScanRun({
        jobId: first.queued.job.id,
        runId: first.queued.run.id,
        leaseToken: first.lease.leaseToken,
        coverage: "complete_public",
        sourceStatus: COMPLETE_PUBLIC_SOURCES,
        ...older,
      }),
    ).resolves.toBe(true);

    const second = await enqueueAndClaim(username, historicalVersions);
    await client.execute({
      sql: "UPDATE public_scan_runs SET started_at = ? WHERE id = ?",
      args: [backfillStartedAt + 1_000, second.queued.run.id],
    });
    await expect(
      db.completePublicScanRun({
        jobId: second.queued.job.id,
        runId: second.queued.run.id,
        leaseToken: second.lease.leaseToken,
        coverage: "complete_public",
        sourceStatus: COMPLETE_PUBLIC_SOURCES,
        ...newer,
      }),
    ).resolves.toBe(true);

    const firstCompletedAt = 2_110_000_000_000;
    const secondCompletedAt = firstCompletedAt + 1_000;
    await client.batch([
      {
        sql: "UPDATE public_scan_runs SET completed_at = ? WHERE id = ?",
        args: [firstCompletedAt, first.queued.run.id],
      },
      {
        sql: "UPDATE public_scan_runs SET completed_at = ? WHERE id = ?",
        args: [secondCompletedAt, second.queued.run.id],
      },
    ]);
    const cursor = canonicalBackfillCursor({
      completedAt: firstCompletedAt - 1,
      runId: "synthetic-cursor",
      watermark: secondCompletedAt + 1_000,
    });
    await expect(readScoreRow(username)).resolves.toBeNull();
    await expect(
      db.backfillCanonicalScoresPage({ apply: false, limit: 10, cursor }),
    ).resolves.toEqual({
      dryRun: true,
      processed: 1,
      eligible: 1,
      materialized: 0,
      skipped: 0,
      rejected: 0,
      failed: 0,
      nextCursor: null,
    });
    await expect(readScoreRow(username)).resolves.toBeNull();

    await expect(
      db.backfillCanonicalScoresPage({ apply: true, limit: 10, cursor }),
    ).resolves.toMatchObject({
      dryRun: false,
      processed: 1,
      eligible: 1,
      materialized: 1,
      skipped: 0,
      rejected: 0,
      failed: 0,
    });
    await expect(readScoreRow(username)).resolves.toMatchObject({
      score_version: SCORE_CACHE_VERSION,
      score_source_collection_version: PUBLIC_SCAN_COLLECTION_VERSION,
      score_source_snapshot_hash: newer.snapshotHash,
      scanned_at: backfillStartedAt + 1_000,
    });

    await expect(
      db.backfillCanonicalScoresPage({ apply: true, limit: 10, cursor }),
    ).resolves.toMatchObject({
      processed: 1,
      eligible: 1,
      materialized: 0,
      skipped: 1,
      rejected: 0,
      failed: 0,
    });
  });

  it("returns a retry cursor that does not skip a failed backfill row", async () => {
    const username = "backfill-retry-fixture";
    const historicalVersions = {
      scoreVersion: `${SCORE_CACHE_VERSION}-previous-retry`,
      collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    };
    const startedAt = 2_120_000_000_000;
    const completedAt = startedAt + 1_000;
    const serialized = serializeScan(
      syntheticScan(username, {
        merged_pr_count: 12,
        recent_merged_pr_sample: 8,
        total_pr_count: 14,
      }),
    );
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const { queued, lease } = await enqueueAndClaim(username, historicalVersions);
    await client.execute({
      sql: "UPDATE public_scan_runs SET started_at = ? WHERE id = ?",
      args: [startedAt, queued.run.id],
    });
    await expect(
      db.completePublicScanRun({
        jobId: queued.job.id,
        runId: queued.run.id,
        leaseToken: lease.leaseToken,
        coverage: "complete_public",
        sourceStatus: COMPLETE_PUBLIC_SOURCES,
        ...serialized,
      }),
    ).resolves.toBe(true);
    await client.execute({
      sql: "UPDATE public_scan_runs SET completed_at = ? WHERE id = ?",
      args: [completedAt, queued.run.id],
    });

    const cursor = canonicalBackfillCursor({
      completedAt: completedAt - 1,
      runId: "retry-cursor",
      watermark: completedAt + 1_000,
    });
    await client.execute(`CREATE TRIGGER reject_backfill_retry_fixture
      BEFORE INSERT ON scores
      WHEN NEW.username = '${username}'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic backfill rejection');
      END`);

    let retryCursor: string | null = null;
    try {
      const failed = await db.backfillCanonicalScoresPage({
        apply: true,
        limit: 10,
        cursor,
      });
      expect(failed).toMatchObject({
        processed: 1,
        eligible: 1,
        materialized: 0,
        failed: 1,
        nextCursor: expect.any(String),
      });
      retryCursor = failed?.nextCursor ?? null;
    } finally {
      await client.execute("DROP TRIGGER reject_backfill_retry_fixture");
    }

    expect(retryCursor).not.toBeNull();
    await expect(
      db.backfillCanonicalScoresPage({ apply: true, limit: 10, cursor: retryCursor }),
    ).resolves.toMatchObject({
      processed: 1,
      eligible: 1,
      materialized: 1,
      failed: 0,
    });
    await expect(readScoreRow(username)).resolves.toMatchObject({
      score_source_snapshot_hash: serialized.snapshotHash,
      scanned_at: startedAt,
    });
  });
});

describe("durable public scan jobs", () => {
  const versions = { scoreVersion: "test-score-v1", collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION };

  async function enqueue(username: string) {
    const result = await db.enqueuePublicScan(username, versions);
    if (!result || "rejection" in result) {
      throw new Error(`expected durable job for ${username}`);
    }
    return result;
  }

  async function claim(
    jobId: string | undefined,
    collectionVersion = PUBLIC_SCAN_COLLECTION_VERSION,
  ) {
    return db.claimPublicScanJob({ jobId, collectionVersion });
  }

  it("isolates admission and claim by collection version", async () => {
    const obsoleteCollection = "obsolete-collection-capacity-fixture";
    const obsolete = await db.enqueuePublicScan("obsolete-capacity-fixture", {
      scoreVersion: "obsolete-score-fixture",
      collectionVersion: obsoleteCollection,
    });
    if (!obsolete || "rejection" in obsolete) throw new Error("expected obsolete fixture job");

    const canonical = await db.enqueuePublicScan("canonical-capacity-fixture", {
      ...versions,
      admission: {
        bucket: "canonical-capacity-fixture",
        limit: 1,
        windowMs: 60_000,
        maxActiveJobs: 1,
      },
    });
    expect(canonical && !("rejection" in canonical) && canonical.created).toBe(true);
    await expect(
      db.claimPublicScanJob({
        jobId: obsolete.job.id,
        collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      }),
    ).resolves.toBeNull();

    const obsoleteLease = await claim(obsolete.job.id, obsoleteCollection);
    await expect(
      db.failPublicScanJob({
        jobId: obsolete.job.id,
        runId: obsolete.run.id,
        leaseToken: obsoleteLease!.leaseToken,
        error: "synthetic cleanup",
      }),
    ).resolves.toBe(true);
    if (!canonical || "rejection" in canonical) throw new Error("expected canonical fixture job");
    const canonicalLease = await claim(canonical.job.id);
    await expect(
      db.failPublicScanJob({
        jobId: canonical.job.id,
        runId: canonical.run.id,
        leaseToken: canonicalLease!.leaseToken,
        error: "synthetic cleanup",
      }),
    ).resolves.toBe(true);
  });

  it("returns only requested complete collection snapshots in completion order", async () => {
    const username = "collection-read-order-fixture";
    const serialized = serializeScan(syntheticScan(username));
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const sources = JSON.stringify(COMPLETE_PUBLIC_SOURCES);
    const completedAt = Date.now();
    await client.batch(
      [
        {
          sql: `INSERT INTO public_scan_runs
                  (id, username, score_version, collection_version, state, coverage,
                   source_status, snapshot, snapshot_hash, started_at, completed_at, updated_at)
                VALUES (?, ?, ?, ?, 'complete_public', 'complete_public', ?, ?, ?, ?, ?, ?)`,
          args: [
            "collection-read-v3-older",
            username,
            "legacy-score-fixture",
            "v3",
            sources,
            serialized.snapshot,
            serialized.snapshotHash,
            completedAt - 2,
            completedAt - 2,
            completedAt - 2,
          ],
        },
        {
          sql: `INSERT INTO public_scan_runs
                  (id, username, score_version, collection_version, state, coverage,
                   source_status, snapshot, snapshot_hash, started_at, completed_at, updated_at)
                VALUES (?, ?, ?, ?, 'complete_public', 'complete_public', ?, ?, ?, ?, ?, ?)`,
          args: [
            "collection-read-v3-newer",
            username,
            "legacy-score-fixture",
            "v3",
            sources,
            serialized.snapshot,
            serialized.snapshotHash,
            completedAt - 1,
            completedAt - 1,
            completedAt - 1,
          ],
        },
        {
          sql: `INSERT INTO public_scan_runs
                  (id, username, score_version, collection_version, state, coverage,
                   source_status, snapshot, snapshot_hash, started_at, completed_at, updated_at)
                VALUES (?, ?, ?, ?, 'complete_public', 'complete_public', ?, ?, ?, ?, ?, ?)`,
          args: [
            "collection-read-non-formal",
            username,
            "non-formal-score-fixture",
            "v5",
            sources,
            serialized.snapshot,
            serialized.snapshotHash,
            completedAt,
            completedAt,
            completedAt,
          ],
        },
      ],
      "write",
    );

    await expect(db.getCompletePublicScanRuns(username, "v3")).resolves.toMatchObject([
      { id: "collection-read-v3-newer", collectionVersion: "v3" },
      { id: "collection-read-v3-older", collectionVersion: "v3" },
    ]);
  });

  it("dry-runs and applies obsolete-job quarantine in bounded aggregate-only batches", async () => {
    const obsoleteCollection = "obsolete-collection-quarantine-fixture";
    const obsoleteJobs = [];
    for (let index = 0; index < 3; index++) {
      const queued = await db.enqueuePublicScan(`obsolete-quarantine-${index}`, {
        scoreVersion: "obsolete-score-fixture",
        collectionVersion: obsoleteCollection,
      });
      if (!queued || "rejection" in queued) throw new Error("expected obsolete fixture job");
      obsoleteJobs.push(queued);
    }
    const running = await claim(obsoleteJobs[0].job.id, obsoleteCollection);
    const slot = await db.acquirePublicScanExecutionLease({
      jobId: obsoleteJobs[0].job.id,
      leaseToken: running!.leaseToken,
    });
    expect(slot).toBe(1);

    await expect(
      db.quarantineObsoletePublicScanJobs({
        canonicalCollectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
        limit: 2,
      }),
    ).resolves.toEqual({
      dryRun: true,
      selected: 2,
      quarantined: 0,
      remainingActive: 3,
      deferredActive: 1,
    });
    await expect(db.getPublicScanRun(obsoleteJobs[0].run.id)).resolves.toMatchObject({
      state: "running",
    });

    const applied = await db.quarantineObsoletePublicScanJobs({
      canonicalCollectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      apply: true,
      limit: 2,
    });
    expect(applied).toEqual({
      dryRun: false,
      selected: 2,
      quarantined: 2,
      remainingActive: 1,
      deferredActive: 1,
    });
    expect(Object.keys(applied!).sort()).toEqual([
      "deferredActive",
      "dryRun",
      "quarantined",
      "remainingActive",
      "selected",
    ]);

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const leaseRow = await client.execute({
      sql: `SELECT job_id, lease_token, lease_expires_at
            FROM public_scan_execution_leases
            WHERE slot = ?`,
      args: [slot!],
    });
    expect(leaseRow.rows[0]).toMatchObject({
      job_id: obsoleteJobs[0].job.id,
      lease_token: running!.leaseToken,
    });

    const summary = await db.getPublicScanJobVersionSummary();
    expect(summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collectionVersion: obsoleteCollection,
          state: "failed",
          count: 2,
        }),
        expect.objectContaining({
          collectionVersion: obsoleteCollection,
          state: "running",
          count: 1,
        }),
      ]),
    );
    await client.execute({
      sql: `UPDATE public_scan_jobs SET lease_expires_at = ? WHERE id = ?`,
      args: [Date.now() - 1, obsoleteJobs[0].job.id],
    });
    await expect(
      db.quarantineObsoletePublicScanJobs({
        canonicalCollectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
        apply: true,
        limit: 1_000,
      }),
    ).resolves.toMatchObject({ quarantined: 1, remainingActive: 0, deferredActive: 0 });
    const heldLease = await client.execute({
      sql: `SELECT job_id FROM public_scan_execution_leases WHERE slot = ?`,
      args: [slot!],
    });
    expect(heldLease.rows[0]?.job_id).toBe(obsoleteJobs[0].job.id);
    await db.releasePublicScanExecutionLease({
      slot: slot!,
      jobId: obsoleteJobs[0].job.id,
      leaseToken: running!.leaseToken,
    });
  });

  it("dedupes active work, persists progress, and publishes only with its lease", async () => {
    const first = await enqueue("history-heavy");
    const second = await enqueue("HISTORY-HEAVY");

    expect(first?.created).toBe(true);
    expect(second).toMatchObject({ created: false, run: { id: first?.run.id }, job: { id: first?.job.id } });

    const firstLease = await claim(first?.job.id);
    expect(firstLease).toMatchObject({ job: { phase: "quick", state: "running" } });
    expect(firstLease?.leaseToken).toBeTruthy();

    const sources = {
      quick: "complete",
      original_repos: "pending",
      native_prs: "pending",
      workflow_landings: "pending",
      commit_recovery: "pending",
    } as const;
    await expect(
      db.savePublicScanQuickResult({
        jobId: first!.job.id,
        runId: first!.run.id,
        leaseToken: firstLease!.leaseToken,
        quickScan: '{"metrics":{"username":"history-heavy"}}',
        sourceStatus: sources,
      }),
    ).resolves.toBe(true);
    await expect(
      db.savePublicScanJobProgress({
        jobId: first!.job.id,
        runId: first!.run.id,
        leaseToken: firstLease!.leaseToken,
        phase: "merged_prs",
        payload: '{"after":"cursor-1"}',
        sourceStatus: sources,
      }),
    ).resolves.toBe(true);

    const secondLease = await claim(first!.job.id);
    expect(secondLease).toMatchObject({ job: { phase: "merged_prs" } });
    await expect(
      db.completePublicScanRun({
        jobId: first!.job.id,
        runId: first!.run.id,
        leaseToken: firstLease!.leaseToken,
        coverage: "complete_public",
        sourceStatus: { ...sources, native_prs: "complete", workflow_landings: "complete", commit_recovery: "complete", original_repos: "complete" },
        snapshot: '{"complete":true}',
        snapshotHash: "snapshot-a",
      }),
    ).resolves.toBe(false);
    const snapshot = '{"complete":true}';
    await expect(
      db.completePublicScanRun({
        jobId: first!.job.id,
        runId: first!.run.id,
        leaseToken: secondLease!.leaseToken,
        coverage: "complete_public",
        sourceStatus: sources,
        snapshot,
        snapshotHash: "snapshot-a",
      }),
    ).resolves.toBe(false);
    await expect(
      db.completePublicScanRun({
        jobId: first!.job.id,
        runId: first!.run.id,
        leaseToken: secondLease!.leaseToken,
        coverage: "complete_public",
        sourceStatus: { ...sources, native_prs: "complete", workflow_landings: "complete", commit_recovery: "complete", original_repos: "complete" },
        snapshot,
        snapshotHash: createHash("sha256").update(snapshot).digest("hex"),
      }),
    ).resolves.toBe(true);

    await expect(db.getLatestPublicScanRun("history-heavy", versions)).resolves.toMatchObject({
      id: first!.run.id,
      state: "complete_public",
      coverage: "complete_public",
      snapshotHash: createHash("sha256").update(snapshot).digest("hex"),
      sourceStatus: { native_prs: "complete", commit_recovery: "complete" },
    });
    await expect(
      db.getLatestPublicScanRun("history-heavy", {
        scoreVersion: "future-score-formula",
        collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      }),
    ).resolves.toMatchObject({ id: first!.run.id, state: "complete_public" });
  });

  it("reclaims an expired lease instead of starting a second active job", async () => {
    const queued = await enqueue("expired-lease");
    const lease = await claim(queued?.job.id);
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE public_scan_jobs SET lease_expires_at = ? WHERE id = ?`,
      args: [Date.now() - 1, queued!.job.id],
    });

    const recovered = await claim(queued!.job.id);
    expect(recovered?.job.id).toBe(queued?.job.id);
    expect(recovered?.leaseToken).not.toBe(lease?.leaseToken);
    await expect(
      db.failPublicScanJob({
        jobId: queued!.job.id,
        runId: queued!.run.id,
        leaseToken: recovered!.leaseToken,
        error: "test complete",
      }),
    ).resolves.toBe(true);
  });

  it("releases a slot-blocked claim without changing attempt or schedule", async () => {
    const queued = await enqueue("slot-release-fixture");
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const before = await client.execute({
      sql: `SELECT attempt_count, next_run_at FROM public_scan_jobs WHERE id = ?`,
      args: [queued.job.id],
    });
    const firstLease = await claim(queued.job.id);

    await expect(
      db.releasePublicScanJobClaim({
        jobId: queued.job.id,
        runId: queued.run.id,
        leaseToken: firstLease!.leaseToken,
      }),
    ).resolves.toBe(true);
    const released = await client.execute({
      sql: `SELECT state, attempt_count, next_run_at, lease_token, lease_expires_at
            FROM public_scan_jobs WHERE id = ?`,
      args: [queued.job.id],
    });
    expect(released.rows[0]).toMatchObject({
      state: "queued",
      attempt_count: before.rows[0]?.attempt_count,
      next_run_at: before.rows[0]?.next_run_at,
      lease_token: null,
      lease_expires_at: null,
    });
    await expect(db.getPublicScanRun(queued.run.id)).resolves.toMatchObject({ state: "queued" });

    const secondLease = await claim(queued.job.id);
    expect(secondLease?.leaseToken).not.toBe(firstLease?.leaseToken);
    await expect(
      db.releasePublicScanJobClaim({
        jobId: queued.job.id,
        runId: queued.run.id,
        leaseToken: firstLease!.leaseToken,
      }),
    ).resolves.toBe(false);
    await expect(
      db.failPublicScanJob({
        jobId: queued.job.id,
        runId: queued.run.id,
        leaseToken: secondLease!.leaseToken,
        error: "synthetic cleanup",
      }),
    ).resolves.toBe(true);
  });

  it("returns aggregate queue, step, slot, obsolete, and Cron metrics only", async () => {
    const canonical = await enqueue("metrics-canonical-fixture");
    const obsoleteCollection = "obsolete-metrics-collection";
    const obsolete = await db.enqueuePublicScan("metrics-obsolete-fixture", {
      scoreVersion: "obsolete-score-fixture",
      collectionVersion: obsoleteCollection,
    });
    if (!obsolete || "rejection" in obsolete) throw new Error("expected obsolete metrics fixture");

    await expect(
      db.recordPublicScanStepMetrics({
        collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
        observations: [
          { phase: "merged_prs", outcome: "continued", durationMs: 10 },
          { phase: "merged_prs", outcome: "continued", durationMs: 30 },
          { phase: "merged_prs", outcome: "failed_retrying", durationMs: 40 },
          { phase: "quick", outcome: "slot_busy", durationMs: 5 },
        ],
      }),
    ).resolves.toBe(true);
    await expect(
      db.recordPublicScanCronMetrics({
        startedAt: 1_000,
        completedAt: 1_050,
        processed: 2,
        failedSteps: 1,
        success: true,
      }),
    ).resolves.toBe(true);
    await expect(
      db.recordPublicScanCronMetrics({
        startedAt: 2_000,
        completedAt: 2_025,
        processed: 0,
        failedSteps: 0,
        success: false,
      }),
    ).resolves.toBe(true);

    const metrics = await db.getPublicScanOperationalMetrics(PUBLIC_SCAN_COLLECTION_VERSION);
    expect(metrics).toMatchObject({
      canonicalCollectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      queue: {
        depth: expect.any(Number),
        queued: expect.any(Number),
        running: expect.any(Number),
        oldestAgeMs: expect.any(Number),
      },
      failures: { retryingSteps: 1, terminalSteps: 0 },
      execution: { capacity: 1, contentionSteps: 1 },
      obsoleteActiveJobs: expect.any(Number),
      cron: {
        lastStartedAt: 2_000,
        lastSuccessAt: 1_050,
        lastDurationMs: 25,
        lastProcessed: 0,
        consecutiveFailures: 1,
      },
    });
    expect(metrics!.queue.depth).toBeGreaterThanOrEqual(1);
    expect(metrics!.obsoleteActiveJobs).toBeGreaterThanOrEqual(1);
    expect(metrics!.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "merged_prs",
          outcome: "continued",
          count: 2,
          averageDurationMs: 20,
          maxDurationMs: 30,
        }),
      ]),
    );
    const serialized = JSON.stringify(metrics);
    expect(serialized).not.toContain("metrics-canonical-fixture");
    expect(serialized).not.toContain("metrics-obsolete-fixture");
    expect(serialized).not.toContain(canonical.job.id);
    expect(serialized).not.toContain(obsolete.job.id);

    const canonicalLease = await claim(canonical.job.id);
    await db.failPublicScanJob({
      jobId: canonical.job.id,
      runId: canonical.run.id,
      leaseToken: canonicalLease!.leaseToken,
      error: "synthetic cleanup",
    });
    const obsoleteLease = await claim(obsolete.job.id, obsoleteCollection);
    await db.failPublicScanJob({
      jobId: obsolete.job.id,
      runId: obsolete.run.id,
      leaseToken: obsoleteLease!.leaseToken,
      error: "synthetic cleanup",
    });
  });

  it.each(["previous", "future"])(
    "stores a complete %s-collection snapshot as historical data without writing a canonical score",
    async (direction) => {
      const username = `historical-collection-${direction}-fixture`;
      const scoreVersion = `${SCORE_CACHE_VERSION}-${direction}`;
      const collectionVersion = `${PUBLIC_SCAN_COLLECTION_VERSION}-${direction}`;
      const queued = await db.enqueuePublicScan(username, {
        scoreVersion,
        collectionVersion,
      });
      if (!queued || "rejection" in queued) {
        throw new Error("expected a synthetic historical job");
      }
      const lease = await claim(queued.job.id, collectionVersion);
      const serialized = serializeScan(syntheticScan(username));

      await expect(
        db.completePublicScanRun({
          jobId: queued.job.id,
          runId: queued.run.id,
          leaseToken: lease!.leaseToken,
          coverage: "complete_public",
          sourceStatus: COMPLETE_PUBLIC_SOURCES,
          ...serialized,
        }),
      ).resolves.toBe(true);
      await expect(
        db.getLatestPublicScanRun(username, { scoreVersion, collectionVersion }),
      ).resolves.toMatchObject({
        state: "complete_public",
        collectionVersion,
      });
      await expect(
        db.getLatestPublicScanRun(username, {
          scoreVersion: SCORE_CACHE_VERSION,
          collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
        }),
      ).resolves.toBeNull();
      await expect(readScoreRow(username)).resolves.toBeNull();

      await db.quarantineObsoletePublicScanJobs({
        canonicalCollectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
        apply: true,
        limit: 100,
      });
      await expect(
        db.getLatestPublicScanRun(username, { scoreVersion, collectionVersion }),
      ).resolves.toMatchObject({ state: "complete_public", snapshot: serialized.snapshot });
    },
  );

  it("admits new durable work atomically without charging an existing job", async () => {
    const admission = {
      bucket: "durable-admission-test",
      limit: 1,
      windowMs: 60_000,
      maxActiveJobs: 100,
    };
    const first = await db.enqueuePublicScan("admission-first", { ...versions, admission });
    expect(first && !("rejection" in first) && first.created).toBe(true);

    const duplicate = await db.enqueuePublicScan("admission-first", { ...versions, admission });
    expect(duplicate).toMatchObject({ created: false, run: { id: (first as { run: { id: string } }).run.id } });

    await expect(
      db.enqueuePublicScan("admission-second", { ...versions, admission }),
    ).resolves.toMatchObject({ created: false, rejection: "admission_limited" });
  });

  it("rejects new durable work when its collection active-job ceiling is full", async () => {
    const first = await db.enqueuePublicScan("queue-cap-first", {
      ...versions,
      admission: { bucket: "queue-cap-first", limit: 10, windowMs: 60_000, maxActiveJobs: 1_000 },
    });
    expect(first && !("rejection" in first)).toBe(true);

    await expect(
      db.enqueuePublicScan("queue-cap-second", {
        ...versions,
        admission: { bucket: "queue-cap-second", limit: 10, windowMs: 60_000, maxActiveJobs: 1 },
      }),
    ).resolves.toMatchObject({ created: false, rejection: "queue_full" });
  });

  it("uses a Turso execution slot and rate window when Redis is unavailable", async () => {
    const one = await enqueue("slot-one");
    const two = await enqueue("slot-two");
    const leaseOne = await claim(one!.job.id);
    const leaseTwo = await claim(two!.job.id);

    const firstSlot = await db.acquirePublicScanExecutionLease({
      jobId: one!.job.id,
      leaseToken: leaseOne!.leaseToken,
    });
    const blockedSlot = await db.acquirePublicScanExecutionLease({
      jobId: two!.job.id,
      leaseToken: leaseTwo!.leaseToken,
    });
    expect(firstSlot).toBe(1);
    expect(blockedSlot).toBeNull();

    await db.releasePublicScanExecutionLease({
      slot: firstSlot!,
      jobId: one!.job.id,
      leaseToken: leaseOne!.leaseToken,
    });
    const reacquiredSlot = await db.acquirePublicScanExecutionLease({
      jobId: two!.job.id,
      leaseToken: leaseTwo!.leaseToken,
    });
    expect(reacquiredSlot).toBe(1);
    await db.releasePublicScanExecutionLease({
      slot: reacquiredSlot!,
      jobId: two!.job.id,
      leaseToken: leaseTwo!.leaseToken,
    });

    await expect(
      db.acquirePublicScanRateWindow({ bucket: "commit-search-test", limit: 2, windowMs: 60_000 }),
    ).resolves.toMatchObject({ granted: true });
    await expect(
      db.acquirePublicScanRateWindow({ bucket: "commit-search-test", limit: 2, windowMs: 60_000 }),
    ).resolves.toMatchObject({ granted: true });
    await expect(
      db.acquirePublicScanRateWindow({ bucket: "commit-search-test", limit: 2, windowMs: 60_000 }),
    ).resolves.toMatchObject({ granted: false });
  });

  it("fails closed when a queued job has lost its durable run", async () => {
    const queued = await enqueue("orphaned-job-fixture");
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `DELETE FROM public_scan_runs WHERE id = ?`,
      args: [queued.run.id],
    });

    try {
      await expect(claim(queued.job.id)).rejects.toMatchObject({
        name: "PublicScanStorageError",
        operation: "claim_job",
      });
    } finally {
      await client.execute({
        sql: `DELETE FROM public_scan_jobs WHERE id = ?`,
        args: [queued.job.id],
      });
    }
  });

  it("fails closed when the execution-slot singleton is missing", async () => {
    const queued = await enqueue("missing-slot-fixture");
    const lease = await claim(queued.job.id);
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute(`DELETE FROM public_scan_execution_leases WHERE slot = 1`);

    try {
      await expect(
        db.acquirePublicScanExecutionLease({
          jobId: queued.job.id,
          leaseToken: lease!.leaseToken,
        }),
      ).rejects.toMatchObject({
        name: "PublicScanStorageError",
        operation: "acquire_execution_slot",
      });
    } finally {
      await client.execute(
        `INSERT OR IGNORE INTO public_scan_execution_leases (slot, lease_expires_at)
         VALUES (1, 0)`,
      );
      await db.failPublicScanJob({
        jobId: queued.job.id,
        runId: queued.run.id,
        leaseToken: lease!.leaseToken,
        error: "synthetic cleanup",
      });
    }
  });

  it("carries commit-candidate fork metadata through verification and aggregation", async () => {
    const queued = await enqueue("fork-candidate-facts");
    const lease = await claim(queued.job.id);
    const leaseInput = {
      jobId: queued.job.id,
      runId: queued.run.id,
      leaseToken: lease!.leaseToken,
    };
    await expect(
      db.upsertPublicScanCommitCandidates({
        ...leaseInput,
        candidates: [
          {
            sha: "candidate-sha",
            repoKey: "forked/large-project",
            ownerLogin: "forked",
            stars: 20_000,
            isPrivate: false,
            isFork: true,
            authoredAt: "2025-01-01T00:00:00Z",
          },
        ],
      }),
    ).resolves.toBe(true);
    await expect(db.preparePublicScanCommitVerificationWork(leaseInput)).resolves.toBe(true);
    const work = await db.getNextPublicScanCommitVerificationWork(queued.run.id);
    expect(work).toMatchObject({ repoKey: "forked/large-project", isFork: true });
    await expect(
      db.recordPublicScanCommitVerificationPage({
        ...leaseInput,
        work: work!,
        commits: [{ sha: "verified-sha", committedAt: "2025-01-01T00:00:00Z" }],
        complete: true,
      }),
    ).resolves.toBe(true);
    await expect(db.materializePublicScanCommitRepoFacts(leaseInput)).resolves.toBe(true);
    await expect(db.getPublicScanContributionAggregates(queued.run.id)).resolves.toEqual([
      expect.objectContaining({ repo: "forked/large-project", isFork: true, prs: 0, commits: 1 }),
    ]);
  });

  it("aggregates lease-guarded PR and commit facts without double-counting replayed pages", async () => {
    const queued = await enqueue("fact-aggregate");
    const lease = await claim(queued!.job.id);
    const leaseInput = {
      jobId: queued!.job.id,
      runId: queued!.run.id,
      leaseToken: lease!.leaseToken,
    };
    const facts = [
      {
        pullRequestId: "pr-1",
        source: "native_merged" as const,
        repoKey: "big/project",
        ownerLogin: "big",
        stars: 500,
        isPrivate: false,
        isFork: false,
        createdAt: "2024-01-01T00:00:00Z",
        mergedAt: "2024-01-03T00:00:00Z",
        closedAt: "2024-01-03T00:00:00Z",
        title: "core fix",
        additions: 10,
        deletions: 2,
        changedFiles: 2,
        labels: [],
      },
      {
        pullRequestId: "pr-2",
        source: "native_merged" as const,
        repoKey: "big/project",
        ownerLogin: "big",
        stars: 550,
        isPrivate: false,
        isFork: false,
        createdAt: "2025-01-01T00:00:00Z",
        mergedAt: "2025-01-03T00:00:00Z",
        closedAt: "2025-01-03T00:00:00Z",
        title: "second fix",
        additions: 10,
        deletions: 2,
        changedFiles: 2,
        labels: [],
      },
    ];
    await expect(db.upsertPublicScanPrFacts({ ...leaseInput, facts })).resolves.toBe(true);
    await expect(db.upsertPublicScanPrFacts({ ...leaseInput, facts: [facts[0]] })).resolves.toBe(true);
    await expect(
      db.upsertPublicScanCommitRepoFacts({
        ...leaseInput,
        facts: [
          {
            repoKey: "big/project",
            ownerLogin: "big",
            stars: 550,
            isPrivate: false,
            isFork: false,
            commits: 8,
            activeYears: 3,
            firstCommittedAt: "2023-01-01T00:00:00Z",
            lastCommittedAt: "2025-01-01T00:00:00Z",
            source: "default_branch_rest",
            evidenceShas: ["abc"],
          },
        ],
      }),
    ).resolves.toBe(true);
    await expect(
      db.upsertPublicScanCommitRepoFacts({
        ...leaseInput,
        facts: [
          {
            repoKey: "forked/project",
            ownerLogin: "forked",
            stars: 5_000,
            isPrivate: false,
            isFork: true,
            commits: 12,
            activeYears: 2,
            firstCommittedAt: "2024-01-01T00:00:00Z",
            lastCommittedAt: "2025-01-01T00:00:00Z",
            source: "default_branch_rest",
            evidenceShas: ["def"],
          },
        ],
      }),
    ).resolves.toBe(true);
    await expect(db.getPublicScanContributionAggregates(queued!.run.id)).resolves.toEqual([
      {
        repo: "forked/project",
        ownerLogin: "forked",
        stars: 5000,
        isPrivate: false,
        isFork: true,
        commits: 12,
        prs: 0,
        activeYears: 2,
      },
      {
        repo: "big/project",
        ownerLogin: "big",
        stars: 550,
        isPrivate: false,
        isFork: false,
        commits: 8,
        prs: 2,
        activeYears: 3,
      },
    ]);
  });

  it("uses all signature PR facts while excluding ordinary closed PRs", async () => {
    const queued = await enqueue("signature-facts");
    const lease = await claim(queued!.job.id);
    const leaseInput = {
      jobId: queued!.job.id,
      runId: queued!.run.id,
      leaseToken: lease!.leaseToken,
    };
    await expect(
      db.upsertPublicScanPrFacts({
        ...leaseInput,
        facts: [
          {
            pullRequestId: "sig-native",
            source: "native_merged",
            repoKey: "big/native",
            ownerLogin: "big",
            stars: 500,
            isPrivate: false,
            isFork: false,
            createdAt: "2024-01-01T00:00:00Z",
            mergedAt: "2024-01-03T00:00:00Z",
            closedAt: "2024-01-03T00:00:00Z",
            title: "fix native path",
            additions: 10,
            deletions: 2,
            changedFiles: 2,
            labels: [],
          },
          {
            pullRequestId: "sig-labeled",
            source: "closed",
            repoKey: "big/label-merged",
            ownerLogin: "big",
            stars: 700,
            isPrivate: false,
            isFork: false,
            createdAt: "2024-02-01T00:00:00Z",
            mergedAt: null,
            closedAt: "2024-02-03T00:00:00Z",
            title: "fix closed path marked merged",
            additions: 20,
            deletions: 3,
            changedFiles: 4,
            labels: ["Merged"],
          },
          {
            pullRequestId: "sig-ordinary-closed",
            source: "closed",
            repoKey: "big/rejected",
            ownerLogin: "big",
            stars: 900,
            isPrivate: false,
            isFork: false,
            createdAt: "2024-03-01T00:00:00Z",
            mergedAt: null,
            closedAt: "2024-03-03T00:00:00Z",
            title: "ordinary closed path",
            additions: 1,
            deletions: 1,
            changedFiles: 1,
            labels: [],
          },
        ],
      }),
    ).resolves.toBe(true);

    await expect(db.getPublicScanSignaturePrFacts(queued!.run.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pullRequestId: "sig-native", source: "native_merged" }),
        expect.objectContaining({ pullRequestId: "sig-labeled", source: "closed" }),
      ]),
    );
    const signatureFacts = await db.getPublicScanSignaturePrFacts(queued!.run.id);
    expect(signatureFacts.map((fact) => fact.pullRequestId)).not.toContain("sig-ordinary-closed");
  });
});

describe("profile snapshots", () => {
  it("persists signature work for profile representative work", async () => {
    const scan = {
      metrics: {
        username: "signature-profile",
        followers: 0,
        total_stars: 0,
      } as ScanResult["metrics"],
      top_repos: [],
      recent_prs: [],
      flood_pr_titles: [],
      impact_repos: [],
      verified_impact_prs: [],
      pinned_repos: [],
      organizations: [],
      signature_work: {
        source: "all_history_public_scan",
        impact_repo_representatives: [],
        work_clusters: [
          {
            repo: "org/small-runtime",
            stars: 20,
            all_time_prs: 9,
            quality_keyword_hits: 7,
            examples: ["fix: preserve ledger consistency"],
            org_context_repo: "org/platform",
            org_context_stars: 100000,
            substantive_low_star_signal: true,
          },
        ],
      },
      scoring: {} as ScanResult["scoring"],
    } as ScanResult;

    await db.recordProfileSnapshot(scan);

    await expect(db.getProfileSnapshot("Signature-Profile")).resolves.toMatchObject({
      signature_work: {
        source: "all_history_public_scan",
        work_clusters: [
          expect.objectContaining({
            repo: "org/small-runtime",
            org_context_repo: "org/platform",
          }),
        ],
      },
    });
  });

  it("prefers v9, falls back to v8, and ignores non-release snapshots", async () => {
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const username = "profile-version-fixture";
    const rows = [
      ["profile-v8", username, 300, JSON.stringify({ followers: 8 }), "v8"],
      ["profile-local", username, 400, JSON.stringify({ followers: 99 }), "local-fixture"],
      ["profile-v9", username, 200, JSON.stringify({ followers: 9 }), "v9"],
    ];
    for (const row of rows) {
      await client.execute({
        sql: `INSERT INTO profile_snapshots (id, username, scanned_at, metrics, scan_version)
              VALUES (?, ?, ?, ?, ?)`,
        args: row,
      });
    }

    await expect(db.getProfileSnapshot(username)).resolves.toMatchObject({
      metrics: { followers: 9 },
      scanned_at: 200,
    });
    await client.execute({
      sql: `DELETE FROM profile_snapshots WHERE id = ?`,
      args: ["profile-v9"],
    });
    await expect(db.getProfileSnapshot(username)).resolves.toMatchObject({
      metrics: { followers: 8 },
      scanned_at: 300,
    });

    await client.execute({
      sql: `INSERT INTO profile_snapshots (id, username, scanned_at, metrics, scan_version)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        "profile-local-only",
        "profile-local-only-fixture",
        500,
        JSON.stringify({ followers: 77 }),
        "local-fixture",
      ],
    });
    await expect(db.hasProfileSnapshot("profile-local-only-fixture")).resolves.toBe(false);
    await expect(db.getProfileSnapshot("profile-local-only-fixture")).resolves.toBeNull();
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

describe("campaign leaderboard", () => {
  it("bumps the live revision for membership and score writes", async () => {
    const { getCampaignLeaderboardRevision } = await import("../redis");
    const before = await getCampaignLeaderboardRevision("live-refresh-event");

    await db.recordCampaignParticipant("live-refresh-event", "live-refresh-user");
    const afterMembership = await getCampaignLeaderboardRevision("live-refresh-event");
    await db.recordScore({ ...entry, username: "live-refresh-user", final_score: 77 });
    const afterScore = await getCampaignLeaderboardRevision("live-refresh-event");

    expect(afterMembership).toBe((before ?? 0) + 1);
    expect(afterScore).toBe((afterMembership ?? 0) + 1);
  });

  it("filters an event cohort while keeping every participant in the main score table", async () => {
    await db.recordScore({ ...entry, username: "advx-only", final_score: 82 });
    await db.recordScore({ ...entry, username: "main-only", final_score: 81 });
    await db.recordCampaignParticipant("advx", "ADVX-ONLY");
    await db.recordCampaignParticipant("another-event", "main-only");

    const campaignEntries = await db.getCampaignLeaderboard("advx");
    const mainEntries = await db.getLeaderboard(500, 0);

    expect(campaignEntries.map((item) => item.username)).toEqual(["advx-only"]);
    expect(mainEntries.some((item) => item.username === "advx-only")).toBe(true);
    expect(mainEntries.some((item) => item.username === "main-only")).toBe(true);
  });

  it("lets one account carry multiple event labels without duplicating its score", async () => {
    await db.recordCampaignParticipant("second-event", "advx-only");

    await expect(db.getCampaignLeaderboard("second-event")).resolves.toMatchObject([
      { username: "advx-only", final_score: 82 },
    ]);
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

describe("recordRepoGraph + updateInfluenceStats", () => {
  const raw = () => createClient({ url: process.env.TURSO_DATABASE_URL! });

  it("upserts repos and replaces a developer's edges", async () => {
    await db.recordRepoGraph("Alice", {
      repos: [
        {
          repo_key: "alice/cool",
          name_with_owner: "Alice/Cool",
          owner_login: "alice",
          name: "Cool",
          description: "a cool project",
          stars: 1200,
          forks: 30,
          language: "Rust",
          topics: ["cli"],
        },
      ],
      links: [{ repo_key: "alice/cool", relation: "owner", commits: null, prs: null, weight: 1200 }],
    });

    const client = raw();
    const repo = await client.execute({
      sql: `SELECT name_with_owner, owner_login, stars, language FROM repos WHERE repo_key = ?`,
      args: ["alice/cool"],
    });
    expect(repo.rows[0]).toMatchObject({
      name_with_owner: "Alice/Cool",
      owner_login: "alice",
      stars: 1200,
      language: "Rust",
    });
    const edge = await client.execute({
      sql: `SELECT relation, weight FROM repo_developers WHERE username = ? AND repo_key = ?`,
      args: ["alice", "alice/cool"],
    });
    expect(edge.rows[0]).toMatchObject({ relation: "owner", weight: 1200 });
  });

  it("takes the higher star count and never nulls owner metadata on a later thin scan", async () => {
    // Bob contributes to alice/cool later with sparser metadata but a higher star count.
    await db.recordRepoGraph("Bob", {
      repos: [
        {
          repo_key: "alice/cool",
          name_with_owner: "alice/cool",
          owner_login: "alice",
          name: "cool",
          description: null,
          stars: 1500,
          forks: null,
          language: null,
          topics: [],
        },
      ],
      links: [{ repo_key: "alice/cool", relation: "contributor", commits: 8, prs: 2, weight: 10 }],
    });

    const client = raw();
    const repo = await client.execute({
      sql: `SELECT stars, language, description FROM repos WHERE repo_key = ?`,
      args: ["alice/cool"],
    });
    // Star count moves up; the owner's rich language/description survive.
    expect(repo.rows[0]).toMatchObject({ stars: 1500, language: "Rust", description: "a cool project" });

    // Both developers now have an edge to the shared repo.
    const contributors = await client.execute({
      sql: `SELECT username, relation FROM repo_developers WHERE repo_key = ? ORDER BY username`,
      args: ["alice/cool"],
    });
    expect(contributors.rows.map((r) => r.username)).toEqual(["alice", "bob"]);
  });

  it("lifts followers/total_stars onto an existing scores row", async () => {
    await db.recordScore({ ...entry, username: "vip-user", final_score: 88 });
    await db.updateInfluenceStats("vip-user", 4200, 15000);

    const client = raw();
    const res = await client.execute({
      sql: `SELECT followers, total_stars FROM scores WHERE username = ?`,
      args: ["vip-user"],
    });
    expect(res.rows[0]).toMatchObject({ followers: 4200, total_stars: 15000 });
  });
});

describe("getRepoOverview + filterExistingRepoKeys", () => {
  const node = (over: Partial<import("../repo-graph").RepoNode> = {}) => ({
    repo_key: "acme/widget",
    name_with_owner: "acme/Widget",
    owner_login: "acme",
    name: "Widget",
    description: "a widget",
    stars: 3000,
    forks: 100,
    language: "Go",
    topics: ["cli"],
    ...over,
  });

  it("assembles the repo, its scored owner, and the contributor-quality summary", async () => {
    // Owner "acme" (夯) owns the repo; contributor "beta" (人上人) works on it.
    await db.recordScore({ ...entry, username: "acme", final_score: 96, tier: "夯" });
    await db.recordScore({ ...entry, username: "beta", final_score: 72, tier: "人上人" });
    await db.recordRepoGraph("acme", {
      repos: [node()],
      links: [{ repo_key: "acme/widget", relation: "owner", commits: null, prs: null, weight: 3000 }],
    });
    await db.recordRepoGraph("beta", {
      repos: [node({ language: null, description: null, topics: [] })],
      links: [
        { repo_key: "acme/widget", relation: "contributor", commits: 9, prs: 4, weight: 13 },
      ],
    });

    const overview = await db.getRepoOverview("acme/widget");
    expect(overview).not.toBeNull();
    expect(overview!.repo.name_with_owner).toBe("acme/Widget");
    // Owner resolves from the repo's owner_login → scores row.
    expect(overview!.owner).toMatchObject({ username: "acme", tier: "夯" });
    // Summary spans both edges (owner + contributor).
    expect(overview!.summary.count).toBe(2);
    expect(overview!.summary.avgScore).toBe(84); // (96 + 72) / 2
    expect(overview!.summary.tierCounts).toEqual([
      { tier: "夯", count: 1 },
      { tier: "人上人", count: 1 },
    ]);
  });

  it("returns null for a repo not in the graph", async () => {
    expect(await db.getRepoOverview("nobody/here")).toBeNull();
  });

  it("filters a key set down to repos that exist", async () => {
    const found = await db.filterExistingRepoKeys(["Acme/Widget", "ghost/missing"]);
    expect(found.has("acme/widget")).toBe(true);
    expect(found.has("ghost/missing")).toBe(false);
  });
});

describe("legacy public score release guardrail", () => {
  it("keeps a synthetic v8 row on every passive public surface without creating work", async () => {
    const username = "legacy-public-fixture";
    const peer = "legacy-peer-fixture";
    const repoKey = `${username}/public-fixture`;
    const followerId = 9_100_001;
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });

    await db.recordScore({ ...entry, username, final_score: 86 });
    await db.recordScore({ ...entry, username: peer, final_score: 84 });
    await client.execute({
      sql: `UPDATE scores
            SET score_version = 'v8', roast = 'legacy report', roast_version = 'v8'
            WHERE username IN (?, ?)`,
      args: [username, peer],
    });
    await db.recordDeveloperFacets(username, [
      { type: "language", value: "FixtureLang", weight: 1 },
    ]);
    await db.recordRepoGraph(username, {
      repos: [
        {
          repo_key: repoKey,
          name_with_owner: `${username}/PublicFixture`,
          owner_login: username,
          name: "PublicFixture",
          description: "Synthetic release fixture",
          stars: 100,
          forks: 5,
          language: "FixtureLang",
          topics: ["release-fixture"],
        },
      ],
      links: [
        {
          repo_key: repoKey,
          relation: "owner",
          commits: null,
          prs: null,
          weight: 100,
        },
      ],
    });
    await expect(db.setFollow(followerId, username)).resolves.toBe("ok");

    const jobsBefore = await client.execute(
      "SELECT COUNT(*) AS count FROM public_scan_jobs",
    );
    const runsBefore = await client.execute(
      "SELECT COUNT(*) AS count FROM public_scan_runs",
    );

    const [
      detail,
      brief,
      suggestions,
      leaderboard,
      trending,
      heat,
      facets,
      facetDevelopers,
      sitemapProfiles,
      repo,
      similar,
      following,
      archivedRoast,
    ] = await Promise.all([
      db.getAccountDetail(username),
      db.getScoreBrief(username),
      db.searchScoredUsers("legacy-public"),
      db.getLeaderboard(500, 0),
      db.getTrendingLeaderboard(500, 0),
      db.getHeatLeaderboard(500, 0),
      db.getFacetCategories("language"),
      db.getDevelopersByFacet("language", "FixtureLang"),
      db.getAllPublicUsernames(0),
      db.getRepoOverview(repoKey),
      db.getSimilarAccounts(username, 86, entry.sub_scores, 100),
      db.listFollowedAccounts(followerId),
      db.getArchivedRoast(username, "zh"),
    ]);

    expect(detail).toMatchObject({
      username,
      final_score: 86,
      score_version: "v8",
      tags: { zh: [], en: [] },
      roast_line: { zh: "", en: "" },
      roast: null,
      roast_en: null,
    });
    expect(brief).toMatchObject({ username, final_score: 86 });
    expect(suggestions).toEqual(expect.arrayContaining([expect.objectContaining({ username })]));
    for (const entries of [leaderboard, trending, heat]) {
      expect(entries.some((item) => item.username === username)).toBe(true);
      expect(entries.find((item) => item.username === username)?.tags).toEqual({ zh: [], en: [] });
    }
    expect(facets).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "FixtureLang" })]),
    );
    expect(facetDevelopers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ username, tags: { zh: [], en: [] } }),
      ]),
    );
    expect(sitemapProfiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ username })]),
    );
    expect(repo).toMatchObject({ owner: { username }, summary: { count: 1 } });
    expect(similar).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ username: peer, tags: { zh: [], en: [] } }),
      ]),
    );
    expect(following).toEqual(
      expect.arrayContaining([expect.objectContaining({ username, final_score: 86 })]),
    );
    expect(archivedRoast).toBeNull();

    const jobsAfter = await client.execute("SELECT COUNT(*) AS count FROM public_scan_jobs");
    const runsAfter = await client.execute("SELECT COUNT(*) AS count FROM public_scan_runs");
    const persisted = await client.execute({
      sql: "SELECT score_version FROM scores WHERE username = ?",
      args: [username],
    });
    expect(Number(jobsAfter.rows[0]?.count)).toBe(Number(jobsBefore.rows[0]?.count));
    expect(Number(runsAfter.rows[0]?.count)).toBe(Number(runsBefore.rows[0]?.count));
    expect(persisted.rows[0]?.score_version).toBe("v8");
  });
});

describe("project discovery queries", () => {
  const repo = (
    key: string,
    over: Partial<import("../repo-graph").RepoNode> = {},
  ): import("../repo-graph").RepoNode => {
    const [owner, name] = key.split("/");
    return {
      repo_key: key,
      name_with_owner: `${owner}/${name}`,
      owner_login: owner,
      name,
      description: `${name} project`,
      stars: 100,
      forks: 5,
      language: "TypeScript",
      topics: ["developer-tools"],
      ...over,
    };
  };

  beforeAll(async () => {
    const repos = {
      quality: repo("discover/quality", { stars: 1_000, name: "QualityKit" }),
      related: repo("discover/related", { stars: 900, name: "RelatedKit" }),
      scale: repo("discover/scale", { stars: 800, name: "ScaleKit" }),
      momentum: repo("discover/momentum", { stars: 700, name: "MomentumKit" }),
      stars: repo("discover/stars", {
        stars: 50_000,
        name: "StarKit",
        language: "Rust",
        topics: ["database"],
      }),
      rustPeer: repo("discover/rust-peer", {
        stars: 600,
        name: "RustPeer",
        language: "Rust",
        topics: ["database"],
      }),
    };
    const score = async (username: string, finalScore: number, tier: ScoreEntry["tier"]) =>
      db.recordScore({ ...entry, username, final_score: finalScore, tier });

    await Promise.all([
      score("discover-alice", 96, "夯"),
      score("discover-bob", 90, "顶级"),
      score("discover-carol", 72, "人上人"),
      score("discover-dan", 72, "人上人"),
      score("discover-eve", 72, "人上人"),
      score("discover-hot", 65, "人上人"),
      score("discover-star", 80, "顶级"),
      score("discover-rust", 78, "顶级"),
      score("discover-hidden", 100, "夯"),
      score("discover-low", 50, "NPC"),
    ]);

    await db.recordRepoGraph("discover-alice", {
      repos: [repos.quality, repos.related],
      links: [
        { repo_key: repos.quality.repo_key, relation: "contributor", commits: 5, prs: 2, weight: 7 },
        { repo_key: repos.related.repo_key, relation: "contributor", commits: 3, prs: 1, weight: 4 },
      ],
    });
    await db.recordRepoGraph("discover-bob", {
      repos: [repos.quality, repos.related],
      links: [
        { repo_key: repos.quality.repo_key, relation: "contributor", commits: 4, prs: 1, weight: 5 },
        { repo_key: repos.related.repo_key, relation: "contributor", commits: 2, prs: 1, weight: 3 },
      ],
    });
    for (const username of ["discover-carol", "discover-dan", "discover-eve"]) {
      await db.recordRepoGraph(username, {
        repos: [repos.scale],
        links: [
          { repo_key: repos.scale.repo_key, relation: "contributor", commits: 1, prs: 1, weight: 2 },
        ],
      });
    }
    await db.recordRepoGraph("discover-hot", {
      repos: [repos.momentum],
      links: [
        { repo_key: repos.momentum.repo_key, relation: "contributor", commits: 1, prs: 1, weight: 2 },
      ],
    });
    await db.recordRepoGraph("discover-star", {
      repos: [repos.stars],
      links: [{ repo_key: repos.stars.repo_key, relation: "owner", commits: null, prs: null, weight: 50_000 }],
    });
    await db.recordRepoGraph("discover-rust", {
      repos: [repos.rustPeer],
      links: [
        { repo_key: repos.rustPeer.repo_key, relation: "owner", commits: null, prs: null, weight: 600 },
      ],
    });
    for (const username of ["discover-hidden", "discover-low"]) {
      await db.recordRepoGraph(username, {
        repos: [repos.quality],
        links: [
          { repo_key: repos.quality.repo_key, relation: "contributor", commits: 1, prs: 0, weight: 1 },
        ],
      });
    }
    await db.hideUser("discover-hidden");
    await db.recordAccountLookup("discover-hot", "203.0.113.10");
    await db.recordAccountLookup("discover-hot", "203.0.113.11");
    await db.recordAccountLookup("discover-hot", "203.0.113.12");
  });

  it("orders projects by contributor quality and excludes hidden or low scores", async () => {
    const projects = await db.getProjects({ sort: "quality", limit: 20 });
    const quality = projects.find((p) => p.repo.repo_key === "discover/quality");
    const scale = projects.find((p) => p.repo.repo_key === "discover/scale");

    expect(quality).toMatchObject({ contributorCount: 2, avgScore: 93, eliteCount: 2 });
    expect(quality!.qualityScore).toBeGreaterThan(scale!.qualityScore);
    expect(projects.indexOf(quality!)).toBeLessThan(projects.indexOf(scale!));
    expect(quality!.topContributors.map((c) => c.username)).toEqual([
      "discover-alice",
      "discover-bob",
    ]);
  });

  it("supports momentum, stars, language, and stable pagination", async () => {
    const momentum = await db.getProjects({ sort: "momentum", limit: 20 });
    expect(momentum[0]?.repo.repo_key).toBe("discover/momentum");
    expect(momentum[0]?.momentum).toBeGreaterThan(0);

    const stars = await db.getProjects({ sort: "stars", limit: 20 });
    expect(stars[0]?.repo.repo_key).toBe("discover/stars");

    const rust = await db.getProjects({ sort: "quality", language: "Rust", limit: 20 });
    expect(rust.map((p) => p.repo.repo_key)).toEqual([
      "discover/stars",
      "discover/rust-peer",
    ]);

    const first = await db.getProjects({ sort: "stars", limit: 1, offset: 0 });
    const second = await db.getProjects({ sort: "stars", limit: 1, offset: 1 });
    expect(first[0]?.repo.repo_key).not.toBe(second[0]?.repo.repo_key);
  });

  it("searches repositories by owner/name and bare project name", async () => {
    const byOwner = await db.searchRepos("discover/q", 4);
    expect(byOwner[0]?.repo_key).toBe("discover/quality");

    const byName = await db.searchRepos("quality", 4);
    expect(byName[0]?.name).toBe("QualityKit");
  });

  it("prefers shared contributors for related projects", async () => {
    const related = await db.getRelatedProjects("discover/quality", 4);
    expect(related[0]?.project.repo.repo_key).toBe("discover/related");
    expect(related[0]?.sharedContributorCount).toBe(2);
  });

  it("returns no related projects when contributors do not overlap (language filler lives in project-discovery)", async () => {
    const related = await db.getRelatedProjects("discover/stars", 4);
    expect(related).toEqual([]);
  });

  it("exposes a repo's language for the project-discovery filler", async () => {
    await expect(db.getRepoLanguage("discover/stars")).resolves.toBe("Rust");
    await expect(db.getRepoLanguage("discover/unknown")).resolves.toBeNull();
  });

  it("finds projects shared by two developers", async () => {
    const common = await db.getDeveloperCommonProjects("discover-alice", "discover-bob", 5);
    expect(common.map((project) => project.repo.repo_key)).toEqual([
      "discover/quality",
      "discover/related",
    ]);
  });
});
