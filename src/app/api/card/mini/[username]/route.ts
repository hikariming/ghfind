/**
 * `GET /api/card/mini/{username}` — the README-sized brag card.
 *
 * SVG (not an ImageResponse PNG) so it stays sharp at its intrinsic width in a
 * Markdown embed, can render CJK, and can adapt to the viewer's color scheme —
 * see the header of `src/lib/mini-card.ts` for the full reasoning.
 *
 * Params: `?variant=bars|radar|strip`, `?theme=auto|dark|light`, `?lang=en|zh`.
 * Defaults (`bars`, `auto`, `en`) are the safest thing to paste into a README.
 *
 * Every read here is a PK/index seek or a cached aggregate, and the response
 * carries a 6h CDN cache: README views are served by the CDN and GitHub's camo
 * proxy, so the function barely runs even on a popular profile.
 */

import { NextRequest } from "next/server";
import { TIER_LABEL_EN } from "@/lib/badge";
import {
  parseMiniCardLang,
  parseMiniCardTheme,
  parseMiniCardVariant,
  renderMiniCardSvg,
  renderMiniCardUnratedSvg,
} from "@/lib/mini-card";
import { beatPercent } from "@/lib/percentile";
import { aggregateLanguages } from "@/lib/profile-insights";
import { getGoProfilePresentation } from "@/lib/go-profile.server";
import { tierFor } from "@/lib/score-presentation";
import { sponsorLogoDataUrl } from "@/lib/sponsor.server";
import { publicDisplayName, USERNAME_RE } from "@/lib/username";
import { avatarDataUrl, CDN_CACHE } from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Unrated/invalid: short, so a freshly-scored account flips to its real card soon. */
const UNRATED_CACHE = "public, max-age=0, s-maxage=300, stale-while-revalidate=600";

/** Inlined into every response, so keep it small. */
const AVATAR_PX = 96;

/** How many languages fit the footer slot before it needs clipping anyway. */
const FOOTER_LANGUAGES = 3;

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
  const params = req.nextUrl.searchParams;
  const variant = parseMiniCardVariant(params.get("variant"));
  const theme = parseMiniCardTheme(params.get("theme"));
  const lang = parseMiniCardLang(params.get("lang"));

  const name = decodeURIComponent(username ?? "").trim();
  const presentation = USERNAME_RE.test(name) ? await getGoProfilePresentation(name) : null;
  const detail = presentation?.detail ?? null;
  if (!detail) {
    // Never 404: an embedded card that fails renders as a broken image in
    // someone else's README.
    return svg(
      renderMiniCardUnratedSvg({ username: name || "unknown", variant, theme, lang }),
      UNRATED_CACHE,
    );
  }

  // Rank and percentile both come off getRankCached so the two halves of the
  // meta line ("Top 0.8% · #128 / 21,384") share one denominator. getRank /
  // getPercentile in db.ts aggregate the whole table — never call those here.
  const [avatar, sponsorLogo] = await Promise.all([
    avatarDataUrl(detail.avatar_url, AVATAR_PX),
    // `small`: this is the other half of the payload budget the avatar spends.
    sponsorLogoDataUrl("small"),
  ]);
  const rank = presentation?.rank ?? null;
  const delta = presentation?.delta ?? null;
  const snap = presentation?.snapshot ?? null;

  // Snapshots are version-gated, so this is legitimately empty for older rows —
  // the footer slot then carries the brand line alone.
  const languages = snap
    ? aggregateLanguages(snap.top_repos, FOOTER_LANGUAGES).map((l) => l.name)
    : [];

  return svg(
    renderMiniCardSvg({
      username: detail.username,
      displayName: publicDisplayName(detail.display_name),
      avatar,
      score: detail.final_score,
      tier: detail.tier,
      tierLabel:
        lang === "zh" ? tierFor(detail.final_score).tier_label : TIER_LABEL_EN[detail.tier],
      scores: detail.sub_scores,
      languages,
      rank: rank?.rank ?? null,
      total: rank?.total ?? null,
      beat: rank ? beatPercent(rank.below, rank.total) : null,
      delta,
      sponsorLogo,
      variant,
      theme,
      lang,
    }),
    CDN_CACHE,
  );
}
