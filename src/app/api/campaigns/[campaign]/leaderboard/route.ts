import { NextRequest, NextResponse } from "next/server";
import { campaignSlug } from "@/lib/campaigns";
import { getCampaignLeaderboard } from "@/lib/db";
import { paginate, parsePagination } from "@/lib/pagination";
import { checkRateLimit, rateLimitHeaders } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, s-maxage=10, stale-while-revalidate=30";

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
}

function canonicalPaginationUrl(
  req: NextRequest,
  page: { limit: number; offset: number },
): URL | null {
  // The API is CDN-cached. Collapse syntactic variants such as `limit=0100`,
  // reordered params and tracking query strings before querying Turso, or each
  // variant becomes a distinct edge-cache key with the same response.
  const url = new URL(req.url);
  url.search = "";
  if (page.limit !== 100) url.searchParams.set("limit", String(page.limit));
  if (page.offset !== 0) url.searchParams.set("offset", String(page.offset));
  return url.search === req.nextUrl.search ? null : url;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ campaign: string }> },
) {
  const { campaign: rawCampaign } = await context.params;
  const campaign = campaignSlug(rawCampaign);
  if (!campaign) {
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }

  // The API is not used by the page renderer, but remains a public compatibility
  // surface. Keep cache-busting probes from reaching the 500-row Turso query.
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

  const page = parsePagination(req, { defaultLimit: 100, maxLimit: 500 });
  if (page.offset >= 500) {
    return NextResponse.json(
      { error: "invalid_pagination" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const canonicalUrl = canonicalPaginationUrl(req, page);
  if (canonicalUrl) {
    return NextResponse.redirect(canonicalUrl, 308);
  }

  const entries = await getCampaignLeaderboard(campaign, 500);
  return NextResponse.json(
    { ...paginate(entries, page), campaign },
    { headers: { "Cache-Control": CACHE_CONTROL } },
  );
}
