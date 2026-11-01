"use client";

import { useTranslations } from "next-intl";
import { Building2, Clock } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { secondaryButton } from "./parts";

/** The "I'm hiring" tab until company matching ships (phase 3 of docs/plans/2026-10-12-talent-match-report.md). */
export function CompanyPanel() {
  const t = useTranslations("talentMatch.company");
  return (
    <section className="flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.02] px-6 py-14 text-center" data-state="coming-soon">
      <span className="flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-300">
        <Building2 className="h-6 w-6" aria-hidden="true" />
      </span>
      <span className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300">
        <Clock className="h-3.5 w-3.5" aria-hidden="true" />{t("badge")}
      </span>
      <h2 className="mt-3 text-lg font-black text-zinc-100">{t("title")}</h2>
      <p className="mt-2 max-w-md text-sm text-zinc-400">{t("body")}</p>
      <Link href="/contact" prefetch={false} className={`${secondaryButton} mt-6`}>{t("cta")}</Link>
    </section>
  );
}
