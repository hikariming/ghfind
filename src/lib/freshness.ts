/**
 * How long a persisted roast counts as "fresh", measured from `scores.scanned_at`
 * (only updated by a real default-model generation — replays never touch it).
 * Used by the profile page (replay vs. forced regeneration on a homepage
 * handoff). Kept at 48h so a homepage handoff does not re-spend an LLM call
 * for a roast that is still relatively recent.
 */
export const ROAST_FRESH_MS = 48 * 60 * 60 * 1000;

/**
 * Manual rescan cooldown and server-side `refresh: true` honor window, measured
 * from `scores.scanned_at`. Shared by RescanButton, POST /api/roast refresh
 * validation (aligned with Go `roastFreshness`), and the on-visit auto score
 * refresh age gate. Must stay in sync across those call sites so the UI does
 * not promise a regeneration the server refuses (or vice versa).
 *
 * Distinct from {@link ROAST_FRESH_MS}: owners can manually re-detect after 24h,
 * while the roast Redis TTL (`ROAST_TTL_SECONDS`, 48h) and homepage handoff
 * freshness stay on the longer window.
 */
export const RESCAN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
