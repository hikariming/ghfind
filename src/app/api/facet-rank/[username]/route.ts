import { NextRequest, NextResponse } from "next/server";
import { getFacetRank, getScoreBrief } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=600";

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
}

/**
 * Language-bucket rank for a freshly-roasted user, read client-side by the roast
 * result modal to render its "see where I rank on {lang}" exit. The score row was
 * just persisted, so we look it up (getScoreBrief) and derive the rank. Returns
 * `{ facetRank: null }` whenever there's no bucket to show — the modal simply
 * hides the CTA.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  // This legacy public endpoint is no longer part of the rendered profile flow,
  // but it remains API-compatible. Limit before the two database reads so a
  // direct username sweep cannot turn into unbounded Turso work.
  const limit = await checkRateLimit(clientIp(req));
  if (!limit.success) {
    return NextResponse.json(
      { error: limit.unavailable ? "rate_limit_unavailable" : "rate_limited" },
      {
        status: limit.unavailable ? 503 : 429,
        headers: { ...rateLimitHeaders(limit), "Cache-Control": "no-store" },
      },
    );
  }

  const { username } = await params;
  const decoded = decodeURIComponent(username);
  const brief = await getScoreBrief(decoded);
  if (!brief) {
    return NextResponse.json({ facetRank: null }, { headers: { "Cache-Control": CACHE_CONTROL } });
  }
  const facetRank = await getFacetRank(brief.username, brief.final_score);
  return NextResponse.json({ facetRank }, { headers: { "Cache-Control": CACHE_CONTROL } });
}
