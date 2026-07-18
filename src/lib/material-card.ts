import { BRAND_MARK_PATHS } from "@/components/BrandMark";
import { DIMENSIONS } from "./dimensions";
import { SUBSCORE_MAX } from "./score";
import { TIER_AVATAR_FRAME_VECTORS, tierAvatarFrame } from "./tier";
import type { SubScoreKey, SubScores, Tier } from "./types";

export const MATERIAL_CARD_WIDTH = 912;
export const MATERIAL_CARD_HEIGHT = 600;
export const MATERIAL_CARD_EXPORT_SCALE = 2;
export const MATERIAL_CARD_EXPORT_WIDTH =
  MATERIAL_CARD_WIDTH * MATERIAL_CARD_EXPORT_SCALE;
export const MATERIAL_CARD_EXPORT_HEIGHT =
  MATERIAL_CARD_HEIGHT * MATERIAL_CARD_EXPORT_SCALE;

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
const RADAR_GRADE_RADIUS = 124;
const RADAR_LABEL_VERTICAL_GAP = 40;
const DIMENSION_LABELS: Record<SubScoreKey, string> = {
  account_maturity: "账号成熟",
  original_project_quality: "原创质量",
  contribution_quality: "贡献质量",
  ecosystem_impact: "生态影响",
  community_influence: "社区影响",
  activity_authenticity: "活跃真实",
};

const TAG_ROW_START_X = 48;
const TAG_ROW_Y = 445;
const TAG_HEIGHT = 40;
const TAG_GAP = 10;
const TAG_MAX_COUNT = 3;
const TAG_MAX_WIDTH = 156;

const MATERIAL_TEXT_SIZE = {
  tag: 22,
  dimensionLabel: 22,
  dimensionGrade: 33,
  avatarFallback: 66,
  username: 42,
  displayName: 29,
  score: 94,
  tier: 74,
  tierLabel: 28,
  brand: 27,
  footer: 20,
} as const;

const SCORE_X = 48;
const SCORE_Y = 255;
const TIER_Y = 348;
const TIER_LABEL_Y = 400;
const AVATAR_FRAME_RADIUS = 60;
const AVATAR_IMAGE_RADIUS = 55;
const AVATAR_CENTER = { x: SCORE_X + AVATAR_FRAME_RADIUS, y: 101 };
const PROFILE_TEXT_X = AVATAR_CENTER.x + AVATAR_FRAME_RADIUS + 10;
const PROFILE_USERNAME_Y = 98;
const PROFILE_DISPLAY_NAME_Y = 136;

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
  return points.map((point) => `${svgCoordinate(point.x)},${svgCoordinate(point.y)}`).join(" ");
}

function svgCoordinate(value: number): string {
  return value.toFixed(1);
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
  return Math.min(TAG_MAX_WIDTH, 42 + Array.from(tag).length * 22);
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
  const iconSize = frame.emojiSize === "large" ? 34 : 24;
  return frame.placements
    .map((placement) => {
      const vector = TIER_AVATAR_FRAME_VECTORS[placement];
      const x = AVATAR_CENTER.x + vector.x * AVATAR_FRAME_RADIUS;
      const y = AVATAR_CENTER.y + vector.y * AVATAR_FRAME_RADIUS;
      return `<image href="${tierIcon}" x="${x - iconSize / 2}" y="${y - iconSize / 2}" width="${iconSize}" height="${iconSize}"/>`;
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
  const visibleTags = options.tags.slice(0, TAG_MAX_COUNT);
  let tagX = TAG_ROW_START_X;
  const tags = visibleTags.map((rawTag) => {
    const tag = escapeXml(rawTag);
    const width = tagWidth(rawTag);
    const x = tagX;
    tagX += width + TAG_GAP;
    return `<g><rect x="${x}" y="${TAG_ROW_Y}" width="${width}" height="${TAG_HEIGHT}" rx="${TAG_HEIGHT / 2}" fill="#000000" stroke="${options.color}" stroke-width="1.5"/><text x="${x + width / 2}" y="${TAG_ROW_Y + 27}" text-anchor="middle" fill="${options.color}" font-size="${MATERIAL_TEXT_SIZE.tag}" font-weight="700">#${tag}</text></g>`;
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
  const radarLabels = DIMENSIONS.map((key, index) => {
    const gradePoint = polarPoint(RADAR_GRADE_RADIUS, index);
    const labelVerticalDirection = gradePoint.y < RADAR_CENTER.y ? -1 : 1;
    const labelY = gradePoint.y + labelVerticalDirection * RADAR_LABEL_VERTICAL_GAP;
    const grade = gradeForDimension(options.scores[key] ?? 0, SUBSCORE_MAX[key]);
    return `<g data-dimension-label="${key}"><text x="${svgCoordinate(gradePoint.x)}" y="${svgCoordinate(gradePoint.y)}" text-anchor="middle" dominant-baseline="middle" fill="${options.color}" font-size="${MATERIAL_TEXT_SIZE.dimensionGrade}" font-weight="800">${grade}</text><text x="${svgCoordinate(gradePoint.x)}" y="${svgCoordinate(labelY)}" text-anchor="middle" dominant-baseline="middle" fill="${palette.muted}" font-size="${MATERIAL_TEXT_SIZE.dimensionLabel}" font-weight="600">${DIMENSION_LABELS[key]}</text></g>`;
  }).join("");
  const avatar = options.avatar
    ? `<image href="${options.avatar}" x="${AVATAR_CENTER.x - AVATAR_IMAGE_RADIUS}" y="${AVATAR_CENTER.y - AVATAR_IMAGE_RADIUS}" width="${AVATAR_IMAGE_RADIUS * 2}" height="${AVATAR_IMAGE_RADIUS * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#material-avatar-clip)"/>`
    : `<text x="${AVATAR_CENTER.x}" y="${AVATAR_CENTER.y + 23}" text-anchor="middle" fill="${palette.fg}" font-size="${MATERIAL_TEXT_SIZE.avatarFallback}" font-weight="800">${escapeXml(options.username.slice(0, 1).toUpperCase())}</text>`;
  const avatarFrame = avatarEmojiFrame(options.tier, options.tierIcon);
  const glowOpacity = options.theme === "dark" ? 0.5 : 0.34;
  const avatarGlowOpacity = options.theme === "dark" ? 0.42 : 0.32;
  const watermarkOpacity = options.theme === "dark" ? 0.14 : 0.1;
  const qr = options.qr
    ? `<image href="${options.qr}" x="768" y="34" width="110" height="110"/><rect x="810" y="76" width="26" height="26" fill="${palette.bg}"/>${brandMark(810, 76, 26, palette.fg)}`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${MATERIAL_CARD_EXPORT_WIDTH}" height="${MATERIAL_CARD_EXPORT_HEIGHT}" viewBox="0 0 ${MATERIAL_CARD_WIDTH} ${MATERIAL_CARD_HEIGHT}" data-print-width="76mm" data-print-height="50mm" role="img" aria-label="${username} 的 ghfind 中文开发者实力卡">
  <defs>
    <radialGradient id="material-glow" cx="88%" cy="4%" r="72%"><stop offset="0" stop-color="${options.color}" stop-opacity="${glowOpacity}"/><stop offset="0.68" stop-color="${options.color}" stop-opacity="0"/></radialGradient>
    <radialGradient id="material-glow-opposite" cx="12%" cy="96%" r="72%"><stop offset="0" stop-color="${options.color}" stop-opacity="${glowOpacity}"/><stop offset="0.68" stop-color="${options.color}" stop-opacity="0"/></radialGradient>
    <linearGradient id="radar-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${options.color}" stop-opacity="0.46"/><stop offset="1" stop-color="${options.color}" stop-opacity="0.12"/></linearGradient>
    <clipPath id="material-avatar-clip"><circle cx="${AVATAR_CENTER.x}" cy="${AVATAR_CENTER.y}" r="${AVATAR_IMAGE_RADIUS}"/></clipPath>
    <filter id="material-avatar-shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="7" stdDeviation="10" flood-color="${options.color}" flood-opacity="${avatarGlowOpacity}"/></filter>
    <style>text{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif}</style>
  </defs>
  <rect width="912" height="600" rx="28" fill="${palette.bg}"/><rect width="912" height="600" rx="28" fill="url(#material-glow)"/><rect width="912" height="600" rx="28" fill="url(#material-glow-opposite)"/><g data-decoration="ghfind-watermark" opacity="${watermarkOpacity}">${brandMark(366, 170, 180, palette.fg)}</g><rect x="24" y="24" width="864" height="552" rx="20" fill="none" stroke="${options.color}" stroke-opacity="0.18"/>
  <circle cx="${AVATAR_CENTER.x}" cy="${AVATAR_CENTER.y}" r="${AVATAR_FRAME_RADIUS}" fill="${palette.panel}" stroke="${options.color}" stroke-width="3" filter="url(#material-avatar-shadow)"/>${avatar}${avatarFrame}
  <text x="${PROFILE_TEXT_X}" y="${PROFILE_USERNAME_Y}" fill="${options.color}" font-size="${MATERIAL_TEXT_SIZE.username}" font-weight="800">@${username}</text>${displayName ? `<text x="${PROFILE_TEXT_X}" y="${PROFILE_DISPLAY_NAME_Y}" fill="${palette.muted}" font-size="${MATERIAL_TEXT_SIZE.displayName}">${displayName}</text>` : ""}
  <text x="${SCORE_X}" y="${SCORE_Y}" fill="${options.color}" font-size="${MATERIAL_TEXT_SIZE.score}" font-weight="800" letter-spacing="-3">${options.score.toFixed(2)}</text>
  <text x="52" y="${TIER_Y}" fill="${options.color}" font-size="${MATERIAL_TEXT_SIZE.tier}" font-weight="800">${escapeXml(options.tier)}</text><text x="52" y="${TIER_LABEL_Y}" fill="${palette.muted}" font-size="${MATERIAL_TEXT_SIZE.tierLabel}" font-weight="600">${tierLabel}</text>
  ${tags.join("")}
  ${radarGrid}${radarAxes}<polygon points="${pointList(radarPoints)}" fill="url(#radar-fill)" stroke="${options.color}" stroke-width="4" stroke-linejoin="round"/>${radarDots}${radarLabels}${qr}
  <line x1="48" y1="505" x2="864" y2="505" stroke="${palette.grid}" stroke-opacity="0.62"/>${brandMark(48, 530, 28, palette.fg)}
  <text x="87" y="553" fill="${palette.fg}" font-size="${MATERIAL_TEXT_SIZE.brand}" font-weight="800">ghfind.com</text><text x="240" y="553" fill="${palette.subtle}" font-size="${MATERIAL_TEXT_SIZE.footer}">GitHub 开发者实力认证</text><text x="864" y="553" text-anchor="end" fill="${palette.subtle}" font-size="${MATERIAL_TEXT_SIZE.footer}">Powered by Lubehub, Dify and Mosoo.</text>
</svg>`;
}
