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

export type TierAvatarFramePlacement =
  | "top"
  | "top-right"
  | "right"
  | "bottom-right"
  | "bottom"
  | "bottom-left"
  | "left"
  | "top-left";

export type TierAvatarFrameEmojiSize = "normal" | "large";
export type TierAvatarFrameIcon = "crown" | "medal" | "thumbs-up" | "smile" | "poop";

export interface TierAvatarFrameVector {
  x: number;
  y: number;
}

const DIAGONAL_FRAME_VECTOR = Math.SQRT1_2;

/** Unit-circle vectors keep every decoration centered on the avatar ring. */
export const TIER_AVATAR_FRAME_VECTORS: Record<
  TierAvatarFramePlacement,
  TierAvatarFrameVector
> = {
  top: { x: 0, y: -1 },
  "top-right": { x: DIAGONAL_FRAME_VECTOR, y: -DIAGONAL_FRAME_VECTOR },
  right: { x: 1, y: 0 },
  "bottom-right": { x: DIAGONAL_FRAME_VECTOR, y: DIAGONAL_FRAME_VECTOR },
  bottom: { x: 0, y: 1 },
  "bottom-left": { x: -DIAGONAL_FRAME_VECTOR, y: DIAGONAL_FRAME_VECTOR },
  left: { x: -1, y: 0 },
  "top-left": { x: -DIAGONAL_FRAME_VECTOR, y: -DIAGONAL_FRAME_VECTOR },
};

export interface TierAvatarFrame {
  emoji: string;
  icon: TierAvatarFrameIcon;
  placements: TierAvatarFramePlacement[];
  emojiSize: TierAvatarFrameEmojiSize;
  /** Tailwind ring color class for the avatar shell. */
  ring: string;
  /** Tailwind background class for the inner avatar shell. */
  bg: string;
  /** CSS glow color used by inline shadow styles. */
  glow: string;
}

export const TIER_AVATAR_FRAMES: Record<Tier, TierAvatarFrame> = {
  夯: {
    emoji: "👑",
    icon: "crown",
    placements: ["top"],
    emojiSize: "large",
    ring: "ring-amber-300/70",
    bg: "bg-amber-400/10",
    glow: "rgba(251,191,36,0.65)",
  },
  顶级: {
    emoji: "🥇",
    icon: "medal",
    placements: ["bottom"],
    emojiSize: "large",
    ring: "ring-yellow-300/70",
    bg: "bg-yellow-300/10",
    glow: "rgba(250,204,21,0.55)",
  },
  人上人: {
    emoji: "👍",
    icon: "thumbs-up",
    placements: ["top-left", "top-right", "bottom-right", "bottom-left"],
    emojiSize: "normal",
    ring: "ring-emerald-300/70",
    bg: "bg-emerald-400/10",
    glow: "rgba(52,211,153,0.5)",
  },
  NPC: {
    emoji: "🙂",
    icon: "smile",
    placements: ["bottom"],
    emojiSize: "normal",
    ring: "ring-sky-300/70",
    bg: "bg-sky-400/10",
    glow: "rgba(56,189,248,0.45)",
  },
  拉完了: {
    emoji: "💩",
    icon: "poop",
    placements: [
      "top",
      "top-right",
      "right",
      "bottom-right",
      "bottom",
      "bottom-left",
      "left",
      "top-left",
    ],
    emojiSize: "normal",
    ring: "ring-rose-300/70",
    bg: "bg-rose-400/10",
    glow: "rgba(251,113,133,0.55)",
  },
};

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
    text: "text-sky-300",
    ring: "ring-sky-400/50",
    glow: "rgba(56,189,248,0.28)",
    blurb: "普通账号 · 特征平庸存疑",
  },
  拉完了: {
    tier: "拉完了",
    emoji: "💩",
    text: "text-rose-400",
    ring: "ring-rose-500/50",
    glow: "rgba(244,63,94,0.30)",
    blurb: "低价值 · 疑似刷量 / AI 机器人",
  },
};

export function tierStyle(tier: Tier): TierStyle {
  return TIER_STYLES[tier] ?? TIER_STYLES.NPC;
}

export function tierAvatarFrame(tier: Tier): TierAvatarFrame {
  return TIER_AVATAR_FRAMES[tier] ?? TIER_AVATAR_FRAMES.NPC;
}

export function tierAvatarFrameIconPath(icon: TierAvatarFrameIcon): string {
  return `/tier-emoji/${icon}.svg`;
}
