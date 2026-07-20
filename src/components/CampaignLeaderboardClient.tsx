"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Link } from "@/i18n/navigation";
import type { CampaignSlug } from "@/lib/campaigns";
import type { LeaderboardEntry } from "@/lib/db";
import { normLang } from "@/lib/lang";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import { useMountEffect } from "@/lib/use-mount-effect";

const REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const RANK_BADGE = ["🥇", "🥈", "🥉"];

export function CampaignLeaderboardClient({
  campaign,
  initialEntries,
  emptyLabel,
}: {
  campaign: CampaignSlug;
  initialEntries: LeaderboardEntry[];
  emptyLabel: string;
}) {
  const locale = useLocale();
  const tTier = useTranslations("tiers");
  const [entries, setEntries] = useState(initialEntries);
  const tagLocale = normLang(locale);

  useMountEffect(() => {
    let disposed = false;
    let refreshing = false;
    let dirty = false;
    let lastRefresh = Date.now();

    const refresh = async () => {
      if (disposed || refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      try {
        const response = await fetch(
          `/api/campaigns/${campaign}/leaderboard?limit=500&live=1`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const data = (await response.json()) as { entries?: LeaderboardEntry[] };
        if (!disposed && Array.isArray(data.entries)) {
          setEntries(data.entries);
          dirty = false;
        }
      } catch {
        // Keep the last successful board visible; the next interval retries.
      } finally {
        lastRefresh = Date.now();
        refreshing = false;
      }
    };

    const events = new EventSource(`/api/campaigns/${campaign}/leaderboard/events`);
    events.onmessage = () => {
      dirty = true;
      void refresh();
    };
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        (dirty || Date.now() - lastRefresh >= REFRESH_INTERVAL_MS)
      ) {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      events.close();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  });

  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-6 py-16 text-center text-zinc-500">
        {emptyLabel}
      </div>
    );
  }

  return (
    <ol className="grid gap-3">
      {entries.map((entry, index) => {
        const style = tierStyle(entry.tier);
        const tags = entry.tags[tagLocale].slice(0, 3);
        return (
          <li
            key={entry.username}
            className="group relative flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 transition-colors hover:bg-white/[0.06] sm:gap-4 sm:p-4"
          >
            <Link
              href={`/u/${entry.username}?campaign=${campaign}`}
              prefetch={false}
              aria-label={`@${entry.username}`}
              className="absolute inset-0 rounded-2xl"
            />
            <span className="w-9 shrink-0 text-center text-base font-black tabular-nums text-zinc-400 sm:w-11 sm:text-lg">
              {RANK_BADGE[index] ?? index + 1}
            </span>
            {entry.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={entry.avatar_url}
                alt=""
                className="size-11 shrink-0 rounded-full sm:size-12"
              />
            ) : (
              <div className="size-11 shrink-0 rounded-full bg-white/10 sm:size-12" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="truncate font-black text-zinc-100 sm:text-lg">
                  @{entry.username}
                </span>
                {entry.display_name ? (
                  <span className="hidden truncate text-sm text-zinc-500 sm:inline">
                    {entry.display_name}
                  </span>
                ) : null}
              </div>
              {tags.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-orange-500/10 px-2 py-0.5 text-[10px] font-medium text-orange-200/90"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="shrink-0 text-end">
              <div className={`text-2xl font-black tabular-nums sm:text-3xl ${style.text}`}>
                {entry.final_score.toFixed(2)}
              </div>
              <div className={`text-xs font-bold sm:text-sm ${style.text}`}>
                {style.emoji} {tTier(`${TIER_KEY[entry.tier]}.name`)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
