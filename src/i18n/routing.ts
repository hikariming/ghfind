import { defineRouting } from "next-intl/routing";

/**
 * Locale routing: Chinese is the default and lives at the root (no prefix) so
 * every existing URL — `/`, `/leaderboard`, `/u/<name>`, and the README-embedded
 * badge/card endpoints — keeps working untouched. English is served under `/en`.
 *
 * `localeDetection: false` is deliberate: the root path must always be Chinese
 * (no Accept-Language redirect), so shared links and SEO for existing zh URLs
 * never silently switch language.
 */
export const routing = defineRouting({
  locales: ["zh", "en"],
  defaultLocale: "zh",
  localePrefix: "as-needed",
  localeDetection: false,
});

export type Locale = (typeof routing.locales)[number];
