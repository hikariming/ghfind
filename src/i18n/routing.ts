import { defineRouting } from "next-intl/routing";
import { DEFAULT_LOCALE, LOCALES } from "@ghfind/i18n";

// Locale config (locales, HTML_LANG, RTL, negotiation) lives in the shared
// `@ghfind/i18n` package so the Astro app and router Worker route identically.
export { HTML_LANG, RTL_LOCALES, localeDir, type Locale } from "@ghfind/i18n";

/**
 * next-intl routing for the Next app. zh lives at the bare root (`as-needed`),
 * every other locale under its prefix.
 *
 * `localeDetection: false` keeps next-intl's built-in detection off; `proxy.ts`
 * handles language selection itself via `decideLocale` from `@ghfind/i18n`: a
 * remembered `NEXT_LOCALE` cookie wins, and a first-time visitor is routed by
 * their Accept-Language top language when it maps to a supported locale.
 * Visitors without a matching header — including crawlers that send no
 * Accept-Language — stay on the zh root, so the canonical Chinese URLs keep
 * their SEO.
 */
export const routing = defineRouting({
  locales: [...LOCALES],
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "as-needed",
  localeDetection: false,
});
