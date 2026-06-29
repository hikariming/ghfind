/**
 * Declarative primary-navigation config.
 *
 * The site is growing from a single scoring tool into a developer directory, so
 * nav items live here as plain data: adding a feature link = one entry here plus
 * one `nav.<key>` string in `src/messages/{zh,en}.json`.
 *
 * Kept serializable (no `"use client"`, no component refs) so the server `Navbar`
 * can pass it straight into the client `NavLinks` island. `icon` is a string
 * token, not a component, for the same reason — `NavLinks` maps it to an SVG.
 */
export type NavItem = {
  /** i18n key under the `nav` namespace, e.g. "leaderboard". */
  key: string;
  /** Internal path for the locale-aware `Link`. Omitted for a pure dropdown parent. */
  href?: string;
  /** Optional icon token resolved inside `NavLinks` (no icons yet). */
  icon?: string;
  /** Match the pathname exactly instead of treating `href` as a section prefix. */
  exact?: boolean;
  /** Small label badge, e.g. "beta". */
  badge?: string;
  /** Submenu items — when present this entry renders as a dropdown parent. */
  children?: NavItem[];
};

export const NAV_ITEMS: NavItem[] = [
  { key: "roast", href: "/", exact: true },
  { key: "leaderboard", href: "/leaderboard" },
  // P1 落地后加: { key: "developers", href: "/developers" },
];
