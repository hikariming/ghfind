/**
 * Locale configuration shared by every frontend runtime (Next, Astro, router).
 *
 * Chinese is the default and lives at the root (no prefix) so every existing
 * URL — `/`, `/leaderboard`, `/u/<name>`, and the README-embedded badge/card
 * endpoints — keeps working untouched. Every other locale is served under its
 * prefix (`/en`, `/ja`, `/ko`, `/es`, `/pt`, `/id`, `/vi`, `/ar`).
 *
 * UI/content split: these locales localize the UI shell, metadata, and research
 * articles. LLM-generated content (roast reports, tags, VS verdicts) only exists
 * in zh/en — non-zh locales read the English side (see `normLang` in
 * `src/lib/lang.ts`).
 */
export const LOCALES = ["zh", "en", "ja", "ko", "es", "pt", "id", "vi", "ar"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "zh";

/** Locales served under a `/<locale>` prefix (everything but the zh root). */
export const PREFIXED_LOCALES: readonly Locale[] = LOCALES.filter((l) => l !== DEFAULT_LOCALE);

/**
 * Remembered language choice. Same name next-intl uses, so the cookie stays
 * consistent across the Next and Astro apps during the migration.
 */
export const LOCALE_COOKIE = "NEXT_LOCALE";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * BCP 47 tag per locale — used for `<html lang>`, hreflang keys, and JSON-LD
 * `inLanguage`. zh is regionalized (the site is Simplified Chinese) and pt is
 * Brazilian (the translation targets Brazil's dev community); the rest pass
 * through unchanged.
 */
export const HTML_LANG = {
  zh: "zh-CN",
  en: "en",
  ja: "ja",
  ko: "ko",
  es: "es",
  pt: "pt-BR",
  id: "id",
  vi: "vi",
  ar: "ar",
} as const satisfies Record<Locale, string>;

/**
 * Text direction per locale for `<html dir>`. Only Arabic is RTL today; the
 * layout ships logical CSS properties (`ms-`/`pe-`/`text-start`…) so adding
 * another RTL locale later is just extending this set.
 */
export const RTL_LOCALES: ReadonlySet<Locale> = new Set(["ar"]);

export function isLocale(value: unknown): value is Locale {
  return LOCALES.includes(value as Locale);
}

export function localeDir(locale: string): "ltr" | "rtl" {
  return RTL_LOCALES.has(locale as Locale) ? "rtl" : "ltr";
}

/**
 * BCP 47 tag for a (possibly untrusted) locale string — for `Intl` formatters
 * and JSON-LD `inLanguage`. Unknown values fall back to the default locale.
 */
export function bcp47(locale: string): string {
  return isLocale(locale) ? HTML_LANG[locale] : HTML_LANG[DEFAULT_LOCALE];
}
