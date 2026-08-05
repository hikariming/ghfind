import { NextRequest } from "next/server";
import { buildBadge, TIER_EN, type BadgeLang } from "@/lib/badge";
import { getGoPublicData } from "@/lib/go-backend.server";
import { USERNAME_RE } from "@/lib/username";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 6h at the edge with a day of stale-while-revalidate — README views are served
// from the CDN (and GitHub's camo cache), so the function barely runs.
const RATED_CACHE = "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400";
// Unrated/invalid: shorter, so a freshly-scored account flips to its real badge soon.
const UNRATED_CACHE = "public, max-age=0, s-maxage=300, stale-while-revalidate=600";

function svg(body: string, cache: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": cache,
    },
  });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ username: string }> },
) {
  const { username } = await ctx.params;
  const lang: BadgeLang =
    req.nextUrl.searchParams.get("lang") === "zh" ? "zh" : "en";

  const name = decodeURIComponent(username ?? "").trim();
  if (!USERNAME_RE.test(name)) {
    return svg(buildBadge({ score: null, tier: null, lang }), UNRATED_CACHE);
  }

  const data = await getGoPublicData<{
    final_score: number | null;
    tier: string | null;
    delta: number | null;
  }>(`/api/embed/badge/${encodeURIComponent(name)}`);
  if (!data || data.final_score === null || data.tier === null || !(data.tier in TIER_EN)) {
    return svg(buildBadge({ score: null, tier: null, lang }), UNRATED_CACHE);
  }
  return svg(
    buildBadge({
      score: data.final_score,
      tier: data.tier as keyof typeof TIER_EN,
      lang,
      delta: data.delta,
    }),
    RATED_CACHE,
  );
}
