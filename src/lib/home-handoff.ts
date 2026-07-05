/**
 * Client-side helpers for the homepage → /u/{username} handoff: the homepage
 * stashes the fresh scan in sessionStorage and navigates with `?roasting=1`
 * (see Roaster). The profile-page components consume both here so they agree
 * on the key and on when the one-shot URL marker is spent.
 */
import { pendingScanKey } from "./roast-stream";
import type { ScanResult } from "./types";

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
