"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link } from "@/i18n/navigation";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import type { Tier } from "@/lib/types";
import { resolveLeaderboardPageInput } from "./leaderboardPagination";

export interface LeaderboardClientEntry {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  final_score: number;
  tier: Tier;
  tags?: { zh: string[]; en: string[] };
  lookup_count: number;
  recent_lookup_count: number;
  trending_score: number;
  prev_score?: number;
  delta?: number;
}

export interface LeaderboardLabels {
  empty: string;
  prev: string;
  next: string;
  pageJumpLabel: string;
  collapse: string;
  viewDetail: string;
  trendLabel: string;
  trendTitle: string;
  scoreLabel: string;
  scoreTitle: string;
  heatLabel: string;
  heatTitle: string;
}

export type LeaderboardView = "trending" | "score" | "heat";

const RANK_BADGE = ["🥇", "🥈", "🥉"];
const TAG_TONE: Record<TagLocale, string> = {
  zh: "bg-orange-500/10 text-orange-200/90",
  en: "bg-sky-500/10 text-sky-200/90",
};

type TagLocale = "zh" | "en";

function tagLocaleFor(locale: string): TagLocale {
  return locale === "en" ? "en" : "zh";
}

interface MetricRow {
  label: ReactNode;
  value: ReactNode;
  title?: string;
  ariaLabel?: string;
  valueClass?: string;
}

function MetricBlock({ compact, rows }: { compact?: boolean; rows: MetricRow[] }) {
  return (
    <div
      className={`grid w-full shrink-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 rounded-lg border border-white/5 bg-black/10 px-2.5 py-2 text-right sm:border-0 sm:bg-transparent sm:p-0 ${
        compact ? "sm:w-36" : "sm:w-60"
      }`}
    >
      {rows.map((row, index) => (
        <div key={index} className="contents">
          <div
            className="truncate text-left text-[11px] font-semibold leading-tight sm:text-xs"
            title={row.title}
          >
            {row.label}
          </div>
          <div
            className={`font-black tabular-nums ${row.valueClass ?? "text-sm"}`}
            title={row.title}
            aria-label={row.ariaLabel}
          >
            {row.value}
          </div>
        </div>
      ))}
    </div>
  );
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
          className={`max-w-full truncate rounded-full px-2 py-0.5 text-[10px] ${TAG_TONE[visibleLocale]}`}
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
  trendingEntries,
}: {
  initialView: LeaderboardView;
  labels: LeaderboardLabels;
  pageSize?: number;
  scoreEntries: LeaderboardClientEntry[];
  heatEntries: LeaderboardClientEntry[];
  trendingEntries: LeaderboardClientEntry[];
}) {
  const locale = useLocale();
  const tTier = useTranslations("tiers");
  const [page, setPage] = useState(0);
  const [pageInput, setPageInput] = useState({ page: 0, value: "1" });
  const entries =
    initialView === "score"
      ? scoreEntries
      : initialView === "heat"
        ? heatEntries
        : trendingEntries;
  const tagLocale = tagLocaleFor(locale);
  const totalPages = pageSize ? Math.max(1, Math.ceil(entries.length / pageSize)) : 1;
  const current = Math.min(page, totalPages - 1);
  const currentPageInput = pageInput.page === current ? pageInput.value : String(current + 1);
  const visible = pageSize ? entries.slice(current * pageSize, (current + 1) * pageSize) : entries;
  const offset = pageSize ? current * pageSize : 0;

  function goToPage(nextPage: number) {
    const target = resolveLeaderboardPageInput(String(nextPage + 1), current, totalPages);
    setPage(target);
    setPageInput({ page: target, value: String(target + 1) });
  }

  function commitPageInput() {
    const target = resolveLeaderboardPageInput(currentPageInput, current, totalPages);
    setPage(target);
    setPageInput({ page: target, value: String(target + 1) });
  }

  function handlePageSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    commitPageInput();
  }

  if (entries.length === 0) return <p className="text-center text-zinc-500">{labels.empty}</p>;

  return (
    <>
      <ol className="flex flex-col gap-2">
        {visible.map((e, i) => {
          const rank = offset + i;
          const style = tierStyle(e.tier);
          const tierName = tTier(`${TIER_KEY[e.tier]}.name`);
          const detailLabel = labels.viewDetail.replace("{username}", e.username);
          const trendingScore = e.trending_score ?? 0;
          const recentLookupCount = e.recent_lookup_count ?? 0;
          const heatValue = initialView === "trending" ? recentLookupCount : e.lookup_count;
          const profileUrl = e.profile_url ?? `https://github.com/${encodeURIComponent(e.username)}`;
          const scoreLabel = (
            <span className={style.text}>
              {style.emoji} {tierName}
            </span>
          );
          const scoreValue = <span className={style.text}>{e.final_score.toFixed(2)}</span>;
          const trendLabel = <span className="text-orange-300">🚀{labels.trendLabel}</span>;
          const trendValue = <span className="text-orange-300">{trendingScore.toFixed(1)}</span>;
          const heatLabel = <span className="text-amber-300">🔥 {labels.heatLabel}</span>;
          const heatMetricValue = <span className="text-amber-300">{heatValue}</span>;
          const divider = <span className="px-1 text-zinc-600">/</span>;
          const metricRows: MetricRow[] =
            initialView === "score"
              ? [
                  {
                    label: scoreLabel,
                    value: scoreValue,
                    title: labels.scoreTitle,
                    ariaLabel: `${labels.scoreLabel} ${e.final_score.toFixed(2)}`,
                    valueClass: "text-lg",
                  },
                  {
                    label: (
                      <>
                        {trendLabel}
                        {divider}
                        {heatLabel}
                      </>
                    ),
                    value: (
                      <>
                        {trendValue}
                        {divider}
                        <span className="text-amber-300">{e.lookup_count}</span>
                      </>
                    ),
                    title: labels.trendTitle,
                  },
                ]
              : initialView === "heat"
                ? [
                    {
                      label: heatLabel,
                      value: <span className="text-amber-300">{e.lookup_count}</span>,
                      title: labels.heatTitle,
                      ariaLabel: `${labels.heatLabel} ${e.lookup_count}`,
                      valueClass: "text-lg",
                    },
                    {
                      label: (
                        <>
                          {trendLabel}
                          {divider}
                          {scoreLabel}
                        </>
                      ),
                      value: (
                        <>
                          {trendValue}
                          {divider}
                          {scoreValue}
                        </>
                      ),
                      title: labels.scoreTitle,
                    },
                  ]
                : [
                    {
                      label: trendLabel,
                      value: trendValue,
                      title: labels.trendTitle,
                      ariaLabel: `${labels.trendLabel} ${trendingScore.toFixed(1)}`,
                      valueClass: "text-lg",
                    },
                    {
                      label: (
                        <>
                          {scoreLabel}
                          {divider}
                          {heatLabel}
                        </>
                      ),
                      value: (
                        <>
                          {scoreValue}
                          {divider}
                          {heatMetricValue}
                        </>
                      ),
                      title: labels.scoreTitle,
                    },
                  ];
          return (
            <li
              key={e.username}
              className="group relative flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 transition-colors hover:bg-white/[0.06] sm:flex-row sm:items-center sm:rounded-xl sm:px-4"
            >
              {/* Stretched link: whole row navigates to the detail page. Kept as a
                  real <a> so cmd/ctrl-click opens a new tab. Tag expand buttons sit
                  above it (z-10) so they still toggle instead of navigating. */}
              <Link
                href={`/u/${e.username}`}
                prefetch={false}
                aria-label={detailLabel}
                className="absolute inset-0 z-0 rounded-2xl sm:rounded-xl"
              />
              <div className="flex w-full min-w-0 items-start gap-3 sm:w-auto sm:flex-1 sm:items-center">
                <span className="mt-1 w-8 shrink-0 text-center text-sm font-bold tabular-nums text-zinc-400 sm:mt-0">
                  {RANK_BADGE[rank] ?? rank + 1}
                </span>
                {e.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={e.avatar_url}
                    alt={e.username}
                    className="h-10 w-10 shrink-0 rounded-full sm:h-9 sm:w-9"
                  />
                ) : (
                  <div className="h-10 w-10 shrink-0 rounded-full bg-white/10 sm:h-9 sm:w-9" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <a
                      href={profileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="relative z-10 max-w-full truncate font-medium underline-offset-2 hover:underline"
                    >
                      @{e.username}
                    </a>
                    {e.display_name && (
                      <span className="min-w-0 max-w-full truncate text-sm text-zinc-500">
                        {e.display_name}
                      </span>
                    )}
                  </div>
                  {/* Above the stretched link so the +N / collapse buttons toggle, not navigate. */}
                  <div className="relative z-10 w-full min-w-0 sm:w-fit">
                    <TagRow labels={labels} locale={tagLocale} tags={e.tags} />
                  </div>
                </div>
              </div>
              <MetricBlock rows={metricRows} />
            </li>
          );
        })}
      </ol>

      {pageSize && totalPages > 1 && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-sm sm:gap-4">
          <button
            onClick={() => goToPage(current - 1)}
            disabled={current === 0}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-zinc-300 hover:bg-white/10 disabled:opacity-40"
          >
            {labels.prev}
          </button>
          <form
            onSubmit={handlePageSubmit}
            className="flex items-center gap-1 tabular-nums text-zinc-500"
          >
            <input
              aria-label={labels.pageJumpLabel}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={currentPageInput}
              onBlur={commitPageInput}
              onChange={(event) => setPageInput({ page: current, value: event.target.value })}
              className="w-14 rounded-lg border border-white/10 bg-transparent px-2 py-1 text-center text-zinc-300 outline-none hover:bg-white/10 focus:border-orange-500/60 focus:bg-white/[0.03]"
            />
            <span>/ {totalPages}</span>
          </form>
          <button
            onClick={() => goToPage(current + 1)}
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
