import { splitLocale } from "@ghfind/i18n";

export type Target = "web" | "api" | "legacy";

/**
 * Migration route table: which Worker serves each path. Anything unmatched
 * stays on the legacy Next Worker. To roll a route back, delete its rule (or
 * set ROUTER_FORCE_LEGACY to send everything to legacy).
 */

/**
 * Pages served by the Astro Worker. Rules match the locale-agnostic path
 * (`/en/about` and `/about` both match `/about`), so one rule covers all nine
 * locales.
 */
const WEB_PAGES: readonly string[] = [
  "/about",
];

/** Build output of the Astro app (hashed JS/CSS). */
const WEB_PREFIXES: readonly string[] = ["/_astro/"];

/**
 * API routes served by the Hono Worker (P1 batch 1: read-only). Whole-path
 * patterns, never prefixes: sibling routes such as /api/talent/:id and
 * /api/campaigns/:c/leaderboard/events are not migrated yet.
 */
const API_ROUTES: readonly RegExp[] = [
  /^\/api\/leaderboard$/,
  /^\/api\/stats$/,
  /^\/api\/search-users$/,
  /^\/api\/developers$/,
  /^\/api\/talent$/,
  /^\/api\/sponsors$/,
  /^\/api\/facet-rank\/[^/]+$/,
  /^\/api\/campaigns\/[^/]+\/leaderboard$/,
];

export function pickTarget(pathname: string): Target {
  if (pathname.startsWith("/api/")) {
    return API_ROUTES.some((re) => re.test(pathname)) ? "api" : "legacy";
  }
  if (WEB_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return "web";
  const { path } = splitLocale(pathname);
  return WEB_PAGES.includes(path) ? "web" : "legacy";
}
