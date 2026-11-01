/**
 * Cultivation realms + Adventurer Level — DISPLAY ONLY.
 *
 * Derived from the numeric final_score. Does NOT change scoring, stored Tier
 * keys, DB rows, or SCORE/ROAST/COLLECTION versions. Import this module
 * everywhere user-facing copy/color needs a realm (web, OG/card, share,
 * leaderboard, PK, CLI display strings).
 */

import type { Tier } from "./types";

/** Stable i18n / CSS key per realm (`realms.<id>.name` / `.blurb`). */
export type RealmId =
  | "qi"
  | "foundation"
  | "goldenCore"
  | "nascentSoul"
  | "deity"
  | "voidRefining"
  | "integration"
  | "mahayana";

export type RealmGlyphKind = "dot" | "core" | "lotus" | "star";

export interface RealmColors {
  /** Dark-theme foreground (score / realm text). */
  fg: string;
  /** Light-theme foreground (WCAG AA on white). */
  fgLight: string;
  ring: string;
  glow: string;
  /** Optional multi-stop gradient for the level number (higher realms). */
  gradient?: string[];
}

export interface RealmDef {
  id: RealmId;
  /** Inclusive lower bound; next realm's min is exclusive upper (except mahayana ≤100). */
  minScore: number;
  /** Display rank 1..8 (练气=1 … 大乘=8). */
  rank: number;
  glyph: RealmGlyphKind;
  /** Soft outer glow / avatar effects. */
  effects: {
    softGlow: boolean;
    lightSweep: boolean;
    shimmer: boolean;
    doubleRing: boolean;
    aurora: boolean;
  };
  colors: RealmColors;
  /** Fallback zh blurb (messages JSON is authoritative in UI). */
  blurbZh: string;
  blurbEn: string;
  nameZh: string;
  /** Primary EN label (≤22 chars for OG/cards). */
  nameEn: string;
  /** Ultra-tight EN (badges / mini). */
  nameEnShort: string;
}

/**
 * Ascending thresholds. Boundary rule: score === min → that realm
 * (30.0 → 筑基, 90.0 → 大乘). 练气 is [0, 30).
 */
export const REALM_DEFS: readonly RealmDef[] = [
  {
    id: "qi",
    minScore: 0,
    rank: 1,
    glyph: "dot",
    effects: { softGlow: false, lightSweep: false, shimmer: false, doubleRing: false, aurora: false },
    colors: {
      fg: "#8B9099",
      fgLight: "#5A5F68",
      ring: "#6B7079",
      glow: "rgba(139,144,153,0.18)",
    },
    nameZh: "练气",
    nameEn: "Qi Condensation",
    nameEnShort: "Qi Cond.",
    blurbZh: "初入仙途 · 打牢根基",
    blurbEn: "First steps · Building the base",
  },
  {
    id: "foundation",
    minScore: 30,
    rank: 2,
    glyph: "dot",
    effects: { softGlow: false, lightSweep: false, shimmer: false, doubleRing: false, aurora: false },
    colors: {
      fg: "#B0565A",
      fgLight: "#8E3A3E",
      ring: "#8E4447",
      glow: "rgba(176,86,90,0.22)",
    },
    nameZh: "筑基",
    nameEn: "Foundation Est.",
    nameEnShort: "Foundation",
    blurbZh: "根基已成 · 稳步精进",
    blurbEn: "Foundation laid · Steady progress",
  },
  {
    id: "goldenCore",
    minScore: 40,
    rank: 3,
    glyph: "core",
    effects: { softGlow: false, lightSweep: false, shimmer: false, doubleRing: false, aurora: false },
    colors: {
      fg: "#C08457",
      fgLight: "#8F5A30",
      ring: "#A06B42",
      glow: "rgba(192,132,87,0.25)",
      gradient: ["#C99064", "#A9714A"],
    },
    nameZh: "金丹",
    nameEn: "Core Formation",
    nameEnShort: "Core Form.",
    blurbZh: "丹成一品 · 渐露锋芒",
    blurbEn: "Core formed · Showing an edge",
  },
  {
    id: "nascentSoul",
    minScore: 50,
    rank: 4,
    glyph: "core",
    effects: { softGlow: false, lightSweep: false, shimmer: false, doubleRing: false, aurora: false },
    colors: {
      fg: "#DCC88F",
      fgLight: "#8A7231",
      ring: "#C7B278",
      glow: "rgba(220,200,143,0.28)",
      gradient: ["#E6D6A6", "#C9B173"],
    },
    nameZh: "元婴",
    nameEn: "Nascent Soul",
    nameEnShort: "Nascent Soul",
    blurbZh: "元婴初成 · 自成一派",
    blurbEn: "Soul awakened · Own style",
  },
  {
    id: "deity",
    minScore: 60,
    rank: 5,
    glyph: "lotus",
    effects: { softGlow: false, lightSweep: false, shimmer: false, doubleRing: false, aurora: false },
    colors: {
      fg: "#6DB396",
      fgLight: "#2C7457",
      ring: "#4F9A7C",
      glow: "rgba(109,179,150,0.30)",
      gradient: ["#8CCAB0", "#4F9A7C"],
    },
    nameZh: "化神",
    nameEn: "Deity Transformation",
    nameEnShort: "Deity Trans.",
    blurbZh: "神识通达 · 影响一方",
    blurbEn: "Clear-minded · Real influence",
  },
  {
    id: "voidRefining",
    minScore: 70,
    rank: 6,
    glyph: "lotus",
    effects: { softGlow: true, lightSweep: false, shimmer: false, doubleRing: false, aurora: false },
    colors: {
      fg: "#4A9BE0",
      fgLight: "#1C64A3",
      ring: "#3A86C8",
      glow: "rgba(74,155,224,0.34)",
      gradient: ["#7DBBF0", "#2F78C0"],
    },
    nameZh: "炼虚",
    nameEn: "Spatial Tempering",
    nameEnShort: "Spatial Temp.",
    blurbZh: "返璞归真 · 举重若轻",
    blurbEn: "Effortless mastery",
  },
  {
    id: "integration",
    minScore: 80,
    rank: 7,
    glyph: "star",
    effects: { softGlow: true, lightSweep: true, shimmer: false, doubleRing: false, aurora: false },
    colors: {
      fg: "#A97CF5",
      fgLight: "#6F3FC4",
      ring: "#9566EA",
      glow: "rgba(169,124,245,0.40)",
      gradient: ["#CDB2FF", "#8B5CF0"],
    },
    nameZh: "合体",
    nameEn: "Body Integration",
    nameEnShort: "Body Integ.",
    blurbZh: "天人合一 · 一线宗师",
    blurbEn: "In harmony · Top-tier master",
  },
  {
    id: "mahayana",
    minScore: 90,
    rank: 8,
    glyph: "star",
    effects: { softGlow: true, lightSweep: false, shimmer: true, doubleRing: true, aurora: true },
    colors: {
      fg: "#F6C744",
      fgLight: "#A87700",
      ring: "#F2B91F",
      glow: "rgba(246,199,68,0.45)",
      gradient: ["#FFF0B8", "#F6C744", "#E0A010"],
    },
    nameZh: "大乘",
    nameEn: "Grand Ascension",
    nameEnShort: "Grand Asc.",
    blurbZh: "大道将成 · 殿堂标杆",
    blurbEn: "Near the summit · Hall of fame",
  },
] as const;

const BY_ID = Object.fromEntries(REALM_DEFS.map((r) => [r.id, r])) as Record<RealmId, RealmDef>;

/** Clamp floor(score) into Lv.1 … Lv.100. */
export function adventurerLevel(score: number): number {
  if (!Number.isFinite(score)) return 1;
  return Math.min(100, Math.max(1, Math.floor(score)));
}

/** Format as `Lv.97` (always with the Lv. prefix). */
export function formatAdventurerLevel(score: number): string {
  return `Lv.${adventurerLevel(score)}`;
}

/** Resolve realm from numeric score. Exact boundary mins belong to that realm. */
export function realmForScore(score: number): RealmDef {
  const s = Number.isFinite(score) ? score : 0;
  let current = REALM_DEFS[0]!;
  for (const r of REALM_DEFS) {
    if (s >= r.minScore) current = r;
  }
  return current;
}

export function realmById(id: RealmId): RealmDef {
  return BY_ID[id] ?? REALM_DEFS[0]!;
}

/**
 * Approximate realm when only a stored Tier is available (no score).
 * Prefer {@link realmForScore} whenever a numeric score exists.
 */
export function realmForTier(tier: Tier): RealmDef {
  switch (tier) {
    case "夯":
      return BY_ID.mahayana;
    case "顶级":
      return BY_ID.integration;
    case "人上人":
      return BY_ID.voidRefining;
    case "NPC":
      return BY_ID.goldenCore;
    case "拉完了":
    default:
      return BY_ID.qi;
  }
}

/** Next realm promotion line, or null at 大乘. */
export function nextRealm(score: number): { threshold: number; realm: RealmDef } | null {
  const current = realmForScore(score);
  const idx = REALM_DEFS.findIndex((r) => r.id === current.id);
  const nxt = REALM_DEFS[idx + 1];
  if (!nxt) return null;
  return { threshold: nxt.minScore, realm: nxt };
}

/** CSS custom-property bag for inline style / data-realm attribute consumers. */
/** Sets dark/light/glow/ring(/grad). `--realm-fg` is resolved by CSS from data-theme. */
export function realmCssVars(realm: RealmDef, _theme: "dark" | "light" = "dark"): Record<string, string> {
  const vars: Record<string, string> = {
    "--realm-fg-dark": realm.colors.fg,
    "--realm-fg-light": realm.colors.fgLight,
    "--realm-glow": realm.colors.glow,
    "--realm-ring": realm.colors.ring,
  };
  if (realm.colors.gradient && realm.colors.gradient.length >= 2) {
    vars["--realm-grad"] = `linear-gradient(135deg, ${realm.colors.gradient.join(", ")})`;
  }
  return vars;
}

/** Gradient (or solid) text fill for the big Lv number. */
export function realmNumberStyle(
  realm: RealmDef,
  theme: "dark" | "light" = "dark",
): Record<string, string> {
  const fg = theme === "light" ? realm.colors.fgLight : realm.colors.fg;
  const g = realm.colors.gradient;
  if (g && g.length >= 2 && theme === "dark") {
    return {
      backgroundImage: `linear-gradient(135deg, ${g.join(", ")})`,
      WebkitBackgroundClip: "text",
      backgroundClip: "text",
      color: "transparent",
      WebkitTextFillColor: "transparent",
    };
  }
  return { color: fg };
}

/** Tooltip / title for the precise composite score (hidden from primary UI). */
export function preciseScoreTitle(score: number, lang: "zh" | "en" = "zh"): string {
  const n = Number.isFinite(score) ? score.toFixed(2) : "0.00";
  return lang === "zh" ? `综合分 ${n}` : `Composite ${n}`;
}

/**
 * Remap a roast markdown H2 header line:
 *   `## user — 82.90/100 · 顶级` → `## user — Lv.82 · 合体`
 * Leaves body text untouched. Used by the display-layer remap (no cache bump).
 */
export function remapRoastHeaderLine(md: string, score: number, realmName: string): string {
  const lv = formatAdventurerLevel(score);
  return md.replace(
    /^(\s*#{1,6}\s+\S.*?)\s*[—–-]\s*\d+(?:\.\d+)?\s*\/\s*100\s*[·•|]\s*.+$/m,
    `$1 — ${lv} · ${realmName}`,
  );
}

/** Old display names that must never appear in user-facing tier/realm copy. */
export const BANNED_REALM_DISPLAY_TERMS: readonly string[] = [
  "拉完了",
  "新手村",
  "学徒",
  "成长中",
  "探索者",
  "普通账号",
  "特征平庸",
  "平庸存疑",
  "人上人",
  "顶级",
  "夯",
  "封神",
  "TRASH",
  "Trash",
  "NEWBIE",
  "Newbie",
  "APPRENTICE",
  "Apprentice",
  "Rising",
  "RISING",
  "GOD",
  "ELITE",
  "SOLID",
  "NPC",
  "强者",
  "💩",
  "🌱",
  "📜",
  "🫥",
  "🧭",
  "🏆",
  "🥇",
];
