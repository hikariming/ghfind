import "server-only";

import { getGoPublicData } from "@/lib/go-backend.server";
import type { ProjectSort } from "@/lib/projects";
import type { Tier } from "@/lib/types";

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
}) {
  const query = new URLSearchParams({
    sort: options.sort,
    limit: String(options.limit),
    offset: String(options.offset),
  });
  if (options.language) query.set("language", options.language);
  const data = await getGoPublicData<{ projects: GoProjectListItem[] }>(
    `/api/projects?${query.toString()}`,
  );
  return (data?.projects ?? []).map((project) => ({
    ...project,
    repo: { ...project.repo, topics: project.repo.topics ?? [] },
  }));
}

export function getGoProjectDetail(owner: string, repo: string) {
  return getGoPublicData<{ overview: GoProjectOverview; related: GoRelatedProject[] }>(
    `/api/projects/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
}
