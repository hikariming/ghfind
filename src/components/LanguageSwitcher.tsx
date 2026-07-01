"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { Button } from "@/components/ui/button";

/**
 * zh / en toggle. Uses next-intl navigation so it swaps the locale while keeping
 * the current path (and re-adds or drops the `/en` prefix accordingly).
 *
 * The current query string is read from `window.location.search` at click time
 * rather than via `useSearchParams()`, so this navbar island doesn't force a CSR
 * bailout that would block the homepage (and other pages) from prerendering.
 */
export function LanguageSwitcher() {
  const t = useTranslations("langSwitch");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div
      className="inline-flex items-center rounded-full border border-white/10 bg-white/5 p-0.5 text-xs"
      role="group"
      aria-label={t("label")}
    >
      {routing.locales.map((loc) => (
        <Button
          key={loc}
          type="button"
          onClick={() => {
            if (loc !== locale) {
              // Remember the manual choice so the next visit to the bare root
              // honors it (the middleware reads this same cookie).
              document.cookie = `NEXT_LOCALE=${loc}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
              const query = window.location.search; // includes the leading "?"
              router.replace(`${pathname}${query}`, { locale: loc });
            }
          }}
          aria-current={loc === locale}
          variant={loc === locale ? "secondary" : "ghost"}
          size="sm"
          className={`rounded-full px-2.5 py-1 ${
            loc === locale
              ? "bg-white/10 font-semibold text-zinc-100 hover:bg-white/10"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {t(loc)}
        </Button>
      ))}
    </div>
  );
}
