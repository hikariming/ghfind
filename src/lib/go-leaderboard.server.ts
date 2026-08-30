import "server-only";

import { getLeaderboardCached } from "@/lib/leaderboard";
import type { LeaderboardWindow } from "@/lib/leaderboardWindow";
import type { LeaderboardView } from "@/components/LeaderboardClient";
import type { PresentationLeaderboardEntry } from "@/lib/profile-presentation";

export async function getGoLeaderboard(
  view: LeaderboardView = "trending",
  window: LeaderboardWindow = "all",
  limit = 500,
  // Shaped the Railway fetch's ISR window; reads now come from the local
  // cache-aside in lib/leaderboard.ts, which has its own TTL.
  _revalidate?: number,
): Promise<PresentationLeaderboardEntry[]> {
  const { entries } = await getLeaderboardCached(view, window);
  return entries.slice(0, limit);
}
