/**
 * `next-intl` → `use-intl` shim so existing React components under `src/`
 * can run as Astro islands unchanged. next-intl's client API is a thin layer
 * over use-intl; the hooks and message format are identical.
 */
export {
  IntlProvider as NextIntlClientProvider,
  useFormatter,
  useLocale,
  useMessages,
  useNow,
  useTimeZone,
  useTranslations,
} from "use-intl";
