/**
 * Mid-size brag cards as self-contained SVG — the README-native tier between the
 * 20px badge (`./badge.ts`) and the 1200×630 PNG (`app/api/card/[username]`).
 *
 * Why SVG rather than another `ImageResponse` PNG:
 *  - Markdown can't size an image. `![](url)` renders at the intrinsic size, so a
 *    440-wide PNG is soft on retina and an 880-wide one swallows the README. An
 *    SVG declaring `width="440"` lays out at exactly 440 CSS px and stays sharp
 *    at any DPI.
 *  - The PNG path is locked to Latin-only Inter, so it drops non-ASCII display
 *    names outright. SVG text resolves against the viewer's fonts, so `lang:"zh"`
 *    can finally put Chinese names and tier words on a card.
 *  - `theme:"auto"` embeds a `prefers-color-scheme` block, so one URL reads
 *    correctly in both GitHub themes. A PNG can't.
 *  - ~8KB and no Satori pass. This is the endpoint camo and crawlers hammer.
 *
 * The cost is hand-rolled layout: no flexbox, so text is measured with
 * `estimateTextWidth` and clipped to a fixed slot. Pure functions → the geometry
 * is unit-testable without a DB (see `__tests__/mini-card.test.ts`).
 *
 * Nothing here may reference an external resource: an SVG rendered inside an
 * `<img>` is blocked from loading anything over the network, so the avatar must
 * arrive as a data URL.
 */

import {
  BADGE_COLOR,
  BADGE_COLOR_LIGHT,
  escapeXml,
  estimateTextWidth,
  TIER_EN,
} from "./badge";
import { DIMENSIONS } from "./dimensions";
import { brandMarkSvg, gradeForDimension } from "./material-card";
import { MINI_CARD_SIZES, type MiniCardVariant } from "./mini-card-sizes";
import { SUBSCORE_MAX } from "./score";
import { SPONSOR } from "./sponsor";
import type { SubScoreKey, SubScores, Tier } from "./types";

export { MINI_CARD_SIZES, type MiniCardVariant };

export type MiniCardTheme = "auto" | "dark" | "light";
export type MiniCardLang = "en" | "zh";

export interface MiniCardOptions {
  username: string;
  displayName: string | null;
  /** Data URL. A plain https URL renders as nothing inside an `<img>`. */
  avatar: string | null;
  score: number;
  tier: Tier;
  /** Localized tier blurb (zh from `tierFor`, en from `TIER_LABEL_EN`). */
  tierLabel: string;
  scores: SubScores;
  /** Top languages, already ranked. Empty is fine — the slot degrades. */
  languages: string[];
  rank: number | null;
  total: number | null;
  /** Percent of ranked devs beaten, from the same denominator as `rank`. */
  beat: number | null;
  /** Week-over-week score change. Only positive values render. */
  delta: number | null;
  /**
   * Sponsor logo as a data URL (`sponsorLogoDataUrl("small")`). Null renders the
   * credit as text alone. `strip` ignores it — see `renderStrip`.
   */
  sponsorLogo: string | null;
  variant: MiniCardVariant;
  theme: MiniCardTheme;
  lang: MiniCardLang;
}

export interface MiniCardUnratedOptions {
  username: string;
  variant: MiniCardVariant;
  theme: MiniCardTheme;
  lang: MiniCardLang;
}

interface Palette {
  bg: string;
  fg: string;
  muted: string;
  panel: string;
  grid: string;
  accent: string;
}

const THEME_HEX = {
  dark: {
    bg: "#0a0a0b",
    fg: "#f4f4f5",
    muted: "#a1a1aa",
    panel: "#18181b",
    grid: "#3f3f46",
  },
  light: {
    bg: "#ffffff",
    fg: "#18181b",
    muted: "#52525b",
    panel: "#f4f4f5",
    grid: "#d4d4d8",
  },
} as const;

const NEUTRAL_ACCENT = { dark: "#9ca3af", light: "#6b7280" } as const;

const FONT_STACK =
  'Inter,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

const DIMENSION_LABELS: Record<MiniCardLang, Record<SubScoreKey, string>> = {
  en: {
    account_maturity: "Maturity",
    original_project_quality: "Original",
    contribution_quality: "Contrib",
    ecosystem_impact: "Ecosystem",
    community_influence: "Community",
    activity_authenticity: "Authentic",
  },
  zh: {
    account_maturity: "成熟",
    original_project_quality: "原创",
    contribution_quality: "贡献",
    ecosystem_impact: "生态",
    community_influence: "社区",
    activity_authenticity: "真实",
  },
};

interface Copy {
  outOf: string;
  top: (pct: string) => string;
  rank: (rank: string, total: string) => string;
  week: (delta: string) => string;
  unrated: string;
  brand: string;
}

const COPY: Record<MiniCardLang, Copy> = {
  en: {
    outOf: "/100",
    top: (pct) => `Top ${pct}%`,
    rank: (rank, total) => `#${rank} / ${total}`,
    week: (delta) => `↑${delta} wk`,
    unrated: "Not yet rated",
    brand: "ghfind.com",
  },
  zh: {
    outOf: "/100",
    top: (pct) => `前 ${pct}%`,
    rank: (rank, total) => `第 ${rank} / ${total}`,
    week: (delta) => `↑${delta} 周`,
    unrated: "尚未评分",
    brand: "ghfind.com",
  },
};

function accentFor(tier: Tier | null, mode: "dark" | "light"): string {
  if (!tier) return NEUTRAL_ACCENT[mode];
  return mode === "dark" ? BADGE_COLOR[tier] : BADGE_COLOR_LIGHT[tier];
}

/**
 * Fixed themes emit literal hex; `auto` emits `var()` with the dark value as the
 * fallback. Keeping the literals out of `auto`'s code path is deliberate — if a
 * renderer ever ignores custom properties, `theme=dark`/`light` (and the
 * `<picture>` snippet built on them) remain exact.
 */
function paletteFor(theme: MiniCardTheme, tier: Tier | null): Palette {
  if (theme !== "auto") {
    return { ...THEME_HEX[theme], accent: accentFor(tier, theme) };
  }
  const d = THEME_HEX.dark;
  return {
    bg: `var(--b,${d.bg})`,
    fg: `var(--f,${d.fg})`,
    muted: `var(--m,${d.muted})`,
    panel: `var(--p,${d.panel})`,
    grid: `var(--g,${d.grid})`,
    accent: `var(--a,${accentFor(tier, "dark")})`,
  };
}

function styleBlock(theme: MiniCardTheme, tier: Tier | null): string {
  const font = `text{font-family:${FONT_STACK}}`;
  if (theme !== "auto") return `<style>${font}</style>`;
  const vars = (mode: "dark" | "light") => {
    const h = THEME_HEX[mode];
    return `--b:${h.bg};--f:${h.fg};--m:${h.muted};--p:${h.panel};--g:${h.grid};--a:${accentFor(tier, mode)}`;
  };
  return `<style>:root{${vars("dark")}}@media (prefers-color-scheme:light){:root{${vars("light")}}}${font}</style>`;
}

/**
 * `estimateTextWidth` bills every Latin glyph at 0.6em, which is right for
 * digits but underestimates heavy-weight uppercase (an 800-weight "GOD" is
 * closer to 0.72em/char). Inline runs that continue *after* a bold word must
 * advance by this figure or they collide with it.
 */
function boldWidth(text: string, fontSize: number): number {
  return Math.ceil(estimateTextWidth(text, fontSize) * 1.18);
}

/** Truncate to fit a slot, measured with the badge's CJK-aware estimator. */
export function clipText(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length > 1) {
    chars.pop();
    if (estimateTextWidth(`${chars.join("")}…`, fontSize) <= maxWidth) break;
  }
  return `${chars.join("")}…`;
}

interface TextOptions {
  size: number;
  fill: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  ls?: number;
  middle?: boolean;
}

/** `content` must already be XML-escaped. */
function t(x: number, y: number, content: string, o: TextOptions): string {
  const anchor = o.anchor && o.anchor !== "start" ? ` text-anchor="${o.anchor}"` : "";
  const baseline = o.middle ? ' dominant-baseline="middle"' : "";
  const weight = o.weight ? ` font-weight="${o.weight}"` : "";
  const ls = o.ls ? ` letter-spacing="${o.ls}"` : "";
  return `<text x="${x}" y="${y}"${anchor}${baseline} fill="${o.fill}" font-size="${o.size}"${weight}${ls}>${content}</text>`;
}

function frame(w: number, h: number, radius: number, p: Palette): string {
  return `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${radius}" fill="${p.bg}" stroke="${p.accent}" stroke-opacity="0.32"/>`;
}

const AVATAR_CLIP_ID = "mc-avatar";

function avatarNode(
  avatar: string | null,
  cx: number,
  cy: number,
  r: number,
  p: Palette,
  username: string,
): string {
  const ring = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${p.panel}" stroke="${p.accent}" stroke-opacity="0.75" stroke-width="1.5"/>`;
  if (!avatar) {
    const initial = escapeXml(Array.from(username)[0]?.toUpperCase() ?? "?");
    return `${ring}${t(cx, cy, initial, {
      size: Math.round(r * 1.1),
      fill: p.fg,
      weight: 800,
      anchor: "middle",
      middle: true,
    })}`;
  }
  const ir = r - 2;
  return `<defs><clipPath id="${AVATAR_CLIP_ID}"><circle cx="${cx}" cy="${cy}" r="${ir}"/></clipPath></defs>${ring}<image href="${avatar}" x="${cx - ir}" y="${cy - ir}" width="${ir * 2}" height="${ir * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${AVATAR_CLIP_ID})"/>`;
}

/** `Top 0.8%` reads stronger than `beats 99.2%`, and is shorter. */
function topPercent(beat: number): string {
  const top = Math.max(0.1, Math.round((100 - beat) * 10) / 10);
  return top >= 10 ? String(Math.round(top)) : top.toFixed(1);
}

function num(value: number): string {
  return value.toLocaleString("en-US");
}

/** `Top 0.8% · #128 / 21,384`, dropping whichever half is unavailable. */
function metaLine(o: MiniCardOptions, c: Copy): string {
  const parts: string[] = [];
  if (o.beat !== null) parts.push(c.top(topPercent(o.beat)));
  if (o.rank !== null && o.total !== null) parts.push(c.rank(num(o.rank), num(o.total)));
  return parts.join(" · ");
}

/** Drops are hidden: like the badge, this is a brag surface, not a report card. */
function weekDelta(delta: number | null, c: Copy): string | null {
  if (typeof delta !== "number" || delta < 0.05) return null;
  return c.week(delta.toFixed(1));
}

function tierWord(tier: Tier, lang: MiniCardLang): string {
  return lang === "zh" ? tier : TIER_EN[tier];
}

/** Pill with the tier word knocked out of an accent fill. */
function tierChip(rightX: number, y: number, h: number, word: string, p: Palette): string {
  const size = Math.round(h * 0.55);
  const w = boldWidth(word, size) + 18;
  const x = rightX - w;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${p.accent}"/>${t(
    x + w / 2,
    y + h / 2 + 0.5,
    escapeXml(word),
    { size, fill: p.bg, weight: 800, anchor: "middle", middle: true },
  )}`;
}

/**
 * `[logo] Powered by <name>`, laid out from `x` and reporting its own width so
 * the footer can subtract it from the slot left for the language list.
 *
 * A null logo drops the mark but keeps the wordmark — the credit is the part
 * that's owed, and a missing asset shouldn't silently retract it.
 */
function sponsorGroup(
  x: number,
  y: number,
  logo: string | null,
  size: number,
  fontSize: number,
  p: Palette,
): { svg: string; width: number } {
  const label = "Powered by ";
  const labelWidth = estimateTextWidth(label, fontSize);
  const mark = logo
    ? `<image href="${logo}" x="${x}" y="${y - Math.round(size * 0.78)}" width="${size}" height="${size}"/>`
    : "";
  const markWidth = logo ? size + 4 : 0;
  const textX = x + markWidth;
  const svg = [
    mark,
    t(textX, y, label.trimEnd(), { size: fontSize, fill: p.muted }),
    t(textX + labelWidth, y, escapeXml(SPONSOR.name), {
      size: fontSize,
      fill: p.fg,
      weight: 600,
    }),
  ].join("");
  return {
    svg,
    width: markWidth + labelWidth + estimateTextWidth(SPONSOR.name, fontSize),
  };
}

/**
 * `[mark] ghfind.com  [logo] Powered by <sponsor>` on the left, `right` (the
 * language list) anchored to `rightX` and clipped to whatever survives.
 *
 * The sponsor sits beside the ghfind lock-up rather than opposite it: both are
 * site-level credits, while the right slot carries the account's own data.
 *
 * `sponsor: null` drops the credit outright (the strip has no room for it) —
 * distinct from `{ logo: null }`, which keeps the credit minus its mark.
 */
function footer(
  y: number,
  leftX: number,
  rightX: number,
  markSize: number,
  fontSize: number,
  right: string,
  p: Palette,
  c: Copy,
  sponsorCredit: { logo: string | null } | null,
): string {
  const markY = y - Math.round(markSize * 0.78);
  const wordX = leftX + markSize + 3;
  const brandWidth = estimateTextWidth(c.brand, fontSize);
  const sponsor = sponsorCredit
    ? sponsorGroup(wordX + brandWidth + 12, y, sponsorCredit.logo, markSize, fontSize, p)
    : null;
  const leftEnd = wordX + brandWidth + (sponsor ? 12 + sponsor.width : 0);
  const rightMax = rightX - leftEnd - 12;
  const trailing =
    right && rightMax > 24
      ? t(rightX, y, escapeXml(clipText(right, rightMax, fontSize)), {
          size: fontSize,
          fill: p.muted,
          anchor: "end",
        })
      : "";
  return `${brandMarkSvg(leftX, markY, markSize, p.fg)}${t(wordX, y, c.brand, {
    size: fontSize,
    fill: p.fg,
    weight: 700,
  })}${sponsor?.svg ?? ""}${trailing}`;
}

function svgRoot(
  w: number,
  h: number,
  variant: MiniCardVariant,
  label: string,
  style: string,
  body: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" data-variant="${variant}" aria-label="${escapeXml(label)}">
<title>${escapeXml(label)}</title>
${style}
${body}
</svg>`;
}

// ---------------------------------------------------------------------------
// bars — 440×200: identity, score, six micro meters, languages
// ---------------------------------------------------------------------------

const BAR_COLUMN_X = [18, 241];
const BAR_ROW_Y = [128, 146, 164];
const BAR_LABEL_W = 76;
const BAR_CELLS = 6;
const BAR_CELL_W = 15;
const BAR_CELL_GAP = 3;
const BAR_CELL_H = 7;

function barGroup(
  x: number,
  y: number,
  key: SubScoreKey,
  o: MiniCardOptions,
  p: Palette,
): string {
  const ratio = Math.max(0, Math.min(1, (o.scores?.[key] ?? 0) / SUBSCORE_MAX[key]));
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round(ratio * BAR_CELLS)));
  const cells = Array.from({ length: BAR_CELLS }, (_, i) => {
    const on = i < filled;
    const cx = x + BAR_LABEL_W + i * (BAR_CELL_W + BAR_CELL_GAP);
    return `<rect x="${cx}" y="${y}" width="${BAR_CELL_W}" height="${BAR_CELL_H}" rx="1.5" fill="${
      on ? p.accent : p.grid
    }"/>`;
  }).join("");
  const label = clipText(DIMENSION_LABELS[o.lang][key], BAR_LABEL_W - 6, 10);
  return `<g data-dimension="${key}">${t(x, y + BAR_CELL_H, escapeXml(label), {
    size: 10,
    fill: p.muted,
    weight: 600,
  })}${cells}</g>`;
}

function renderBars(o: MiniCardOptions, p: Palette, c: Copy): string {
  const word = tierWord(o.tier, o.lang);
  const chip = tierChip(422, 27, 22, word, p);
  const chipLeft = 422 - (boldWidth(word, 12) + 18);
  const textMax = chipLeft - 70 - 12;

  const score = o.score.toFixed(2);
  const scoreW = estimateTextWidth(score, 34);
  const outOfX = 18 + scoreW + 5;
  const delta = weekDelta(o.delta, c);
  const deltaNode = delta
    ? t(outOfX + estimateTextWidth(c.outOf, 12.5) + 9, 92, escapeXml(delta), {
        size: 11,
        fill: p.accent,
        weight: 700,
      })
    : "";

  const meta = metaLine(o, c);
  return [
    frame(440, 200, 12, p),
    avatarNode(o.avatar, 38, 38, 20, p, o.username),
    t(70, 33, escapeXml(clipText(`@${o.username}`, textMax, 15)), {
      size: 15,
      fill: p.accent,
      weight: 700,
    }),
    o.displayName
      ? t(70, 51, escapeXml(clipText(o.displayName, textMax, 11.5)), {
          size: 11.5,
          fill: p.muted,
        })
      : "",
    chip,
    t(18, 92, score, { size: 34, fill: p.fg, weight: 800, ls: -1 }),
    t(outOfX, 92, c.outOf, { size: 12.5, fill: p.muted }),
    deltaNode,
    meta ? t(18, 111, escapeXml(meta), { size: 10.5, fill: p.muted }) : "",
    DIMENSIONS.map((key, i) =>
      barGroup(BAR_COLUMN_X[i % 2], BAR_ROW_Y[Math.floor(i / 2)], key, o, p),
    ).join(""),
    `<line x1="18" y1="180" x2="422" y2="180" stroke="${p.grid}" stroke-opacity="0.7"/>`,
    footer(194, 18, 422, 13, 10, o.languages.join(" · "), p, c, { logo: o.sponsorLogo }),
  ].join("");
}

// ---------------------------------------------------------------------------
// radar — 440×200: identity, score, tier blurb, six-axis radar with A–E grades
// ---------------------------------------------------------------------------

const RADAR_CENTER = { x: 346, y: 92 };
const RADAR_RADIUS = 46;
const RADAR_GRADE_RADIUS = 66;
const RADAR_TEXT_MAX = 250;

function radarPoint(radius: number, index: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / DIMENSIONS.length;
  return {
    x: RADAR_CENTER.x + Math.cos(angle) * radius,
    y: RADAR_CENTER.y + Math.sin(angle) * radius,
  };
}

function pointList(points: { x: number; y: number }[]): string {
  return points.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");
}

function renderRadar(o: MiniCardOptions, p: Palette, c: Copy): string {
  const rings = [0.34, 0.67, 1]
    .map(
      (ratio) =>
        `<polygon points="${pointList(
          DIMENSIONS.map((_, i) => radarPoint(RADAR_RADIUS * ratio, i)),
        )}" fill="none" stroke="${p.grid}" stroke-width="${ratio === 1 ? 1.2 : 0.8}"/>`,
    )
    .join("");
  const axes = DIMENSIONS.map((_, i) => {
    const pt = radarPoint(RADAR_RADIUS, i);
    return `<line x1="${RADAR_CENTER.x}" y1="${RADAR_CENTER.y}" x2="${pt.x.toFixed(1)}" y2="${pt.y.toFixed(1)}" stroke="${p.grid}" stroke-width="0.8"/>`;
  }).join("");
  const shape = DIMENSIONS.map((key, i) => {
    const ratio = Math.max(0, Math.min(1, (o.scores?.[key] ?? 0) / SUBSCORE_MAX[key]));
    return radarPoint(RADAR_RADIUS * ratio, i);
  });
  const grades = DIMENSIONS.map((key, i) => {
    const pt = radarPoint(RADAR_GRADE_RADIUS, i);
    const grade = gradeForDimension(o.scores?.[key] ?? 0, SUBSCORE_MAX[key]);
    return `<g data-dimension="${key}">${t(
      Number(pt.x.toFixed(1)),
      Number(pt.y.toFixed(1)),
      grade,
      { size: 11, fill: p.accent, weight: 800, anchor: "middle", middle: true },
    )}</g>`;
  }).join("");

  const word = tierWord(o.tier, o.lang);
  const wordW = boldWidth(word, 14);
  const score = o.score.toFixed(2);
  const outOfX = 18 + estimateTextWidth(score, 32) + 5;
  const delta = weekDelta(o.delta, c);
  const meta = metaLine(o, c);

  return [
    frame(440, 200, 12, p),
    avatarNode(o.avatar, 36, 36, 18, p, o.username),
    t(62, 32, escapeXml(clipText(`@${o.username}`, RADAR_TEXT_MAX - 44, 14)), {
      size: 14,
      fill: p.accent,
      weight: 700,
    }),
    o.displayName
      ? t(62, 49, escapeXml(clipText(o.displayName, RADAR_TEXT_MAX - 44, 11)), {
          size: 11,
          fill: p.muted,
        })
      : "",
    t(18, 92, score, { size: 32, fill: p.fg, weight: 800, ls: -1 }),
    t(outOfX, 92, c.outOf, { size: 12, fill: p.muted }),
    delta
      ? t(outOfX + estimateTextWidth(c.outOf, 12) + 9, 92, escapeXml(delta), {
          size: 11,
          fill: p.accent,
          weight: 700,
        })
      : "",
    t(18, 116, escapeXml(word), { size: 14, fill: p.accent, weight: 800 }),
    t(
      18 + wordW + 7,
      116,
      escapeXml(clipText(o.tierLabel, RADAR_TEXT_MAX - wordW - 7, 10)),
      { size: 10, fill: p.muted },
    ),
    meta
      ? t(18, 134, escapeXml(clipText(meta, RADAR_TEXT_MAX, 10.5)), {
          size: 10.5,
          fill: p.muted,
        })
      : "",
    rings,
    axes,
    `<polygon points="${pointList(shape)}" fill="${p.accent}" fill-opacity="0.22" stroke="${p.accent}" stroke-width="2" stroke-linejoin="round"/>`,
    shape
      .map(
        (pt) =>
          `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="2.4" fill="${p.accent}"/>`,
      )
      .join(""),
    grades,
    `<line x1="18" y1="164" x2="422" y2="164" stroke="${p.grid}" stroke-opacity="0.7"/>`,
    footer(180, 18, 422, 13, 10, o.languages.join(" · "), p, c, { logo: o.sponsorLogo }),
  ].join("");
}

// ---------------------------------------------------------------------------
// strip — 420×88: two dense rows, sized to sit in a shields badge row
//
// The only variant with no sponsor credit: its footer is already brand +
// languages inside 392px, and a third run would leave every slot clipped to
// nothing. The sponsor is better served by a legible slot on bars/radar (the
// default, and what the builder leads with) than a squeezed one here.
// ---------------------------------------------------------------------------

function renderStrip(o: MiniCardOptions, p: Palette, c: Copy): string {
  const score = o.score.toFixed(2);
  const scoreW = estimateTextWidth(score, 22);
  const word = tierWord(o.tier, o.lang);
  const delta = weekDelta(o.delta, c);
  const tail = delta ? `${word} ${delta}` : word;
  const tailW = boldWidth(tail, 10);
  const textMax = Math.max(60, 406 - Math.max(scoreW, tailW) - 56 - 12);
  const meta = metaLine(o, c);

  return [
    frame(420, 88, 10, p),
    avatarNode(o.avatar, 30, 38, 16, p, o.username),
    t(56, 34, escapeXml(clipText(`@${o.username}`, textMax, 13)), {
      size: 13,
      fill: p.accent,
      weight: 700,
    }),
    t(406, 36, score, { size: 22, fill: p.fg, weight: 800, anchor: "end", ls: -0.5 }),
    meta
      ? t(56, 51, escapeXml(clipText(meta, textMax, 9.5)), { size: 9.5, fill: p.muted })
      : "",
    t(406, 52, escapeXml(tail), { size: 10, fill: p.accent, weight: 700, anchor: "end" }),
    `<line x1="14" y1="59" x2="406" y2="59" stroke="${p.grid}" stroke-opacity="0.7"/>`,
    footer(72, 14, 406, 11, 9.5, o.languages.join(" · "), p, c, null),
  ].join("");
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export function parseMiniCardVariant(value: string | null): MiniCardVariant {
  return value === "radar" || value === "strip" ? value : "bars";
}

export function parseMiniCardTheme(value: string | null): MiniCardTheme {
  return value === "dark" || value === "light" ? value : "auto";
}

export function parseMiniCardLang(value: string | null): MiniCardLang {
  return value === "zh" ? "zh" : "en";
}

export function renderMiniCardSvg(o: MiniCardOptions): string {
  const { w, h } = MINI_CARD_SIZES[o.variant];
  const p = paletteFor(o.theme, o.tier);
  const c = COPY[o.lang];
  const body =
    o.variant === "radar"
      ? renderRadar(o, p, c)
      : o.variant === "strip"
        ? renderStrip(o, p, c)
        : renderBars(o, p, c);
  const label = `@${o.username} — ${o.score.toFixed(2)}${c.outOf} ${tierWord(
    o.tier,
    o.lang,
  )} · ${c.brand}`;
  return svgRoot(w, h, o.variant, label, styleBlock(o.theme, o.tier), body);
}

/**
 * Placeholder at the same intrinsic size. Unrated accounts must still return a
 * 200 with a drawable card — an embedded README image that 404s renders as a
 * broken-image icon on someone else's profile.
 */
export function renderMiniCardUnratedSvg(o: MiniCardUnratedOptions): string {
  const { w, h } = MINI_CARD_SIZES[o.variant];
  const p = paletteFor(o.theme, null);
  const c = COPY[o.lang];
  const strip = o.variant === "strip";
  const handle = clipText(`@${o.username}`, w - 48, strip ? 13 : 16);
  // One centered lock-up rather than the rated layout with holes in it — at
  // 440×200 two stray lines of text read as a half-loaded image.
  const body = strip
    ? [
        frame(w, h, 10, p),
        t(w / 2, 38, escapeXml(handle), {
          size: 13,
          fill: p.fg,
          weight: 800,
          anchor: "middle",
        }),
        t(w / 2, 56, escapeXml(`${c.unrated} · ${c.brand}`), {
          size: 9.5,
          fill: p.muted,
          anchor: "middle",
        }),
      ].join("")
    : [
        frame(w, h, 12, p),
        brandMarkSvg(w / 2 - 13, 52, 26, p.muted),
        t(w / 2, 106, escapeXml(handle), {
          size: 16,
          fill: p.fg,
          weight: 800,
          anchor: "middle",
        }),
        t(w / 2, 128, escapeXml(c.unrated), {
          size: 12,
          fill: p.muted,
          anchor: "middle",
        }),
        t(w / 2, 152, c.brand, {
          size: 10.5,
          fill: p.muted,
          weight: 700,
          anchor: "middle",
        }),
      ].join("");
  return svgRoot(
    w,
    h,
    o.variant,
    `@${o.username} — ${c.unrated} · ${c.brand}`,
    styleBlock(o.theme, null),
    body,
  );
}
