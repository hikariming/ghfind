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
  progressView: string;
}

function TabDivider() {
  return <span className="h-10 w-1 shrink-0 rotate-12 rounded-full bg-[rgb(255,105,0)] sm:h-12" />;
}

export function HomeLeaderboardClient({
  heatEntries,
  labels,
  leaderboardLabels,
  pageSize,
  scoreEntries,
  trendingEntries,
  progressEntries = [],
}: {
  heatEntries: LeaderboardClientEntry[];
  labels: HomeLeaderboardLabels;
  leaderboardLabels: LeaderboardLabels;
  pageSize: number;
  scoreEntries: LeaderboardClientEntry[];
  trendingEntries: LeaderboardClientEntry[];
  progressEntries?: LeaderboardClientEntry[];
}) {
  const [view, setView] = useState<LeaderboardView>("trending");
  const fullBoardHref =
    view === "score"
      ? "/leaderboard?view=score"
      : view === "heat"
      ? "/leaderboard?view=heat"
      : view === "progress"
        ? "/leaderboard?view=progress"
        : "/leaderboard";
  const tabClass = (tab: LeaderboardView) =>
    `shrink-0 text-base font-black leading-tight sm:text-lg ${
      view === tab ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-200"
    }`;

  return (
    <section className="mt-16 w-full max-w-4xl">
      <h2 className="mb-4 text-center text-2xl font-black leading-tight text-zinc-100 sm:text-3xl">
        {labels.heading}
      </h2>
      <div className="mb-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-4 gap-y-2 sm:gap-x-5">
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
            <TabDivider />
            <button
              type="button"
              onClick={() => setView("progress")}
              className={tabClass("progress")}
              aria-pressed={view === "progress"}
            >
              {labels.progressView}
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
        progressEntries={progressEntries}
      />
    </section>
  );
}
