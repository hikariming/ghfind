import type { ImpactRepo, SignatureWork, TopRepo } from "./types";

export type ProfileWorkSource = "signature" | "impact" | "own";

export interface ProfileWorkItem {
  repo: string;
  name: string;
  stars: number;
  source: ProfileWorkSource;
  score: number;
  prs?: number;
  commits?: number;
  language?: string | null;
  description?: string | null;
  examples?: string[];
  orgContextRepo?: string;
}

export interface ProfileWorkInput {
  username: string;
  topRepos?: TopRepo[] | null;
  impactRepos?: ImpactRepo[] | null;
  pinnedRepos?: string[] | null;
  signatureWork?: SignatureWork | null;
}

const MAX_EXAMPLES = 2;

function repoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

function repoName(repo: string): string {
  return repo.split("/").pop() || repo;
}

function topRepoFullName(username: string, repo: TopRepo): string {
  return repo.name_with_owner ?? `${repo.owner_login ?? username}/${repo.name}`;
}

function starScore(stars: number): number {
  return Math.log10(Math.max(0, stars) + 10) * 3;
}

function mergeWork(
  works: Map<string, ProfileWorkItem>,
  item: ProfileWorkItem,
) {
  const key = repoKey(item.repo);
  const prev = works.get(key);
  if (!prev || item.score > prev.score) {
    works.set(key, {
      ...prev,
      ...item,
      prs: Math.max(prev?.prs ?? 0, item.prs ?? 0) || undefined,
      commits: Math.max(prev?.commits ?? 0, item.commits ?? 0) || undefined,
      examples: [...(item.examples ?? prev?.examples ?? [])].slice(0, MAX_EXAMPLES),
    });
    return;
  }
  works.set(key, {
    ...prev,
    prs: Math.max(prev.prs ?? 0, item.prs ?? 0) || undefined,
    commits: Math.max(prev.commits ?? 0, item.commits ?? 0) || undefined,
    examples: [...(prev.examples ?? []), ...(item.examples ?? [])].slice(0, MAX_EXAMPLES),
    orgContextRepo: prev.orgContextRepo ?? item.orgContextRepo,
  });
}

export function rankProfileWorks(input: ProfileWorkInput, limit = 6): ProfileWorkItem[] {
  const works = new Map<string, ProfileWorkItem>();
  const pinned = new Set(
    (input.pinnedRepos ?? [])
      .map((repo) => repo.split("/").pop()?.toLowerCase())
      .filter((name): name is string => Boolean(name)),
  );

  for (const cluster of input.signatureWork?.work_clusters ?? []) {
    const prs = cluster.all_time_prs ?? cluster.recent_merged_prs_in_sample ?? 0;
    const quality = cluster.quality_keyword_hits ?? 0;
    const score =
      26 +
      Math.log1p(prs * 2) * 14 +
      Math.log1p(quality) * 8 +
      (cluster.org_context_repo ? 14 : 0) +
      (cluster.substantive_low_star_signal ? 10 : 0) +
      starScore(cluster.stars);

    mergeWork(works, {
      repo: cluster.repo,
      name: repoName(cluster.repo),
      stars: cluster.stars,
      source: "signature",
      score,
      prs: prs || undefined,
      examples: cluster.examples?.slice(0, MAX_EXAMPLES),
      orgContextRepo: cluster.org_context_repo,
    });
  }

  for (const repo of input.signatureWork?.impact_repo_representatives ?? []) {
    const workUnits = repo.prs * 2 + repo.commits;
    mergeWork(works, {
      repo: repo.repo,
      name: repoName(repo.repo),
      stars: repo.stars,
      source: "impact",
      score: 18 + Math.log1p(workUnits) * 12 + starScore(repo.stars),
      prs: repo.prs || undefined,
      commits: repo.commits || undefined,
    });
  }

  for (const repo of input.impactRepos ?? []) {
    const workUnits = repo.prs * 2 + repo.commits;
    mergeWork(works, {
      repo: repo.repo,
      name: repoName(repo.repo),
      stars: repo.stars,
      source: "impact",
      score: 12 + Math.log1p(workUnits) * 10 + starScore(repo.stars),
      prs: repo.prs || undefined,
      commits: repo.commits || undefined,
    });
  }

  for (const repo of input.topRepos ?? []) {
    const fullName = topRepoFullName(input.username, repo);
    const isPinned = pinned.has(repo.name.toLowerCase());
    mergeWork(works, {
      repo: fullName,
      name: repo.name,
      stars: repo.stars,
      source: "own",
      score: (isPinned ? 8 : 0) + Math.log10(Math.max(0, repo.stars) + 10) * 5,
      language: repo.language,
      description: repo.description,
    });
  }

  return [...works.values()]
    .sort((a, b) => b.score - a.score || b.stars - a.stars || a.repo.localeCompare(b.repo))
    .slice(0, limit);
}
