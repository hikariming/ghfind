import { BADGE_COLOR } from "@/lib/badge";
import { getAccountDetail } from "@/lib/db";
import { renderMaterialCardSvg } from "@/lib/material-card";
import { tierFor } from "@/lib/score";
import { sponsorLogoDataUrl } from "@/lib/sponsor.server";
import { tierAvatarFrame } from "@/lib/tier";
import { tierAvatarFrameIconDataUrl } from "@/lib/tier-emoji.server";
import { publicDisplayName, USERNAME_RE } from "@/lib/username";
import { avatarDataUrl, CDN_CACHE, qrDataUrl, qrModuleColor } from "../../card/shared";
import { parseTheme } from "../../card/[username]/cards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ username: string }> }) {
  const { username } = await ctx.params;
  const name = decodeURIComponent(username ?? "").trim();
  const detail = USERNAME_RE.test(name) ? await getAccountDetail(name) : null;

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
  const [avatar, qr, tierIcon, sponsorLogo] = await Promise.all([
    avatarDataUrl(detail.avatar_url),
    qrDataUrl(`/u/${detail.username}?ref=material`, qrModuleColor(color, theme)),
    tierAvatarFrameIconDataUrl(tierAvatarFrame(tier).icon),
    sponsorLogoDataUrl(),
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
    tierIcon,
    sponsorLogo,
  });

  return new Response(svg, {
    headers: {
      "Cache-Control": isPreview ? "no-store" : CDN_CACHE,
      "Content-Type": "image/svg+xml; charset=utf-8",
    },
  });
}
