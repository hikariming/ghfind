/**
 * Shared content language for the roast (report + prompt + cache key).
 *
 * The site UI locale comes from next-intl (`zh` default, `en` prefixed). This
 * type mirrors it for the parts of the pipeline that live outside the React tree
 * — the LLM prompt, the API route, and the Redis/DB cache keys — so a `/en` user
 * gets an English report cached separately from the Chinese one.
 */

export type Lang = "zh" | "en";

export const LOCALES = ["zh", "en"] as const;

/** Coerce an untrusted value (request body / query) to a Lang; defaults to zh. */
export function normLang(value: unknown): Lang {
  return value === "en" ? "en" : "zh";
}
