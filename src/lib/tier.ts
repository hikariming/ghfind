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
  /** Tailwind text color class (safelisted in globals.css @source inline). */
  text: string;
  /** Tailwind ring/border color class. */
  ring: string;
  /** Radial glow color (CSS). */
  glow: string;
  /**
   * Opaque accent for rings/borders via inline style (avoids Tailwind purge on
   * dynamic class names). Matches the score-number hue.
   */
  hex: string;
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
    ring: "ring-amber-500",
    bg: "bg-amber-400/20",
    glow: "rgba(251,191,36,0.65)",
  },
  顶级: {
    emoji: "🥇",
    icon: "medal",
    placements: ["bottom"],
    emojiSize: "large",
    ring: "ring-violet-500",
    bg: "bg-violet-400/20",
    glow: "rgba(167,139,250,0.55)",
  },
  人上人: {
    emoji: "👍",
    icon: "thumbs-up",
    placements: ["top-left", "top-right", "bottom-right", "bottom-left"],
    emojiSize: "normal",
    ring: "ring-emerald-500",
    bg: "bg-emerald-400/20",
    glow: "rgba(52,211,153,0.5)",
  },
  NPC: {
    emoji: "📜",
    icon: "smile",
    placements: ["bottom"],
    emojiSize: "normal",
    ring: "ring-sky-500",
    bg: "bg-sky-400/20",
    glow: "rgba(56,189,248,0.45)",
  },
  拉完了: {
    emoji: "🌱",
    icon: "smile",
    placements: ["bottom"],
    emojiSize: "normal",
    ring: "ring-zinc-500",
    bg: "bg-zinc-400/15",
    glow: "rgba(161,161,170,0.45)",
  },
};

export const TIER_STYLES: Record<Tier, TierStyle> = {
  夯: {
    tier: "夯",
    emoji: "🏆",
    text: "text-amber-300",
    ring: "ring-amber-400/50",
    glow: "rgba(251,191,36,0.35)",
    hex: "#fcd34d", // amber-300
    blurb: "封神 · 殿堂级标杆",
  },
  顶级: {
    tier: "顶级",
    emoji: "🥇",
    text: "text-violet-300",
    ring: "ring-violet-400/50",
    glow: "rgba(167,139,250,0.30)",
    hex: "#c4b5fd", // violet-300
    blurb: "顶级开发者 · 一线水准",
  },
  人上人: {
    tier: "人上人",
    emoji: "💪",
    text: "text-emerald-300",
    ring: "ring-emerald-400/50",
    glow: "rgba(52,211,153,0.30)",
    hex: "#6ee7b7", // emerald-300
    blurb: "优质贡献者 · 值得信任",
  },
  NPC: {
    tier: "NPC",
    emoji: "📜",
    text: "text-sky-300",
    ring: "ring-sky-400/50",
    glow: "rgba(56,189,248,0.28)",
    hex: "#7dd3fc", // sky-300 — distinct from newbie grey
    blurb: "稳步积累 · 继续打磨作品",
  },
  拉完了: {
    tier: "拉完了",
    emoji: "🌱",
    // Muted zinc — flattest tier; NPC stays sky so the two stay distinct.
    text: "text-zinc-400",
    ring: "ring-zinc-500/50",
    glow: "rgba(161,161,170,0.28)",
    hex: "#a1a1aa", // zinc-400
    blurb: "起步阶段 · 多练多攒作品",
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
