"use client";

import { useEffect } from "react";
import { HTML_LANG, localeDir, routing, type Locale } from "@/i18n/routing";

export function HtmlLangSync({ locale }: { locale: string }) {
  useEffect(() => {
    const known = routing.locales.includes(locale as Locale)
      ? (locale as Locale)
      : routing.defaultLocale;
    document.documentElement.lang = HTML_LANG[known];
    document.documentElement.dir = localeDir(known);
  }, [locale]);

  return null;
}
