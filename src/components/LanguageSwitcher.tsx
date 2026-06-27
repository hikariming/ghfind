"use client";

import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

/**
 * zh / en toggle. Uses next-intl navigation so it swaps the locale while keeping
 * the current path (and re-adds or drops the `/en` prefix accordingly).
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
        <button
          key={loc}
          type="button"
          onClick={() => {
            if (loc !== locale) router.replace(pathname, { locale: loc });
          }}
          aria-current={loc === locale}
          className={`rounded-full px-2.5 py-1 transition-colors ${
            loc === locale
              ? "bg-white/10 font-semibold text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {t(loc)}
        </button>
      ))}
    </div>
  );
}
