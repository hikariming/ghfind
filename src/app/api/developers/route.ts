import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  getDevelopersByFacetCached,
  getFacetCategoriesCached,
} from "@/lib/developers";
import type { FacetType } from "@/lib/facets";
import { paginate, parsePagination } from "@/lib/pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CDN-cache the payload at the edge so most visitors never invoke the function,
// with stale-while-revalidate keeping it instant during a background refresh —
// the same lever /api/leaderboard uses. The directory moves slowly, so a longer
// edge window than the boards is fine.
const CDN_CACHE = "public, s-maxage=300, stale-while-revalidate=1800";

function parseFacetType(raw: string | null): FacetType | null {
  return raw === "language" || raw === "org" || raw === "repo" ? raw : null;
}

/**
 * Directory JSON:
 *   ?type=language            → category grid for that facet type
 *   ?type=language&value=Rust → the head of one bucket (developers)
 * Everything is served from the Redis cache-aside in lib/developers.ts, then
 * CDN-cached on top.
 */
export async function GET(req: NextRequest) {
  const type = parseFacetType(req.nextUrl.searchParams.get("type"));
  if (!type) {
    return apiError("invalid_type", { status: 400 });
  }
  const value = req.nextUrl.searchParams.get("value");

  if (value) {
    const all = await getDevelopersByFacetCached(type, value);
    // Buckets are capped well under 500; the default keeps full-bucket payloads.
    const page = parsePagination(req, { defaultLimit: 500, maxLimit: 500 });
    return NextResponse.json(
      { type, value, ...paginate(all, page) },
      { headers: { "Cache-Control": CDN_CACHE } },
    );
  }

  const categories = await getFacetCategoriesCached(type);
  return NextResponse.json(
    { type, categories, total: categories.length },
    { headers: { "Cache-Control": CDN_CACHE } },
  );
}
