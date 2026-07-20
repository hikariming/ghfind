import { after } from "next/server";
import {
  recordPublicScanCronMetrics,
  recordPublicScanStepMetrics,
  type PublicScanStepObservation,
} from "./db";
import { processPublicScanJob, type PublicScanWorkerResult } from "./public-scan-worker";
import { PUBLIC_SCAN_COLLECTION_VERSION, type PublicScanStepOutcome } from "./scan-run-types";

// A response-side head start is optional acceleration only. Keep it to one
// bounded unit so a high-history scan cannot make the initiating public API
// request wait behind several GitHub pages; Cron is the durable throughput path.
const REQUEST_DRAIN_MAX_STEPS = 1;
const REQUEST_DRAIN_MAX_MS = 10_000;
const CRON_DRAIN_MAX_STEPS = 24;
const CRON_DRAIN_MAX_MS = 50_000;

export interface PublicScanDrainResult {
  processed: number;
  results: PublicScanWorkerResult[];
  exhaustedBudget: boolean;
}

type PublicScanDrainSource = "request" | "cron";

function stepOutcome(result: Exclude<PublicScanWorkerResult, { status: "idle" }>): PublicScanStepOutcome {
  if (result.status === "failed") {
    return result.retryScheduled ? "failed_retrying" : "failed_terminal";
  }
  return result.status;
}

function logStep(
  source: PublicScanDrainSource,
  result: Exclude<PublicScanWorkerResult, { status: "idle" }>,
  durationMs: number,
): void {
  console.info(
    "public_scan.step",
    JSON.stringify({
      source,
      status: result.status,
      jobId: result.jobId,
      runId: result.runId,
      phase: result.phase,
      durationMs,
      ...(result.status === "failed" ? { retryScheduled: result.retryScheduled } : {}),
    }),
  );
}

/**
 * Drain short, leased units from the Turso-backed queue. There is intentionally
 * no process-local queue and no network callback: every continuation has already
 * been persisted by the worker before it returns. A later Cron invocation can
 * resume exactly where this invocation stops.
 */
export async function drainPublicScanJobs(input: {
  maxSteps: number;
  maxDurationMs: number;
  source: PublicScanDrainSource;
  targetJobId?: string;
}): Promise<PublicScanDrainResult> {
  const maxSteps = input.targetJobId ? 1 : Math.max(1, Math.floor(input.maxSteps));
  const deadline = Date.now() + Math.max(1_000, Math.floor(input.maxDurationMs));
  const results: PublicScanWorkerResult[] = [];
  const observations: PublicScanStepObservation[] = [];

  while (results.length < maxSteps && Date.now() < deadline) {
    const startedAt = Date.now();
    const result = await processPublicScanJob(input.targetJobId);
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (result.status === "idle") break;
    results.push(result);
    observations.push({ phase: result.phase, outcome: stepOutcome(result), durationMs });
    logStep(input.source, result, durationMs);
    if (input.targetJobId || result.status === "slot_busy") break;
  }

  await recordPublicScanStepMetrics({
    collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    observations,
  });

  const processed = results.filter((result) => result.status !== "slot_busy").length;

  return {
    processed,
    results,
    exhaustedBudget: processed >= maxSteps || Date.now() >= deadline,
  };
}

/**
 * Start a small server-side head start after a request returns. This does not
 * make the browser responsible for work: the durable job is already committed
 * to Turso and the deployment Cron remains the recovery mechanism.
 */
export function kickPublicScanDrain(jobId: string): void {
  after(async () => {
    try {
      await drainPublicScanJobs({
        maxSteps: REQUEST_DRAIN_MAX_STEPS,
        maxDurationMs: REQUEST_DRAIN_MAX_MS,
        source: "request",
        targetJobId: jobId,
      });
    } catch {
      console.error(
        "public_scan.request_head_start_failed",
        JSON.stringify({ jobId, kind: "dispatcher_failure" }),
      );
    }
  });
}

export async function drainPublicScanJobsFromCron(): Promise<PublicScanDrainResult> {
  const startedAt = Date.now();
  try {
    const result = await drainPublicScanJobs({
      maxSteps: CRON_DRAIN_MAX_STEPS,
      maxDurationMs: CRON_DRAIN_MAX_MS,
      source: "cron",
    });
    const completedAt = Date.now();
    const failedSteps = result.results.filter((step) => step.status === "failed").length;
    await recordPublicScanCronMetrics({
      startedAt,
      completedAt,
      processed: result.processed,
      failedSteps,
      success: true,
    });
    console.info(
      "public_scan.cron",
      JSON.stringify({
        status: "ok",
        processed: result.processed,
        failedSteps,
        durationMs: completedAt - startedAt,
        exhaustedBudget: result.exhaustedBudget,
      }),
    );
    return result;
  } catch {
    const completedAt = Date.now();
    try {
      await recordPublicScanCronMetrics({
        startedAt,
        completedAt,
        processed: 0,
        failedSteps: 0,
        success: false,
      });
    } catch {
      // The 5xx and fixed log line remain the health signal when storage itself
      // is unavailable and cannot persist the failed heartbeat.
    }
    console.error(
      "public_scan.cron",
      JSON.stringify({ status: "failed", durationMs: completedAt - startedAt }),
    );
    throw new Error("public scan Cron drain failed");
  }
}
