import { getScoreBrief, getWeeklyBaselines, resolveWeeklyDelta } from "@/lib/db";
import { buildBadge, type BadgeLang } from "@/lib/badge";
import { USERNAME_RE } from "@/lib/username";
import { decodeRouteParam } from "@/lib/route-params";
import { SCORE_CARD_CACHE } from "../../card/assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same short edge window as the cards, so a rescan reaches README badges in minutes.
const RATED_CACHE = SCORE_CARD_CACHE;
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
  req: Request,
  ctx: { params: Promise<{ username: string }> },
) {
  const { username } = await ctx.params;
  const lang: BadgeLang =
    new URL(req.url).searchParams.get("lang") === "zh" ? "zh" : "en";

  const name = decodeRouteParam(username ?? "").trim();
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
