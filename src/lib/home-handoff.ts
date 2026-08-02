/**
 * Client-side helpers for the homepage → /u/{username} handoff: the homepage
 * stashes the fresh scan in sessionStorage and navigates with `?roasting=1`
 * (see Roaster). The profile-page components consume both here so they agree
 * on the key and on when the one-shot URL marker is spent.
 */
import { pendingScanKey } from "./roast-stream";
import type { ScanResult } from "./types";

const HANDOFF_CONSUMED_KEY = "__ghfindRoastingHandoffConsumed";

/** Read the homepage-stashed scan for `username`; null during SSR or if absent. */
export function readSessionScan(username: string): ScanResult | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(pendingScanKey(username));
    return raw ? (JSON.parse(raw) as ScanResult) : null;
  } catch {
    return null;
  }
}

/**
 * Remove the `?roasting=1` handoff marker from the address bar once it has been
 * consumed, so reloads / back-nav / copied links behave like direct visits (no
 * repeat popup, no repeat regeneration). Native replaceState — a router.replace
 * would re-render the force-dynamic profile page for nothing.
 */
export function stripRoastingParam(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("roasting")) return;
  url.searchParams.delete("roasting");
  window.history.replaceState(window.history.state, "", url);
}

/**
 * Atomically spend the current homepage handoff. Removing the query parameter
 * alone is not enough: a client component can remount while Next still holds
 * the server-rendered `?roasting=1` search params. Marking the history entry
 * makes that same navigation idempotent without suppressing a later, new
 * homepage handoff for the same profile.
 */
export function consumeRoastingHandoff(): boolean {
  if (typeof window === "undefined") return false;

  const url = new URL(window.location.href);
  if (url.searchParams.get("roasting") !== "1") return false;

  const state = window.history.state;
  if (
    state !== null &&
    typeof state === "object" &&
    (state as Record<string, unknown>)[HANDOFF_CONSUMED_KEY] === true
  ) {
    return false;
  }

  url.searchParams.delete("roasting");
  window.history.replaceState(
    {
      ...(state !== null && typeof state === "object" ? state : {}),
      [HANDOFF_CONSUMED_KEY]: true,
    },
    "",
    url,
  );
  return true;
}
