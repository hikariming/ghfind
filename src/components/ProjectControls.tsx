"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { buildProjectListHref, type ProjectSort } from "@/lib/projects";
import { trackEvent } from "@/lib/track";

export function ProjectControls({
  sort,
  language,
  page,
  hasNext,
  languages,
}: {
  sort: ProjectSort;
  language: string | null;
  page: number;
  hasNext: boolean;
  languages: string[];
}) {
  const t = useTranslations("projects");
  const sorts: ProjectSort[] = ["quality", "momentum", "stars"];
  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.025] p-4">
      <div className="flex flex-wrap gap-2" aria-label={t("sortLabel")}> 
        {sorts.map((value) => (
          <Link
            key={value}
            href={buildProjectListHref({ sort: value, language, page: 1 })}
            aria-current={sort === value ? "page" : undefined}
            onClick={() => trackEvent("project_sort_change", { sort: value })}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors ${
              sort === value
                ? "border-orange-400/50 bg-orange-500/15 text-orange-200"
                : "border-white/10 text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
            }`}
          >
            {t(`sort.${value}`)}
          </Link>
        ))}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1" aria-label={t("languageLabel")}> 
        {[null, ...languages].map((value) => (
          <Link
            key={value ?? "all"}
            href={buildProjectListHref({ sort, language: value, page: 1 })}
            aria-current={language === value ? "page" : undefined}
            onClick={() =>
              trackEvent("project_filter_change", { language: value ?? "all" })
            }
            className={`shrink-0 rounded-full px-3 py-1 text-xs transition-colors ${
              language === value
                ? "bg-white/10 font-semibold text-zinc-100"
                : "text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300"
            }`}
          >
            {value ?? t("allLanguages")}
          </Link>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-white/10 pt-3">
        <Link
          href={buildProjectListHref({ sort, language, page: Math.max(1, page - 1) })}
          aria-disabled={page <= 1}
          className={`text-sm ${page <= 1 ? "pointer-events-none text-zinc-700" : "text-zinc-400 hover:text-zinc-200"}`}
        >
          {t("prev")}
        </Link>
        <span className="text-xs tabular-nums text-zinc-500">{t("page", { page })}</span>
        <Link
          href={buildProjectListHref({ sort, language, page: page + 1 })}
          aria-disabled={!hasNext}
          className={`text-sm ${!hasNext ? "pointer-events-none text-zinc-700" : "text-zinc-400 hover:text-zinc-200"}`}
        >
          {t("next")}
        </Link>
      </div>
    </div>
  );
}
