import type { LeaderboardView } from "@/components/LeaderboardClient";
import { getGoLeaderboard } from "@/lib/go-leaderboard.server";
import type { LeaderboardWindow } from "@/lib/leaderboardWindow";

/**
 * Data for the /leaderboard page, shared by the Next page and apps/web. One
 * cache-aside read (same key as /api/leaderboard): the board's initial paint
 * and, on the score view, the ItemList JSON-LD (top 50 of the same rows).
 */
export async function loadLeaderboardPage(query: { view?: string; window?: string } | undefined) {
  const view: LeaderboardView =
    query?.view === "score"
      ? "score"
      : query?.view === "heat"
        ? "heat"
        : "trending";
  const timeWindow: LeaderboardWindow =
    query?.window === "24h"
      ? "24h"
      : query?.window === "7d"
        ? "7d"
        : query?.window === "30d"
          ? "30d"
          : "all";
  const entries = await getGoLeaderboard(view, timeWindow);
  return { view, timeWindow, entries, rankingEntries: view === "score" ? entries.slice(0, 50) : [] };
}
