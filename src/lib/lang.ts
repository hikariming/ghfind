/**
 * Shared content language for the roast (report + prompt + cache key).
 *
 * The site UI locale comes from next-intl (`zh` default; `en`/`ja`/`ko`
 * prefixed). LLM-generated content, however, is only produced and stored in
 * two languages — Chinese and English (`roast`/`roast_en` columns, bilingual
 * `{zh,en}` tags/one-liners/verdicts). This type mirrors that storage model for
 * the parts of the pipeline that live outside the React tree — the LLM prompt,
 * the API route, and the Redis/DB cache keys.
 *
 * Non-zh UI locales (en, ja, ko, es, pt, id, vi, ar) all read the ENGLISH
 * side: those visitors get the fully localized UI shell with the English
 * report, plus a "report available in zh/en only" notice
 * (`detail.reportLangNotice`). Generating native reports per locale is
 * deliberately deferred until those locales prove out — it requires widening
 * the two-column storage model.
 */

import { routing, type Locale } from "@/i18n/routing";

export type Lang = "zh" | "en";

/**
 * Coerce an untrusted value (request body / query / UI locale) to a content
 * Lang. `zh` stays Chinese; every other supported locale reads English; junk
 * and missing values default to zh (the site default).
 */
export function normLang(value: unknown): Lang {
  return value !== "zh" && routing.locales.includes(value as Locale) ? "en" : "zh";
}
