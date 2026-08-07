import "server-only";

import { getGoPublicData } from "@/lib/go-backend.server";
import type { LeaderboardWindow } from "@/lib/leaderboardWindow";
import type { LeaderboardView } from "@/components/LeaderboardClient";
import type { PresentationLeaderboardEntry } from "@/lib/profile-presentation";

export async function getGoLeaderboard(
  view: LeaderboardView = "trending",
  window: LeaderboardWindow = "all",
  limit = 500,
  revalidate?: number,
) {
  const query = new URLSearchParams({ view, window, limit: String(limit) });
  const data = await getGoPublicData<{ entries: PresentationLeaderboardEntry[] }>(
    `/api/leaderboard?${query.toString()}`,
    revalidate ? { revalidate } : undefined,
  );
  return data?.entries ?? [];
}
