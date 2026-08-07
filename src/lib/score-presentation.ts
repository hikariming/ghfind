import type { SubScoreKey, Tier } from "./types";

/** Max points per sub-dimension (sums to 100). Single source for normalization. */
export const SUBSCORE_MAX: Record<SubScoreKey, number> = {
  account_maturity: 10,
  original_project_quality: 18,
  contribution_quality: 27,
  ecosystem_impact: 20,
  community_influence: 8,
  activity_authenticity: 17,
};

/** Map a final score to its tier label. Shared by the scorer and presentation. */
export function tierFor(final: number): { tier: Tier; tier_label: string } {
  if (final >= 90) return { tier: "夯", tier_label: "封神 · 殿堂级标杆" };
  if (final >= 80) return { tier: "顶级", tier_label: "顶级开发者 · 一线水准" };
  if (final >= 70) return { tier: "人上人", tier_label: "优质贡献者 · 值得信任" };
  if (final >= 40) return { tier: "NPC", tier_label: "普通账号 · 特征平庸存疑" };
  return { tier: "拉完了", tier_label: "低价值 · 疑似刷量/AI 机器人" };
}

/** Ascending tier promotion thresholds, kept in sync with `tierFor`. */
const TIER_THRESHOLDS: { threshold: number; tier: Tier }[] = [
  { threshold: 40, tier: "NPC" },
  { threshold: 70, tier: "人上人" },
  { threshold: 80, tier: "顶级" },
  { threshold: 90, tier: "夯" },
];

/**
 * The next tier a score can be promoted into, and the score line to reach it.
 * Returns null once already in the top tier.
 */
export function nextTier(final: number): { threshold: number; tier: Tier } | null {
  return TIER_THRESHOLDS.find((t) => final < t.threshold) ?? null;
}
