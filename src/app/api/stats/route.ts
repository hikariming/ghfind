import { NextResponse } from "next/server";
import { getScoreCount } from "@/lib/db";
import { getCachedStats, setCachedStats } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The count is decorative homepage copy. Redis already refreshes it once per
// minute at the origin; let the CDN share that same freshness window so every
// homepage visitor does not invoke this dynamic route.
const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

export async function GET() {
  const cached = await getCachedStats();
  if (cached !== null) {
    return NextResponse.json(
      { total: cached, cached: true },
      { headers: { "Cache-Control": CACHE_CONTROL } },
    );
  }
  const total = await getScoreCount();
  if (total !== null) await setCachedStats(total);
  return NextResponse.json(
    { total, cached: false },
    { headers: { "Cache-Control": CACHE_CONTROL } },
  );
}
