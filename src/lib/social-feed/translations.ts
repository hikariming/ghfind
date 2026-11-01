import { isLocale, type Locale } from "@ghfind/i18n";
import { FEED_MAX_INGEST_TRANSLATION_CHARS, FEED_MAX_INGEST_TRANSLATIONS, FEED_MAX_TRANSLATION_LABEL_LENGTH, FEED_MAX_X_TEXT_LENGTH, SocialFeedError, type FeedTranslationInput } from "./contract";

/** Lowercase BCP 47 tag; only the primary subtag is compared with site locales. */
export function normalizeSourceLang(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,4}$/.test(value) || value.length > 35) {
    throw new SocialFeedError("invalid_source_lang", 400);
  }
  return value.toLowerCase().replace(/_/g, "-");
}
export const sameLanguage = (lang: string | null, locale: Locale): boolean => lang?.split("-")[0] === locale;
function optionalLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > FEED_MAX_TRANSLATION_LABEL_LENGTH) throw new SocialFeedError("invalid_translation", 400);
  return value;
}
/** Rejects unknown locales, duplicates, empty text and unexpected fields before any write. */
export function validateTranslations(items: readonly FeedTranslationInput[]): FeedTranslationInput[] {
  if (!Array.isArray(items) || items.length > FEED_MAX_INGEST_TRANSLATIONS) throw new SocialFeedError("invalid_translation", 400);
  const seen = new Set<string>();
  let totalChars = 0;
  const validated = items.map((item) => {
    if (!item || typeof item !== "object" || Object.keys(item).some((key) => !["locale", "text", "source_lang", "model", "provider"].includes(key))) {
      throw new SocialFeedError("invalid_translation", 400);
    }
    if (!isLocale(item.locale)) throw new SocialFeedError("invalid_locale", 400);
    if (seen.has(item.locale)) throw new SocialFeedError("duplicate_locale", 400);
    seen.add(item.locale);
    if (typeof item.text !== "string" || !item.text.trim() || [...item.text].length > FEED_MAX_X_TEXT_LENGTH) throw new SocialFeedError("invalid_translation", 400);
    totalChars += [...item.text].length;
    if (totalChars > FEED_MAX_INGEST_TRANSLATION_CHARS) throw new SocialFeedError("translation_budget_exceeded", 400);
    return { locale: item.locale, text: item.text, source_lang: normalizeSourceLang(item.source_lang),
      model: optionalLabel(item.model), provider: optionalLabel(item.provider) };
  });
  return validated;
}
