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
  | "roast_reveal" // homepage handoff popped the result modal over a cached roast
  // Project discovery (Phase B) — the /developers/repo project page and the
  // profile→project links that feed it, so the "developer ↔ project" loop is
  // measurable: repo_page_view carries a client-classified `source`, and
  // repo_card_click marks a profile repo card that routed into a project page.
  | "repo_page_view"
  | "repo_card_click"
  | "project_card_click"
  | "project_sort_change"
  | "project_filter_change"
  | "discovery_recommendation_click"
  // Homepage editor's-picks band: promo card → collection page.
  | "home_collections_click";

type GaWindow = Window & {
  gtag?: (...params: unknown[]) => void;
};

/**
 * Thin, typed wrapper over the GA4 transport (`gtag`, loaded in the root
 * layout). Client-only and swallows failures so a blocked analytics script
 * never breaks a click handler. GA4 pageview autotracking is untouched; this
 * only adds the custom interaction events the growth surfaces need.
 */
export function trackEvent(
  name: TrackEvent,
  props?: Record<string, string | number | boolean>,
): void {
  try {
    if (typeof window === "undefined") return;
    (window as GaWindow).gtag?.("event", name, props ?? {});
  } catch {
    /* analytics blocked or unavailable */
  }
}
