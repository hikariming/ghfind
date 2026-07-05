import { describe, expect, it } from "vitest";
import {
  bestOriginalRepoQuality,
  computeClosedPrBreakdown,
  computeFloodSignals,
  computeImpactFromContribMap,
  computeImpactQualitySignals,
  computeOrgRepoAttribution,
  isDocLikeImpactPr,
  isEcosystemImpactPr,
  isExternalTrivialFarmPr,
  originalRepoQualityScore,
  parseReadmeFeatures,
  topStarredOriginalRepoQuality,
  type ContribRepoAgg,
} from "../github";
import {
  authorSelfClosedExternalPenalty,
  contributionQualityCap,
  docLikePrVolumeDiscount,
  highImpactCorePrBonus,
  lowPrestigeBulkContributionCap,
  logRatio,
  score,
  spamBotScore,
  tierFor,
} from "../score";
import type { RawMetrics, RecentPr, TopRepo } from "../types";
import fixtures from "./score-fixtures.json";

const pr = (over: Partial<RecentPr>): RecentPr => ({
  title: "x",
  repo: "owner/repo",
  repo_stars: 0,
  churn: 100,
  changed_files: 3,
  trivial: false,
  ...over,
});

/** A neutral, established account that trips no red flags — override per test. */
const NEUTRAL: RawMetrics = {
  username: "x",
  profile_url: null,
  avatar_url: null,
  name: "X",
  bio: "dev",
  company: null,
  account_age_years: 5,
  created_at: "2019-01-01T00:00:00Z",
  followers: 50,
  following: 30,
  public_repos: 20,
  fetched_repo_count: 20,
  original_repo_count: 10,
  nonempty_original_repo_count: 5,
  fork_repo_count: 2,
  empty_original_repo_count: 0,
  total_stars: 100,
  max_stars: 50,
  merged_pr_count: 30,
  total_pr_count: 35,
  issues_created: 10,
  last_year_contributions: 500,
  activity_type_count: 3,
  contribution_years_active: 3,
  days_since_last_activity: 30,
  recent_merged_pr_sample: 20,
  recent_trivial_pr_count: 2,
  external_trivial_pr_count: 0,
  max_impact_repo_stars: 0,
  impact_pr_count: 0,
  impact_depth_raw: 0,
  star_inflation_suspect: false,
  closed_unmerged_pr_count: 2,
  pr_rejection_rate: 0.06,
  recent_pr_sample: 20,
  top_repo_pr_target: "a/b",
  top_repo_pr_share: 0.3,
  templated_pr_ratio: 0.2,
  pr_flood_suspect: false,
};

const hasFlag = (m: RawMetrics, name: string) =>
  score(m).red_flags.some((f) => f.flag === name);

const closedPr = ({
  actor,
  author = "alice",
  owner = "someone",
}: {
  actor?: string | null;
  author?: string;
  owner?: string;
}) => ({
  author: { login: author },
  repository: { owner: { login: owner } },
  timelineItems: {
    nodes: actor === undefined ? [] : [{ actor: actor ? { login: actor } : null }],
  },
});

const repo = (over: Partial<TopRepo>): TopRepo => ({
  name: "project",
  stars: 0,
  forks: 0,
  open_issues: 0,
  size: 100,
  language: "TypeScript",
  description: "A complete useful project",
  pushed_at: "2026-06-01T00:00:00Z",
  readme_excerpt:
    "Install the service, configure usage examples, run the test suite, explore the API, deploy it, review architecture decisions, and inspect screenshots for the complete workflow.",
  ...over,
});

const contribRepo = (over: Partial<ContribRepoAgg>): ContribRepoAgg => ({
  repo: "org/main-engine",
  stars: 10000,
  is_private: false,
  is_fork: false,
  owner_login: "org",
  commits: 80,
  prs: 12,
  active_years: 3,
  ...over,
});

describe("spam-PR red flags", () => {
  it("does not fire on a neutral account", () => {
    expect(score(NEUTRAL).red_flags).toHaveLength(0);
  });

  it("flags templated_pr_flooding and scales the penalty 12→30 by severity", () => {
    const mk = (share: number, templated: number): RawMetrics => ({
      ...NEUTRAL,
      pr_flood_suspect: true,
      recent_pr_sample: 18,
      top_repo_pr_target: "org/target",
      top_repo_pr_share: share,
      templated_pr_ratio: templated,
    });
    const pen = (m: RawMetrics) =>
      score(m).red_flags.find((f) => f.flag === "templated_pr_flooding")?.penalty;
    expect(pen(mk(0.5, 0.5))).toBe(12); // just-suspect → min
    expect(pen(mk(1.0, 1.0))).toBe(30); // egregious one-repo bot → max
    const cq = pen(mk(1.0, 0.67))!; // all PRs to one repo, 67% templated
    expect(cq).toBeGreaterThanOrEqual(20);
    expect(cq).toBeLessThanOrEqual(26);
  });

  it("flags high_pr_rejection when most decided PRs were rejected", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 5,
      closed_unmerged_pr_count: 20,
      maintainer_closed_unmerged_pr_count: 20,
      pr_rejection_rate: 0.8,
    };
    const flag = score(m).red_flags.find((f) => f.flag === "high_pr_rejection");
    expect(flag).toBeTruthy();
    expect(flag?.penalty).toBe(10); // >0.7 → 10
  });

  it("does not flag rejection below the threshold or with too few PRs", () => {
    expect(hasFlag({ ...NEUTRAL, pr_rejection_rate: 0.4 }, "high_pr_rejection")).toBe(false);
    expect(
      hasFlag(
        { ...NEUTRAL, merged_pr_count: 3, closed_unmerged_pr_count: 4, pr_rejection_rate: 0.57 },
        "high_pr_rejection",
      ),
    ).toBe(false); // decided 7 < 10
  });

  it("does not treat self-closed own-repo PRs as rejection or acceptance misses", () => {
    const base = score({ ...NEUTRAL, merged_pr_count: 10, total_pr_count: 20 });
    const withSelfClosedOwn = score({
      ...NEUTRAL,
      merged_pr_count: 10,
      total_pr_count: 20,
      closed_unmerged_pr_count: 10,
      maintainer_closed_unmerged_pr_count: 0,
      self_closed_own_repo_pr_count: 10,
      pr_rejection_rate: 0,
    });
    expect(withSelfClosedOwn.red_flags.some((f) => f.flag === "high_pr_rejection")).toBe(false);
    expect(withSelfClosedOwn.sub_scores.contribution_quality).toBeGreaterThan(
      base.sub_scores.contribution_quality,
    );
  });

  it("does not treat normal author-closed external PRs as acceptance misses", () => {
    const base = score({
      ...NEUTRAL,
      merged_pr_count: 20,
      total_pr_count: 25,
      closed_unmerged_pr_count: 5,
      maintainer_closed_unmerged_pr_count: 0,
      self_closed_external_pr_count: 5,
      self_closed_own_repo_pr_count: 0,
      pr_rejection_rate: 0,
    });
    const withoutSelfClosedExternal = score({
      ...NEUTRAL,
      merged_pr_count: 20,
      total_pr_count: 20,
      closed_unmerged_pr_count: 0,
      maintainer_closed_unmerged_pr_count: 0,
      self_closed_external_pr_count: 0,
      self_closed_own_repo_pr_count: 0,
      pr_rejection_rate: 0,
    });

    expect(base.red_flags.some((f) => f.flag === "high_pr_rejection")).toBe(false);
    expect(base.sub_scores.contribution_quality).toBe(
      withoutSelfClosedExternal.sub_scores.contribution_quality,
    );
  });

  it("ignores even large author-closed external PR patterns for scoring", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 20,
      total_pr_count: 50,
      closed_unmerged_pr_count: 30,
      maintainer_closed_unmerged_pr_count: 0,
      self_closed_external_pr_count: 30,
      self_closed_own_repo_pr_count: 0,
      pr_rejection_rate: 0,
    };
    expect(authorSelfClosedExternalPenalty(m)).toBe(0);
    expect(score(m).sub_scores.contribution_quality).toBe(
      score({ ...m, self_closed_external_pr_count: 0 }).sub_scores.contribution_quality,
    );
  });

  it("flags trivial_pr_farming for garbage PRs into popular external repos", () => {
    const m: RawMetrics = { ...NEUTRAL, recent_merged_pr_sample: 18, external_trivial_pr_count: 12 };
    expect(hasFlag(m, "trivial_pr_farming")).toBe(true);
  });

  it("does NOT flag a heavy self-PR dev (no external garbage)", () => {
    // Solo-dev-like: lots of own-repo PRs, zero external-trivial → no spam flags.
    const m: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 30,
      recent_merged_pr_sample: 20,
      external_trivial_pr_count: 0,
    };
    expect(score(m).red_flags).toHaveLength(0);
  });
});

describe("spamBotScore (hidden 0-10 farming/bot likelihood)", () => {
  it("is ~0 for a clean account", () => {
    expect(spamBotScore(NEUTRAL)).toBeLessThanOrEqual(0.5);
  });

  it("stays ~0 for a genuine solo dev (all PRs into own repo — never penalized)", () => {
    // Real engineering on own 0-star project. No external garbage,
    // no flood → bot_score ≈ 0 regardless of how many self-PRs.
    const m: RawMetrics = {
      ...NEUTRAL,
      recent_merged_pr_sample: 20,
      recent_trivial_pr_count: 1,
      external_trivial_pr_count: 0,
      total_stars: 0,
      max_stars: 0,
    };
    expect(spamBotScore(m)).toBeLessThanOrEqual(0.5);
  });

  it("is HIGH for garbage PRs into popular external repos (Hacktoberfest farming)", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      recent_merged_pr_sample: 17,
      external_trivial_pr_count: 14, // mostly typo PRs into others' famous repos
    };
    expect(spamBotScore(m)).toBeGreaterThanOrEqual(3);
  });

  it("is HIGH for templated PR flooding of an external repo", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      pr_flood_suspect: true,
      recent_pr_sample: 30,
      top_repo_pr_share: 1,
      templated_pr_ratio: 0.67,
    };
    expect(spamBotScore(m)).toBeGreaterThanOrEqual(5);
  });

  it("caps at 10 for an everything-bot", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      pr_flood_suspect: true,
      recent_pr_sample: 30,
      top_repo_pr_share: 1,
      templated_pr_ratio: 1,
      recent_merged_pr_sample: 20,
      external_trivial_pr_count: 20,
      following: 5000,
      followers: 10,
    };
    expect(spamBotScore(m)).toBe(10);
  });
});

describe("computeFloodSignals", () => {
  it("flags a one-repo templated burst", () => {
    const titles = [
      ...Array.from({ length: 15 }, (_, i) => `refactor(api): migrate ${i} endpoints to BaseModel`),
      "refactor(api): remove legacy field compatibility",
      "refactor(api): remove member field compatibility",
      "chore: rehearse ordered BaseModel migration merge",
    ];
    const prs = titles.map((title) => ({ title, repo: "org/target" }));
    const s = computeFloodSignals(prs);
    expect(s.pr_flood_suspect).toBe(true);
    expect(s.top_repo_pr_target).toBe("org/target");
    expect(s.top_repo_pr_share).toBe(1);
    expect(s.templated_pr_ratio).toBeGreaterThanOrEqual(0.5);
    expect(s.flood_pr_titles.length).toBeGreaterThan(0);
  });

  it("does not flag varied PRs across many repos", () => {
    const prs = [
      { title: "fix: handle null pointer in parser", repo: "a/one" },
      { title: "docs: clarify install steps", repo: "b/two" },
      { title: "feat: add export to csv", repo: "c/three" },
      { title: "perf: cache compiled regex", repo: "d/four" },
      { title: "test: cover edge cases", repo: "e/five" },
      { title: "refactor: split god object", repo: "f/six" },
      { title: "ci: bump node version", repo: "g/seven" },
      { title: "fix: race in scheduler", repo: "h/eight" },
      { title: "feat: dark mode toggle", repo: "i/nine" },
      { title: "chore: update deps", repo: "j/ten" },
      { title: "fix: typo in readme", repo: "k/eleven" },
      { title: "feat: pagination support", repo: "l/twelve" },
    ];
    expect(computeFloodSignals(prs).pr_flood_suspect).toBe(false);
  });

  it("handles an empty list", () => {
    expect(computeFloodSignals([]).pr_flood_suspect).toBe(false);
  });

  it("does NOT flag flooding your OWN repo (self-PRs are fine)", () => {
    const prs = Array.from({ length: 18 }, (_, i) => ({
      title: `refactor: migrate ${i} module to v2`,
      repo: "alice/myproject",
    }));
    expect(computeFloodSignals(prs, "alice").pr_flood_suspect).toBe(false); // own repo
    expect(computeFloodSignals(prs, "bob").pr_flood_suspect).toBe(true); // someone else's
  });
});

describe("computeClosedPrBreakdown", () => {
  it("separates maintainer-closed PRs from author self-closed PRs", () => {
    const b = computeClosedPrBreakdown(
      [
        closedPr({ actor: "maintainer", owner: "external" }),
        closedPr({ actor: "alice", owner: "external" }),
        closedPr({ actor: "alice", owner: "alice" }),
        closedPr({ actor: "teammate", owner: "alice" }),
        closedPr({ actor: null, owner: "external" }),
      ],
      6,
      "alice",
    );
    expect(b).toEqual({
      closed_unmerged_pr_count: 6,
      maintainer_closed_unmerged_pr_count: 1,
      self_closed_external_pr_count: 1,
      self_closed_own_repo_pr_count: 1,
      unknown_closed_unmerged_pr_count: 3,
    });
  });
});

describe("original project quality", () => {
  const now = new Date("2026-06-28T00:00:00Z");

  it("gives substance credit to a complete 0-star original project", () => {
    const q = originalRepoQualityScore(repo({ stars: 0, size: 1800 }), "alice", now);
    expect(q).toBeGreaterThanOrEqual(0.8);

    const s = score({
      ...NEUTRAL,
      total_stars: 0,
      max_stars: 0,
      nonempty_original_repo_count: 1,
      best_original_repo_quality_score: q,
    });
    expect(s.sub_scores.original_project_quality).toBeGreaterThanOrEqual(4.8);
  });

  it("scores structured README features instead of the prompt summary length", () => {
    const features = parseReadmeFeatures(`
# Project

${"Intro copy with badges and screenshots. ".repeat(40)}

## Installation

Install the package and configure the service.

## Usage

Use the API to run tests and deploy the workflow.
`);
    expect(features.length).toBeGreaterThan(800);
    expect(features.has_install).toBe(true);
    expect(features.has_usage).toBe(true);
    expect(features.prompt_summary.length).toBeLessThanOrEqual(1500);

    const q = originalRepoQualityScore(
      repo({
        size: 1800,
        readme: {
          path: "README.md",
          sha: "abc",
          size: 2000,
          html_url: null,
          truncated: false,
          features,
        },
        readme_excerpt: "Project summary.",
      }),
      "alice",
      now,
    );

    expect(q).toBeGreaterThan(0.8);
  });

  it("uses the first non-empty H1 section as the README summary intro", () => {
    const features = parseReadmeFeatures(`
# Project

A clear overview of what this project does and why it exists.

## Installation

Install the package.
`);

    expect(features.prompt_summary).toContain("A clear overview");
  });

  it("treats Quick Start as a usage signal", () => {
    const features = parseReadmeFeatures(`
# Project

## Quick Start

Run the CLI with the default config.
`);

    expect(features.has_usage).toBe(true);
  });

  it("does not count badges as screenshots", () => {
    const badges = parseReadmeFeatures(`
# Project

[![CI](https://img.shields.io/badge/ci-passing-green.svg)](https://example.com)
![license](https://img.shields.io/badge/license-MIT-blue.svg)
`);
    const screenshot = parseReadmeFeatures(`
# Project

![Screenshot](./assets/screenshot.png)
`);

    expect(badges.has_screenshot).toBe(false);
    expect(screenshot.has_screenshot).toBe(true);
  });

  it("does not let stars alone max out original quality without project substance", () => {
    const s = score({
      ...NEUTRAL,
      total_stars: 100000,
      max_stars: 50000,
      nonempty_original_repo_count: 1,
      best_original_repo_quality_score: 0,
    });
    expect(s.sub_scores.original_project_quality).toBe(12);
  });

  it("discounts star points when the top-starred repo lacks project substance", () => {
    const s = score({
      ...NEUTRAL,
      total_stars: 200,
      max_stars: 100,
      nonempty_original_repo_count: 3,
      best_original_repo_quality_score: 0.8,
      top_starred_original_repo_quality_score: 0.15,
    });
    const withoutDiscount = score({
      ...NEUTRAL,
      total_stars: 200,
      max_stars: 100,
      nonempty_original_repo_count: 3,
      best_original_repo_quality_score: 0.8,
      top_starred_original_repo_quality_score: 1,
    });
    expect(s.sub_scores.original_project_quality).toBeLessThan(
      withoutDiscount.sub_scores.original_project_quality - 3,
    );
  });

  it("downranks profile and WIP-style repos when selecting the best original repo", () => {
    const best = bestOriginalRepoQuality(
      [
        repo({
          name: "alice",
          size: 500,
          readme_excerpt: "Personal profile README with badges and social links.",
        }),
        repo({
          name: "tmp-playground",
          description: "WIP learning notes",
          readme_excerpt: "TODO scratch notes",
        }),
        repo({
          name: "invoice-engine",
          size: 1400,
          language: "Go",
          description: "Invoice workflow engine with API and persistence",
          readme_excerpt:
            "Install the service, configure the database, run tests, use the API and deploy with Docker.",
        }),
      ],
      "alice",
      now,
    );
    expect(best.repo).toBe("invoice-engine");
    expect(best.score).toBeGreaterThan(0.7);
  });

  it("scores the top-starred repo separately from the best usable repo", () => {
    const topStarred = topStarredOriginalRepoQuality(
      [
        repo({
          name: "alice",
          stars: 100,
          size: 500,
          readme_excerpt: "Personal profile README with badges and social links.",
        }),
        repo({
          name: "usable-engine",
          stars: 3,
          size: 1400,
          language: "Go",
          description: "Workflow engine with API and persistence",
          readme_excerpt:
            "Install the service, configure the database, run tests, use the API and deploy with Docker.",
        }),
      ],
      "alice",
      now,
    );
    const best = bestOriginalRepoQuality(
      [
        repo({
          name: "alice",
          stars: 100,
          size: 500,
          readme_excerpt: "Personal profile README with badges and social links.",
        }),
        repo({
          name: "usable-engine",
          stars: 3,
          size: 1400,
          language: "Go",
          description: "Workflow engine with API and persistence",
          readme_excerpt:
            "Install the service, configure the database, run tests, use the API and deploy with Docker.",
        }),
      ],
      "alice",
      now,
    );
    expect(topStarred.repo).toBe("alice");
    expect(topStarred.score).toBeLessThan(0.3);
    expect(best.repo).toBe("usable-engine");
  });

  it("attributes an organization repo only with strong long-term core maintenance", () => {
    const attribution = computeOrgRepoAttribution({
      repo: contribRepo({ commits: 90, prs: 8, active_years: 4 }),
      organizations: ["org"],
    });

    expect(attribution?.repo).toBe("org/main-engine");
    expect(attribution?.score).toBeGreaterThanOrEqual(5);
    expect(attribution?.evidence.join(" ")).toContain("90 commits");
  });

  it("does not attribute org repos from docs-like or PR-only contribution volume", () => {
    expect(
      computeOrgRepoAttribution({
        repo: contribRepo({ repo: "org/main-docs", commits: 120, prs: 40 }),
        organizations: ["org"],
      }),
    ).toBeNull();

    expect(
      computeOrgRepoAttribution({
        repo: contribRepo({ commits: 0, prs: 120, active_years: 4 }),
        organizations: ["org"],
        releaseOrTagAuthorHit: true,
        maintainerFileHit: true,
      }),
    ).toBeNull();
  });

  it("does not attribute organization repos without public org membership", () => {
    expect(
      computeOrgRepoAttribution({
        repo: contribRepo({ commits: 200, prs: 30, active_years: 5 }),
        organizations: ["other-org"],
        releaseOrTagAuthorHit: true,
        maintainerFileHit: true,
      }),
    ).toBeNull();
  });
});

describe("isExternalTrivialFarmPr (garbage into popular community repos)", () => {
  const me = "alice";
  it("flags a trivial PR into someone else's ≥200★ repo", () => {
    expect(
      isExternalTrivialFarmPr(pr({ repo: "org/framework", repo_stars: 200000, trivial: true }), me),
    ).toBe(true);
  });
  it("does NOT flag PRs into your own repo (any size/substance)", () => {
    expect(
      isExternalTrivialFarmPr(pr({ repo: "alice/toy", repo_stars: 0, trivial: true }), me),
    ).toBe(false);
  });
  it("does NOT flag substantial external PRs, or trivial PRs to small repos", () => {
    expect(
      isExternalTrivialFarmPr(pr({ repo: "org/framework", repo_stars: 200000, trivial: false }), me),
    ).toBe(false);
    expect(
      isExternalTrivialFarmPr(pr({ repo: "someone/tiny", repo_stars: 12, trivial: true }), me),
    ).toBe(false);
  });
});

describe("score() regression fixtures", () => {
  for (const [name, { input, expected }] of Object.entries(fixtures)) {
    it(`matches expected output for "${name}"`, () => {
      const result = score(input as unknown as RawMetrics);
      expect(result).toEqual(expected);
    });
  }
});

describe("isEcosystemImpactPr (dimension 4 qualification)", () => {
  const me = "maintainer";

  it("counts a substantial PR into your OWN ≥1000★ repo (maintainer value)", () => {
    expect(isEcosystemImpactPr(pr({ repo: "maintainer/popular", repo_stars: 30000 }), me)).toBe(true);
  });

  it("does NOT count PRs into your own <1000★ repo (self-PR-farming pattern)", () => {
    expect(isEcosystemImpactPr(pr({ repo: "owner/junk", repo_stars: 0 }), "owner")).toBe(false);
    expect(isEcosystemImpactPr(pr({ repo: "maintainer/sidequest", repo_stars: 500 }), me)).toBe(false);
  });

  it("counts a substantial PR into an external ≥200★ repo", () => {
    expect(isEcosystemImpactPr(pr({ repo: "org/target", repo_stars: 5000 }), me)).toBe(true);
  });

  it("does NOT count an external repo below 200★", () => {
    expect(isEcosystemImpactPr(pr({ repo: "someone/tiny", repo_stars: 100 }), me)).toBe(false);
  });

  it("never counts trivial (≤5-line) PRs, even into huge repos", () => {
    expect(
      isEcosystemImpactPr(pr({ repo: "org/kernel", repo_stars: 200000, trivial: true }), me),
    ).toBe(false);
  });
});

describe("computeImpactFromContribMap (all-time PR + commit impact)", () => {
  const me = "contributor";
  const agg = (over: Partial<ContribRepoAgg>): ContribRepoAgg => ({
    repo: "foundation/platform",
    stars: 24000,
    is_private: false,
    is_fork: false,
    owner_login: "foundation",
    commits: 0,
    prs: 0,
    active_years: 1,
    ...over,
  });

  it("credits old high-star external work via commits even with no recent PRs", () => {
    // Older all-time commits can sit outside any recent-PR window.
    const m = computeImpactFromContribMap([agg({ commits: 30, prs: 0 })], me);
    expect(m.max_impact_repo_stars).toBe(24000);
    expect(m.impact_depth_raw).toBeGreaterThan(0);
    expect(m.impact_repo_count).toBe(1);
    expect(m.impact_commit_count).toBe(30);
    expect(m.impact_repos[0].repo).toBe("foundation/platform");
  });

  it("credits a single landed PR into an external ≥200★ repo", () => {
    const m = computeImpactFromContribMap([agg({ repo: "org/target", owner_login: "org", stars: 5000, prs: 1 })], me);
    expect(m.impact_repo_count).toBe(1);
  });

  it("excludes one-off personal entries in known registry and directory repos", () => {
    const m = computeImpactFromContribMap(
      [
        agg({
          repo: "is-a-dev/register",
          owner_login: "is-a-dev",
          stars: 10600,
          commits: 1,
          prs: 1,
        }),
        agg({
          repo: "tuna/blogroll",
          owner_login: "tuna",
          stars: 2200,
          commits: 1,
          prs: 1,
        }),
        agg({ repo: "org/target", owner_login: "org", stars: 5000, prs: 1 }),
      ],
      me,
    );
    expect(m.impact_repos.map((r) => r.repo)).toEqual(["org/target"]);
    expect(m.impact_repo_count).toBe(1);
    expect(m.impact_commit_count).toBe(0);
    expect(m.impact_pr_count).toBe(1);
  });

  it("preserves sustained maintenance work in a registry repo", () => {
    const m = computeImpactFromContribMap(
      [
        agg({
          repo: "is-a-dev/register",
          owner_login: "is-a-dev",
          stars: 10600,
          commits: 20,
          prs: 10,
        }),
      ],
      me,
    );
    expect(m.impact_repo_count).toBe(1);
    expect(m.impact_repos[0].repo).toBe("is-a-dev/register");
  });

  it("ignores a single drive-by commit (needs ≥2 commits or ≥1 PR)", () => {
    const m = computeImpactFromContribMap([agg({ commits: 1, prs: 0 })], me);
    expect(m.impact_repo_count).toBe(0);
    expect(m.max_impact_repo_stars).toBe(0);
  });

  it("credits one git/git default-branch commit despite its non-GitHub merge workflow", () => {
    const m = computeImpactFromContribMap(
      [
        agg({
          repo: "git/git",
          owner_login: "git",
          stars: 61828,
          commits: 1,
          prs: 0,
        }),
        agg({
          repo: "foundation/drive-by",
          owner_login: "foundation",
          stars: 61828,
          commits: 1,
          prs: 0,
        }),
      ],
      me,
    );
    expect(m.impact_repos).toEqual([
      { repo: "git/git", stars: 61828, commits: 1, prs: 0 },
    ]);
    expect(m.impact_repo_count).toBe(1);
    expect(m.impact_commit_count).toBe(1);
    expect(m.impact_pr_count).toBe(0);
  });

  it("excludes forks and private repos", () => {
    const m = computeImpactFromContribMap(
      [
        agg({ repo: "me/platform-fork", is_fork: true, commits: 50 }),
        agg({ repo: "me/secret", is_private: true, commits: 50 }),
      ],
      me,
    );
    expect(m.impact_repo_count).toBe(0);
  });

  it("applies the higher ≥1000★ bar to the user's OWN repos", () => {
    const own500 = computeImpactFromContribMap([agg({ repo: "contributor/proj", owner_login: "contributor", stars: 500, commits: 50 })], me);
    expect(own500.impact_repo_count).toBe(0);
    const own2000 = computeImpactFromContribMap([agg({ repo: "contributor/proj", owner_login: "contributor", stars: 2000, commits: 50 })], me);
    expect(own2000.impact_repo_count).toBe(1);
  });

  it("does NOT count an external repo below 200★", () => {
    const m = computeImpactFromContribMap([agg({ repo: "someone/tiny", owner_login: "someone", stars: 100, commits: 50 })], me);
    expect(m.impact_repo_count).toBe(0);
  });
});

describe("impact quality caps", () => {
  it("classifies docs, website, examples, and templates as doc-like impact", () => {
    expect(isDocLikeImpactPr(pr({ repo: "foundation/project-site", repo_stars: 4000 }))).toBe(true);
    expect(isDocLikeImpactPr(pr({ repo: "docs-org/examples", repo_stars: 2000 }))).toBe(true);
    expect(isDocLikeImpactPr(pr({ repo: "is-a-dev/register", repo_stars: 10600 }))).toBe(true);
    expect(isDocLikeImpactPr(pr({ repo: "tuna/blogroll", repo_stars: 2200 }))).toBe(true);
    expect(isDocLikeImpactPr(pr({ title: "docs: update install guide", repo_stars: 5000 }))).toBe(true);
    expect(isDocLikeImpactPr(pr({ title: "feat: add project template", repo_stars: 5000 }))).toBe(true);
    expect(
      isDocLikeImpactPr(
        pr({
          title: "fix(frontend): avoid stale chat route state",
          repo: "big-org/workflow",
          repo_stars: 75000,
          files: ["web/src/routes/chat.tsx", "web/src/store/session.ts"],
        }),
      ),
    ).toBe(false);
  });

  it("caps ecosystem impact when graph-heavy high-star impact is not backed by core PRs", () => {
    const recentPrs = [
      pr({
        title: "fix(frontend): avoid stale chat route state",
        repo: "big-org/workflow",
        repo_stars: 75000,
        files: ["web/src/routes/chat.tsx"],
      }),
      pr({
        title: "fix: update interaction demo",
        repo: "ui-org/components",
        repo_stars: 4600,
        files: ["components/demo/basic.tsx"],
      }),
      pr({ title: "docs: update agent guide", repo: "docs-org/framework", repo_stars: 10000 }),
      pr({ title: "feat: add example", repo: "docs-org/examples", repo_stars: 2700 }),
      pr({ title: "feat: add company template", repo: "ui-org/components", repo_stars: 13000 }),
    ];
    const signals = computeImpactQualitySignals(recentPrs, 23, "docsheavyuser");
    expect(signals.core_impact_pr_count).toBe(2);
    expect(signals.doc_like_impact_pr_count).toBe(3);
    expect(signals.unverified_impact_pr_count).toBe(18);
    expect(signals.impact_quality_cap).toBe(4);

    const s = score({
      ...NEUTRAL,
      username: "DocsHeavyUser",
      account_age_years: 2.28,
      contribution_years_active: 3,
      nonempty_original_repo_count: 14,
      total_stars: 158,
      max_stars: 85,
      merged_pr_count: 38,
      total_pr_count: 68,
      issues_created: 65,
      max_impact_repo_stars: 75125,
      impact_pr_count: 23,
      impact_depth_raw: 13.08,
      followers: 1047,
      following: 33,
      last_year_contributions: 356,
      activity_type_count: 2,
      impact_quality_cap: signals.impact_quality_cap,
    });
    expect(s.sub_scores.ecosystem_impact).toBe(4);
    expect(s.final_score).toBeLessThanOrEqual(60);
  });

  it("does not cap old high-star code PRs just because they are outside the recent 50", () => {
    const recentPrs = [
      pr({
        title: "refactor: use current_user in console controllers",
        repo: "popular-ai/backend",
        repo_stars: 146000,
        files: ["api/controllers/console/wraps.py", "api/tests/unit_tests/controllers/console/test_wraps.py"],
      }),
      pr({
        title: "feat: complete local app metadata lifecycle",
        repo: "foundation/runtime",
        repo_stars: 4900,
        files: ["metadata/metadata.go", "metadata/metadata_test.go"],
      }),
      pr({
        title: "add: supply deployment in vercel",
        repo: "deploy-org/service",
        repo_stars: 1600,
        files: ["vercel.json"],
      }),
    ];
    const signals = computeImpactQualitySignals(recentPrs, 10, "codeheavyuser");
    expect(signals.core_impact_pr_count).toBe(3);
    expect(signals.doc_like_impact_pr_count).toBe(0);
    expect(signals.unverified_impact_pr_count).toBe(7);
    expect(signals.impact_quality_cap).toBeUndefined();
  });

  it("does not treat an empty verification window as proof of low-quality impact", () => {
    const signals = computeImpactQualitySignals([], 10, "codeheavyuser");
    expect(signals.verified_impact_pr_count).toBe(0);
    expect(signals.unverified_impact_pr_count).toBe(10);
    expect(signals.impact_quality_cap).toBeUndefined();
  });
});

describe("doc-like PR contribution-quality discount", () => {
  it("strongly discounts PR volume for docs/site/examples/template-heavy histories", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      username: "DocsHeavyUser",
      account_age_years: 2.28,
      contribution_years_active: 3,
      nonempty_original_repo_count: 14,
      total_stars: 158,
      max_stars: 85,
      merged_pr_count: 38,
      total_pr_count: 68,
      issues_created: 65,
      followers: 1047,
      following: 33,
      last_year_contributions: 356,
      activity_type_count: 2,
      recent_merged_pr_sample: 38,
      recent_doc_like_pr_count: 25,
      recent_doc_like_pr_ratio: 0.66,
      max_impact_repo_stars: 75125,
      impact_pr_count: 23,
      impact_depth_raw: 13.08,
      impact_quality_cap: 4,
    };
    const prVolume = logRatio(m.merged_pr_count, 200) * 16;
    expect(docLikePrVolumeDiscount(m, prVolume)).toBeCloseTo(5.5, 1);
    expect(score(m).sub_scores.contribution_quality).toBe(13.4);
  });

  it("caps contribution quality for low-trust high-star doc-heavy histories", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 38,
      total_pr_count: 68,
      issues_created: 65,
      total_stars: 158,
      recent_merged_pr_sample: 38,
      recent_external_pr_sample: 37,
      recent_external_doc_like_pr_count: 22,
      recent_external_doc_like_pr_ratio: 0.59,
      max_impact_repo_stars: 75125,
      impact_pr_count: 23,
      impact_depth_raw: 13.08,
      impact_quality_cap: 4,
      core_impact_pr_count: 2,
      doc_like_impact_pr_count: 3,
      top_starred_original_repo_quality_score: 0.14,
      self_closed_external_pr_count: 21,
    };
    expect(contributionQualityCap(m)).toBe(12);
    expect(score(m).sub_scores.contribution_quality).toBe(12);
  });

  it("does not cap contribution quality just because external PRs were author-closed", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 38,
      total_pr_count: 68,
      issues_created: 65,
      total_stars: 158,
      recent_merged_pr_sample: 38,
      recent_external_pr_sample: 37,
      recent_external_doc_like_pr_count: 22,
      recent_external_doc_like_pr_ratio: 0.59,
      max_impact_repo_stars: 75125,
      impact_pr_count: 23,
      impact_depth_raw: 13.08,
      impact_quality_cap: 4,
      core_impact_pr_count: 2,
      doc_like_impact_pr_count: 3,
      top_starred_original_repo_quality_score: 0.8,
      self_closed_external_pr_count: 21,
    };
    expect(contributionQualityCap(m)).toBeUndefined();
  });

  it("does not discount normal histories with a small docs share", () => {
    const m = {
      ...NEUTRAL,
      recent_merged_pr_sample: 50,
      recent_doc_like_pr_count: 8,
      recent_doc_like_pr_ratio: 0.16,
    };
    const prVolume = logRatio(m.merged_pr_count, 200) * 16;
    expect(docLikePrVolumeDiscount(m, prVolume)).toBe(0);
  });

  it("uses external doc-like ratio so own-repo docs do not drive the discount", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 50,
      recent_merged_pr_sample: 50,
      recent_doc_like_pr_count: 30,
      recent_doc_like_pr_ratio: 0.6,
      recent_external_pr_sample: 8,
      recent_external_doc_like_pr_count: 1,
      recent_external_doc_like_pr_ratio: 0.13,
    };
    const prVolume = logRatio(m.merged_pr_count, 200) * 16;
    expect(docLikePrVolumeDiscount(m, prVolume)).toBe(0);
  });

  it("does not discount tiny samples even when docs dominate", () => {
    const m = {
      ...NEUTRAL,
      recent_merged_pr_sample: 8,
      recent_doc_like_pr_count: 6,
      recent_doc_like_pr_ratio: 0.75,
    };
    const prVolume = logRatio(m.merged_pr_count, 200) * 16;
    expect(docLikePrVolumeDiscount(m, prVolume)).toBe(0);
  });

  it("gives a small contribution-quality bonus for high-star core PRs", () => {
    const base: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 78,
      total_pr_count: 98,
      issues_created: 16,
      max_impact_repo_stars: 146000,
      core_impact_pr_count: 3,
      doc_like_impact_pr_count: 0,
    };
    const withoutCoreSignal = {
      ...base,
      core_impact_pr_count: 1,
    };

    expect(highImpactCorePrBonus(base)).toBeCloseTo(1.5, 1);
    expect(score(base).sub_scores.contribution_quality).toBeGreaterThan(
      score(withoutCoreSignal).sub_scores.contribution_quality,
    );
  });

  it("caps bulk PR contribution quality when popular-impact signals are low", () => {
    const bulkSmallRepoHistory: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 118,
      total_pr_count: 120,
      issues_created: 45,
      max_stars: 50,
      max_impact_repo_stars: 5500,
      impact_pr_count: 19,
      impact_depth_raw: 9.6,
    };
    const sameVolumeHighImpact: RawMetrics = {
      ...bulkSmallRepoHistory,
      max_impact_repo_stars: 146000,
      core_impact_pr_count: 3,
    };

    expect(lowPrestigeBulkContributionCap(bulkSmallRepoHistory)).toBe(22);
    expect(score(bulkSmallRepoHistory).sub_scores.contribution_quality).toBe(22);
    expect(lowPrestigeBulkContributionCap(sameVolumeHighImpact)).toBeUndefined();
    expect(score(sameVolumeHighImpact).sub_scores.contribution_quality).toBeGreaterThan(24);
  });
});

describe("social-only dormant profiles", () => {
  it("caps community influence and adds a red flag when followers are detached from code work", () => {
    const s = score({
      ...NEUTRAL,
      account_age_years: 2.28,
      contribution_years_active: 0,
      followers: 1047,
      following: 33,
      public_repos: 70,
      fetched_repo_count: 70,
      fork_repo_count: 55,
      original_repo_count: 15,
      nonempty_original_repo_count: 14,
      total_stars: 158,
      max_stars: 85,
      top_starred_original_repo_quality_score: 0.14,
      best_original_repo_quality_score: 0.75,
      merged_pr_count: 0,
      total_pr_count: 0,
      issues_created: 0,
      last_year_contributions: 0,
      activity_type_count: 0,
      max_impact_repo_stars: 0,
      impact_pr_count: 0,
      impact_depth_raw: 0,
    });

    expect(s.sub_scores.community_influence).toBe(2.5);
    expect(s.red_flags.some((f) => f.flag === "social_only_dormant_profile")).toBe(true);
    expect(s.final_score).toBeLessThan(20);
  });

  it("does not cap followers for dormant accounts with strong original project quality", () => {
    const s = score({
      ...NEUTRAL,
      followers: 1047,
      following: 33,
      merged_pr_count: 0,
      total_pr_count: 0,
      last_year_contributions: 0,
      max_impact_repo_stars: 0,
      impact_pr_count: 0,
      impact_depth_raw: 0,
      total_stars: 250,
      best_original_repo_quality_score: 0.9,
    });

    expect(s.sub_scores.community_influence).toBeGreaterThan(2.5);
    expect(s.red_flags.some((f) => f.flag === "social_only_dormant_profile")).toBe(false);
  });
});

describe("tierFor (5 bands incl. 顶级)", () => {
  it("maps each score band to the right tier", () => {
    expect(tierFor(95).tier).toBe("夯");
    expect(tierFor(90).tier).toBe("夯");
    expect(tierFor(89.99).tier).toBe("顶级");
    expect(tierFor(80).tier).toBe("顶级");
    expect(tierFor(79.99).tier).toBe("人上人");
    expect(tierFor(70).tier).toBe("人上人");
    expect(tierFor(69.99).tier).toBe("NPC");
    expect(tierFor(40).tier).toBe("NPC");
    expect(tierFor(39.99).tier).toBe("拉完了");
    expect(tierFor(0).tier).toBe("拉完了");
  });
});

describe("logRatio", () => {
  it("returns 0 for non-positive values", () => {
    expect(logRatio(0, 5000)).toBe(0);
    expect(logRatio(-5, 5000)).toBe(0);
  });
  it("caps at 1.0 when value >= full_at", () => {
    expect(logRatio(5000, 5000)).toBe(1);
    expect(logRatio(99999, 5000)).toBe(1);
  });
  it("is monotonic increasing", () => {
    expect(logRatio(10, 5000)).toBeLessThan(logRatio(100, 5000));
  });
});
