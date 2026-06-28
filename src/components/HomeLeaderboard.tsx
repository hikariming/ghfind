import { getTranslations } from "next-intl/server";
import {
  getHeatLeaderboard,
  getLeaderboard,
  getProgressLeaderboard,
  getTrendingLeaderboard,
} from "@/lib/db";
import { HomeLeaderboardClient, type HomeLeaderboardLabels } from "./HomeLeaderboardClient";
import type { LeaderboardLabels } from "./LeaderboardClient";

export async function HomeLeaderboard({ pageSize = 10 }: { pageSize?: number }) {
  const tHome = await getTranslations("home");
  const tBoard = await getTranslations("leaderboard");
  const leaderboardLabels: LeaderboardLabels = {
    empty: tBoard("empty"),
    prev: tBoard("prev"),
    next: tBoard("next"),
    collapse: tBoard("collapse"),
    viewDetail: tBoard("viewDetail", { username: "{username}" }),
    trendLabel: tBoard("trendLabel"),
    trendTitle: tBoard("trendTitle"),
    scoreLabel: tBoard("scoreLabel"),
    scoreTitle: tBoard("scoreTitle"),
    heatLabel: tBoard("heatLabel"),
    heatTitle: tBoard("heatTitle"),
    progressLabel: tBoard("progressLabel"),
    progressTitle: tBoard("progressTitle"),
    progressEmpty: tBoard("progressEmpty"),
  };
  const labels: HomeLeaderboardLabels = {
    heading: tHome("boardHeading"),
    openBoard: tHome("openBoard"),
    trendView: tBoard("trendView"),
    scoreView: tBoard("scoreView"),
    heatView: tBoard("heatView"),
    progressView: tBoard("progressView"),
  };

  const [trendingEntries, scoreEntries, heatEntries, progressEntries] = await Promise.all([
    getTrendingLeaderboard(500),
    getLeaderboard(500),
    getHeatLeaderboard(500),
    getProgressLeaderboard(500),
  ]);

  return (
    <HomeLeaderboardClient
      labels={labels}
      leaderboardLabels={leaderboardLabels}
      pageSize={pageSize}
      scoreEntries={scoreEntries}
      heatEntries={heatEntries}
      trendingEntries={trendingEntries}
      progressEntries={progressEntries}
    />
  );
}
