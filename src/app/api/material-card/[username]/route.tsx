import { BADGE_COLOR } from "@/lib/badge";
import { getGoProfileCardPresentation } from "@/lib/go-profile.server";
import { renderMaterialCardSvg } from "@/lib/material-card";
import { tierFor } from "@/lib/score-presentation";
import { getCurrentTitleSponsor } from "@/lib/sponsor.server";
import { publicDisplayName, USERNAME_RE } from "@/lib/username";
import { avatarDataUrl, SCORE_CARD_CACHE, qrDataUrl, qrModuleColor } from "../../card/assets";
import { parseTheme } from "../../card/[username]/cards";
import { decodeRouteParam } from "@/lib/route-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ username: string }> }) {
  const { username } = await ctx.params;
  const name = decodeRouteParam(username ?? "").trim();
  const detail = USERNAME_RE.test(name)
    ? (await getGoProfileCardPresentation(name))?.detail ?? null
    : null;

  if (!detail) {
    return new Response("Not found", { status: 404 });
  }

  const theme = parseTheme(req);
  const isPreview = new URL(req.url).searchParams.get("preview") === "1";
  const score = detail.final_score;
  const tier = detail.tier;
  const tags = detail.tags.zh;
  const scores = detail.sub_scores;
  const color = BADGE_COLOR[tier];
  const [avatar, qr, titleSponsor] = await Promise.all([
    avatarDataUrl(detail.avatar_url),
    qrDataUrl(`/u/${detail.username}?ref=material`, qrModuleColor(color, theme)),
    getCurrentTitleSponsor(),
  ]);
  const svg = renderMaterialCardSvg({
    username: detail.username,
    displayName: publicDisplayName(detail.display_name),
    avatar,
    score,
    tier,
    tierLabel: tierFor(score).tier_label,
    tags,
    scores,
    color,
    theme,
    qr,
    sponsorLogo: titleSponsor?.logo ?? null,
    sponsorName: titleSponsor?.name ?? null,
  });

  return new Response(svg, {
    headers: {
      "Cache-Control": isPreview ? "no-store" : SCORE_CARD_CACHE,
      "Content-Type": "image/svg+xml; charset=utf-8",
    },
  });
}
