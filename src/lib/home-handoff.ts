/**
 * Client-side helpers for the homepage → /u/{username} handoff: the homepage
 * navigates immediately with `?roasting=1` and may stash a scan (or just an
 * evaluate intent + Turnstile token) in sessionStorage. Profile-page components
 * consume both here so they agree on the key and on when the one-shot URL
 * marker is spent.
 */
import { pendingScanKey } from "./roast-stream";
import type { ScanResult } from "./types";

const HANDOFF_CONSUMED_KEY = "__ghfindRoastingHandoffConsumed";

export function pendingEvaluateKey(username: string): string {
  return `pendingEvaluate:${username.toLowerCase()}`;
}

export interface PendingEvaluateIntent {
  /** Turnstile token captured on the homepage; optional if verification is off. */
  turnstileToken?: string;
  campaign?: string | null;
  startedAt: number;
}

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

/** Stash a fresh scan so PendingProfile / LiveRoast can read it after navigation. */
export function writeSessionScan(username: string, scan: ScanResult): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(pendingScanKey(username), JSON.stringify(scan));
  } catch {
    /* private mode / quota */
  }
}

/** Homepage → profile: remember Turnstile + campaign before the scan finishes. */
export function writePendingEvaluate(username: string, intent: PendingEvaluateIntent): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(pendingEvaluateKey(username), JSON.stringify(intent));
  } catch {
    /* private mode / quota */
  }
}

/** Read-and-clear the evaluate intent so a retry can collect a fresh token. */
export function takePendingEvaluate(username: string): PendingEvaluateIntent | null {
  if (typeof window === "undefined") return null;
  try {
    const key = pendingEvaluateKey(username);
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    sessionStorage.removeItem(key);
    return JSON.parse(raw) as PendingEvaluateIntent;
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
