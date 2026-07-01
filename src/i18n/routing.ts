import { defineRouting } from "next-intl/routing";

/**
 * Locale routing: Chinese is the default and lives at the root (no prefix) so
 * every existing URL — `/`, `/leaderboard`, `/u/<name>`, and the README-embedded
 * badge/card endpoints — keeps working untouched. English is served under `/en`.
 *
 * `localeDetection: false` keeps next-intl's built-in detection off; `proxy.ts`
 * handles language selection itself: a remembered `NEXT_LOCALE` cookie wins, and a
 * first-time visitor whose Accept-Language top language is English is sent to `/en`.
 * Visitors without an English-first header — including crawlers that send no
 * Accept-Language — stay on the zh root, so the canonical Chinese URLs keep their SEO.
 */
export const routing = defineRouting({
  locales: ["zh", "en"],
  defaultLocale: "zh",
  localePrefix: "as-needed",
  localeDetection: false,
});

export type Locale = (typeof routing.locales)[number];
