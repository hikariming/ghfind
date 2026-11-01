/**
 * `next-intl/server` shim (wired via the wrangler `alias`). In the Next app,
 * getTranslations resolves messages through the next-intl plugin's request
 * config (src/i18n/request.ts → src/messages/<locale>.json); this Worker has
 * no plugin, so load the same catalogs and use use-intl's createTranslator —
 * the engine next-intl itself runs on. Only the explicit-locale form is
 * supported (route handlers have no request locale).
 */
import { createTranslator, type AbstractIntlMessages } from "use-intl/core";
import { DEFAULT_LOCALE, isLocale } from "@ghfind/i18n";

type Catalog = { default: AbstractIntlMessages };
const catalogs: Record<string, () => Promise<Catalog>> = {
  zh: () => import("../../../../src/messages/zh.json") as unknown as Promise<Catalog>,
  en: () => import("../../../../src/messages/en.json") as unknown as Promise<Catalog>,
  ja: () => import("../../../../src/messages/ja.json") as unknown as Promise<Catalog>,
  ko: () => import("../../../../src/messages/ko.json") as unknown as Promise<Catalog>,
  es: () => import("../../../../src/messages/es.json") as unknown as Promise<Catalog>,
  pt: () => import("../../../../src/messages/pt.json") as unknown as Promise<Catalog>,
  id: () => import("../../../../src/messages/id.json") as unknown as Promise<Catalog>,
  vi: () => import("../../../../src/messages/vi.json") as unknown as Promise<Catalog>,
  ar: () => import("../../../../src/messages/ar.json") as unknown as Promise<Catalog>,
};

export async function getTranslations(opts: { locale: string; namespace?: string }) {
  if (typeof opts !== "object" || !opts?.locale) {
    throw new Error("getTranslations needs an explicit { locale } outside a Next request");
  }
  // next-intl's request config falls back to the default locale the same way.
  const locale = isLocale(opts.locale) ? opts.locale : DEFAULT_LOCALE;
  const messages = (await catalogs[locale]()).default;
  return createTranslator({ locale, messages, namespace: opts.namespace as never, timeZone: "UTC" });
}
