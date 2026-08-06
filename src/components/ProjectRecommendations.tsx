"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { GoRelatedProject } from "@/lib/go-projects.server";
import { relatedProjectRows } from "@/lib/discovery-next-steps";
import { trackEvent } from "@/lib/track";

export function ProjectRecommendations({ projects }: { projects: GoRelatedProject[] }) {
  const t = useTranslations("discoveryNext");
  const rows = relatedProjectRows(projects);
  if (rows.length === 0) return null;
  return (
    <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.035] p-5 sm:p-6">
      <h2 className="text-lg font-black text-zinc-100">{t("relatedTitle")}</h2>
      <p className="mt-1 text-sm text-zinc-500">{t("relatedSubtitle")}</p>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <Link
            key={row.key}
            href={row.href}
            prefetch={false}
            onClick={() =>
              trackEvent("discovery_recommendation_click", {
                surface: "project",
                kind: row.relation,
                subject: row.key,
              })
            }
            className="rounded-xl border border-white/10 bg-white/[0.025] p-3 hover:bg-white/[0.06]"
          >
            <div className="truncate text-sm font-bold text-zinc-200">{row.title}</div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-zinc-500">
              <span>{row.language ?? "—"}</span>
              <span>
                {row.relation === "shared"
                  ? t("sharedContributors", { count: row.sharedContributorCount })
                  : t("sameLanguage")}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
