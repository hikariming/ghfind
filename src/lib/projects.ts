export type ProjectSort = "quality" | "momentum" | "stars";
export type ProjectReason = "elite" | "momentum" | "quality" | "popular";

export function projectQualityScore(avgScore: number, contributorCount: number): number {
  if (!Number.isFinite(avgScore) || !Number.isFinite(contributorCount) || contributorCount <= 0) {
    return 0;
  }
  return avgScore * Math.log2(contributorCount + 1);
}

export function projectRecommendationReason(input: {
  eliteCount: number;
  momentum: number;
  avgScore: number;
}): ProjectReason {
  if (input.eliteCount >= 2) return "elite";
  if (input.momentum >= 10) return "momentum";
  if (input.avgScore >= 85) return "quality";
  return "popular";
}

export function parseProjectSort(value: unknown): ProjectSort {
  return value === "momentum" || value === "stars" ? value : "quality";
}

export function parseProjectPage(value: unknown): number {
  const scalar = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(scalar ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

export function normalizeProjectLanguage(value: unknown): string | null {
  const scalar = Array.isArray(value) ? value[0] : value;
  if (typeof scalar !== "string") return null;
  const normalized = scalar.trim();
  return normalized || null;
}
