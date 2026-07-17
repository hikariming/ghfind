import { after } from "next/server";
import { processPublicScanJob, type PublicScanWorkerResult } from "./public-scan-worker";

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

/**
 * Drain short, leased units from the Turso-backed queue. There is intentionally
 * no process-local queue and no network callback: every continuation has already
 * been persisted by the worker before it returns. A later Cron invocation can
 * resume exactly where this invocation stops.
 */
export async function drainPublicScanJobs(input: {
  maxSteps: number;
  maxDurationMs: number;
}): Promise<PublicScanDrainResult> {
  const maxSteps = Math.max(1, Math.floor(input.maxSteps));
  const deadline = Date.now() + Math.max(1_000, Math.floor(input.maxDurationMs));
  const results: PublicScanWorkerResult[] = [];

  while (results.length < maxSteps && Date.now() < deadline) {
    const result = await processPublicScanJob();
    if (result.status === "idle") break;
    results.push(result);
  }

  return {
    processed: results.length,
    results,
    exhaustedBudget: results.length >= maxSteps || Date.now() >= deadline,
  };
}

/**
 * Start a small server-side head start after a request returns. This does not
 * make the browser responsible for work: the durable job is already committed
 * to Turso and the deployment Cron remains the recovery mechanism.
 */
export function kickPublicScanDrain(): void {
  after(async () => {
    try {
      await drainPublicScanJobs({
        maxSteps: REQUEST_DRAIN_MAX_STEPS,
        maxDurationMs: REQUEST_DRAIN_MAX_MS,
      });
    } catch (error) {
      console.error("request public scan drain failed:", error);
    }
  });
}

export async function drainPublicScanJobsFromCron(): Promise<PublicScanDrainResult> {
  return drainPublicScanJobs({
    maxSteps: CRON_DRAIN_MAX_STEPS,
    maxDurationMs: CRON_DRAIN_MAX_MS,
  });
}
