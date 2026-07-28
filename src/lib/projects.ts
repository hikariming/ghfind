export type ProjectSort = "community" | "attention" | "stars";
export type ProjectReason = "elite" | "attention" | "community" | "popular";

export function communityStrengthScore(avgScore: number, contributorCount: number): number {
  if (!Number.isFinite(avgScore) || !Number.isFinite(contributorCount) || contributorCount <= 0) {
    return 0;
  }
  return avgScore * Math.log2(contributorCount + 1);
}

export function projectRecommendationReason(input: {
  eliteCount: number;
  contributorAttention: number;
  avgScore: number;
}): ProjectReason {
  if (input.eliteCount >= 2) return "elite";
  if (input.contributorAttention >= 10) return "attention";
  if (input.avgScore >= 85) return "community";
  return "popular";
}

export function parseProjectSort(value: unknown): ProjectSort {
  return value === "attention" || value === "stars" ? value : "community";
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

export function buildProjectListHref(options: {
  sort: ProjectSort;
  language: string | null;
  page: number;
}): string {
  const search = new URLSearchParams();
  if (options.sort !== "community") search.set("sort", options.sort);
  if (options.language) search.set("language", options.language);
  if (options.page > 1) search.set("page", String(options.page));
  const query = search.toString();
  return query ? `/projects?${query}` : "/projects";
}
