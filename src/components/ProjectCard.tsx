"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { ProjectListItem } from "@/lib/db";
import { projectCardViewModel } from "@/lib/project-card";
import { tierStyle } from "@/lib/tier";
import { trackEvent } from "@/lib/track";

const number = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function ProjectCard({ project, position }: { project: ProjectListItem; position: number }) {
  const t = useTranslations("projects");
  const model = projectCardViewModel(project);
  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.035] p-5 transition-colors hover:border-white/20 hover:bg-white/[0.055]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link
            href={model.href}
            prefetch={false}
            onClick={() =>
              trackEvent("project_card_click", { repo: model.repoKey, position })
            }
            className="break-all text-lg font-black text-zinc-100 underline-offset-4 hover:text-white hover:underline"
          >
            {model.title}
          </Link>
          {model.description && (
            <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-zinc-400">
              {model.description}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right text-sm tabular-nums text-zinc-400">
          <div>★ {number.format(model.stars)}</div>
          {model.language && <div className="mt-1 text-xs text-zinc-500">{model.language}</div>}
        </div>
      </div>

      {model.topics.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {model.topics.slice(0, 5).map((topic) => (
            <span
              key={topic}
              className="rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-200/90"
            >
              {topic}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-white/10 bg-white/[0.025] p-3 text-center">
        <div>
          <div className="text-sm font-bold tabular-nums text-zinc-100">{model.contributorCount}</div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">{t("contributors")}</div>
        </div>
        <div>
          <div className="text-sm font-bold tabular-nums text-zinc-100">{model.avgScore}</div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">{t("avgScore")}</div>
        </div>
        <div>
          <div className="text-sm font-bold tabular-nums text-orange-300">{model.momentum}</div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">{t("momentum")}</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="rounded-full bg-orange-500/10 px-2.5 py-1 text-xs font-semibold text-orange-200">
          {t(`reason.${model.reason}`)}
        </span>
        {model.contributors.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {model.contributors.map((contributor) => {
              const style = tierStyle(contributor.tier);
              return (
                <Link
                  key={contributor.username}
                  href={contributor.href}
                  prefetch={false}
                  className={`rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] hover:bg-white/[0.07] ${style.text}`}
                >
                  {style.emoji} @{contributor.username}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
}
