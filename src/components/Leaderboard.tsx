"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Link } from "@/i18n/navigation";
import { tierStyle } from "@/lib/tier";
import type { Tier } from "@/lib/types";

interface Entry {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  final_score: number;
  tier: Tier;
  tags?: { zh: string[]; en: string[] };
}

const RANK_BADGE = ["🥇", "🥈", "🥉"];

/** Second-line tags: 3 zh + 3 en by default, expandable to show all. */
function TagRow({ tags }: { tags?: { zh: string[]; en: string[] } }) {
  const t = useTranslations("leaderboard");
  const [expanded, setExpanded] = useState(false);
  const zh = tags?.zh ?? [];
  const en = tags?.en ?? [];
  if (zh.length + en.length === 0) return null;

  const zhShown = expanded ? zh : zh.slice(0, 3);
  const enShown = expanded ? en : en.slice(0, 3);
  const hidden = zh.length - zhShown.length + (en.length - enShown.length);

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {zhShown.map((t, i) => (
        <span
          key={`zh-${t}-${i}`}
          className="rounded-full bg-orange-500/10 px-1.5 py-px text-[10px] text-orange-200/90"
        >
          #{t}
        </span>
      ))}
      {enShown.map((t, i) => (
        <span
          key={`en-${t}-${i}`}
          className="rounded-full bg-sky-500/10 px-1.5 py-px text-[10px] text-sky-200/90"
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
          {t("collapse")}
        </button>
      )}
    </div>
  );
}

export function Leaderboard({ pageSize }: { pageSize?: number }) {
  const t = useTranslations("leaderboard");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch("/api/leaderboard")
      .then((r) => r.json())
      .then((d) => {
        if (alive) setEntries((d.entries as Entry[]) ?? []);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return <p className="text-center text-zinc-500">{t("loadError")}</p>;
  }
  if (entries === null) {
    return <p className="text-center text-zinc-500 animate-pulse">{t("loading")}</p>;
  }
  if (entries.length === 0) {
    return <p className="text-center text-zinc-500">{t("empty")}</p>;
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
          return (
            <li
              key={e.username}
              className="group relative flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 transition-colors hover:bg-white/[0.06]"
            >
              {/* Stretched link: whole row navigates to the detail page. Kept as a
                  real <a> so cmd/ctrl-click opens a new tab. Tag expand buttons sit
                  above it (z-10) so they still toggle instead of navigating. */}
              <Link
                href={`/u/${e.username}`}
                prefetch={false}
                aria-label={t("viewDetail", { username: e.username })}
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
              {/* Above the stretched link so the +N / 收起 buttons toggle, not navigate. */}
              <div className="relative z-10 w-fit">
                <TagRow tags={e.tags} />
              </div>
            </div>
            <span className={`shrink-0 text-xs font-medium ${style.text}`}>
              {style.emoji} {e.tier}
            </span>
            <span className={`w-16 shrink-0 text-right text-lg font-black tabular-nums ${style.text}`}>
              {e.final_score.toFixed(2)}
            </span>
          </li>
          );
        })}
      </ol>

      {pageSize && totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-4 text-sm">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={current === 0}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-zinc-300 hover:bg-white/10 disabled:opacity-40"
          >
            {t("prev")}
          </button>
          <span className="tabular-nums text-zinc-500">
            {current + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={current >= totalPages - 1}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-zinc-300 hover:bg-white/10 disabled:opacity-40"
          >
            {t("next")}
          </button>
        </div>
      )}
    </>
  );
}
