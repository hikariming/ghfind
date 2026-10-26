import { NextRequest } from "next/server";
import type { AtomicStore } from "./atomic-store";
import {
  AUTO_REROAST_JOB_MAX_AGE_MS,
  AUTO_REROAST_MAX_ATTEMPTS,
  AUTO_REROAST_QUEUE_HEAD_KEY,
  AUTO_REROAST_QUEUE_POINTER_TTL_SECONDS,
  AUTO_REROAST_QUEUE_TAIL_KEY,
  AUTO_REROAST_WORKER_LEASE_KEY,
  autoReroastDisabled,
  autoReroastSlotKey,
  enqueueAutoReroastSlot,
  readAutoReroastJob,
  writeAutoReroastJob,
  type AutoReroastJob,
  type AutoReroastSlot,
} from "./auto-reroast";
import { ROAST_CACHE_VERSION } from "./cache-version";
import { getAccountDetail } from "./db";
import { autoReroastStore } from "./redis";
import { handleRoastPost } from "./roast-handler";

/**
 * Producer outcome. "pending" means the producer accepted the work but has not
 * finished (an async/remote generator); the job is re-checked on a later tick
 * without spending an attempt, until AUTO_REROAST_JOB_MAX_AGE_MS.
 */
type AutoReroastProduceResult = "done" | "failed" | "pending";
export type AutoReroastProducer = (slot: AutoReroastSlot) => Promise<AutoReroastProduceResult>;

/** True once the selected-language report is persisted on the current release. */
async function hasCurrentRoast(username: string, lang: AutoReroastSlot["lang"]): Promise<boolean> {
  const detail = await getAccountDetail(username);
  if (!detail || detail.legacy_read_fallback) return false;
  return Boolean(lang === "en" ? detail.roast_en : detail.roast);
}

/**
 * Default producer: the platform model through the exact POST /api/roast
 * pipeline (single-flight lock, sanitizers, CAS write against the current
 * score identity). The stream is drained here; success is judged only by the
 * persisted, version-gated row — never by the stream contents.
 */
const inlineModelProducer: AutoReroastProducer = async (slot) => {
  const req = new NextRequest("https://ghfind-api.internal/api/roast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: slot.username, lang: slot.lang, refresh: true }),
  });
  const res = await handleRoastPost(req, { autoReroastJob: true });
  if (res.body) {
    const reader = res.body.getReader();
    while (!(await reader.read()).done) {
      // drain: generation and persistence finish inside the stream
    }
  }
  return (await hasCurrentRoast(slot.username, slot.lang)) ? "done" : "failed";
};

export interface AutoReroastQueueResult {
  status: "disabled" | "unavailable" | "busy" | "ran";
  processed?: number;
  outcomes?: Record<string, number>;
}

const WORKER_LEASE_SECONDS = 14 * 60;

/**
 * Drain the auto re-roast FIFO (cron). One worker at a time (lease); at most
 * `maxJobs` producer calls per tick and no new job after `budgetMs`, so a tick
 * stays far inside the 15-minute cron limit even when each call is slow.
 */
export async function runAutoReroastQueue({
  store = autoReroastStore(),
  produce = inlineModelProducer,
  maxJobs = 3,
  budgetMs = 8 * 60_000,
  now = () => Date.now(),
}: {
  store?: AtomicStore | null;
  produce?: AutoReroastProducer;
  maxJobs?: number;
  budgetMs?: number;
  now?: () => number;
} = {}): Promise<AutoReroastQueueResult> {
  if (autoReroastDisabled()) return { status: "disabled" };
  if (!store) return { status: "unavailable" };
  const startedAt = now();
  if (!(await store.setIfAbsent(AUTO_REROAST_WORKER_LEASE_KEY, startedAt, WORKER_LEASE_SECONDS))) {
    return { status: "busy" };
  }
  const outcomes: Record<string, number> = {};
  const count = (key: string) => {
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  };
  let processed = 0;
  try {
    const tail = Number((await store.get<number>(AUTO_REROAST_QUEUE_TAIL_KEY)) ?? 0);
    let head = Number((await store.get<number>(AUTO_REROAST_QUEUE_HEAD_KEY)) ?? 0);
    if (head > tail) head = 0; // pointers expired independently; slots self-expire
    while (head < tail && processed < maxJobs && now() - startedAt < budgetMs) {
      head += 1;
      const slot = await store.get<AutoReroastSlot>(autoReroastSlotKey(head));
      if (slot) {
        const outcome = await processSlot(store, slot, produce, now);
        count(outcome);
        if (outcome !== "skipped") processed += 1;
        await store.del(autoReroastSlotKey(head));
      }
      await store.set(AUTO_REROAST_QUEUE_HEAD_KEY, head, AUTO_REROAST_QUEUE_POINTER_TTL_SECONDS);
    }
  } finally {
    await store.del(AUTO_REROAST_WORKER_LEASE_KEY).catch(() => {});
  }
  return { status: "ran", processed, outcomes };
}

type SlotOutcome = "done" | "failed" | "pending" | "retry" | "skipped" | "superseded" | "expired";

async function processSlot(
  store: AtomicStore,
  slot: AutoReroastSlot,
  produce: AutoReroastProducer,
  now: () => number,
): Promise<SlotOutcome> {
  const job = await readAutoReroastJob(store, slot.username, slot.lang);
  if (!job || job.target !== slot.target || (job.state !== "queued" && job.state !== "running")) {
    return "skipped";
  }
  const finish = async (state: AutoReroastJob["state"], reason?: string) => {
    await writeAutoReroastJob(store, { ...job, state, reason, updatedAt: now() });
  };
  // Version-driven: a job for a release that is no longer current is moot.
  if (slot.target !== ROAST_CACHE_VERSION) {
    await finish("failed", "superseded");
    log("superseded", slot);
    return "superseded";
  }
  if (now() - job.queuedAt > AUTO_REROAST_JOB_MAX_AGE_MS) {
    await finish("failed", "expired");
    log("expired", slot);
    return "expired";
  }
  if (await hasCurrentRoast(slot.username, slot.lang).catch(() => false)) {
    await finish("done", "already_current");
    log("done", slot, { reason: "already_current" });
    return "done";
  }
  await writeAutoReroastJob(store, { ...job, state: "running", updatedAt: now() });
  let result: AutoReroastProduceResult;
  const t0 = now();
  try {
    result = await produce(slot);
  } catch (error) {
    console.error("auto_reroast producer threw", error);
    result = "failed";
  }
  const ms = now() - t0;
  if (result === "done") {
    await finish("done");
    log("done", slot, { ms, attempts: job.attempts + 1 });
    return "done";
  }
  if (result === "pending") {
    await writeAutoReroastJob(store, { ...job, state: "queued", updatedAt: now() });
    await enqueueAutoReroastSlot(store, slot);
    log("pending", slot, { ms });
    return "pending";
  }
  const attempts = job.attempts + 1;
  if (attempts < AUTO_REROAST_MAX_ATTEMPTS) {
    await writeAutoReroastJob(store, { ...job, state: "queued", attempts, updatedAt: now() });
    await enqueueAutoReroastSlot(store, slot);
    log("retry", slot, { ms, attempts });
    return "retry";
  }
  await writeAutoReroastJob(store, { ...job, state: "failed", attempts, reason: "generation_failed", updatedAt: now() });
  log("failed", slot, { ms, attempts });
  return "failed";
}

function log(outcome: string, slot: AutoReroastSlot, extra: Record<string, unknown> = {}) {
  console.log("auto_reroast", {
    outcome,
    username: slot.username,
    lang: slot.lang,
    to_roast_version: slot.target,
    ...extra,
  });
}
