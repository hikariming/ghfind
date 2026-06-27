/**
 * shields.io-style profile badge as a self-contained SVG string.
 *
 * Hand-rolled (no PNG/satori) so it's a few hundred bytes, CDN-cacheable, and
 * basically free to serve on every README view. No <script> or external refs, so
 * GitHub's camo image proxy renders it as-is.
 *
 * Pure functions → deterministically unit-testable. Default copy is English/ASCII
 * (most reliable in a GitHub README); `lang: "zh"` swaps in the Chinese tier word.
 */

import type { Tier } from "./types";

export type BadgeLang = "en" | "zh";

/** English tier words (the stored tier is already the Chinese form). */
export const TIER_EN: Record<Tier, string> = {
  夯: "GOD",
  顶级: "ELITE",
  人上人: "SOLID",
  NPC: "NPC",
  拉完了: "TRASH",
};

/** Right-segment background per tier (vivid -500 shades, white text on top). */
export const BADGE_COLOR: Record<Tier, string> = {
  夯: "#F59E0B",
  顶级: "#8B5CF6",
  人上人: "#10B981",
  NPC: "#64748B",
  拉完了: "#F43F5E",
};

const LABEL = "GitHub Roast";
const NEUTRAL = "#9CA3AF"; // gray for unrated
const LEFT_BG = "#555";
const FONT = "Verdana,DejaVu Sans,Geneva,sans-serif";
const FONT_SIZE = 11;
const PAD = 6; // horizontal padding inside each segment

/** Rough text width: CJK ≈ 1em, other glyphs ≈ 0.6em. Good enough with padding. */
export function estimateTextWidth(str: string, fontSize = FONT_SIZE): number {
  let w = 0;
  for (const ch of str) {
    // CJK / fullwidth ranges → ~1em; everything else ~0.6em.
    w += /[　-鿿＀-￯]/.test(ch) ? fontSize : fontSize * 0.6;
  }
  return Math.ceil(w);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Flat two-segment badge: dark label on the left, colored value on the right. */
export function renderBadge({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}): string {
  const lw = estimateTextWidth(label) + PAD * 2;
  const vw = estimateTextWidth(value) + PAD * 2;
  const w = lw + vw;
  const h = 20;
  const r = 3;
  // Text baseline centered; x at each segment's midpoint.
  const lx = lw / 2;
  const vx = lw + vw / 2;
  const ty = 14;
  const labelE = escapeXml(label);
  const valueE = escapeXml(value);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="${labelE}: ${valueE}">
<title>${labelE}: ${valueE}</title>
<rect rx="${r}" width="${w}" height="${h}" fill="${LEFT_BG}"/>
<rect rx="${r}" x="${lw}" width="${vw}" height="${h}" fill="${color}"/>
<rect x="${lw}" width="${r}" height="${h}" fill="${color}"/>
<rect rx="${r}" width="${w}" height="${h}" fill="url(#g)"/>
<defs><linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient></defs>
<g fill="#fff" text-anchor="middle" font-family="${FONT}" font-size="${FONT_SIZE}">
<text x="${lx}" y="${ty}" fill="#000" fill-opacity=".25">${labelE}</text>
<text x="${lx}" y="${ty - 1}">${labelE}</text>
<text x="${vx}" y="${ty}" fill="#000" fill-opacity=".25">${valueE}</text>
<text x="${vx}" y="${ty - 1}">${valueE}</text>
</g>
</svg>`;
}

/** Build the badge for an account's score + tier (or an unrated placeholder). */
export function buildBadge(opts: {
  score: number | null;
  tier: Tier | null;
  lang?: BadgeLang;
}): string {
  const lang: BadgeLang = opts.lang === "zh" ? "zh" : "en";
  if (opts.score === null || opts.tier === null) {
    return renderBadge({
      label: LABEL,
      value: lang === "zh" ? "未评分" : "unrated",
      color: NEUTRAL,
    });
  }
  const word = lang === "zh" ? opts.tier : TIER_EN[opts.tier];
  return renderBadge({
    label: LABEL,
    value: `${opts.score.toFixed(2)} ${word}`,
    color: BADGE_COLOR[opts.tier],
  });
}
