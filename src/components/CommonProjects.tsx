"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { ProjectListItem } from "@/lib/db";
import { commonProjectRows } from "@/lib/discovery-next-steps";
import { trackEvent } from "@/lib/track";

export function CommonProjects({
  projects,
  flat = false,
}: {
  projects: ProjectListItem[];
  flat?: boolean;
}) {
  const t = useTranslations("discoveryNext");
  const rows = commonProjectRows(projects);
  if (rows.length === 0) return null;
  return (
    <section
      className={
        flat
          ? "mt-6 bg-transparent p-0 before:mx-4 before:mb-6 before:block before:h-px before:bg-white/10 before:content-['']"
          : "mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5 sm:p-6"
      }
    >
      <h2 className="text-base font-bold text-zinc-200">{t("commonTitle")}</h2>
      <p className="mt-1 text-xs text-zinc-500">{t("commonSubtitle")}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {rows.map((row) => (
          <Link
            key={row.key}
            href={row.href}
            prefetch={false}
            onClick={() =>
              trackEvent("discovery_recommendation_click", {
                surface: "profile",
                kind: "common_project",
                subject: row.key,
              })
            }
            className="rounded-full border border-white/10 bg-white/[0.025] px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100"
          >
            {row.title} <span className="text-xs text-zinc-500">· {row.avgScore}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
