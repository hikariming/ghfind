import { defineRouting } from "next-intl/routing";

/**
 * Locale routing: Chinese is the default and lives at the root (no prefix) so
 * every existing URL — `/`, `/leaderboard`, `/u/<name>`, and the README-embedded
 * badge/card endpoints — keeps working untouched. Every other locale is served
 * under its prefix (`/en`, `/ja`, `/ko`, `/es`, `/pt`, `/id`, `/vi`, `/ar`).
 *
 * `localeDetection: false` keeps next-intl's built-in detection off; `proxy.ts`
 * handles language selection itself: a remembered `NEXT_LOCALE` cookie wins, and a
 * first-time visitor is routed by their Accept-Language top language when it maps
 * to a supported locale. Visitors without a matching header — including crawlers
 * that send no Accept-Language — stay on the zh root, so the canonical Chinese
 * URLs keep their SEO.
 *
 * UI/content split: these locales localize the UI shell, metadata, and research
 * articles. LLM-generated content (roast reports, tags, VS verdicts) only exists
 * in zh/en — non-zh locales read the English side (see `normLang` in
 * `src/lib/lang.ts`).
 */
export const routing = defineRouting({
  locales: ["zh", "en", "ja", "ko", "es", "pt", "id", "vi", "ar"],
  defaultLocale: "zh",
  localePrefix: "as-needed",
  localeDetection: false,
});

export type Locale = (typeof routing.locales)[number];

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

export function localeDir(locale: string): "ltr" | "rtl" {
  return RTL_LOCALES.has(locale as Locale) ? "rtl" : "ltr";
}
