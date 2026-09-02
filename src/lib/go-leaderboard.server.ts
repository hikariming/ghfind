import "server-only";

import { getLeaderboardCached } from "@/lib/leaderboard";
import { SITE_URL } from "@/lib/site";
import type { LeaderboardWindow } from "@/lib/leaderboardWindow";
import type { LeaderboardView } from "@/components/LeaderboardClient";
import type { PresentationLeaderboardEntry } from "@/lib/profile-presentation";

type PublicLeaderboardResponse = {
  entries?: PresentationLeaderboardEntry[];
};

/**
 * The homepage is force-static, so its build runs before Cloudflare injects
 * the D1/Redis runtime bindings. Fetch the already-published public board as a
 * build-time fallback on Cloudflare; local/runtime reads remain the primary
 * path everywhere else.
 */
async function getPublishedLeaderboard(
  view: LeaderboardView,
  window: LeaderboardWindow,
  limit: number,
  revalidate: number,
): Promise<PresentationLeaderboardEntry[]> {
  const query = new URLSearchParams({ view, window, limit: String(limit) });
  try {
    const response = await fetch(`${SITE_URL}/api/leaderboard?${query.toString()}`, {
      next: { revalidate },
    });
    if (!response.ok) return [];
    const data = (await response.json()) as PublicLeaderboardResponse;
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    // The fallback is best-effort. A build should still succeed if the public
    // origin is temporarily unavailable; the next deploy can repopulate it.
    return [];
  }
}

export async function getGoLeaderboard(
  view: LeaderboardView = "trending",
  window: LeaderboardWindow = "all",
  limit = 500,
  // Shaped the Railway fetch's ISR window; reads now come from the local
  // cache-aside in lib/leaderboard.ts, which has its own TTL.
  _revalidate?: number,
): Promise<PresentationLeaderboardEntry[]> {
  const { entries } = await getLeaderboardCached(view, window);
  if (entries.length > 0) return entries.slice(0, limit);

  // `NEXT_PUBLIC_GHFIND_DEPLOY_PLATFORM` is set by the Cloudflare build
  // scripts. Do not make ordinary local builds unexpectedly read production.
  if (process.env.NEXT_PUBLIC_GHFIND_DEPLOY_PLATFORM !== "cloudflare") return [];

  return getPublishedLeaderboard(view, window, limit, _revalidate ?? 3600);
}
