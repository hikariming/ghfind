import { track } from "@vercel/analytics";

/**
 * Where a PK (versus) entry was triggered from — lets us tell the badge-landing
 * loop apart from in-page CTAs when reading the funnel. Kept as a closed union so
 * the dashboard groups stay clean.
 */
export type PkSource =
  | "badge_banner"
  | "profile_btn"
  | "leaderboard"
  | "modal"
  | "similar";

export type TrackEvent =
  | "badge_banner_view"
  | "badge_banner_click"
  | "pk_cta_click"
  | "similar_dev_click"
  | "leaderboard_vs_click"
  | "facet_rank_click"
  | "facet_board_vs_click"
  | "modal_cta_click"
  // Funnel top/bottom — added to make the /u landing → action → spread loop
  // measurable end-to-end (previously only the mid-funnel clicks were tracked).
  | "profile_landing" // /u profile viewed, with a coarse `source` bucket
  | "scan_start" // a roast was submitted from the home scanner
  | "scan_complete" // /api/scan returned a score (pre-roast)
  | "badge_copy" // a README badge/card snippet was copied
  | "share_click" // a share channel was picked (platform / copy / native / image)
  | "roast_reveal"; // homepage handoff popped the result modal over a cached roast

type VaWindow = Window & {
  va?: (...params: unknown[]) => void;
  vaq?: unknown[][];
};

/**
 * Thin, typed wrapper over Vercel Analytics `track()`. Client-only (the underlying
 * API no-ops on the server) and swallows failures so a blocked analytics script
 * never breaks a click handler. GA4 pageview autotracking is untouched — this only
 * adds the custom interaction events the growth surfaces need.
 */
export function trackEvent(
  name: TrackEvent,
  props?: Record<string, string | number | boolean>,
): void {
  try {
    // Mount-time events (e.g. badge_banner_view in a useEffect) can fire before
    // <Analytics/> — a root-layout effect that runs AFTER child effects — has
    // seeded window.va. The package's track() is `window.va?.(…)`, so those
    // events are silently dropped. Seed the same queue stub initQueue() would,
    // so early events buffer in window.vaq until the script drains them.
    if (typeof window !== "undefined") {
      const w = window as VaWindow;
      if (!w.va) {
        w.va = (...params: unknown[]) => {
          (w.vaq ??= []).push(params);
        };
      }
    }
    track(name, props);
  } catch {
    /* analytics blocked or unavailable */
  }
}
