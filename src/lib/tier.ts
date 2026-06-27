import type { Tier } from "./types";

/** Stable, language-neutral slug per tier — used as the i18n message key
 * (`tiers.<slug>.name` / `.blurb`) so JSON never needs CJK object keys. The
 * stored/canonical tier value itself stays Chinese (see {@link Tier}). */
export type TierKey = "god" | "elite" | "solid" | "npc" | "trash";

export const TIER_KEY: Record<Tier, TierKey> = {
  夯: "god",
  顶级: "elite",
  人上人: "solid",
  NPC: "npc",
  拉完了: "trash",
};

export interface TierStyle {
  tier: Tier;
  emoji: string;
  /** Tailwind text color class. */
  text: string;
  /** Tailwind ring/border color class. */
  ring: string;
  /** Radial glow color (CSS). */
  glow: string;
  blurb: string;
}

export const TIER_STYLES: Record<Tier, TierStyle> = {
  夯: {
    tier: "夯",
    emoji: "🏆",
    text: "text-amber-300",
    ring: "ring-amber-400/50",
    glow: "rgba(251,191,36,0.35)",
    blurb: "封神 · 殿堂级标杆",
  },
  顶级: {
    tier: "顶级",
    emoji: "🥇",
    text: "text-violet-300",
    ring: "ring-violet-400/50",
    glow: "rgba(167,139,250,0.30)",
    blurb: "顶级开发者 · 一线水准",
  },
  人上人: {
    tier: "人上人",
    emoji: "💪",
    text: "text-emerald-300",
    ring: "ring-emerald-400/50",
    glow: "rgba(52,211,153,0.30)",
    blurb: "优质贡献者 · 值得信任",
  },
  NPC: {
    tier: "NPC",
    emoji: "🫥",
    text: "text-slate-300",
    ring: "ring-slate-400/40",
    glow: "rgba(148,163,184,0.25)",
    blurb: "普通账号 · 特征平庸存疑",
  },
  拉完了: {
    tier: "拉完了",
    emoji: "💀",
    text: "text-rose-400",
    ring: "ring-rose-500/50",
    glow: "rgba(244,63,94,0.30)",
    blurb: "低价值 · 疑似刷量 / AI 机器人",
  },
};

export function tierStyle(tier: Tier): TierStyle {
  return TIER_STYLES[tier] ?? TIER_STYLES.NPC;
}
