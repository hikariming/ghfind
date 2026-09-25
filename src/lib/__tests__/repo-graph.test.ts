import { describe, expect, it } from "vitest";
import { extractFacets } from "../facets";
import { extractRepoGraph } from "../repo-graph";
import type { ImpactRepo, TopRepo } from "../types";

function repo(partial: Partial<TopRepo>): TopRepo {
  return {
    name: "r",
    stars: 0,
    forks: 0,
    open_issues: 0,
    size: 0,
    language: null,
    description: null,
    pushed_at: null,
    ...partial,
  };
}

function impact(partial: Partial<ImpactRepo>): ImpactRepo {
  return { repo: "owner/name", stars: 0, commits: 0, prs: 0, ...partial };
}

const keys = (g: ReturnType<typeof extractRepoGraph>) => g.repos.map((r) => r.repo_key).sort();
const link = (g: ReturnType<typeof extractRepoGraph>, key: string) =>
  g.links.find((l) => l.repo_key === key);

describe("extractRepoGraph — owner nodes", () => {
  it("promotes the dev's own notable repos to owner links", () => {
    const g = extractRepoGraph({
      top_repos: [repo({ name: "cool", name_with_owner: "Alice/Cool", stars: 1200, language: "Rust" })],
    });
    expect(keys(g)).toEqual(["alice/cool"]);
    const node = g.repos[0];
    expect(node.name_with_owner).toBe("Alice/Cool");
    expect(node.owner_login).toBe("alice");
    expect(node.language).toBe("Rust");
    expect(link(g, "alice/cool")).toMatchObject({ relation: "owner", weight: 1200 });
  });

  it("drops owned repos below the star floor", () => {
    const g = extractRepoGraph({
      top_repos: [repo({ name_with_owner: "a/tiny", stars: 10 })],
    });
    expect(g.repos).toHaveLength(0);
    expect(g.links).toHaveLength(0);
  });

  it("derives name_with_owner from owner_login when absent", () => {
    const g = extractRepoGraph({
      top_repos: [repo({ name: "proj", owner_login: "Bob", stars: 500 })],
    });
    expect(keys(g)).toEqual(["bob/proj"]);
  });

  it("skips repos with no owner and no name_with_owner (unstable key)", () => {
    const g = extractRepoGraph({ top_repos: [repo({ name: "orphan", stars: 500 })] });
    expect(g.repos).toHaveLength(0);
  });
});

describe("extractRepoGraph — contributor nodes", () => {
  it("promotes contributed OSS above the star floor to contributor links", () => {
    const g = extractRepoGraph({
      impact_repos: [impact({ repo: "langgenius/dify", stars: 40000, commits: 12, prs: 3 })],
    });
    expect(keys(g)).toEqual(["langgenius/dify"]);
    expect(link(g, "langgenius/dify")).toMatchObject({
      relation: "contributor",
      commits: 12,
      prs: 3,
      weight: 15,
    });
  });

  it("drops contributed repos below the 500-star floor (matches repo facet)", () => {
    const g = extractRepoGraph({
      impact_repos: [impact({ repo: "small/lib", stars: 200 })],
    });
    expect(g.repos).toHaveLength(0);
  });
});

describe("extractRepoGraph — owner wins over contributor", () => {
  it("keeps a single owner link when a repo appears on both sides", () => {
    const g = extractRepoGraph({
      top_repos: [repo({ name_with_owner: "Alice/Cool", stars: 1200, language: "Go" })],
      impact_repos: [impact({ repo: "alice/cool", stars: 1200, commits: 5, prs: 2 })],
    });
    expect(keys(g)).toEqual(["alice/cool"]);
    const l = link(g, "alice/cool");
    expect(l?.relation).toBe("owner");
    // Owner node's rich metadata is kept, not the contributor node's null.
    expect(g.repos[0].language).toBe("Go");
  });
});

describe("extractRepoGraph — bounds", () => {
  it("caps contributor repos per developer", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      impact({ repo: `org/proj${i}`, stars: 1000 + i }),
    );
    const g = extractRepoGraph({ impact_repos: many });
    expect(g.repos.length).toBeLessThanOrEqual(20);
  });

  it("keeps the same contributed repos as the repo facets (contribution first)", () => {
    const many = [
      ...Array.from({ length: 25 }, (_, i) =>
        impact({ repo: `famous/r${i}`, stars: 50000 + i, commits: 2 }),
      ),
      impact({ repo: "org/maintained", stars: 1200, commits: 387, prs: 89 }),
    ];
    const g = extractRepoGraph({ impact_repos: many });
    expect(g.links[0]).toMatchObject({ repo_key: "org/maintained", relation: "contributor" });
    const facetRepos = extractFacets({ impact_repos: many })
      .filter((f) => f.type === "repo")
      .map((f) => f.value.toLowerCase());
    expect(g.links.map((l) => l.repo_key)).toEqual(facetRepos);
  });

  it("returns an empty graph for no repo signal", () => {
    expect(extractRepoGraph({})).toEqual({ repos: [], links: [] });
  });
});
