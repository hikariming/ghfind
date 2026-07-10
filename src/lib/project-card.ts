import type { ProjectListItem } from "@/lib/db";
import { projectRecommendationReason } from "@/lib/projects";

export function projectCardViewModel(project: ProjectListItem) {
  return {
    href: `/developers/repo/${project.repo.repo_key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    repoKey: project.repo.repo_key,
    title: project.repo.name_with_owner,
    description: project.repo.description,
    stars: project.repo.stars,
    language: project.repo.language,
    topics: project.repo.topics,
    contributorCount: project.contributorCount,
    avgScore: project.avgScore,
    momentum: project.momentum,
    qualityScore: project.qualityScore,
    reason: projectRecommendationReason(project),
    contributors: project.topContributors.map((contributor) => ({
      username: contributor.username,
      href: `/u/${contributor.username}`,
      score: contributor.final_score,
      tier: contributor.tier,
    })),
  };
}
