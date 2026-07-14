"use client";

import { useLocale, useTranslations } from "next-intl";
import { Check, ChevronDown, Globe } from "lucide-react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Locale picker. A dropdown rather than an inline segmented toggle: the site
 * carries four locales (zh/en/ja/ko) with unequal-width native labels (中文 /
 * EN / 日本語 / 한국어) that no longer fit as flat pills — especially in the
 * mobile sheet. The trigger shows the active language; the menu lists all
 * locales with a check on the current one. Uses next-intl navigation so the
 * choice swaps the locale while keeping the current path (and re-adds or drops
 * the locale prefix accordingly), remembering it in the NEXT_LOCALE cookie the
 * middleware reads.
 *
 * The query string is read from `window.location.search` at click time rather
 * than via `useSearchParams()`, so this navbar island doesn't force a CSR
 * bailout that would block pages from prerendering.
 */
export function LanguageSwitcher() {
  const t = useTranslations("langSwitch");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("label")}
        className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-zinc-300 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/20 data-[state=open]:bg-white/10"
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <span className="font-medium">{t(locale)}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[9rem]">
        {routing.locales.map((loc) => (
          <DropdownMenuItem
            key={loc}
            onSelect={() => {
              if (loc === locale) return;
              // Remember the manual choice so the next visit to the bare root
              // honors it (the middleware reads this same cookie).
              document.cookie = `NEXT_LOCALE=${loc}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
              const query = window.location.search; // includes the leading "?"
              router.replace(`${pathname}${query}`, { locale: loc });
            }}
            aria-current={loc === locale}
            className={
              loc === locale ? "font-semibold text-zinc-100" : "text-zinc-300"
            }
          >
            <span className="flex-1">{t(loc)}</span>
            {loc === locale && (
              <Check className="ms-2 h-4 w-4 shrink-0 text-[var(--primary)]" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
