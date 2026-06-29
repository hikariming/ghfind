"use client";

import { useState } from "react";
import { Link } from "@/i18n/navigation";
import {
  LeaderboardClient,
  type LeaderboardClientEntry,
  type LeaderboardLabels,
  type LeaderboardView,
} from "./LeaderboardClient";

export interface HomeLeaderboardLabels {
  heading: string;
  openBoard: string;
  trendView: string;
  scoreView: string;
  heatView: string;
}

function TabDivider() {
  return (
    <span className="hidden h-10 w-1 shrink-0 rotate-12 rounded-full bg-[rgb(255,105,0)] sm:block sm:h-12" />
  );
}

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
  const fullBoardHref =
    view === "score"
      ? "/leaderboard?view=score"
      : view === "heat"
        ? "/leaderboard?view=heat"
        : "/leaderboard";
  const tabClass = (tab: LeaderboardView) =>
    `shrink-0 snap-start rounded-full border px-3 py-2 text-sm font-black leading-tight transition-colors sm:border-transparent sm:px-0 sm:py-0 sm:text-lg ${
      view === tab
        ? "border-orange-500/40 bg-orange-500/10 text-zinc-100 sm:bg-transparent"
        : "border-white/10 text-zinc-500 hover:border-white/20 hover:text-zinc-200 sm:border-transparent"
    }`;

  return (
    <section className="mt-16 w-full max-w-4xl">
      <h2 className="mb-4 text-center text-2xl font-black leading-tight text-zinc-100 sm:text-3xl">
        {labels.heading}
      </h2>
      <div className="mb-4 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="-mx-1 flex max-w-full snap-x items-center gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-wrap sm:gap-x-5 sm:overflow-visible sm:px-0 sm:pb-0">
            <button
              type="button"
              onClick={() => setView("trending")}
              className={tabClass("trending")}
              aria-pressed={view === "trending"}
            >
              {labels.trendView}
            </button>
            <TabDivider />
            <button
              type="button"
              onClick={() => setView("score")}
              className={tabClass("score")}
              aria-pressed={view === "score"}
            >
              {labels.scoreView}
            </button>
            <TabDivider />
            <button
              type="button"
              onClick={() => setView("heat")}
              className={tabClass("heat")}
              aria-pressed={view === "heat"}
            >
              {labels.heatView}
            </button>
          </div>
        </div>
        <Link
          href={fullBoardHref}
          className="shrink-0 self-end text-xs text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline sm:ml-4 sm:self-auto"
        >
          {labels.openBoard}
        </Link>
      </div>
      <LeaderboardClient
        key={view}
        initialView={view}
        labels={leaderboardLabels}
        pageSize={pageSize}
        scoreEntries={scoreEntries}
        heatEntries={heatEntries}
        trendingEntries={trendingEntries}
      />
    </section>
  );
}
