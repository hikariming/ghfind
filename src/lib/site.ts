/**
 * Single source of truth for the public site origin.
 *
 * Previously `layout.tsx` hardcoded the domain while `u/[username]/page.tsx`,
 * `llm.ts`, etc. read `PUBLIC_SITE_URL` — so the canonical/OG host could drift
 * from the actual deployment. Everything that needs an absolute URL (metadata,
 * sitemap, robots, JSON-LD) now imports `SITE_URL` from here.
 */
export const SITE_URL = (
  process.env.PUBLIC_SITE_URL || "https://ghfind.com"
).replace(/\/$/, "");

/**
 * Minimum public score for a profile to be submitted to search engines.
 *
 * Profiles below this are still reachable and shareable, but are kept out of the
 * sitemap AND marked `noindex` — we publish scores/roasts about real, named
 * people, so we don't want low-score ("NPC"/"拉完了") pages ranking on someone's
 * name. Matches the leaderboard's public floor.
 */
export const PUBLIC_INDEX_MIN_SCORE = 60;
