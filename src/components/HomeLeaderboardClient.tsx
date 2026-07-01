"use client";

import { useEffect, useState } from "react";
import { Link } from "@/i18n/navigation";
import {
  LeaderboardClient,
  type LeaderboardClientEntry,
  type LeaderboardLabels,
  type LeaderboardView,
} from "./LeaderboardClient";
import { LEADERBOARD_WINDOW_OPTIONS, type LeaderboardWindow } from "@/lib/leaderboardWindow";
import { withDevLeaderboardPreview } from "./devLeaderboardPreview";
import { LeaderboardControls } from "./LeaderboardControls";

export interface HomeLeaderboardLabels {
  openBoard: string;
  trendView: string;
  scoreView: string;
  heatView: string;
  windowAria: string;
  window24h: string;
  window7d: string;
  window30d: string;
  windowAll: string;
  loading: string;
  loadError: string;
}

const WINDOW_LABEL_KEY: Record<LeaderboardWindow, keyof HomeLeaderboardLabels> = {
  "24h": "window24h",
  "7d": "window7d",
  "30d": "window30d",
  all: "windowAll",
};

const cacheKey = (view: LeaderboardView, window: LeaderboardWindow) => `${view}:${window}`;

export function HomeLeaderboardClient({
  heatEntries,
  labels,
  leaderboardLabels,
  pageSize,
  scoreEntries,
  trendingEntries,
}: {
  heatEntries: LeaderboardClientEntry[];
  labels: HomeLeaderboardLabels;
  leaderboardLabels: LeaderboardLabels;
  pageSize: number;
  scoreEntries: LeaderboardClientEntry[];
  trendingEntries: LeaderboardClientEntry[];
}) {
  const [view, setView] = useState<LeaderboardView>("trending");
  const [timeWindow, setTimeWindow] = useState<LeaderboardWindow>("all");

  // (view, window) -> entries. Seeded with the SSR'd "all"-window boards so the
  // default render needs no fetch; other windows load on demand from the
  // CDN+Redis-cached /api/leaderboard, so each (view, window) hits the DB at
  // most once per 5-min TTL across all visitors.
  const [cache, setCache] = useState<Record<string, LeaderboardClientEntry[]>>(() => ({
    [cacheKey("trending", "all")]: trendingEntries,
    [cacheKey("score", "all")]: scoreEntries,
    [cacheKey("heat", "all")]: heatEntries,
  }));
  const [error, setError] = useState(false);

  const key = cacheKey(view, timeWindow);
  const entries = cache[key];
  const loading = entries === undefined && !error;

  useEffect(() => {
    if (entries !== undefined) return; // already cached
    let cancelled = false;
    fetch(`/api/leaderboard?view=${view}&window=${timeWindow}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
      .then((data) => {
        if (cancelled) return;
        const fetched = withDevLeaderboardPreview(
          view,
          (data.entries ?? []) as LeaderboardClientEntry[],
        );
        setCache((prev) => ({ ...prev, [key]: fetched }));
        setError(false);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [entries, key, view, timeWindow]);

  // Clear a stale error before navigating to another board so its load isn't
  // masked by the previous failure (the error flag is shared across keys).
  const selectView = (next: LeaderboardView) => {
    setError(false);
    setView(next);
  };
  const selectWindow = (next: LeaderboardWindow) => {
    setError(false);
    setTimeWindow(next);
  };

  const fullBoardHref = (() => {
    const params = new URLSearchParams();
    if (view !== "trending") params.set("view", view);
    if (timeWindow !== "all") params.set("window", timeWindow);
    const qs = params.toString();
    return qs ? `/leaderboard?${qs}` : "/leaderboard";
  })();

  const activeEntries = entries ?? [];
  const viewItems = (["trending", "score", "heat"] as const).map((tab) => ({
    key: tab,
    label:
      tab === "trending"
        ? labels.trendView
        : tab === "score"
          ? labels.scoreView
          : labels.heatView,
    active: view === tab,
    onSelect: () => selectView(tab),
  }));
  const windowItems = LEADERBOARD_WINDOW_OPTIONS.map((w) => ({
    key: w,
    label: labels[WINDOW_LABEL_KEY[w]],
    active: timeWindow === w,
    onSelect: () => selectWindow(w),
  }));

  return (
    <section className="mt-16 w-full max-w-6xl">
      <LeaderboardControls
        frame="panel"
        className="mb-5"
        viewItems={viewItems}
        windowItems={windowItems}
        windowAriaLabel={labels.windowAria}
        action={
          <Link
            href={fullBoardHref}
            className="rounded-full px-3 py-2 text-xs font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            {labels.openBoard}
          </Link>
        }
      />

      {error ? (
        <p className="py-10 text-center text-sm text-zinc-500">{labels.loadError}</p>
      ) : loading ? (
        <p className="py-10 text-center text-sm text-zinc-500">{labels.loading}</p>
      ) : (
        <LeaderboardClient
          key={key}
          initialView={view}
          timeWindow={timeWindow}
          labels={leaderboardLabels}
          pageSize={pageSize}
          scoreEntries={view === "score" ? activeEntries : []}
          heatEntries={view === "heat" ? activeEntries : []}
          trendingEntries={view === "trending" ? activeEntries : []}
        />
      )}
    </section>
  );
}
