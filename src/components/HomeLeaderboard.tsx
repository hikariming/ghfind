import { getTranslations } from "next-intl/server";
import {
  getHeatLeaderboard,
  getLeaderboard,
  getTrendingLeaderboard,
} from "@/lib/db";
import { HomeLeaderboardClient, type HomeLeaderboardLabels } from "./HomeLeaderboardClient";
import type { LeaderboardLabels } from "./LeaderboardClient";
import { withDevLeaderboardPreview } from "./devLeaderboardPreview";

export async function HomeLeaderboard({ pageSize = 10 }: { pageSize?: number }) {
  const tHome = await getTranslations("home");
  const tBoard = await getTranslations("leaderboard");
  const leaderboardLabels: LeaderboardLabels = {
    empty: tBoard("empty"),
    prev: tBoard("prev"),
    next: tBoard("next"),
    pageJumpLabel: tBoard("pageJumpLabel"),
    collapse: tBoard("collapse"),
    viewDetail: tBoard("viewDetail", { username: "{username}" }),
    trendLabel: tBoard("trendLabel"),
    trendTitle: tBoard("trendTitle"),
    scoreLabel: tBoard("scoreLabel"),
    scoreTitle: tBoard("scoreTitle"),
    heatLabel: tBoard("heatLabel"),
    heatTitle: tBoard("heatTitle"),
  };
  const labels: HomeLeaderboardLabels = {
    heading: tHome("boardHeading"),
    openBoard: tHome("openBoard"),
    trendView: tBoard("trendView"),
    scoreView: tBoard("scoreView"),
    heatView: tBoard("heatView"),
  };

  const [trendingEntries, scoreEntries, heatEntries] = await Promise.all([
    getTrendingLeaderboard(500),
    getLeaderboard(500),
    getHeatLeaderboard(500),
  ]);

  return (
    <HomeLeaderboardClient
      labels={labels}
      leaderboardLabels={leaderboardLabels}
      pageSize={pageSize}
      scoreEntries={withDevLeaderboardPreview("score", scoreEntries)}
      heatEntries={withDevLeaderboardPreview("heat", heatEntries)}
      trendingEntries={withDevLeaderboardPreview("trending", trendingEntries)}
    />
  );
}
