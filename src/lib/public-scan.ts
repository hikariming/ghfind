import {
  enqueuePublicScan,
  getLatestPublicScanRun,
  seedPublicScanQuickResult,
  type EnqueuedPublicScan,
} from "./db";
import { SCORE_CACHE_VERSION } from "./cache-version";
import { schedulePublicScanDelivery } from "./public-scan-queue";
import { PUBLIC_SCAN_COLLECTION_VERSION, type PublicScanRun } from "./scan-run-types";
import type { ScanResult } from "./types";

const FAILED_RUN_RETRY_MS = 15 * 60 * 1_000;

export type PublicScanResolution =
  | { status: "complete"; run: PublicScanRun; scan: ScanResult }
  | { status: "pending"; run: PublicScanRun; retryAfterSeconds: number }
  | { status: "queue_unavailable"; run: PublicScanRun | null; retryAfterSeconds: number }
  | { status: "failed"; run: PublicScanRun; retryAfterSeconds: number };

function parseCompleteSnapshot(run: PublicScanRun): ScanResult | null {
  if (run.state !== "complete_public" || run.coverage !== "complete_public" || !run.snapshot) {
    return null;
  }
  try {
    const scan = JSON.parse(run.snapshot) as Partial<ScanResult>;
    return scan.metrics && scan.scoring && Array.isArray(scan.top_repos) && Array.isArray(scan.recent_prs)
      ? (scan as ScanResult)
      : null;
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

async function schedule(enqueued: EnqueuedPublicScan): Promise<boolean> {
  return schedulePublicScanDelivery(
    { jobId: enqueued.job.id },
    { deduplicationId: `${enqueued.job.id}:initial` },
  );
}

/**
 * Return the immutable current-version complete snapshot if available, else
 * enqueue/resume one durable job. The database job remains the source of truth;
 * queue delivery is retried by every later read while the run is active.
 */
export async function resolvePublicScan(
  username: string,
  quickScan?: ScanResult,
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

  const enqueued = await enqueuePublicScan(username, versions);
  if (!enqueued) {
    return { status: "queue_unavailable", run: existing ?? null, retryAfterSeconds: 30 };
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
  const delivered = await schedule(enqueued);
  if (!delivered) {
    return { status: "queue_unavailable", run: enqueued.run, retryAfterSeconds: 30 };
  }
  return { status: "pending", run: enqueued.run, retryAfterSeconds: retryAfter(enqueued.run) };
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
  if (run.state === "failed") return { status: "failed", run, retryAfterSeconds: retryAfter(run) };
  return { status: "pending", run, retryAfterSeconds: retryAfter(run) };
}
