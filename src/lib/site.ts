/**
 * Single source of truth for the public site origin.
 *
 * Previously `layout.tsx` hardcoded the domain while `u/[username]/page.tsx`,
 * `llm.ts`, etc. read `PUBLIC_SITE_URL` — so the canonical/OG host could drift
 * from the actual deployment. Everything that needs an absolute URL (metadata,
 * sitemap, robots, JSON-LD) now imports `SITE_URL` from here.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || process.env.PUBLIC_SITE_URL || "https://ghfind.com"
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

/**
 * Minimum score BOTH sides of a PK must clear for the /vs page to (a) spend an
 * LLM call on a savage verdict and (b) be indexed / added to the sitemap. Lower
 * than the profile floor: a duel is interesting even at "solid" tier, but we
 * still don't burn the model or index pages on low-value matchups.
 */
export const VS_MIN_SCORE = 55;

/**
 * Build the `alternates` block for a page's metadata: a self-referencing
 * `canonical` plus `hreflang` pairs for both locales and an `x-default`.
 *
 * `path` is the locale-agnostic (zh-root) path, e.g. `/leaderboard`, `/u/torvalds`,
 * or `/` for the home page — no `/en` prefix. zh lives at the root, en under `/en`.
 * Each locale is self-canonical (zh and en are genuinely different-language pages,
 * so we do NOT collapse one onto the other); hreflang wires them together and tells
 * Google which URL to serve per language. Returned URLs are relative — `metadataBase`
 * in the root layout resolves them to absolute.
 */
export function localeAlternates(locale: string, path: string) {
  const clean = path === "/" ? "" : path.replace(/\/$/, "");
  const zh = clean || "/";
  const en = `/en${clean}`;
  return {
    canonical: locale === "en" ? en : zh,
    languages: { "zh-CN": zh, en, "x-default": zh },
  };
}
