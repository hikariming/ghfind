"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Link } from "@/i18n/navigation";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import type { Tier } from "@/lib/types";

export interface LeaderboardClientEntry {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  final_score: number;
  tier: Tier;
  tags?: { zh: string[]; en: string[] };
  lookup_count: number;
}

export interface LeaderboardLabels {
  empty: string;
  prev: string;
  next: string;
  collapse: string;
  viewDetail: string;
  heatLabel: string;
  heatTitle: string;
}

export type LeaderboardView = "score" | "heat";

const RANK_BADGE = ["🥇", "🥈", "🥉"];
const TAG_TONE: Record<TagLocale, string> = {
  zh: "bg-orange-500/10 text-orange-200/90",
  en: "bg-sky-500/10 text-sky-200/90",
};

type TagLocale = "zh" | "en";

function tagLocaleFor(locale: string): TagLocale {
  return locale === "en" ? "en" : "zh";
}

/** Second-line tags: current locale first, with the other locale as fallback. */
function TagRow({
  labels,
  locale,
  tags,
}: {
  labels: LeaderboardLabels;
  locale: TagLocale;
  tags?: { zh: string[]; en: string[] };
}) {
  const [expanded, setExpanded] = useState(false);
  const fallbackLocale: TagLocale = locale === "en" ? "zh" : "en";
  const primary = tags?.[locale] ?? [];
  const fallback = tags?.[fallbackLocale] ?? [];
  const visibleTags = primary.length > 0 ? primary : fallback;
  const visibleLocale = primary.length > 0 ? locale : fallbackLocale;
  if (visibleTags.length === 0) return null;

  const shown = expanded ? visibleTags : visibleTags.slice(0, 3);
  const hidden = visibleTags.length - shown.length;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {shown.map((t, i) => (
        <span
          key={`${visibleLocale}-${t}-${i}`}
          className={`rounded-full px-1.5 py-px text-[10px] ${TAG_TONE[visibleLocale]}`}
        >
          #{t}
        </span>
      ))}
      {hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="rounded-full border border-white/10 px-1.5 py-px text-[10px] text-zinc-400 hover:bg-white/10"
        >
          +{hidden}
        </button>
      )}
      {expanded && (
        <button
          onClick={() => setExpanded(false)}
          className="rounded-full border border-white/10 px-1.5 py-px text-[10px] text-zinc-400 hover:bg-white/10"
        >
          {labels.collapse}
        </button>
      )}
    </div>
  );
}

export function LeaderboardClient({
  initialView,
  labels,
  pageSize,
  scoreEntries,
  heatEntries,
}: {
  initialView: LeaderboardView;
  labels: LeaderboardLabels;
  pageSize?: number;
  scoreEntries: LeaderboardClientEntry[];
  heatEntries: LeaderboardClientEntry[];
}) {
  const locale = useLocale();
  const tTier = useTranslations("tiers");
  const [page, setPage] = useState(0);
  const entries = initialView === "heat" ? heatEntries : scoreEntries;
  const tagLocale = tagLocaleFor(locale);

  if (entries.length === 0) {
    return <p className="text-center text-zinc-500">{labels.empty}</p>;
  }

  const totalPages = pageSize ? Math.max(1, Math.ceil(entries.length / pageSize)) : 1;
  const current = Math.min(page, totalPages - 1);
  const visible = pageSize ? entries.slice(current * pageSize, (current + 1) * pageSize) : entries;
  const offset = pageSize ? current * pageSize : 0;

  return (
    <>
      <ol className="flex flex-col gap-2">
        {visible.map((e, i) => {
          const rank = offset + i;
          const style = tierStyle(e.tier);
          const tierName = tTier(`${TIER_KEY[e.tier]}.name`);
          const detailLabel = labels.viewDetail.replace("{username}", e.username);
          const heatSelected = initialView === "heat";
          return (
            <li
              key={e.username}
              className="group relative flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 transition-colors hover:bg-white/[0.06] sm:px-4"
            >
              {/* Stretched link: whole row navigates to the detail page. Kept as a
                  real <a> so cmd/ctrl-click opens a new tab. Tag expand buttons sit
                  above it (z-10) so they still toggle instead of navigating. */}
              <Link
                href={`/u/${e.username}`}
                prefetch={false}
                aria-label={detailLabel}
                className="absolute inset-0 z-0 rounded-xl"
              />
              <span className="w-8 shrink-0 text-center text-sm font-bold tabular-nums text-zinc-400">
                {RANK_BADGE[rank] ?? rank + 1}
              </span>
              {e.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={e.avatar_url}
                  alt={e.username}
                  className="h-9 w-9 shrink-0 rounded-full"
                />
              ) : (
                <div className="h-9 w-9 shrink-0 rounded-full bg-white/10" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  <span className="font-medium group-hover:underline">@{e.username}</span>
                  {e.display_name && (
                    <span className="ml-1.5 text-sm text-zinc-500">{e.display_name}</span>
                  )}
                </div>
                {/* Above the stretched link so the +N / collapse buttons toggle, not navigate. */}
                <div className="relative z-10 w-fit">
                  <TagRow labels={labels} locale={tagLocale} tags={e.tags} />
                </div>
              </div>
              {heatSelected ? (
                <div className="grid w-28 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 text-right sm:w-36">
                  <div
                    className="truncate text-left text-xs font-medium text-amber-300 sm:text-sm"
                    title={labels.heatTitle}
                  >
                    🔥 {labels.heatLabel}
                  </div>
                  <div
                    className="text-lg font-black tabular-nums text-amber-300"
                    title={labels.heatTitle}
                    aria-label={`${labels.heatLabel} ${e.lookup_count}`}
                  >
                    {e.lookup_count}
                  </div>
                  <div className={`truncate text-left text-[11px] font-medium ${style.text}`}>
                    {style.emoji} {tierName}
                  </div>
                  <div className={`text-sm font-black tabular-nums ${style.text}`}>
                    {e.final_score.toFixed(2)}
                  </div>
                </div>
              ) : (
                <div className="grid w-28 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 text-right sm:w-36">
                  <div className={`truncate text-left text-xs font-medium sm:text-sm ${style.text}`}>
                    {style.emoji} {tierName}
                  </div>
                  <div className={`text-lg font-black tabular-nums ${style.text}`}>
                    {e.final_score.toFixed(2)}
                  </div>
                  <div
                    className="truncate text-left text-[11px] font-semibold text-amber-300"
                    title={labels.heatTitle}
                  >
                    🔥 {labels.heatLabel}
                  </div>
                  <div
                    className="text-sm font-black tabular-nums text-amber-300"
                    title={labels.heatTitle}
                    aria-label={`${labels.heatLabel} ${e.lookup_count}`}
                  >
                    {e.lookup_count}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {pageSize && totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-4 text-sm">
          <button
            onClick={() => setPage(Math.max(0, current - 1))}
            disabled={current === 0}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-zinc-300 hover:bg-white/10 disabled:opacity-40"
          >
            {labels.prev}
          </button>
          <span className="tabular-nums text-zinc-500">
            {current + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, current + 1))}
            disabled={current >= totalPages - 1}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-zinc-300 hover:bg-white/10 disabled:opacity-40"
          >
            {labels.next}
          </button>
        </div>
      )}
    </>
  );
}
