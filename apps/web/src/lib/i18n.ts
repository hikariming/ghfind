import { createTranslator, type AbstractIntlMessages } from "use-intl/core";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@ghfind/i18n";

// The Next app's message catalogs are the single source of truth during the
// migration; they move into @ghfind/i18n once the Next app is retired (P5).
const catalogs = import.meta.glob<{ default: AbstractIntlMessages }>("../../../../src/messages/*.json");

const cache = new Map<Locale, AbstractIntlMessages>();

export async function getMessages(locale: Locale): Promise<AbstractIntlMessages> {
  const hit = cache.get(locale);
  if (hit) return hit;
  const load = catalogs[`../../../../src/messages/${locale}.json`];
  if (!load) throw new Error(`No message catalog for ${locale}`);
  const messages = (await load()).default;
  cache.set(locale, messages);
  return messages;
}

/** Server-side translator with next-intl semantics (ICU messages, `t.raw`). */
export async function getTranslator<N extends string>(locale: Locale, namespace: N) {
  const messages = await getMessages(locale);
  // use-intl's generics are keyed to a global message type we don't declare;
  // pages call `t("key")` with plain strings like the Next app does.
  return createTranslator({ locale, messages, namespace: namespace as never, timeZone: "UTC" }) as unknown as {
    (key: string, values?: Record<string, string | number>): string;
    raw(key: string): unknown;
    has(key: string): boolean;
  };
}

/** Pick only the namespaces an island uses, so pages don't ship the full catalog. */
export function pickMessages(messages: AbstractIntlMessages, namespaces: readonly string[]): AbstractIntlMessages {
  return Object.fromEntries(namespaces.filter((n) => n in messages).map((n) => [n, messages[n]]));
}

/** Locale param from a `[locale]` route, validated. */
export function routeLocale(param: string | undefined): Locale | null {
  if (param === undefined) return DEFAULT_LOCALE;
  return isLocale(param) ? param : null;
}
