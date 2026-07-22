import { NextRequest } from "next/server";
import { getScoreBrief, getWeeklyBaselines, resolveWeeklyDelta } from "@/lib/db";
import { buildBadge, type BadgeLang } from "@/lib/badge";
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

  const brief = await getScoreBrief(name);
  if (!brief) {
    return svg(buildBadge({ score: null, tier: null, lang }), UNRATED_CACHE);
  }
  // Weekly movement makes the embedded badge a living stat instead of a static
  // trophy — one indexed snapshot lookup, then served from the CDN for 6h.
  const baselines = await getWeeklyBaselines([brief.username]);
  const delta = resolveWeeklyDelta({
    currentScore: brief.final_score,
    snapshotBaseline: baselines.get(brief.username) ?? null,
    prevScore: brief.prev_score,
    prevScannedAt: brief.prev_scanned_at,
  });
  return svg(
    buildBadge({ score: brief.final_score, tier: brief.tier, lang, delta }),
    RATED_CACHE,
  );
}
