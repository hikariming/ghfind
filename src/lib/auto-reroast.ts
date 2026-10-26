import type { AtomicStore } from "./atomic-store";
import { ROAST_CACHE_VERSION } from "./cache-version";
import type { Lang } from "./lang";

/**
 * On-view roast re-generation after a version upgrade ("auto re-roast").
 *
 * A profile whose deterministic score is current but whose report in the
 * viewer's language is not on the current roast release (ROAST_CACHE_VERSION —
 * never a hardwired label) asks POST /api/roast/auto to regenerate it. The
 * request only *enqueues* a job; the ghfind-api cron drains the queue (see
 * auto-reroast-worker.ts) and the page polls GET /api/roast/auto. Generation
 * can therefore be slow or asynchronous (a future Mosoo-backed producer may
 * answer "pending" for several ticks) without holding a browser request open.
 *
 * Admission layers (all must pass, mirroring the auto score rescan):
 * - kill switch env `GHFIND_AUTO_REROAST_DISABLED` (1/true/on/yes → off);
 * - automated-client filter and per-IP limit (in the route);
 * - the server re-checks that the report is really behind the current release;
 * - one attempt per user + language + target release per 24h;
 * - a global fixed-window hourly budget, `GHFIND_AUTO_REROAST_MAX_PER_HOUR`
 *   (default {@link AUTO_REROAST_DEFAULT_MAX_PER_HOUR}; 0 disables).
 * Never a batch: one job per real page view.
 */

export const AUTO_REROAST_TRIGGER = "roast_version_upgrade";
const AUTO_REROAST_KILL_SWITCH_ENV = "GHFIND_AUTO_REROAST_DISABLED";
const AUTO_REROAST_MAX_PER_HOUR_ENV = "GHFIND_AUTO_REROAST_MAX_PER_HOUR";
export const AUTO_REROAST_DEFAULT_MAX_PER_HOUR = 20;
export const AUTO_REROAST_USER_COOLDOWN_SECONDS = 24 * 60 * 60;
/** A queued job that has not finished within this window is abandoned. */
export const AUTO_REROAST_JOB_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Generation attempts per job (a failed attempt is re-queued once). */
export const AUTO_REROAST_MAX_ATTEMPTS = 2;
const JOB_TTL_SECONDS = 3 * 60 * 60;
const FAILED_JOB_TTL_SECONDS = AUTO_REROAST_USER_COOLDOWN_SECONDS;
const DONE_JOB_TTL_SECONDS = 60 * 60;
const QUEUE_POINTER_TTL_SECONDS = 30 * 24 * 60 * 60;
const HOUR_MS = 60 * 60 * 1000;

type Env = Record<string, string | undefined>;

export function autoReroastDisabled(env: Env = process.env): boolean {
  const raw = env[AUTO_REROAST_KILL_SWITCH_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function autoReroastMaxPerHour(env: Env = process.env): number {
  const raw = env[AUTO_REROAST_MAX_PER_HOUR_ENV]?.trim();
  if (!raw) return AUTO_REROAST_DEFAULT_MAX_PER_HOUR;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : AUTO_REROAST_DEFAULT_MAX_PER_HOUR;
}

type AutoReroastState = "queued" | "running" | "done" | "failed";

export interface AutoReroastJob {
  state: AutoReroastState;
  username: string;
  lang: Lang;
  /** Roast release the job regenerates to (ROAST_CACHE_VERSION at enqueue). */
  target: string;
  queuedAt: number;
  attempts: number;
  updatedAt: number;
  reason?: string;
}

export interface AutoReroastSlot {
  username: string;
  lang: Lang;
  target: string;
}

export type AutoReroastDeferral =
  | "disabled"
  | "automated_client"
  | "not_eligible"
  | "cooldown"
  | "budget"
  | "unavailable";

const lc = (username: string) => username.toLowerCase();
export const autoReroastUserKey = (target: string, username: string, lang: Lang) =>
  `auto-reroast:v1:user:${target}:${lc(username)}:${lang}`;
export const autoReroastBudgetKey = (now: number) =>
  `auto-reroast:v1:budget:${Math.floor(now / HOUR_MS)}`;
export const autoReroastJobKey = (username: string, lang: Lang) =>
  `auto-reroast:v1:job:${lc(username)}:${lang}`;
export const AUTO_REROAST_QUEUE_TAIL_KEY = "auto-reroast:v1:queue:tail";
export const AUTO_REROAST_QUEUE_HEAD_KEY = "auto-reroast:v1:queue:head";
export const AUTO_REROAST_WORKER_LEASE_KEY = "auto-reroast:v1:worker";
export const autoReroastSlotKey = (index: number) => `auto-reroast:v1:queue:slot:${index}`;

/** Browser sessionStorage: one automatic attempt per tab session, profile and language. */
export const autoReroastSessionKey = (username: string, lang: Lang) =>
  `ghfind:auto-reroast:${lc(username)}:${lang}`;
/** Set by the auto score rescan so the follow-up re-roast needs no new gesture. */
export const autoReroastArmedKey = (username: string) => `ghfind:auto-reroast-armed:${lc(username)}`;

export function isActiveJob(job: AutoReroastJob | null, target = ROAST_CACHE_VERSION): job is AutoReroastJob {
  return Boolean(job && job.target === target && (job.state === "queued" || job.state === "running"));
}

export async function readAutoReroastJob(
  store: AtomicStore | null,
  username: string,
  lang: Lang,
): Promise<AutoReroastJob | null> {
  if (!store) return null;
  try {
    return (await store.get<AutoReroastJob>(autoReroastJobKey(username, lang))) ?? null;
  } catch {
    return null;
  }
}

export async function writeAutoReroastJob(store: AtomicStore, job: AutoReroastJob): Promise<void> {
  const ttl =
    job.state === "failed"
      ? FAILED_JOB_TTL_SECONDS
      : job.state === "done"
        ? DONE_JOB_TTL_SECONDS
        : JOB_TTL_SECONDS;
  await store.set(autoReroastJobKey(job.username, job.lang), job, ttl);
}

/** Append one slot to the FIFO the cron worker drains (head → tail). */
export async function enqueueAutoReroastSlot(store: AtomicStore, slot: AutoReroastSlot): Promise<number> {
  const index = await store.incr(AUTO_REROAST_QUEUE_TAIL_KEY, QUEUE_POINTER_TTL_SECONDS);
  await store.set(autoReroastSlotKey(index), slot, JOB_TTL_SECONDS);
  return index;
}

export const AUTO_REROAST_QUEUE_POINTER_TTL_SECONDS = QUEUE_POINTER_TTL_SECONDS;

export type AutoReroastAdmission =
  | { ok: true; job: AutoReroastJob; existing: boolean }
  | {
      ok: false;
      reason: Extract<AutoReroastDeferral, "cooldown" | "budget" | "unavailable">;
      retryAfter: number;
      job: AutoReroastJob | null;
    };

/**
 * Join an in-flight job for free; otherwise claim the per-user slot, then one
 * unit of the hourly budget, then enqueue. Fails closed without a store.
 */
export async function admitAutoReroast(
  store: AtomicStore | null,
  input: { username: string; lang: Lang; target?: string },
  { maxPerHour, now = Date.now() }: { maxPerHour: number; now?: number },
): Promise<AutoReroastAdmission> {
  const target = input.target ?? ROAST_CACHE_VERSION;
  const username = lc(input.username);
  const nextHour = Math.max(1, Math.ceil((HOUR_MS - (now % HOUR_MS)) / 1000));
  if (!store) return { ok: false, reason: "unavailable", retryAfter: 60, job: null };
  try {
    const existing = await readAutoReroastJob(store, username, input.lang);
    if (isActiveJob(existing, target)) return { ok: true, job: existing, existing: true };
    if (maxPerHour <= 0) return { ok: false, reason: "budget", retryAfter: nextHour, job: existing };
    const userKey = autoReroastUserKey(target, username, input.lang);
    const claimed = await store.setIfAbsent(userKey, now, AUTO_REROAST_USER_COOLDOWN_SECONDS);
    if (!claimed) {
      return {
        ok: false,
        reason: "cooldown",
        retryAfter: AUTO_REROAST_USER_COOLDOWN_SECONDS,
        job: existing,
      };
    }
    const used = await store.incr(autoReroastBudgetKey(now), Math.ceil(HOUR_MS / 1000) + 60);
    if (used > maxPerHour) {
      await store.del(userKey).catch(() => {});
      return { ok: false, reason: "budget", retryAfter: nextHour, job: existing };
    }
    const job: AutoReroastJob = {
      state: "queued",
      username,
      lang: input.lang,
      target,
      queuedAt: now,
      attempts: 0,
      updatedAt: now,
    };
    await writeAutoReroastJob(store, job);
    await enqueueAutoReroastSlot(store, { username, lang: input.lang, target });
    return { ok: true, job, existing: false };
  } catch {
    return { ok: false, reason: "unavailable", retryAfter: 60, job: null };
  }
}
