import type { AtomicStore } from "./atomic-store";
import {
  AUTO_RESCAN_USER_COOLDOWN_SECONDS,
  isAutomatedClient,
  type AutoRescanAdmission,
} from "./auto-rescan";
import { RESCAN_COOLDOWN_MS } from "./freshness";

/**
 * On-visit background score refresh: when a real browser is served an indexed
 * snapshot whose `scanned_at` is older than the scan-cache window (~24h),
 * schedule a score-only rescan (no LLM) while still returning the old snapshot
 * immediately. Mirrors {@link admitAutoRescan} (per-user 24h slot + hourly
 * budget) with a separate key namespace so it does not compete with the
 * score-version-upgrade auto-rescan budget.
 *
 * Env (defaults are safe to leave unset):
 * - `AUTO_REFRESH_ON_VISIT_ENABLED` — default ON; set 0/false/off/no to kill.
 * - `AUTO_REFRESH_ON_VISIT_HOURLY_BUDGET` — default
 *   {@link AUTO_REFRESH_ON_VISIT_DEFAULT_HOURLY_BUDGET} (3000/h; first-time scans of new users are not counted).
 */

const ENABLED_ENV = "AUTO_REFRESH_ON_VISIT_ENABLED";
const BUDGET_ENV = "AUTO_REFRESH_ON_VISIT_HOURLY_BUDGET";
const HOUR_MS = 60 * 60 * 1000;

export const AUTO_REFRESH_ON_VISIT_DEFAULT_HOURLY_BUDGET = 3000;
/** Same 24h user cooldown as the version-upgrade auto-rescan. */
export const AUTO_REFRESH_ON_VISIT_USER_COOLDOWN_SECONDS = AUTO_RESCAN_USER_COOLDOWN_SECONDS;
/** Snapshot older than this (≈ scan Redis TTL) may trigger a background refresh. */
export const AUTO_REFRESH_ON_VISIT_STALE_MS = RESCAN_COOLDOWN_MS;

type Env = Record<string, string | undefined>;

/** Default ON; only an explicit off value disables. */
export function autoRefreshOnVisitEnabled(env: Env = process.env): boolean {
  const raw = env[ENABLED_ENV]?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

export function autoRefreshOnVisitMaxPerHour(env: Env = process.env): number {
  const raw = env[BUDGET_ENV]?.trim();
  if (!raw) return AUTO_REFRESH_ON_VISIT_DEFAULT_HOURLY_BUDGET;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0
    ? value
    : AUTO_REFRESH_ON_VISIT_DEFAULT_HOURLY_BUDGET;
}

export const autoRefreshOnVisitUserKey = (username: string) =>
  `auto-refresh-visit:v1:user:${username.toLowerCase()}`;
export const autoRefreshOnVisitBudgetKey = (now: number) =>
  `auto-refresh-visit:v1:budget:${Math.floor(now / HOUR_MS)}`;

/**
 * Document navigations (profile SSR) send `sec-fetch-mode: navigate`, which the
 * strict fetch filter treats as automated. For SSR visit triggers, only the UA
 * bot heuristics apply (same list as {@link isAutomatedClient}).
 */
export function isAutomatedVisitClient(
  headers: Headers,
  { documentNavigate = false }: { documentNavigate?: boolean } = {},
): boolean {
  if (!documentNavigate) return isAutomatedClient(headers);
  const ua = headers.get("user-agent")?.trim() ?? "";
  if (!ua || !/^Mozilla\//.test(ua)) return true;
  return isAutomatedClient(
    new Headers({
      "user-agent": ua,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
    }),
  );
}

export function snapshotStaleForVisitRefresh(
  scannedAt: number | null | undefined,
  now = Date.now(),
): boolean {
  if (scannedAt == null || !Number.isSafeInteger(scannedAt) || scannedAt <= 0) return false;
  return now - scannedAt >= AUTO_REFRESH_ON_VISIT_STALE_MS;
}

/**
 * Claim the visit-refresh per-user 24h slot, then one unit of the hourly budget.
 * Fails closed when the coordination store is missing or erroring.
 */
export async function admitAutoRefreshOnVisit(
  store: AtomicStore | null,
  username: string,
  { maxPerHour, now = Date.now() }: { maxPerHour: number; now?: number },
): Promise<AutoRescanAdmission> {
  const nextHour = Math.max(1, Math.ceil((HOUR_MS - (now % HOUR_MS)) / 1000));
  if (maxPerHour <= 0) return { ok: false, reason: "budget", retryAfter: nextHour };
  if (!store) return { ok: false, reason: "unavailable", retryAfter: 60 };
  const userKey = autoRefreshOnVisitUserKey(username);
  try {
    const claimed = await store.setIfAbsent(
      userKey,
      now,
      AUTO_REFRESH_ON_VISIT_USER_COOLDOWN_SECONDS,
    );
    if (!claimed) {
      return {
        ok: false,
        reason: "cooldown",
        retryAfter: AUTO_REFRESH_ON_VISIT_USER_COOLDOWN_SECONDS,
      };
    }
    const used = await store.incr(autoRefreshOnVisitBudgetKey(now), Math.ceil(HOUR_MS / 1000) + 60);
    if (used > maxPerHour) {
      await store.del(userKey).catch(() => {});
      return { ok: false, reason: "budget", retryAfter: nextHour };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable", retryAfter: 60 };
  }
}
