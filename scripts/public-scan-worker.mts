import "./_env.mjs";
import { configurePublicScanExecutionCapacity } from "../src/lib/db";
import { drainPublicScanJobsFromWorker } from "../src/lib/public-scan-dispatcher";

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
const IDLE_DELAY_MS = 1_000;
const SLOT_BUSY_DELAY_MS = 250;
const FAILURE_DELAY_MS = 5_000;
const WORKER_LEASE_MS = 5 * 60 * 1_000;
const IDLE_HEARTBEAT_INTERVAL_MS = 30_000;

function configuredConcurrency(): number {
  const raw = process.env.PUBLIC_SCAN_WORKER_CONCURRENCY;
  if (raw === undefined || raw === "") return DEFAULT_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONCURRENCY) {
    throw new Error(`PUBLIC_SCAN_WORKER_CONCURRENCY must be an integer from 1 to ${MAX_CONCURRENCY}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "Unknown";
}

let stopping = false;
let nextIdleHeartbeatAt = 0;
function stop(): void {
  stopping = true;
}

function shouldRecordIdleHeartbeat(): boolean {
  const now = Date.now();
  if (now < nextIdleHeartbeatAt) return false;
  nextIdleHeartbeatAt = now + IDLE_HEARTBEAT_INTERVAL_MS;
  return true;
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function runLane(lane: number): Promise<void> {
  while (!stopping) {
    try {
      const result = await drainPublicScanJobsFromWorker({
        leaseMs: WORKER_LEASE_MS,
        recordIdleHeartbeat: shouldRecordIdleHeartbeat(),
      });
      if (result.processed > 0) continue;
      const slotBusy = result.results.some((step) => step.status === "slot_busy");
      await sleep(slotBusy ? SLOT_BUSY_DELAY_MS : IDLE_DELAY_MS);
    } catch (error) {
      console.error(
        "public_scan.service_lane_failed",
        JSON.stringify({ lane, errorType: errorKind(error) }),
      );
      await sleep(FAILURE_DELAY_MS);
    }
  }
}

const concurrency = configuredConcurrency();
const capacity = await configurePublicScanExecutionCapacity({ capacity: concurrency });
console.info(
  "public_scan.service_started",
  JSON.stringify({ capacity: capacity.capacity, changed: capacity.changed, lanes: concurrency }),
);

await Promise.all(Array.from({ length: concurrency }, (_, index) => runLane(index + 1)));
console.info("public_scan.service_stopped", JSON.stringify({ lanes: concurrency }));
