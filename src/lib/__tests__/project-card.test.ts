import { describe, expect, it } from "vitest";
import { projectCardViewModel } from "../project-card";
import type { ProjectListItem } from "../db";

const project: ProjectListItem = {
  repo: {
    repo_key: "acme/tool",
    name_with_owner: "Acme/Tool",
    owner_login: "acme",
    name: "Tool",
    description: "A useful toolkit",
    stars: 12_345,
    forks: 20,
    language: "TypeScript",
    topics: ["tooling", "developer-tools"],
  },
  contributorCount: 3,
  avgScore: 91.2,
  eliteCount: 2,
  momentum: 5,
  qualityScore: 182.4,
  topContributors: [
    {
      username: "alice",
      display_name: "Alice",
      avatar_url: null,
      final_score: 96,
      tier: "夯",
    },
  ],
};

describe("projectCardViewModel", () => {
  it("exposes a canonical route and the complete project summary", () => {
    expect(projectCardViewModel(project)).toEqual({
      href: "/developers/repo/acme/tool",
      repoKey: "acme/tool",
      title: "Acme/Tool",
      description: "A useful toolkit",
      stars: 12_345,
      language: "TypeScript",
      topics: ["tooling", "developer-tools"],
      contributorCount: 3,
      avgScore: 91.2,
      momentum: 5,
      qualityScore: 182.4,
      reason: "elite",
      contributors: [{ username: "alice", href: "/u/alice", score: 96, tier: "夯" }],
    });
  });

  it("keeps missing optional metadata absent instead of inventing it", () => {
    const model = projectCardViewModel({
      ...project,
      repo: { ...project.repo, description: null, language: null, topics: [] },
      topContributors: [],
    });
    expect(model.description).toBeNull();
    expect(model.language).toBeNull();
    expect(model.topics).toEqual([]);
    expect(model.contributors).toEqual([]);
  });
});
