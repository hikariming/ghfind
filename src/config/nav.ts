/**
 * Declarative primary-navigation config.
 *
 * The sidebar is organised by what a user wants to do, as flat groups with no
 * collapsible folders: adding a feature link = one entry here plus `nav.<key>`
 * and `nav.hint.<key>` strings in every `src/messages/*.json`.
 *
 * Kept serializable (no `"use client"`, no component refs) so it can cross the
 * server/client boundary. `icon` is a string token resolved by the renderer.
 */
export type NavItem = {
  /** i18n key under the `nav` namespace, e.g. "leaderboard". Also keys `nav.hint.<key>`. */
  key: string;
  /** Internal path for the locale-aware `Link`. */
  href?: string;
  /** Icon token resolved inside the renderer. */
  icon?: string;
  /** Match the pathname exactly instead of treating `href` as a section prefix. */
  exact?: boolean;
  /** Visually emphasise the entry as the primary call to action. */
  featured?: boolean;
  /** Show a Beta badge on this item (for a preview feature outside a Beta group). */
  beta?: boolean;
  /** Show a small "new!" callout on this item. */
  new?: boolean;
  /** Small label badge, e.g. "beta" (legacy `NavLinks` only). */
  badge?: string;
  /** Legacy dropdown children (still understood by `NavLinks`). */
  children?: NavItem[];
};

export type NavGroup = {
  /** i18n key under `nav` for the group heading; omitted for the unlabeled top group. */
  label?: string;
  /** Show a single Beta badge next to the heading instead of on every item. */
  beta?: boolean;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  { items: [
    { key: "roast", href: "/", exact: true, icon: "flame", featured: true },
    { key: "versus", href: "/vs", exact: true, icon: "swords" },
  ] },
  { label: "groupDiscover", items: [
    { key: "talent", href: "/talent", icon: "briefcase", beta: true },
    { key: "leaderboard", href: "/leaderboard", icon: "trophy" },
    { key: "projectBoards", href: "/projects", icon: "code" },
    { key: "collections", href: "/collections", icon: "star" },
    { key: "blog", href: "/blog", icon: "newspaper" },
  ] },
  { label: "groupCareer", beta: true, items: [
    { key: "resume", href: "/resume", icon: "resume" },
  ] },
  { label: "groupTools", items: [
    { key: "githubBot", href: "/github-bot", icon: "bot", new: true },
    { key: "cliApi", href: "/integrations", icon: "cable" },
  ] },
];

/** Every navigable entry, flattened in display order. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap(group => group.items);
