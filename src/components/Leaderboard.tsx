import { getTranslations } from "next-intl/server";
import type { LeaderboardWindow } from "@/lib/leaderboardWindow";
import { getGoLeaderboard } from "@/lib/go-leaderboard.server";
import {
  LeaderboardClient,
  type LeaderboardLabels,
  type LeaderboardView,
} from "./LeaderboardClient";
import { withDevLeaderboardPreview } from "./devLeaderboardPreview";

export async function Leaderboard({
  initialView = "trending",
  pageSize,
  timeWindow = "all",
}: {
  initialView?: LeaderboardView;
  pageSize?: number;
  timeWindow?: LeaderboardWindow;
}) {
  const t = await getTranslations("leaderboard");
  const labels: LeaderboardLabels = {
    empty: t("empty"),
    prev: t("prev"),
    next: t("next"),
    pageJumpLabel: t("pageJumpLabel"),
    collapse: t("collapse"),
    viewDetail: t("viewDetail", { username: "{username}" }),
    trendLabel: t("trendLabel"),
    trendTitle: t("trendTitle"),
    scoreLabel: t("scoreLabel"),
    scoreTitle: t("scoreTitle"),
    heatLabel: t("heatLabel"),
    heatTitle: t("heatTitle"),
    vsButton: t("vsButton"),
  };

  // Route the initial paint through the same Redis cache-aside the /api route
  // uses (shared key per view+window), so the expensive 500-row triple JOIN runs
  // at most once per TTL instead of on every leaderboard page visit. Only the
  // initialView is fetched; the client lazily loads the other views on demand.
  const entries = await getGoLeaderboard(initialView, timeWindow);
  const trendingEntries = initialView === "trending" ? entries : [];
  const scoreEntries = initialView === "score" ? entries : [];
  const heatEntries = initialView === "heat" ? entries : [];

  return (
    <LeaderboardClient
      key={`${initialView}:${timeWindow}`}
      initialView={initialView}
      labels={labels}
      pageSize={pageSize}
      timeWindow={timeWindow}
      scoreEntries={withDevLeaderboardPreview("score", scoreEntries)}
      heatEntries={withDevLeaderboardPreview("heat", heatEntries)}
      trendingEntries={withDevLeaderboardPreview("trending", trendingEntries)}
    />
  );
}
