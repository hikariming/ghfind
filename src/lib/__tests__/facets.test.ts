import { describe, expect, it } from "vitest";
import { extractFacets } from "../facets";
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

const langs = (facets: ReturnType<typeof extractFacets>) =>
  facets.filter((f) => f.type === "language").map((f) => f.value);
const orgs = (facets: ReturnType<typeof extractFacets>) =>
  facets.filter((f) => f.type === "org").map((f) => f.value);
const repos = (facets: ReturnType<typeof extractFacets>) =>
  facets.filter((f) => f.type === "repo").map((f) => f.value);

describe("extractFacets — languages", () => {
  it("ranks primary languages by byte share", () => {
    const facets = extractFacets({
      top_repos: [
        repo({ languages: [{ name: "Rust", size: 80 }, { name: "Go", size: 20 }] }),
      ],
    });
    expect(langs(facets)).toEqual(["Rust", "Go"]);
  });

  it("drops markup/build noise (HTML, CSS, Makefile, …) before ranking", () => {
    const facets = extractFacets({
      top_repos: [
        repo({
          languages: [
            { name: "TypeScript", size: 50 },
            { name: "HTML", size: 30 },
            { name: "CSS", size: 20 },
          ],
        }),
      ],
    });
    expect(langs(facets)).toEqual(["TypeScript"]);
  });

  it("caps at three languages", () => {
    const facets = extractFacets({
      top_repos: [
        repo({
          languages: [
            { name: "A", size: 40 },
            { name: "B", size: 30 },
            { name: "C", size: 20 },
            { name: "D", size: 10 },
          ],
        }),
      ],
    });
    expect(langs(facets)).toHaveLength(3);
  });

  it("keeps the single top language even below the share threshold", () => {
    // Real code is a thin slice; everything else is excluded markup.
    const facets = extractFacets({
      top_repos: [
        repo({
          languages: [
            { name: "HTML", size: 900 },
            { name: "Python", size: 100 },
          ],
        }),
      ],
    });
    // HTML excluded → Python is the only real language, re-normalized to 100%.
    expect(langs(facets)).toEqual(["Python"]);
    expect(facets.find((f) => f.value === "Python")?.weight).toBe(100);
  });

  it("re-normalizes weights over kept languages", () => {
    const facets = extractFacets({
      top_repos: [
        repo({
          languages: [
            { name: "Go", size: 60 },
            { name: "HTML", size: 40 }, // excluded — must not dilute Go's weight
          ],
        }),
      ],
    });
    expect(facets.find((f) => f.value === "Go")?.weight).toBe(100);
  });

  it("returns no language facets when there is no real-code signal", () => {
    const facets = extractFacets({
      top_repos: [repo({ languages: [{ name: "CSS", size: 100 }] })],
    });
    expect(langs(facets)).toEqual([]);
  });
});

describe("extractFacets — orgs", () => {
  it("maps organizations to facets, deduped case-insensitively", () => {
    const facets = extractFacets({
      organizations: ["huggingface", "HuggingFace", "pytorch", "  "],
    });
    expect(orgs(facets)).toEqual(["huggingface", "pytorch"]);
    expect(facets.filter((f) => f.type === "org").every((f) => f.weight === 1)).toBe(true);
  });

  it("caps at five orgs", () => {
    const facets = extractFacets({
      organizations: ["a", "b", "c", "d", "e", "f", "g"],
    });
    expect(orgs(facets)).toHaveLength(5);
  });
});

describe("extractFacets — repos (projects)", () => {
  it("maps contributed-to projects to repo facets, ranked by stars when work ties", () => {
    const facets = extractFacets({
      impact_repos: [
        impact({ repo: "langgenius/dify", stars: 60000 }),
        impact({ repo: "rust-lang/rust", stars: 90000 }),
      ],
    });
    // Equal contribution volume — the busier project first.
    expect(repos(facets)).toEqual(["rust-lang/rust", "langgenius/dify"]);
    expect(facets.find((f) => f.value === "rust-lang/rust")?.weight).toBe(90000);
  });

  it("drops projects below the star floor", () => {
    const facets = extractFacets({
      impact_repos: [
        impact({ repo: "big/one", stars: 500 }),
        impact({ repo: "tiny/one", stars: 499 }),
      ],
    });
    expect(repos(facets)).toEqual(["big/one"]);
  });

  it("ignores malformed repo names (no owner/name slash)", () => {
    const facets = extractFacets({
      impact_repos: [impact({ repo: "not-a-full-name", stars: 9999 })],
    });
    expect(repos(facets)).toEqual([]);
  });

  it("dedupes the same project case-insensitively", () => {
    const facets = extractFacets({
      impact_repos: [
        impact({ repo: "vercel/next.js", stars: 100000 }),
        impact({ repo: "Vercel/Next.js", stars: 100000 }),
      ],
    });
    expect(repos(facets)).toEqual(["vercel/next.js"]);
  });

  it("ranks by the developer's own contribution before stars", () => {
    const facets = extractFacets({
      impact_repos: [
        impact({ repo: "famous/drive-by", stars: 90000, commits: 1, prs: 1 }),
        impact({ repo: "org/maintained", stars: 1200, commits: 387, prs: 89 }),
      ],
    });
    expect(repos(facets)).toEqual(["org/maintained", "famous/drive-by"]);
    expect(facets.find((f) => f.value === "org/maintained")?.weight).toBe(1200);
  });

  it("keeps a heavily-contributed project even when many famous repos compete", () => {
    const facets = extractFacets({
      impact_repos: [
        ...Array.from({ length: 25 }, (_, i) =>
          impact({ repo: `famous/r${i}`, stars: 50000 + i, commits: 2 }),
        ),
        impact({ repo: "org/maintained", stars: 1200, commits: 387, prs: 89 }),
      ],
    });
    expect(repos(facets)).toContain("org/maintained");
  });

  it("caps at twenty projects per developer", () => {
    const facets = extractFacets({
      impact_repos: Array.from({ length: 25 }, (_, i) =>
        impact({ repo: `o/r${i}`, stars: 1000 + i }),
      ),
    });
    expect(repos(facets)).toHaveLength(20);
  });
});

describe("extractFacets — combined", () => {
  it("returns [] for an empty snapshot", () => {
    expect(extractFacets({})).toEqual([]);
    expect(
      extractFacets({ top_repos: [], organizations: [], impact_repos: [] }),
    ).toEqual([]);
  });
});
