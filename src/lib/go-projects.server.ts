import "server-only";

import { getRepoOverview } from "@/lib/db";
import { getProjectsCached, getRelatedProjectsCached } from "@/lib/project-discovery";
import type { ProjectSort } from "@/lib/projects";
import type { Tier } from "@/lib/types";

// Local port of the Go backend's /api/projects* presentation models
// (internal/backend/projects.go). The Go* names and shapes are the frozen
// public contract the pages/components were built against; the data now comes
// from the Redis-cached Turso readers instead of a Railway fetch.

export interface GoProjectRepo {
  repo_key: string;
  name_with_owner: string;
  owner_login: string;
  name: string;
  description: string | null;
  stars: number;
  forks: number | null;
  language: string | null;
  topics: string[];
}

export interface GoProjectOwner {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  final_score: number;
  tier: Tier;
}

export interface GoProjectListItem {
  repo: GoProjectRepo;
  contributorCount: number;
  avgScore: number;
  eliteCount: number;
  momentum: number;
  qualityScore: number;
  topContributors: GoProjectOwner[];
}

export interface GoRelatedProject {
  project: GoProjectListItem;
  sharedContributorCount: number;
}

export interface GoProjectOverview {
  repo: GoProjectRepo;
  owner: GoProjectOwner | null;
  summary: {
    count: number;
    avgScore: number;
    tierCounts: { tier: Tier; count: number }[];
  };
}

export async function getGoProjects(options: {
  sort: ProjectSort;
  language: string | null;
  limit: number;
  offset: number;
  /** Inert since the Railway fetch was repatriated: the Redis-cached DB read is
   * already safe inside static prerenders. Kept so callers compile unchanged. */
  revalidate?: number;
}): Promise<GoProjectListItem[]> {
  // Never throws: the discovery cache layer degrades to [] on DB failure,
  // matching the old null-response → [] behavior.
  return getProjectsCached({
    sort: options.sort,
    language: options.language,
    limit: options.limit,
    offset: options.offset,
  });
}

export async function getGoProjectDetail(
  owner: string,
  repo: string,
): Promise<{ overview: GoProjectOverview; related: GoRelatedProject[] } | null> {
  const key = `${owner}/${repo}`.toLowerCase();
  // Null covers both "repo not in the graph" (Go's 404) and a DB failure
  // (Go's 503) — the same null the fetch wrapper produced for either.
  const overview = await getRepoOverview(key);
  if (!overview) return null;
  const related = await getRelatedProjectsCached(key, 6);
  return { overview, related };
}
