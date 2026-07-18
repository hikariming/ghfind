import { createHash } from "node:crypto";
import {
  enqueuePublicScan,
  getLatestPublicScanRun,
  seedPublicScanQuickResult,
  type PublicScanAdmission,
} from "./db";
import { SCORE_CACHE_VERSION } from "./cache-version";
import {
  PUBLIC_SCAN_COLLECTION_VERSION,
  hasCompletePublicScanSources,
  type PublicScanRun,
} from "./scan-run-types";
import { score } from "./score";
import type { ScanResult } from "./types";

const FAILED_RUN_RETRY_MS = 15 * 60 * 1_000;
const PUBLIC_SCAN_ADMISSION_WINDOW_MS = 60 * 60 * 1_000;
const PUBLIC_SCAN_ADMISSION_LIMIT = 2;
const PUBLIC_SCAN_MAX_ACTIVE_JOBS = 24;

const REQUIRED_NUMERIC_METRICS = [
  "account_age_years",
  "followers",
  "following",
  "public_repos",
  "fetched_repo_count",
  "original_repo_count",
  "nonempty_original_repo_count",
  "fork_repo_count",
  "empty_original_repo_count",
  "total_stars",
  "max_stars",
  "merged_pr_count",
  "total_pr_count",
  "issues_created",
  "last_year_contributions",
  "activity_type_count",
  "contribution_years_active",
  "recent_merged_pr_sample",
  "recent_trivial_pr_count",
  "external_trivial_pr_count",
  "max_impact_repo_stars",
  "impact_pr_count",
  "impact_depth_raw",
  "closed_unmerged_pr_count",
  "pr_rejection_rate",
  "recent_pr_sample",
  "top_repo_pr_share",
  "templated_pr_ratio",
] as const;

function hasUsableSnapshotShape(scan: Partial<ScanResult>): scan is ScanResult {
  if (
    !scan.metrics ||
    typeof scan.metrics.username !== "string" ||
    !Array.isArray(scan.top_repos) ||
    !Array.isArray(scan.recent_prs) ||
    !Array.isArray(scan.flood_pr_titles)
  ) {
    return false;
  }
  return REQUIRED_NUMERIC_METRICS.every((key) => Number.isFinite(scan.metrics![key]));
}

export type PublicScanResolution =
  | { status: "complete"; run: PublicScanRun; scan: ScanResult }
  | { status: "pending"; run: PublicScanRun; retryAfterSeconds: number }
  | { status: "queue_full" | "admission_limited"; run: null; retryAfterSeconds: number }
  | { status: "storage_unavailable"; run: PublicScanRun | null; retryAfterSeconds: number }
  | { status: "failed"; run: PublicScanRun; retryAfterSeconds: number };

/**
 * Build a privacy-preserving, persistent admission key for *new* durable jobs.
 * Raw IP addresses and Bearer credentials never reach the database; cache hits,
 * completed scans, and status reads do not consume this budget.
 */
export function publicScanAdmission(principal: string): PublicScanAdmission {
  const normalized = principal.trim() || "anonymous";
  const digest = createHash("sha256")
    .update(`ghfind-public-scan-admission-v1\0${normalized}`)
    .digest("hex");
  return {
    bucket: `durable-admission:${digest}`,
    limit: PUBLIC_SCAN_ADMISSION_LIMIT,
    windowMs: PUBLIC_SCAN_ADMISSION_WINDOW_MS,
    maxActiveJobs: PUBLIC_SCAN_MAX_ACTIVE_JOBS,
  };
}

function parseCompleteSnapshot(run: PublicScanRun): ScanResult | null {
  if (
    run.state !== "complete_public" ||
    run.coverage !== "complete_public" ||
    !run.snapshot ||
    !run.snapshotHash ||
    !hasCompletePublicScanSources(run.sourceStatus)
  ) {
    return null;
  }
  const actualHash = createHash("sha256").update(run.snapshot).digest("hex");
  if (actualHash !== run.snapshotHash) return null;
  try {
    const scan = JSON.parse(run.snapshot) as Partial<ScanResult>;
    if (!hasUsableSnapshotShape(scan)) return null;
    // A complete public-history snapshot is a durable factual input. Score
    // formulas deliberately evolve faster than collectors, so recompute the
    // deterministic result at read time instead of forcing another historical
    // GitHub crawl solely because SCORE_CACHE_VERSION changed.
    return { ...scan, scoring: score(scan.metrics) };
  } catch {
    return null;
  }
}

/**
 * The quick collector is intentionally bounded. These signals mean it cannot
 * honestly describe the full public history, so callers must wait for the
 * durable run rather than send a partial score to the writer or leaderboard.
 */
export function requiresDurablePublicScan(scan: ScanResult): boolean {
  const metrics = scan.metrics;
  return Boolean(
    metrics.commit_contribution_aggregation_unavailable ||
      metrics.merged_pr_contribution_aggregation_incomplete ||
      metrics.merged_pr_count > 300 ||
      metrics.total_pr_count > 600 ||
      metrics.public_repos > metrics.fetched_repo_count,
  );
}

function retryAfter(run: PublicScanRun): number {
  if (run.state === "failed") {
    return Math.max(1, Math.ceil((run.updatedAt + FAILED_RUN_RETRY_MS - Date.now()) / 1_000));
  }
  return 5;
}

/**
 * Return the immutable current-version complete snapshot if available, else
 * enqueue/resume one durable job. The database remains both the source of truth
 * and the queue; request after-work and the deployment Cron drain it server-side.
 */
async function resolvePublicScan(
  username: string,
  quickScan?: ScanResult,
  admission?: PublicScanAdmission,
): Promise<PublicScanResolution> {
  const versions = {
    scoreVersion: SCORE_CACHE_VERSION,
    collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
  };
  const existing = await getLatestPublicScanRun(username, versions);
  if (existing) {
    const complete = parseCompleteSnapshot(existing);
    if (complete) return { status: "complete", run: existing, scan: complete };
    if (existing.state === "failed" && Date.now() - existing.updatedAt < FAILED_RUN_RETRY_MS) {
      return { status: "failed", run: existing, retryAfterSeconds: retryAfter(existing) };
    }
  }

  const enqueued = await enqueuePublicScan(username, { ...versions, admission });
  if (!enqueued) {
    // Turso itself is unavailable. Do not pretend a durable queue exists.
    return { status: "storage_unavailable", run: existing ?? null, retryAfterSeconds: 30 };
  }
  if ("rejection" in enqueued) {
    return {
      status: enqueued.rejection,
      run: null,
      retryAfterSeconds: Math.max(1, Math.ceil((enqueued.retryAt - Date.now()) / 1_000)),
    };
  }
  if (quickScan && enqueued.created) {
    await seedPublicScanQuickResult({
      jobId: enqueued.job.id,
      runId: enqueued.run.id,
      quickScan: JSON.stringify(quickScan),
      sourceStatus: {
        quick: "complete",
        original_repos: "pending",
        native_prs: "pending",
        workflow_landings: "pending",
        commit_recovery: "pending",
      },
    });
  }
  return { status: "pending", run: enqueued.run, retryAfterSeconds: retryAfter(enqueued.run) };
}

/**
 * Start durable collection without accepting any caller-supplied scan data.
 * Use this from routes that only have an untrusted request body; the worker's
 * quick phase will collect the first server-authored snapshot itself.
 */
export async function startPublicScan(
  username: string,
  admission?: PublicScanAdmission,
): Promise<PublicScanResolution> {
  return resolvePublicScan(username, undefined, admission);
}

/**
 * Reuse a scan only when it was collected by this server in the current request
 * or loaded from its own cache. This function is intentionally separate from
 * {@link startPublicScan}: HTTP request bodies must never seed durable facts.
 */
export async function resolvePublicScanFromTrustedQuickScan(
  username: string,
  quickScan: ScanResult,
  admission?: PublicScanAdmission,
): Promise<PublicScanResolution> {
  return resolvePublicScan(username, quickScan, admission);
}

export async function getCompletedPublicScan(username: string): Promise<ScanResult | null> {
  const run = await getLatestPublicScanRun(username, {
    scoreVersion: SCORE_CACHE_VERSION,
    collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
  });
  return run ? parseCompleteSnapshot(run) : null;
}

/** Read-only status probe for a job already requested through POST /api/scan. */
export async function getPublicScanStatus(username: string): Promise<PublicScanResolution | null> {
  const run = await getLatestPublicScanRun(username, {
    scoreVersion: SCORE_CACHE_VERSION,
    collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
  });
  if (!run) return null;
  const scan = parseCompleteSnapshot(run);
  if (scan) return { status: "complete", run, scan };
  if (run.state === "failed" && Date.now() - run.updatedAt < FAILED_RUN_RETRY_MS) {
    return { status: "failed", run, retryAfterSeconds: retryAfter(run) };
  }
  if (run.state === "queued" || run.state === "running") {
    return { status: "pending", run, retryAfterSeconds: retryAfter(run) };
  }
  // Corrupt/legacy terminal rows must be repaired by resolvePublicScan rather
  // than reported as endlessly pending when no active job remains.
  return null;
}
