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
 * Non-zh UI locales (en, ja, ko) all read the ENGLISH side: a Japanese or
 * Korean visitor gets the fully localized UI shell with the English report,
 * plus a "report available in zh/en only" notice (`detail.reportLangNotice`).
 * Generating native ja/ko reports is deliberately deferred until those locales
 * prove out — it requires widening the two-column storage model.
 */

export type Lang = "zh" | "en";

/**
 * Coerce an untrusted value (request body / query / UI locale) to a content
 * Lang. `zh` stays Chinese; every other supported locale reads English; junk
 * and missing values default to zh (the site default).
 */
export function normLang(value: unknown): Lang {
  return value === "en" || value === "ja" || value === "ko" ? "en" : "zh";
}
