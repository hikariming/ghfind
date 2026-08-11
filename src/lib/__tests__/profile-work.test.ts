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

  it("shows independently proven organization maintenance without promoting it to own work", () => {
    const works = rankProfileWorks({
      username: "dev",
      signatureWork: {
        source: "recent_sample",
        impact_repo_representatives: [],
        work_clusters: [],
        organization_maintained_repos: [
          {
            repository: {
              name: "controller",
              name_with_owner: "org/controller",
              owner_login: "org",
              stars: 80,
              forks: 0,
              open_issues: 0,
              size: 1,
              language: "Go",
              description: "Organization controller",
              pushed_at: null,
            },
            commits: 80,
            prs: 12,
            active_years: 3,
            evidence: ["80 commits + 12 PRs across 3 years", "listed in maintainer/codeowner docs"],
          },
        ],
      },
    });

    expect(works).toEqual([
      expect.objectContaining({
        repo: "org/controller",
        source: "organization",
        language: "Go",
        commits: 80,
        prs: 12,
      }),
    ]);
  });
});
