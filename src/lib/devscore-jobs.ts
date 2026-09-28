/**
 * Background devscore scoring: advances one account's `devscore_jobs` row.
 *
 * A run has three stages, checkpointed in the job row after every step so any
 * invocation (a status poll, the internal advance route) can continue it:
 *   display → ghfind's bounded `collect()` for display/roast evidence (never scored)
 *   collect → devscore's resumable collector (`stepCollect`) until a `Developer` exists
 *   publish → `rateDeveloper` summary stored in the snapshot; ghfind `score()`
 *             of the display metrics → canonical score write
 * Large intermediate data (display scan, developer) lives in the collect store.
 */
import {
  claimDevscoreJob,
  completeDevscoreJob,
  enqueueDevscoreJob,
  failDevscoreJobAttempt,
  getCurrentCanonicalQuickScan,
  getDevscoreJob,
  publishCompleteQuickScan,
  saveDevscoreJobProgress,
  type DevscoreJob,
} from "@/lib/db";
import {
  startCollect,
  stepCollect,
  type CollectEnv,
  type CollectState,
  type CollectStore,
} from "@/lib/devscore/collect";
import { rateDeveloper } from "@/lib/devscore/engine";
import { parseDeveloper, type Developer } from "@/lib/devscore/model";
import { devscoreSummary } from "@/lib/devscore-scoring";
import { getDevscoreCollectStore } from "@/lib/devscore-store";
import { AccountNotFoundError, GitHubAuthRequiredError, githubTokens } from "@/lib/github";
import { setCachedScan } from "@/lib/redis";
import { score } from "@/lib/score";
import { buildDisplayScan, type DisplayScan } from "@/lib/scan-core";
import type { ScanJobStatus } from "@/lib/scan-job-client";
import type { ScanResult } from "@/lib/types";

/** Work budget of one advance inside a 60 s route. */
export const DEVSCORE_STEP_BUDGET_MS = 35_000;
/** Lease outlives the step budget so a live runner is never reclaimed. */
const LEASE_MS = DEVSCORE_STEP_BUDGET_MS + 25_000;
export const DEVSCORE_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
/** Intermediate run blobs outlive any realistic retry window. */
const RUN_BLOB_TTL_SECONDS = 7 * 24 * 60 * 60;

type Stage = "display" | "collect" | "publish";

interface Checkpoint {
  v: 1;
  stage: Stage;
  /** Canonical-case login from the display collection. */
  login?: string;
  collect?: CollectState;
}

export interface AdvanceResult {
  status: ScanJobStatus;
  /** The published canonical scan, once the job is done. */
  result?: ScanResult;
}

function statusOf(job: DevscoreJob): ScanJobStatus {
  if (job.state === "failed") return { state: "failed", error: job.lastError ?? "scan_failed" };
  if (job.state === "done") return { state: "done", phase: "publish", progress: 1 };
  return { state: job.state, phase: job.phase, progress: job.progress };
}

/** Pending/finished status of one account's job; null without a job or database. */
export async function getDevscoreJobStatus(username: string): Promise<ScanJobStatus | null> {
  try {
    const job = await getDevscoreJob(username);
    return job ? statusOf(job) : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a job exists for an account without a current score. `rescan` resets
 * a finished or failed job at once; otherwise a finished job is reset (its
 * score was not readable, or the caller would not be here) and a failed one
 * only after its cooldown.
 */
export async function requestDevscoreJob(
  username: string,
  options: { rescan?: boolean } = {},
): Promise<ScanJobStatus | null> {
  const job = await enqueueDevscoreJob(username, { resetDone: true, resetFailed: options.rescan === true });
  return job ? statusOf(job) : null;
}

function parseCheckpoint(raw: string | null): Checkpoint {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<Checkpoint>;
      if (parsed?.v === 1 && (parsed.stage === "display" || parsed.stage === "collect" || parsed.stage === "publish")) {
        return parsed as Checkpoint;
      }
    } catch {
      // A corrupt checkpoint restarts the run below.
    }
  }
  return { v: 1, stage: "display" };
}

function displayKey(job: DevscoreJob) {
  return `job:${job.runId}:display`;
}

function developerKey(job: DevscoreJob) {
  return `job:${job.runId}:developer`;
}

function collectEnv(store: CollectStore): CollectEnv {
  return {
    fetch: (input, init) => fetch(input, init),
    githubTokens: githubTokens(),
    store,
    now: Date.now,
    log: (msg) => console.log(`devscore.collect ${msg}`),
  };
}

function isAccountNotFound(error: unknown): boolean {
  return (
    error instanceof AccountNotFoundError ||
    (error instanceof Error && /^user .+ not found$/i.test(error.message))
  );
}

function errorCode(error: unknown): string {
  if (isAccountNotFound(error)) return "account_not_found";
  if (error instanceof GitHubAuthRequiredError) return "github_token_required";
  return "scan_failed";
}

/**
 * Merge the display evidence with a rated developer into the snapshot to
 * publish. The snapshot stores the devscore summary; the published score is
 * still `score()` of the display metrics.
 */
export function buildDevscoreScan(display: DisplayScan, developer: Developer): ScanResult {
  const summary = devscoreSummary(developer, rateDeveloper(developer));
  return { ...display, devscore: summary, scoring: score(display.metrics) };
}

async function publish(
  job: DevscoreJob,
  checkpoint: Checkpoint,
  store: CollectStore,
  now: number,
): Promise<ScanResult> {
  const [display, developerJson] = await Promise.all([
    store.get<DisplayScan>(displayKey(job)),
    store.get<unknown>(developerKey(job)),
  ]);
  if (!display || developerJson === null) {
    // The run's blobs expired or were lost: the retry restarts the run.
    checkpoint.stage = "display";
    delete checkpoint.collect;
    throw new Error("devscore run data missing");
  }
  const scan = buildDevscoreScan(display, parseDeveloper(developerJson));
  const written = await publishCompleteQuickScan(scan, now);
  const canonical = written ? null : await getCurrentCanonicalQuickScan(scan.metrics.username);
  // Superseded by a newer canonical write for the same account: that one stands.
  if (!written && !canonical) throw new Error("score persistence unavailable");
  const published = canonical?.scan ?? scan;
  await setCachedScan(published.metrics.username, published);
  return published;
}

/**
 * Claim `username`'s job and advance it until it finishes or `deadlineMs`
 * (epoch ms). Returns null when the account has no job. Never throws for job
 * failures: they are recorded on the row (backoff, then `failed`).
 */
export async function advanceDevscoreJob(
  username: string,
  deadlineMs: number,
): Promise<AdvanceResult | null> {
  const existing = await getDevscoreJob(username);
  if (!existing) return null;
  if (existing.state === "failed") return { status: statusOf(existing) };
  if (existing.state === "done") {
    const current = await getCurrentCanonicalQuickScan(username);
    // A finished job whose score is no longer readable ends the poll; the next
    // scan request re-enqueues it.
    return current
      ? { status: statusOf(existing), result: current.scan }
      : { status: { state: "failed", error: "scan_failed" } };
  }
  const startedAt = Date.now();
  const job = await claimDevscoreJob(username, { now: startedAt, leaseMs: LEASE_MS });
  // Another runner holds the lease, or the job is backing off.
  if (!job) return { status: statusOf(existing) };

  const store = getDevscoreCollectStore();
  const checkpoint = parseCheckpoint(job.collectState);
  let phase = job.phase;
  let progress = job.progress;
  let nextRunAt = startedAt;
  const save = (release: boolean) =>
    saveDevscoreJobProgress(job, {
      collectState: JSON.stringify(checkpoint),
      phase,
      progress,
      nextRunAt,
      now: Date.now(),
      release,
    });

  try {
    if (checkpoint.stage === "display") {
      phase = "user";
      const display = await buildDisplayScan(username);
      await store.put(displayKey(job), display, RUN_BLOB_TTL_SECONDS);
      checkpoint.login = display.metrics.username;
      checkpoint.collect = startCollect(display.metrics.username);
      checkpoint.stage = "collect";
      if (!(await save(false))) return { status: statusOf(existing) };
    }

    if (checkpoint.stage === "collect") {
      const env = collectEnv(store);
      let state = checkpoint.collect ?? startCollect(checkpoint.login ?? username);
      while (Date.now() < deadlineMs) {
        if (state.waitUntil !== null && state.waitUntil > Date.now()) {
          nextRunAt = state.waitUntil;
          break;
        }
        const step = await stepCollect(state, env, deadlineMs);
        if (step.done) {
          await store.put(developerKey(job), step.developer, RUN_BLOB_TTL_SECONDS);
          checkpoint.stage = "publish";
          delete checkpoint.collect;
          phase = "publish";
          progress = 1;
          break;
        }
        state = step.state;
        checkpoint.collect = state;
        phase = state.phase;
        progress = Math.min(0.99, Math.max(0, state.progress));
        if (!(await save(false))) return { status: { state: "running", phase, progress } };
      }
    }

    if (checkpoint.stage === "publish" && Date.now() < deadlineMs) {
      const result = await publish(job, checkpoint, store, Date.now());
      await completeDevscoreJob(job, Date.now());
      return { status: { state: "done", phase: "publish", progress: 1 }, result };
    }

    await save(true);
    return { status: { state: "running", phase, progress } };
  } catch (error) {
    const code = errorCode(error);
    const terminal = code === "account_not_found";
    if (code !== "account_not_found") console.error("devscore job step failed:", error);
    const now = Date.now();
    const retryAt = now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** job.attempts);
    // Keep the checkpoint so the retry resumes where this attempt stopped.
    await save(false).catch(() => false);
    const failed = await failDevscoreJobAttempt(job, {
      error: code,
      now,
      retryAt,
      maxAttempts: DEVSCORE_MAX_ATTEMPTS,
      terminal,
    }).catch(() => null);
    return { status: failed ? statusOf(failed) : { state: "running", phase, progress } };
  }
}
