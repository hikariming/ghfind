"use client";

import { useEffect } from "react";
import { HTML_LANG, routing, type Locale } from "@/i18n/routing";

export function HtmlLangSync({ locale }: { locale: string }) {
  useEffect(() => {
    const known = routing.locales.includes(locale as Locale)
      ? (locale as Locale)
      : routing.defaultLocale;
    document.documentElement.lang = HTML_LANG[known];
  }, [locale]);

  return null;
}
