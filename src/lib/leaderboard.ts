import {
  getHeatLeaderboard,
  getLeaderboard,
  getProgressLeaderboard,
  getTrendingLeaderboard,
  type LeaderboardEntry,
  type LeaderboardWindow,
} from "@/lib/db";
import {
  getCachedLeaderboard,
  setCachedLeaderboard,
  type LeaderboardCacheView,
} from "@/lib/redis";

// One source of truth for "how many rows a board holds". The full /leaderboard
// page wants the long list; the home page slices what it needs off the same
// cached payload, so both share a single Redis entry per (view, window).
export const LEADERBOARD_LIMIT = 20;

const fetchers: Record<
  LeaderboardCacheView,
  (limit: number, window: LeaderboardWindow) => Promise<LeaderboardEntry[]>
> = {
  trending: (limit, window) => getTrendingLeaderboard(limit, undefined, window),
  score: (limit, window) => getLeaderboard(limit, undefined, window),
  heat: (limit, window) => getHeatLeaderboard(limit, undefined, window),
  progress: (limit, window) => getProgressLeaderboard(limit, window),
};

/**
 * Cache-aside leaderboard read shared by the home page (SSR) and the
 * /api/leaderboard route. A hit serves entirely from Redis — no DB query — so
 * the expensive triple LEFT JOIN only runs once per (view, window) per TTL.
 */
export async function getLeaderboardCached(
  view: LeaderboardCacheView = "trending",
  window: LeaderboardWindow = "all",
): Promise<{ entries: LeaderboardEntry[]; cached: boolean }> {
  const cached = await getCachedLeaderboard(view, window);
  if (cached) return { entries: cached, cached: true };
  const entries = await fetchers[view](LEADERBOARD_LIMIT, window);
  await setCachedLeaderboard(entries, view, window);
  return { entries, cached: false };
}
