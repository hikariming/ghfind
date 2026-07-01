"use client";

import { useEffect } from "react";

export function HtmlLangSync({ locale }: { locale: "en" | "zh" }) {
  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
  }, [locale]);

  return null;
}
