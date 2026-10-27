import type { AtomicStore } from "./atomic-store";

/**
 * Guard rails for the on-view "score version upgrade" rescan: when a real
 * browser views a profile whose stored score predates the current scoring
 * release, the page asks POST /api/scan (trigger=score_version_upgrade) to
 * re-evaluate it in the background. This is strictly on demand, one profile
 * per real page view — never a batch rescore or backfill.
 *
 * Layers (all must pass):
 * - kill switch env `GHFIND_AUTO_RESCAN_DISABLED` (1/true/on → off);
 * - automated-client filter (bot/crawler/headless/HTTP-library user agents,
 *   requests without browser fetch metadata, cross-site fetches);
 * - the stored score must actually be behind the current release (checked
 *   server-side, never trusted from the client);
 * - one attempt per user per 24h (the key doubles as the in-flight lock and is
 *   kept on failure too);
 * - a global fixed-window budget per hour, `GHFIND_AUTO_RESCAN_MAX_PER_HOUR`
 *   (default {@link AUTO_RESCAN_DEFAULT_MAX_PER_HOUR}; 0 disables).
 * The scan itself still goes through the normal producer (GitHub token pool,
 * scan slots, admission limits), so it cannot exceed the manual path's limits.
 */

export const AUTO_RESCAN_TRIGGER = "score_version_upgrade";
const AUTO_RESCAN_KILL_SWITCH_ENV = "GHFIND_AUTO_RESCAN_DISABLED";
const AUTO_RESCAN_MAX_PER_HOUR_ENV = "GHFIND_AUTO_RESCAN_MAX_PER_HOUR";
export const AUTO_RESCAN_DEFAULT_MAX_PER_HOUR = 20;
export const AUTO_RESCAN_USER_COOLDOWN_SECONDS = 24 * 60 * 60;
const HOUR_MS = 60 * 60 * 1000;

export type AutoRescanDeferral =
  | "disabled"
  | "automated_client"
  | "not_stale"
  | "cooldown"
  | "budget"
  | "unavailable";

type Env = Record<string, string | undefined>;

export function autoRescanDisabled(env: Env = process.env): boolean {
  const raw = env[AUTO_RESCAN_KILL_SWITCH_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function autoRescanMaxPerHour(env: Env = process.env): number {
  const raw = env[AUTO_RESCAN_MAX_PER_HOUR_ENV]?.trim();
  if (!raw) return AUTO_RESCAN_DEFAULT_MAX_PER_HOUR;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : AUTO_RESCAN_DEFAULT_MAX_PER_HOUR;
}

const AUTOMATED_UA =
  /bot\b|bot\/|crawl|spider|slurp|scrap|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|preview|facebookexternalhit|embedly|curl|wget|python|httpie|http-client|httpclient|okhttp|go-http|node-fetch|undici|axios|java\/|libwww|feedfetcher|monitor|uptime/i;

/** Best-effort: true for anything that does not look like an interactive browser fetch. */
export function isAutomatedClient(headers: Headers): boolean {
  const ua = headers.get("user-agent")?.trim() ?? "";
  if (!ua || !/^Mozilla\//.test(ua) || AUTOMATED_UA.test(ua)) return true;
  // Every current browser sends Fetch Metadata on fetch(); the page's own
  // request is same-origin. Missing or cross-site metadata → not our page.
  if (headers.get("sec-fetch-site") !== "same-origin") return true;
  const mode = headers.get("sec-fetch-mode");
  if (mode && mode !== "cors" && mode !== "same-origin") return true;
  return false;
}

export const autoRescanUserKey = (username: string) =>
  `auto-rescan:v1:user:${username.toLowerCase()}`;
export const autoRescanBudgetKey = (now: number) =>
  `auto-rescan:v1:budget:${Math.floor(now / HOUR_MS)}`;

export type AutoRescanAdmission =
  | { ok: true }
  | { ok: false; reason: Extract<AutoRescanDeferral, "cooldown" | "budget" | "unavailable">; retryAfter: number };

/**
 * Claim the per-user 24h slot, then one unit of the hourly budget. Fails
 * closed when the coordination store is missing or erroring.
 */
export async function admitAutoRescan(
  store: AtomicStore | null,
  username: string,
  { maxPerHour, now = Date.now() }: { maxPerHour: number; now?: number },
): Promise<AutoRescanAdmission> {
  const nextHour = Math.max(1, Math.ceil((HOUR_MS - (now % HOUR_MS)) / 1000));
  if (maxPerHour <= 0) return { ok: false, reason: "budget", retryAfter: nextHour };
  if (!store) return { ok: false, reason: "unavailable", retryAfter: 60 };
  const userKey = autoRescanUserKey(username);
  try {
    const claimed = await store.setIfAbsent(userKey, now, AUTO_RESCAN_USER_COOLDOWN_SECONDS);
    if (!claimed) {
      return { ok: false, reason: "cooldown", retryAfter: AUTO_RESCAN_USER_COOLDOWN_SECONDS };
    }
    const used = await store.incr(autoRescanBudgetKey(now), Math.ceil(HOUR_MS / 1000) + 60);
    if (used > maxPerHour) {
      // Over budget: give the user slot back so a later view can still try.
      await store.del(userKey).catch(() => {});
      return { ok: false, reason: "budget", retryAfter: nextHour };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable", retryAfter: 60 };
  }
}
