import { describe, expect, it } from "vitest";
import { rankProfileWorks } from "../profile-work";

describe("rankProfileWorks", () => {
  it("prioritizes substantive signature work over star-only contribution targets", () => {
    const works = rankProfileWorks({
      username: "dev",
      topRepos: [
        {
          name: "own-popular",
          name_with_owner: "dev/own-popular",
          stars: 2000,
          forks: 0,
          open_issues: 0,
          size: 1,
          language: "TypeScript",
          description: "Own project",
          pushed_at: null,
        },
      ],
      impactRepos: [{ repo: "big/platform", stars: 150000, prs: 1, commits: 0 }],
      signatureWork: {
        source: "all_history_public_scan",
        impact_repo_representatives: [],
        work_clusters: [
          {
            repo: "big/control-plane",
            stars: 40,
            all_time_prs: 12,
            quality_keyword_hits: 10,
            examples: ["fix: tighten capability boundaries"],
            org_context_repo: "big/platform",
            org_context_stars: 150000,
            substantive_low_star_signal: true,
          },
        ],
      },
    });

    expect(works.map((work) => work.repo).slice(0, 3)).toEqual([
      "big/control-plane",
      "big/platform",
      "dev/own-popular",
    ]);
    expect(works[0]).toMatchObject({
      prs: 12,
      orgContextRepo: "big/platform",
      examples: ["fix: tighten capability boundaries"],
    });
  });

  it("falls back to full owner/repo names for own repositories", () => {
    const works = rankProfileWorks({
      username: "dev",
      pinnedRepos: ["dev/small-tool"],
      topRepos: [
        {
          name: "small-tool",
          stars: 1,
          forks: 0,
          open_issues: 0,
          size: 1,
          language: "Go",
          description: "Pinned utility",
          pushed_at: null,
        },
      ],
    });

    expect(works).toEqual([
      expect.objectContaining({
        repo: "dev/small-tool",
        source: "own",
        language: "Go",
      }),
    ]);
  });

  it("keeps collector-attributed organization flagships visible without changing scoring", () => {
    const works = rankProfileWorks({
      username: "dev",
      topRepos: [
        {
          name: "main-engine",
          name_with_owner: "org/main-engine",
          stars: 50,
          forks: 0,
          open_issues: 0,
          size: 1,
          language: "TypeScript",
          description: "Long-term maintained organization project",
          pushed_at: null,
          attributed_original: true,
        },
      ],
      impactRepos: [{ repo: "org/main-engine", stars: 50, prs: 18, commits: 75 }],
      signatureWork: {
        source: "all_history_public_scan",
        impact_repo_representatives: [],
        work_clusters: [
          {
            repo: "popular/one",
            stars: 200_000,
            all_time_prs: 80,
            quality_keyword_hits: 10,
            examples: ["feat: useful change"],
          },
          {
            repo: "popular/two",
            stars: 150_000,
            all_time_prs: 70,
            quality_keyword_hits: 10,
            examples: ["fix: important behavior"],
          },
          {
            repo: "popular/three",
            stars: 100_000,
            all_time_prs: 60,
            quality_keyword_hits: 10,
            examples: ["refactor: safety"],
          },
        ],
      },
    }, 3);

    expect(works.map((work) => work.repo)).toContain("org/main-engine");
    expect(works.find((work) => work.repo === "org/main-engine")).toMatchObject({
      source: "own",
      attributedOriginal: true,
      prs: 18,
      commits: 75,
    });
  });
});
