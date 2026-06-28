import { NextRequest, NextResponse } from "next/server";
import {
  getHeatLeaderboard,
  getLeaderboard,
  getProgressLeaderboard,
  getTrendingLeaderboard,
  type LeaderboardEntry,
} from "@/lib/db";
import {
  getCachedLeaderboard,
  setCachedLeaderboard,
  type LeaderboardCacheView,
} from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 500;

// CDN-cache the whole payload so most visitors are served from Vercel's edge
// without invoking the function at all (the big lever on the serverless bill).
// stale-while-revalidate keeps it instant while one background request refreshes.
const CDN_CACHE = "public, s-maxage=120, stale-while-revalidate=600";

function leaderboardView(req: NextRequest): LeaderboardCacheView {
  const view = req.nextUrl.searchParams.get("view");
  if (view === "score") return "score";
  if (view === "heat") return "heat";
  if (view === "progress") return "progress";
  return "trending";
}

export async function GET(req: NextRequest) {
  const view = leaderboardView(req);
  const cached = await getCachedLeaderboard(view);
  if (cached) {
    return NextResponse.json(
      { entries: cached, cached: true, view },
      { headers: { "Cache-Control": CDN_CACHE } },
    );
  }

  const entries: LeaderboardEntry[] =
    view === "score"
      ? await getLeaderboard(LIMIT)
      : view === "heat"
      ? await getHeatLeaderboard(LIMIT)
      : view === "progress"
        ? await getProgressLeaderboard(LIMIT)
        : await getTrendingLeaderboard(LIMIT);
  await setCachedLeaderboard(entries, view);
  return NextResponse.json(
    { entries, cached: false, view },
    { headers: { "Cache-Control": CDN_CACHE } },
  );
}
