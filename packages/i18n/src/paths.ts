import { DEFAULT_LOCALE, HTML_LANG, LOCALES, PREFIXED_LOCALES, type Locale } from "./config";

/**
 * Prefix a locale-agnostic (zh-root) path for a locale: zh lives at the bare
 * root, every other locale under `/<locale>`. `path` must start with `/`.
 */
export function localePath(locale: string, path: string): string {
  const clean = path === "/" ? "" : path.replace(/\/$/, "");
  return locale === DEFAULT_LOCALE ? clean || "/" : `/${locale}${clean}`;
}

/**
 * Build the `alternates` block for a page's metadata: a self-referencing
 * `canonical` plus `hreflang` pairs for every locale and an `x-default`.
 *
 * `path` is the locale-agnostic (zh-root) path, e.g. `/leaderboard`, `/u/torvalds`,
 * or `/` for the home page — no locale prefix. Each locale is self-canonical
 * (the locales are genuinely different-language pages, so we do NOT collapse one
 * onto another); hreflang wires them together and tells Google which URL to serve
 * per language. Returned URLs are relative to the site origin.
 */
export function localeAlternates(locale: string, path: string) {
  const languages: Record<string, string> = {};
  for (const l of LOCALES) {
    languages[HTML_LANG[l]] = localePath(l, path);
  }
  languages["x-default"] = localePath(DEFAULT_LOCALE, path);
  return {
    canonical: localePath(locale, path),
    languages,
  };
}

/**
 * Split a public pathname into its locale prefix and the locale-agnostic rest.
 * `/en/u/x` → `{ locale: "en", path: "/u/x" }`; `/u/x` → `{ locale: null, path: "/u/x" }`.
 * An explicit `/zh` prefix is recognized too. The router matches its route
 * table against `path` so one rule covers all nine locales.
 */
export function splitLocale(pathname: string): { locale: Locale | null; path: string } {
  for (const l of [DEFAULT_LOCALE, ...PREFIXED_LOCALES]) {
    if (pathname === `/${l}`) return { locale: l, path: "/" };
    if (pathname.startsWith(`/${l}/`)) return { locale: l, path: pathname.slice(l.length + 1) };
  }
  return { locale: null, path: pathname };
}
