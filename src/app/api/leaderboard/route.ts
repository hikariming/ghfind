import { NextRequest, NextResponse } from "next/server";
import type { LeaderboardWindow } from "@/lib/db";
import { getLeaderboardCached, LEADERBOARD_LIMIT } from "@/lib/leaderboard";
import { paginate, parsePagination } from "@/lib/pagination";
import type { LeaderboardCacheView } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function leaderboardWindow(req: NextRequest): LeaderboardWindow {
  const window = req.nextUrl.searchParams.get("window");
  if (window === "24h") return "24h";
  if (window === "7d") return "7d";
  if (window === "30d") return "30d";
  return "all";
}

export async function GET(req: NextRequest) {
  const view = leaderboardView(req);
  const window = leaderboardWindow(req);
  // Default limit = the full board, so callers that never send limit/offset
  // (home client, SDKs) keep the exact payload they had before pagination.
  const page = parsePagination(req, {
    defaultLimit: LEADERBOARD_LIMIT,
    maxLimit: LEADERBOARD_LIMIT,
  });
  const { entries, cached } = await getLeaderboardCached(view, window);
  return NextResponse.json(
    { ...paginate(entries, page), cached, view, window },
    { headers: { "Cache-Control": CDN_CACHE } },
  );
}
