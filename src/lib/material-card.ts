import { BRAND_MARK_PATHS } from "@/components/BrandMark";
import { DIMENSIONS } from "./dimensions";
import { SUBSCORE_MAX } from "./score";
import { TIER_AVATAR_FRAME_VECTORS, tierAvatarFrame } from "./tier";
import type { SubScoreKey, SubScores, Tier } from "./types";

export const MATERIAL_CARD_WIDTH = 912;
export const MATERIAL_CARD_HEIGHT = 600;

type MaterialCardTheme = "dark" | "light";
type DimensionGrade = "A" | "B" | "C" | "D" | "E";

export interface MaterialCardSvgOptions {
  username: string;
  displayName: string | null;
  avatar: string | null;
  score: number;
  tier: Tier;
  tierLabel: string;
  tags: string[];
  scores: SubScores;
  color: string;
  theme: MaterialCardTheme;
  qr: string | null;
  tierIcon: string;
}

interface Point {
  x: number;
  y: number;
}

interface DimensionLabel {
  key: SubScoreKey;
  label: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  gradeX?: number;
}

interface MaterialPalette {
  bg: string;
  fg: string;
  muted: string;
  subtle: string;
  panel: string;
  grid: string;
}

const RADAR_CENTER = { x: 688, y: 292 };
const RADAR_RADIUS = 96;
const DIMENSION_LABELS: DimensionLabel[] = [
  { key: "account_maturity", label: "账号成熟", x: 688, y: 151, anchor: "middle" },
  { key: "original_project_quality", label: "原创质量", x: 786, y: 220, anchor: "start" },
  { key: "contribution_quality", label: "贡献质量", x: 786, y: 355, anchor: "start" },
  { key: "ecosystem_impact", label: "生态影响", x: 688, y: 414, anchor: "middle" },
  { key: "community_influence", label: "社区影响", x: 590, y: 355, anchor: "end" },
  {
    key: "activity_authenticity",
    label: "活跃真实",
    x: 612,
    y: 220,
    anchor: "end",
    gradeX: 590,
  },
];

const TAG_ROW_END_X = 556;

const AVATAR_CENTER = { x: 94, y: 96 };
const AVATAR_FRAME_RADIUS = 52;

const PALETTES: Record<MaterialCardTheme, MaterialPalette> = {
  dark: {
    bg: "#0a0a0b",
    fg: "#f4f4f5",
    muted: "#d4d4d8",
    subtle: "#d4d4d8",
    panel: "#151517",
    grid: "#3f3f46",
  },
  light: {
    bg: "#f6f8fb",
    fg: "#18181b",
    muted: "#18181b",
    subtle: "#18181b",
    panel: "#ffffff",
    grid: "#d4d4d8",
  },
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function polarPoint(radius: number, index: number): Point {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / DIMENSIONS.length;
  return {
    x: RADAR_CENTER.x + Math.cos(angle) * radius,
    y: RADAR_CENTER.y + Math.sin(angle) * radius,
  };
}

function pointList(points: Point[]): string {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

function normalizedScore(scores: SubScores, key: SubScoreKey): number {
  return Math.max(0, Math.min(1, (scores[key] ?? 0) / SUBSCORE_MAX[key]));
}

export function gradeForDimension(value: number, max: number): DimensionGrade {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  if (ratio >= 0.85) return "A";
  if (ratio >= 0.7) return "B";
  if (ratio >= 0.55) return "C";
  if (ratio >= 0.4) return "D";
  return "E";
}

function tagWidth(tag: string): number {
  return Math.min(176, 38 + Array.from(tag).length * 23);
}

function brandMark(x: number, y: number, size: number, color: string): string {
  const scale = size / 32;
  const orbits = BRAND_MARK_PATHS.orbit
    .map((path) => `<path d="${path}"/>`)
    .join("");
  return `<g transform="translate(${x} ${y}) scale(${scale})" color="${color}">
    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2.25">${orbits}</g>
    <g fill="currentColor"><circle cx="16" cy="3.5" r="2.5"/><circle cx="5.25" cy="23.5" r="2.5"/><circle cx="26.75" cy="23.5" r="2.5"/></g>
    <g fill="none" stroke-linecap="square" stroke-linejoin="miter" stroke-width="3.5"><path d="${BRAND_MARK_PATHS.coreLeft}" stroke="currentColor"/><path d="${BRAND_MARK_PATHS.coreRight}" stroke="#f97316"/></g>
  </g>`;
}

function avatarEmojiFrame(tier: Tier, tierIcon: string): string {
  const frame = tierAvatarFrame(tier);
  const fontSize = frame.emojiSize === "large" ? 30 : 21;
  return frame.placements
    .map((placement) => {
      const vector = TIER_AVATAR_FRAME_VECTORS[placement];
      const x = AVATAR_CENTER.x + vector.x * AVATAR_FRAME_RADIUS;
      const y = AVATAR_CENTER.y + vector.y * AVATAR_FRAME_RADIUS;
      return `<image href="${tierIcon}" x="${x - fontSize / 2}" y="${y - fontSize / 2}" width="${fontSize}" height="${fontSize}"/>`;
    })
    .join("");
}

export function renderMaterialCardSvg(options: MaterialCardSvgOptions): string {
  const palette = PALETTES[options.theme];
  const username = escapeXml(options.username);
  const displayName = options.displayName ? escapeXml(options.displayName) : null;
  const tierLabel = escapeXml(options.tierLabel);
  const radarPoints = DIMENSIONS.map((key, index) =>
    polarPoint(RADAR_RADIUS * normalizedScore(options.scores, key), index),
  );
  let tagX = 48;
  let tagY = 402;
  const tags = options.tags.slice(0, 4).map((rawTag) => {
    const tag = escapeXml(rawTag);
    const width = tagWidth(rawTag);
    if (tagX + width > TAG_ROW_END_X) {
      tagX = 48;
      tagY = 446;
    }
    const x = tagX;
    const y = tagY;
    tagX += width + 10;
    const fillOpacity = options.theme === "dark" ? 0.12 : 0.06;
    const strokeOpacity = options.theme === "dark" ? 0.48 : 0.4;
    return `<g><rect x="${x}" y="${y}" width="${width}" height="36" rx="18" fill="${options.color}" fill-opacity="${fillOpacity}" stroke="${options.color}" stroke-opacity="${strokeOpacity}"/><text x="${x + width / 2}" y="${y + 24}" text-anchor="middle" fill="${options.color}" font-size="18" font-weight="700">#${tag}</text></g>`;
  });
  const radarGrid = [0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const outer = ratio === 1;
      return `<polygon points="${pointList(DIMENSIONS.map((_, index) => polarPoint(RADAR_RADIUS * ratio, index)))}" fill="${outer ? palette.panel : "none"}" fill-opacity="${outer ? 0.42 : 0}" stroke="${palette.grid}" stroke-width="${outer ? 1.5 : 1}"/>`;
    })
    .join("");
  const radarAxes = DIMENSIONS.map((key, index) => {
    const point = polarPoint(RADAR_RADIUS, index);
    return `<line data-dimension="${key}" x1="${RADAR_CENTER.x}" y1="${RADAR_CENTER.y}" x2="${point.x}" y2="${point.y}" stroke="${palette.grid}" stroke-width="1"/>`;
  }).join("");
  const radarDots = radarPoints
    .map((point) => `<circle cx="${point.x}" cy="${point.y}" r="5" fill="${options.color}" stroke="${palette.bg}" stroke-width="2"/>`)
    .join("");
  const radarLabels = DIMENSION_LABELS.map(({ key, label, x, y, anchor, gradeX = x }) => {
    const grade = gradeForDimension(options.scores[key] ?? 0, SUBSCORE_MAX[key]);
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${palette.muted}" font-size="20" font-weight="600"><tspan x="${x}">${label}</tspan><tspan x="${gradeX}" dy="29" fill="${options.color}" font-size="29" font-weight="800">${grade}</tspan></text>`;
  }).join("");
  const avatar = options.avatar
    ? `<image href="${options.avatar}" x="47" y="49" width="94" height="94" preserveAspectRatio="xMidYMid slice" clip-path="url(#material-avatar-clip)"/>`
    : `<text x="94" y="116" text-anchor="middle" fill="${palette.fg}" font-size="54" font-weight="800">${escapeXml(options.username.slice(0, 1).toUpperCase())}</text>`;
  const avatarFrame = avatarEmojiFrame(options.tier, options.tierIcon);
  const qr = options.qr
    ? `<image href="${options.qr}" x="768" y="34" width="110" height="110"/><rect x="810" y="76" width="26" height="26" fill="${palette.bg}"/>${brandMark(810, 76, 26, palette.fg)}`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="76mm" height="50mm" viewBox="0 0 ${MATERIAL_CARD_WIDTH} ${MATERIAL_CARD_HEIGHT}" role="img" aria-label="${username} 的 ghfind 中文开发者实力卡">
  <defs>
    <radialGradient id="material-glow" cx="88%" cy="4%" r="72%"><stop offset="0" stop-color="${options.color}" stop-opacity="${options.theme === "dark" ? 0.24 : 0.16}"/><stop offset="0.68" stop-color="${options.color}" stop-opacity="0"/></radialGradient>
    <radialGradient id="material-glow-opposite" cx="12%" cy="96%" r="72%"><stop offset="0" stop-color="${options.color}" stop-opacity="${options.theme === "dark" ? 0.24 : 0.16}"/><stop offset="0.68" stop-color="${options.color}" stop-opacity="0"/></radialGradient>
    <linearGradient id="radar-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${options.color}" stop-opacity="0.46"/><stop offset="1" stop-color="${options.color}" stop-opacity="0.12"/></linearGradient>
    <clipPath id="material-avatar-clip"><circle cx="94" cy="96" r="47"/></clipPath>
    <filter id="material-avatar-shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="7" stdDeviation="10" flood-color="${options.color}" flood-opacity="0.28"/></filter>
    <style>text{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif}</style>
  </defs>
  <rect width="912" height="600" rx="28" fill="${palette.bg}"/><rect width="912" height="600" rx="28" fill="url(#material-glow)"/><rect width="912" height="600" rx="28" fill="url(#material-glow-opposite)"/><g data-decoration="ghfind-watermark" opacity="${options.theme === "dark" ? 0.055 : 0.04}">${brandMark(366, 170, 180, palette.fg)}</g><rect x="24" y="24" width="864" height="552" rx="20" fill="none" stroke="${options.color}" stroke-opacity="0.18"/>
  <circle cx="94" cy="96" r="52" fill="${palette.panel}" stroke="${options.color}" stroke-width="3" filter="url(#material-avatar-shadow)"/>${avatar}${avatarFrame}
  <text x="164" y="84" fill="${options.color}" font-size="34" font-weight="800">@${username}</text>${displayName ? `<text x="164" y="121" fill="${palette.muted}" font-size="20">${displayName}</text>` : ""}
  <text x="48" y="255" fill="${options.color}" font-size="88" font-weight="800" letter-spacing="-3">${options.score.toFixed(2)}</text>
  <text x="52" y="330" fill="${options.color}" font-size="68" font-weight="800">${escapeXml(options.tier)}</text><text x="52" y="366" fill="${palette.muted}" font-size="24" font-weight="600">${tierLabel}</text>
  ${tags.join("")}
  ${radarGrid}${radarAxes}<polygon points="${pointList(radarPoints)}" fill="url(#radar-fill)" stroke="${options.color}" stroke-width="4" stroke-linejoin="round"/>${radarDots}${radarLabels}${qr}
  <line x1="48" y1="505" x2="864" y2="505" stroke="${palette.grid}" stroke-opacity="0.62"/>${brandMark(48, 530, 28, palette.fg)}
  <text x="87" y="553" fill="${palette.fg}" font-size="23" font-weight="800">ghfind.com</text><text x="225" y="553" fill="${palette.subtle}" font-size="17">GitHub 开发者实力认证</text><text x="864" y="553" text-anchor="end" fill="${palette.subtle}" font-size="17">Powered by Lubehub, Dify and Mosoo.</text>
</svg>`;
}
