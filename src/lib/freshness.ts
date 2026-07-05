/**
 * How long a persisted roast counts as "fresh", measured from `scores.scanned_at`
 * (only updated by a real default-model generation — replays never touch it).
 * Shared by the profile page (replay vs. forced regeneration on a homepage
 * handoff), the /api/roast `refresh` validation, and the RescanButton cooldown —
 * all three must agree, or a client could be promised a regeneration the server
 * refuses (or vice versa).
 */
export const ROAST_FRESH_MS = 24 * 60 * 60 * 1000;
