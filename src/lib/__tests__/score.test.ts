import { describe, expect, it } from "vitest";
import {
  aggregateMergedPrNodes,
  applyImpactCodeSamples,
  applyImpactRepoSignals,
  authoredCommits,
  bestOriginalRepoQuality,
  computeClosedPrBreakdown,
  computeFloodSignals,
  computeImpactFromContribMap,
  computeImpactQualitySignals,
  computeOrgRepoAttribution,
  highStarPrShare,
  impactCodeSample,
  impactRepoCodeWeight,
  impactRepoTenureWeight,
  prestigeWorkMultiplier,
  isWorkflowLandedPr,
  isDocLikeImpactPr,
  isDocLikeRepo,
  isDocOrResourceRepo,
  isEcosystemImpactPr,
  isExternalTrivialFarmPr,
  isProfileReadmeRepo,
  isUiLibraryRepo,
  originalRepoQualityScore,
  originalRepoStarWeight,
  parseReadmeFeatures,
  topStarredOriginalRepoQuality,
  weightedOriginalStars,
  type ContribRepoAgg,
} from "../github";
import {
  authorSelfClosedExternalPenalty,
  contributionQualityCap,
  docLikePrVolumeDiscount,
  highImpactCorePrBonus,
  impactPrestigeSignal,
  lowPrestigeBulkContributionCap,
  logRatio,
  ownPrCommunityCredit,
  score,
  roundHalfEven,
  spamBotScore,
  starEngagementMultiplier,
  tierFor,
} from "../score";
import type { RawMetrics, RecentPr, TopRepo } from "../types";
import fixtures from "./score-fixtures.json";

describe("roundHalfEven", () => {
  it("uses half-even rounding for profile score reconstruction", () => {
    expect(roundHalfEven(17.25, 1)).toBe(17.2);
    expect(roundHalfEven(17.35, 1)).toBe(17.4);
    expect(roundHalfEven(34.205, 2)).toBe(34.2);
    expect(roundHalfEven(34.215, 2)).toBe(34.22);
  });
});

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
const hasNote = (m: RawMetrics, name: string) =>
  score(m).risk_notes?.some((f) => f.flag === name) ?? false;

describe("profile pronouns", () => {
  it.each(["she/her", "he/him", "they/them", "she/they", "ze/zir", "", null, undefined])(
    "does not change scoring or bot detection (%s)",
    (pronouns) => {
      expect(score({ ...NEUTRAL, pronouns })).toEqual(score(NEUTRAL));
      expect(spamBotScore({ ...NEUTRAL, pronouns })).toEqual(spamBotScore(NEUTRAL));
    },
  );
});

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

  it("only notes templated flooding when the bounded sample is too small or lacks corroboration", () => {
    const mk = (share: number, templated: number, over: Partial<RawMetrics> = {}): RawMetrics => ({
      ...NEUTRAL,
      pr_flood_suspect: true,
      recent_pr_sample: 18,
      top_repo_pr_target: "org/target",
      top_repo_pr_share: share,
      templated_pr_ratio: templated,
      ...over,
    });
    expect(hasFlag(mk(1.0, 1.0), "templated_pr_flooding")).toBe(false);
    expect(hasNote(mk(1.0, 1.0), "templated_pr_flooding")).toBe(true);
    expect(hasFlag(mk(1.0, 0.9, {
        recent_merged_pr_sample: 30,
        recent_external_doc_like_pr_ratio: 0.7,
        pr_rejection_rate: 0.4,
      }), "templated_pr_flooding")).toBe(false);
  });

  it("uses a Wilson lower bound and keeps high rejection below the old flat penalty", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 5,
      closed_unmerged_pr_count: 20,
      maintainer_closed_unmerged_pr_count: 20,
      pr_rejection_rate: 0.8,
    };
    const flag = score(m).red_flags.find((f) => f.flag === "high_pr_rejection");
    expect(flag).toBeTruthy();
    expect(flag?.penalty).toBeGreaterThan(0);
    expect(flag?.penalty).toBeLessThan(4);
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

  it("only notes external trivial PRs until the merged sample reaches 20", () => {
    const m: RawMetrics = { ...NEUTRAL, recent_merged_pr_sample: 18, external_trivial_pr_count: 12 };
    expect(hasFlag(m, "trivial_pr_farming")).toBe(false);
    expect(hasNote(m, "trivial_pr_farming")).toBe(true);
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

  it("excludes verified repository-workflow landings from closed-unmerged counts", () => {
    const b = computeClosedPrBreakdown(
      [
        { ...closedPr({ actor: "merge-bot", owner: "upstream" }), id: "workflow-pr" },
        { ...closedPr({ actor: "maintainer", owner: "upstream" }), id: "rejected-pr" },
      ],
      2,
      "alice",
      new Set(["workflow-pr"]),
    );
    expect(b).toEqual({
      closed_unmerged_pr_count: 1,
      maintainer_closed_unmerged_pr_count: 1,
      self_closed_external_pr_count: 0,
      self_closed_own_repo_pr_count: 0,
      unknown_closed_unmerged_pr_count: 0,
    });
  });
});

describe("repository workflow landings", () => {
  const workflowPr = (over: Record<string, unknown> = {}) => ({
    __typename: "PullRequest" as const,
    id: "PR_kwDOExample",
    mergedAt: null,
    additions: 24,
    deletions: 8,
    changedFiles: 3,
    repository: {
      nameWithOwner: "upstream/project",
      stargazerCount: 50_000,
      isPrivate: false,
      isFork: false,
      owner: { login: "upstream" },
    },
    timelineItems: {
      nodes: [
        {
          __typename: "LabeledEvent" as const,
          createdAt: "2026-01-02T00:00:00Z",
          actor: { login: "upstream-mergebot", __typename: "Bot" },
          label: { name: "Merged" },
        },
        {
          __typename: "ClosedEvent" as const,
          createdAt: "2026-01-02T00:01:00Z",
          actor: { login: "upstream-mergebot", __typename: "Bot" },
        },
      ],
    },
    ...over,
  });

  it("accepts a substantive PR marked and closed by the same official bot", () => {
    expect(isWorkflowLandedPr(workflowPr())).toBe(true);
  });

  it("accepts a repository merge-bot account even when GitHub types it as User", () => {
    expect(
      isWorkflowLandedPr(
        workflowPr({
          timelineItems: {
            nodes: [
              {
                __typename: "LabeledEvent",
                createdAt: "2026-01-02T00:00:00Z",
                actor: { login: "upstreammergebot", __typename: "User" },
                label: { name: "Merged" },
              },
              {
                __typename: "ClosedEvent",
                createdAt: "2026-01-02T00:01:00Z",
                actor: { login: "upstreammergebot", __typename: "User" },
              },
            ],
          },
        }),
      ),
    ).toBe(true);
  });

  it("does not trust a human-applied Merged label", () => {
    expect(
      isWorkflowLandedPr(
        workflowPr({
          timelineItems: {
            nodes: [
              {
                __typename: "LabeledEvent",
                createdAt: "2026-01-02T00:00:00Z",
                actor: { login: "maintainer", __typename: "User" },
                label: { name: "Merged" },
              },
              {
                __typename: "ClosedEvent",
                createdAt: "2026-01-02T00:01:00Z",
                actor: { login: "maintainer", __typename: "User" },
              },
            ],
          },
        }),
      ),
    ).toBe(false);
  });

  it("does not trust a bot label unless that bot also closes the PR", () => {
    expect(
      isWorkflowLandedPr(
        workflowPr({
          timelineItems: {
            nodes: [
              {
                __typename: "LabeledEvent",
                createdAt: "2026-01-02T00:00:00Z",
                actor: { login: "upstream-mergebot", __typename: "Bot" },
                label: { name: "Merged" },
              },
              {
                __typename: "ClosedEvent",
                createdAt: "2026-01-02T00:01:00Z",
                actor: { login: "different-mergebot", __typename: "Bot" },
              },
            ],
          },
        }),
      ),
    ).toBe(false);
  });

  it("does not treat a native GitHub merge as a workflow landing", () => {
    expect(isWorkflowLandedPr(workflowPr({ mergedAt: "2026-01-02T00:01:00Z" }))).toBe(false);
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

  it("softens the notes-keyword discount for repos with organic star and fork traction", () => {
    const notes = (over: Partial<TopRepo>) =>
      repo({
        size: 1800,
        description: "My learning notes for ML systems",
        readme_excerpt: "Install usage examples architecture test. ".repeat(20),
        ...over,
      });

    expect(originalRepoQualityScore(notes({ stars: 40, forks: 5 }), "alice", now)).toBe(0.55);
    expect(originalRepoQualityScore(notes({ stars: 7000, forks: 50 }), "alice", now)).toBe(0.55);
    expect(originalRepoQualityScore(notes({ stars: 7000, forks: 500 }), "alice", now)).toBe(0.75);
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

  it("attributes a long-term org repo when the first commit author is the scored user", () => {
    const attribution = computeOrgRepoAttribution({
      repo: contribRepo({
        repo: "lab/layerfs",
        owner_login: "lab",
        commits: 200,
        prs: 20,
        active_years: 1,
      }),
      organizations: [],
      scoredLogin: "alice",
      firstCommitLogin: "alice",
    });

    expect(attribution?.repo).toBe("lab/layerfs");
    expect(attribution?.score).toBeGreaterThanOrEqual(5);
    expect(attribution?.evidence.join(" ")).toContain("first commit author is alice");
  });

  it("does not let a first-commit match skip the long-term maintenance gate", () => {
    expect(
      computeOrgRepoAttribution({
        repo: contribRepo({
          repo: "lab/plugins",
          owner_login: "lab",
          commits: 54,
          prs: 12,
          active_years: 1,
        }),
        organizations: [],
        scoredLogin: "alice",
        firstCommitLogin: "alice",
      }),
    ).toBeNull();
  });

  it("does not attribute when the first commit belongs to someone else", () => {
    expect(
      computeOrgRepoAttribution({
        repo: contribRepo({
          repo: "lab/sandbox",
          owner_login: "lab",
          commits: 2000,
          prs: 40,
          active_years: 1,
        }),
        organizations: [],
        scoredLogin: "alice",
        firstCommitLogin: "other-dev",
      }),
    ).toBeNull();
  });

  it("prefers public membership evidence when both gates match", () => {
    const attribution = computeOrgRepoAttribution({
      repo: contribRepo({ commits: 90, prs: 8, active_years: 4 }),
      organizations: ["org"],
      scoredLogin: "alice",
      firstCommitLogin: "alice",
    });

    expect(attribution?.evidence.join(" ")).toContain("org member of org");
    expect(attribution?.evidence.join(" ")).not.toContain("first commit author");
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

describe("ownPrCommunityCredit (v13 extra on v10)", () => {
  it("is zero when external_merged_pr_count is missing", () => {
    expect(ownPrCommunityCredit({ ...NEUTRAL, own_pr_community: 1, merged_pr_count: 200 })).toBe(0);
    expect(score({ ...NEUTRAL, own_pr_community: 1, merged_pr_count: 200 })).toEqual(
      score({ ...NEUTRAL, merged_pr_count: 200 }),
    );
  });

  it("is zero when A is 0 even with many own PRs", () => {
    expect(
      ownPrCommunityCredit({
        ...NEUTRAL,
        merged_pr_count: 200,
        external_merged_pr_count: 0,
        own_pr_community: 0,
      }),
    ).toBe(0);
  });

  it("adds 6·A·logRatio(own, 200) and never decreases the v10 score", () => {
    expect(
      ownPrCommunityCredit({
        ...NEUTRAL,
        merged_pr_count: 200,
        external_merged_pr_count: 0,
        own_pr_community: 1,
      }),
    ).toBe(6);
    const base = {
      ...NEUTRAL,
      merged_pr_count: 50,
      total_pr_count: 55,
      external_merged_pr_count: 0,
    };
    const withCommunity = { ...base, own_pr_community: 1 };
    expect(ownPrCommunityCredit(withCommunity)).toBeCloseTo(logRatio(50, 200) * 6, 10);
    const v10 = score(base);
    const v13 = score(withCommunity);
    expect(v13.sub_scores.contribution_quality).toBeGreaterThan(v10.sub_scores.contribution_quality);
    expect(v13.final_score).toBeGreaterThan(v10.final_score);
    expect(v13.final_score - v10.final_score).toBeLessThanOrEqual(6);
    const capped = {
      ...NEUTRAL,
      merged_pr_count: 200,
      total_pr_count: 210,
      external_merged_pr_count: 0,
    };
    expect(score({ ...capped, own_pr_community: 1 }).final_score).toBeGreaterThanOrEqual(
      score(capped).final_score,
    );
  });

  it("scales with A and saturates own volume at 200 PRs", () => {
    const half = ownPrCommunityCredit({
      ...NEUTRAL,
      merged_pr_count: 400,
      external_merged_pr_count: 0,
      own_pr_community: 0.5,
    });
    expect(half).toBe(3);
    const partialOwn = ownPrCommunityCredit({
      ...NEUTRAL,
      merged_pr_count: 50,
      external_merged_pr_count: 40,
      own_pr_community: 1,
    });
    expect(partialOwn).toBeCloseTo(logRatio(10, 200) * 6, 10);
  });
});

describe("score() regression fixtures", () => {
  for (const [name, { input, expected }] of Object.entries(fixtures)) {
    it(`matches expected output for "${name}"`, () => {
      const result = score(input as unknown as RawMetrics);
      // The golden fixtures lock the six positive dimensions and base score.
      // Risk output is intentionally versioned separately from those values.
      expect(result.sub_scores).toEqual(expected.sub_scores);
      expect(result.base_score).toBe(expected.base_score);
      expect(result.risk_assessment?.version).toBe("v10");
      expect(result.total_penalty).toBeGreaterThanOrEqual(0);
      expect(result.total_penalty).toBeLessThanOrEqual(25);
    });
  }
});

describe("isEcosystemImpactPr (dimension 4 qualification)", () => {
  const me = "maintainer";

  it("never counts PRs into your own repos, however popular (credited via aggregates)", () => {
    expect(isEcosystemImpactPr(pr({ repo: "maintainer/popular", repo_stars: 30000 }), me)).toBe(false);
    expect(isEcosystemImpactPr(pr({ repo: "Maintainer/popular", repo_stars: 30000 }), me)).toBe(false);
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

describe("starEngagementMultiplier (viral-but-hollow star gate)", () => {
  it("maps engagement ratio to the discount tiers", () => {
    expect(starEngagementMultiplier(undefined)).toBe(1); // not measured → no penalty
    expect(starEngagementMultiplier(0.19)).toBe(1); // llama.cpp-class flagship
    expect(starEngagementMultiplier(0.04)).toBe(1);
    expect(starEngagementMultiplier(0.035)).toBe(0.85); // tutorial-repo territory
    expect(starEngagementMultiplier(0.015)).toBe(0.7);
    expect(starEngagementMultiplier(0.0097)).toBe(0.5); // archify-class: audience, not community
  });

  it("halves star points for a viral repo with no community, leaving substance intact", () => {
    const viral: RawMetrics = {
      ...NEUTRAL,
      total_stars: 6815,
      max_stars: 5667,
      top_starred_original_repo_quality_score: 1,
      best_original_repo_quality_score: 1,
    };
    const engaged = score({ ...viral, top_repo_engagement_ratio: 0.2 });
    const hollow = score({ ...viral, top_repo_engagement_ratio: 0.0097 });
    const unmeasured = score(viral);
    // Unmeasured behaves exactly like healthy engagement.
    expect(unmeasured.sub_scores.original_project_quality).toBe(
      engaged.sub_scores.original_project_quality,
    );
    // Star points (≈12 here) halve; the 6 substance points are untouched.
    const drop =
      engaged.sub_scores.original_project_quality -
      hollow.sub_scores.original_project_quality;
    expect(drop).toBeGreaterThan(5);
    expect(drop).toBeLessThan(7);
    expect(hollow.sub_scores.original_project_quality).toBeGreaterThanOrEqual(6);
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

  it("preserves fixture-owner-037 maintenance work in a registry repo", () => {
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

  it("weights prestige continuously by landed work instead of using a hard cliff", () => {
    expect(prestigeWorkMultiplier(0, 1)).toBeGreaterThan(0);
    expect(prestigeWorkMultiplier(0, 2)).toBeGreaterThan(prestigeWorkMultiplier(0, 1));
    expect(prestigeWorkMultiplier(0, 3)).toBeLessThan(1);
    expect(prestigeWorkMultiplier(10, 0)).toBeLessThan(1);
    expect(prestigeWorkMultiplier(0, 12)).toBe(1);
    expect(prestigeWorkMultiplier(40, 0)).toBe(1);

    const m = computeImpactFromContribMap(
      [
        agg({ repo: "mega/agent", owner_login: "mega", stars: 216457, commits: 4, prs: 1 }),
        agg({ repo: "org/workplace", owner_login: "org", stars: 26085, commits: 163, prs: 159 }),
      ],
      me,
    );
    expect(m.impact_repo_count).toBe(2);
    expect(m.max_impact_repo_stars).toBe(216457);
    expect(m.impact_prestige_score).toBeGreaterThan(0);
    expect(m.impact_prestige_score).toBeLessThanOrEqual(1);
  });

  it("keeps high-work impact repos visible even when they are not top by stars", () => {
    const highStarRepos = Array.from({ length: 7 }, (_, i) =>
      agg({
        repo: `mega/project-${i}`,
        owner_login: "mega",
        stars: 100_000 - i * 5_000,
        prs: 1,
      }),
    );
    const m = computeImpactFromContribMap(
      [
        ...highStarRepos,
        agg({
          repo: "runtime/heavy-core",
          owner_login: "runtime",
          stars: 12_000,
          prs: 11,
        }),
      ],
      me,
    );

    expect(m.impact_repos.length).toBeLessThanOrEqual(12);
    expect(m.impact_repos.map((r) => r.repo)).toContain("runtime/heavy-core");
  });

  it("gives partial prestige when all impact work is shallow", () => {
    const m = computeImpactFromContribMap(
      [agg({ repo: "mega/agent", owner_login: "mega", stars: 216457, commits: 4, prs: 1 })],
      me,
    );
    expect(m.impact_repo_count).toBe(1);
    expect(m.max_impact_repo_stars).toBe(216457);
    expect(m.impact_prestige_score).toBeGreaterThan(0);
    expect(m.impact_prestige_score).toBeLessThan(1);
  });

  it("lets fixture-owner-037 merged-PR work anchor prestige without a commit trail", () => {
    const m = computeImpactFromContribMap(
      [
        agg({
          repo: "org/tooling",
          owner_login: "org",
          stars: 40000,
          commits: 0,
          prs: 12,
          pr_sample: 10,
          code_pr_sample: 10,
          months: ["2025-01", "2025-03", "2025-05", "2025-07", "2025-09", "2025-11"],
        }),
      ],
      me,
    );
    expect(m.max_impact_repo_stars).toBe(40000);
    expect(m.impact_prestige_score).toBeCloseTo(logRatio(40000, 100000), 4);
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

  it("requires outside evidence even for high-star own repos", () => {
    const own500 = computeImpactFromContribMap([agg({ repo: "contributor/proj", owner_login: "contributor", stars: 500, commits: 50 })], me);
    expect(own500.impact_repo_count).toBe(0);
    const own2000 = computeImpactFromContribMap([agg({ repo: "contributor/proj", owner_login: "contributor", stars: 2000, commits: 50 })], me);
    expect(own2000.impact_repo_count).toBe(0);
  });

  it("does NOT count an external repo below 200★", () => {
    const m = computeImpactFromContribMap([agg({ repo: "someone/tiny", owner_login: "someone", stars: 100, commits: 50 })], me);
    expect(m.impact_repo_count).toBe(0);
  });

  it("does not count merge commits as work in prestige or depth", () => {
    const authored = computeImpactFromContribMap([agg({ commits: 6, prs: 0 })], me);
    const withMerges = computeImpactFromContribMap(
      [agg({ commits: 30, merge_commits: 24, prs: 0 })],
      me,
    );
    expect(authoredCommits({ commits: 30, merge_commits: 24 })).toBe(6);
    expect(withMerges.impact_prestige_score).toBe(authored.impact_prestige_score);
    expect(withMerges.impact_depth_raw).toBe(authored.impact_depth_raw);
    expect(withMerges.impact_prestige_score).toBeLessThan(
      computeImpactFromContribMap([agg({ commits: 30, prs: 0 })], me).impact_prestige_score,
    );

    const mergesOnly = computeImpactFromContribMap([agg({ commits: 12, merge_commits: 12 })], me);
    expect(mergesOnly.impact_prestige_score).toBe(0);
    expect(mergesOnly.impact_depth_raw).toBe(0);
  });

  it("excludes doc/resource repos under 5k★ and halves popular ones", () => {
    const code = agg({ repo: "org/engine", owner_login: "org", stars: 8000, commits: 40, prs: 10 });
    const small = computeImpactFromContribMap(
      [
        agg({ repo: "org/engine-website", owner_login: "org", stars: 4999, commits: 40, prs: 10 }),
        agg({ repo: "org/list", owner_login: "org", stars: 3000, commits: 40, topics: ["awesome"] }),
      ],
      me,
    );
    expect(small.impact_repo_count).toBe(0);
    expect(small.impact_depth_raw).toBe(0);

    const full = computeImpactFromContribMap([code], me);
    const half = computeImpactFromContribMap([{ ...code, topics: ["course"] }], me);
    expect(half.impact_repo_count).toBe(1);
    expect(half.impact_prestige_score).toBeCloseTo(full.impact_prestige_score / 2, 3);
    expect(half.impact_depth_raw).toBeCloseTo(full.impact_depth_raw / 2, 1);
  });

  it("gives own repos damped depth and no prestige", () => {
    const own = agg({ repo: "contributor/tool", owner_login: "contributor", stars: 30000, commits: 200, forks: 1000 });
    const external = agg({ repo: "org/tool", owner_login: "org", stars: 30000, commits: 200 });
    const ownOnly = computeImpactFromContribMap([own], me);
    expect(ownOnly.impact_repo_count).toBe(1);
    expect(ownOnly.impact_prestige_score).toBe(0);
    expect(ownOnly.impact_depth_raw).toBeCloseTo(
      computeImpactFromContribMap([external], me).impact_depth_raw * 0.3 * (1 - Math.exp(-0.6 * Math.log1p(1000))),
      1,
    );
  });

  it("estimates merge commits from the sampled share and attaches topics", () => {
    const [enriched, untouched] = applyImpactRepoSignals(
      [agg({ repo: "Org/Engine", commits: 50 }), agg({ repo: "org/other", commits: 9 })],
      new Map([["org/engine", { topics: ["notes"], sampled_commits: 100, merge_commits: 30 }]]),
    );
    expect(enriched.merge_commits).toBe(15);
    expect(enriched.topics).toEqual(["notes"]);
    expect(untouched.merge_commits).toBeUndefined();
  });
});

describe("doc/resource repo detection", () => {
  it("does not treat .io/.org project names as doc sites", () => {
    expect(isDocLikeRepo("fixture-owner-035/socket.io")).toBe(false);
    expect(isDocLikeRepo("socket.io")).toBe(false);
    expect(isDocLikeRepo("foo/bar.org")).toBe(false);
  });

  it("matches GitHub Pages and site/website/homepage names", () => {
    for (const repo of [
      "someone/someone.github.io",
      "fixture-account-016/deerflow-website",
      "org/project-site",
      "org/project-homepage",
      "org/website",
      "org/site",
      "org/mywebsite",
    ]) {
      expect(isDocLikeRepo(repo), repo).toBe(true);
    }
    for (const repo of ["org/composite", "org/parasite", "org/homepage-builder-sdk"]) {
      expect(isDocLikeRepo(repo), repo).toBe(false);
    }
  });

  it("matches resource collections by topic", () => {
    for (const topic of ["awesome", "course", "tutorial", "notes", "docs", "Awesome-List"]) {
      expect(isDocOrResourceRepo({ repo: "org/engine", topics: [topic] }), topic).toBe(true);
    }
    expect(isDocOrResourceRepo({ repo: "org/engine", topics: ["llm", "inference"] })).toBe(false);
    expect(isDocOrResourceRepo({ repo: "org/engine" })).toBe(false);
  });
});

describe("impact quality signals and per-repo code share", () => {
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
          repo: "fixture-owner-004/workflow",
          repo_stars: 75000,
          files: ["web/src/routes/chat.tsx", "web/src/store/session.ts"],
        }),
      ),
    ).toBe(false);
  });

  it("does not extrapolate a sparse file-level sample to all-time ecosystem impact", () => {
    const recentPrs = [
      pr({
        title: "fix(frontend): avoid stale chat route state",
        repo: "fixture-owner-004/workflow",
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
    expect(signals.core_impact_pr_count).toBe(1);
    expect(signals.doc_like_impact_pr_count).toBe(4);
    expect(signals.unverified_impact_pr_count).toBe(18);
    expect(signals).not.toHaveProperty("impact_quality_cap");

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
    });
    expect(s.sub_scores.ecosystem_impact).toBeGreaterThan(4);
  });

  it("weights each impact repo by the code share of its sampled PRs, without a cliff", () => {
    const repo = (name: string, over: Partial<ContribRepoAgg> = {}): ContribRepoAgg => ({
      repo: name,
      stars: 20000,
      is_private: false,
      is_fork: false,
      owner_login: name.split("/")[0],
      commits: 0,
      prs: 10,
      active_years: 1,
      ...over,
    });
    const code = computeImpactFromContribMap([repo("org/engine", { pr_sample: 10, code_pr_sample: 10 })], "me");
    const docs = computeImpactFromContribMap([repo("org/engine", { pr_sample: 10, code_pr_sample: 0 })], "me");
    const prior = computeImpactFromContribMap([repo("org/engine")], "me");
    const work = { prs: 4, commits: 4 };
    expect(impactRepoCodeWeight({ ...work, pr_sample: 4, code_pr_sample: 4 })).toBe(1);
    expect(impactRepoCodeWeight({ ...work, pr_sample: 4, code_pr_sample: 0 })).toBeCloseTo(0.3, 10);
    expect(impactRepoCodeWeight(work)).toBeCloseTo(0.79, 10);
    // A sample speaks only for the work it covers: 1 PR out of 70 authored
    // commits stays near the prior (coverage 1/10).
    expect(
      impactRepoCodeWeight({ prs: 1, commits: 70, pr_sample: 1, code_pr_sample: 1 }),
    ).toBeCloseTo(0.3 + 0.7 * (0.1 + 0.9 * 0.7), 10);
    // A merged PR also lands as a commit: 1 PR + 1 commit is fully covered.
    expect(impactRepoCodeWeight({ prs: 1, commits: 1, pr_sample: 1, code_pr_sample: 0 })).toBeCloseTo(0.3, 10);
    expect(docs.impact_prestige_score).toBeCloseTo(code.impact_prestige_score * 0.3, 3);
    expect(docs.impact_depth_raw).toBeCloseTo(code.impact_depth_raw * 0.3, 1);
    expect(prior.impact_prestige_score).toBeCloseTo(code.impact_prestige_score * 0.79, 3);

    // Doc work in one repo leaves real code elsewhere untouched.
    const mixed = computeImpactFromContribMap(
      [
        repo("org/engine", { pr_sample: 10, code_pr_sample: 10 }),
        repo("org/handbook", { stars: 3000, pr_sample: 5, code_pr_sample: 0 }),
      ],
      "me",
    );
    expect(mixed.impact_prestige_score).toBe(code.impact_prestige_score);
    expect(mixed.impact_depth_raw).toBeGreaterThan(code.impact_depth_raw);
  });

  it("samples code share from up to ten merged PRs", () => {
    const docs = pr({ title: "docs: update guide", files: ["docs/guide.md"] });
    const codePr = pr({ title: "fix scheduler", files: ["src/scheduler.ts"] });
    expect(impactCodeSample([docs, codePr, codePr])).toEqual({ pr_sample: 3, code_pr_sample: 2 });
    expect(impactCodeSample(Array.from({ length: 15 }, () => codePr))).toEqual({
      pr_sample: 10,
      code_pr_sample: 10,
    });
    const applied = applyImpactCodeSamples(
      [
        { repo: "Org/Engine", stars: 1, is_private: false, is_fork: false, owner_login: "Org", commits: 0, prs: 1, active_years: 1 },
      ],
      new Map([["org/engine", { pr_sample: 3, code_pr_sample: 2 }]]),
    );
    expect(applied[0]).toMatchObject({ pr_sample: 3, code_pr_sample: 2 });
  });

  it("discounts short bursts by repo tenure (0.7 floor, full at six active months)", () => {
    expect(impactRepoTenureWeight({})).toBe(1);
    expect(impactRepoTenureWeight({ months: [] })).toBe(1);
    expect(impactRepoTenureWeight({ months: ["2026-09"] })).toBeCloseTo(0.75, 10);
    expect(impactRepoTenureWeight({ months: ["2026-01", "2026-02", "2026-03"] })).toBeCloseTo(0.85, 10);
    expect(
      impactRepoTenureWeight({ months: ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07"] }),
    ).toBe(1);
  });

  it("treats stylesheets as code in UI libraries and design systems", () => {
    const stylePr = (repo: string) =>
      pr({ title: "fix: scrollbar flicker", repo, files: ["components/bubble/style/index.ts", "components/bubble/style/index.less"] });
    expect(isUiLibraryRepo("ant-design/x")).toBe(true);
    expect(isUiLibraryRepo("org/react-components")).toBe(true);
    expect(isUiLibraryRepo("org/inference-engine")).toBe(false);
    expect(isDocLikeImpactPr(stylePr("ant-design/x"))).toBe(false);
    expect(isDocLikeImpactPr(pr({ repo: "ant-design/x", files: ["components/bubble/index.less"] }))).toBe(false);
    expect(isDocLikeImpactPr(pr({ repo: "org/inference-engine", files: ["web/index.css"] }))).toBe(true);
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
    expect(signals).not.toHaveProperty("impact_quality_cap");
  });

  it("does not let eleven PRs in one repository cap unrelated ecosystem work", () => {
    const prs = Array.from({ length: 11 }, (_, i) => pr({
      repo: "org/benchmark", repo_stars: 246,
      title: i === 0 ? "fix runner" : "docs: update benchmark",
      files: i === 0 ? ["src/runner.ts"] : ["README.md"],
    }));
    const signals = computeImpactQualitySignals(prs, 38, "alice");
    expect(signals.doc_like_impact_pr_count).toBe(10);
    expect(signals.core_impact_pr_count).toBe(1);
    expect(signals).not.toHaveProperty("impact_quality_cap");
  });

  it("counts only external high-star PRs as verified ecosystem PRs", () => {
    const signals = computeImpactQualitySignals(
      [
        pr({ repo: "alice/popular-tool", repo_stars: 30000, files: ["src/a.ts"] }),
        pr({ repo: "org/engine", repo_stars: 2000, files: ["src/b.ts"] }),
        pr({ repo: "org/engine", repo_stars: 2000, title: "docs: guide", files: ["docs/x.md"] }),
      ],
      3,
      "alice",
    );
    expect(signals.verified_impact_pr_count).toBe(2);
    expect(signals.core_impact_pr_count).toBe(1);
    expect(signals.doc_like_impact_pr_count).toBe(1);
  });

  it("does not treat an empty verification window as proof of low-quality impact", () => {
    const signals = computeImpactQualitySignals([], 10, "codeheavyuser");
    expect(signals.verified_impact_pr_count).toBe(0);
    expect(signals.unverified_impact_pr_count).toBe(10);
    expect(signals).not.toHaveProperty("impact_quality_cap");
  });

  it("does not mark bot-verified workflow landings as unverified impact", () => {
    const signals = computeImpactQualitySignals([], 10, "workflowuser", 10);
    expect(signals.verified_impact_pr_count).toBe(0);
    expect(signals.unverified_impact_pr_count).toBe(0);
    expect(signals).not.toHaveProperty("impact_quality_cap");
  });
});

describe("doc-like PR contribution-quality discount", () => {
  it("does not infer a presentation penalty from old binary metadata", () => {
    const m = {...NEUTRAL, recent_external_pr_sample: 40, recent_external_doc_like_pr_ratio: 1, impact_quality_cap: 4};
    expect(docLikePrVolumeDiscount(m, 16)).toBe(0);
    expect(contributionQualityCap(m)).toBeUndefined();
    expect(score(m)).toEqual(score({...m, impact_quality_cap: undefined}));
  });

  it("does not heavily penalize templated high-impact core contribution by title pattern alone", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      account_age_years: 9,
      contribution_years_active: 10,
      total_stars: 508,
      max_stars: 190,
      top_starred_original_repo_quality_score: 0.22,
      merged_pr_count: 1018,
      total_pr_count: 1803,
      issues_created: 100,
      followers: 580,
      following: 259,
      last_year_contributions: 4180,
      activity_type_count: 4,
      recent_pr_sample: 30,
      recent_merged_pr_sample: 30,
      recent_external_doc_like_pr_ratio: 0,
      max_impact_repo_stars: 222_859,
      impact_prestige_score: 1,
      impact_pr_count: 315,
      impact_depth_raw: 80,
      core_impact_pr_count: 50,
      doc_like_impact_pr_count: 0,
      maintainer_closed_unmerged_pr_count: 91,
      self_closed_external_pr_count: 9,
      pr_rejection_rate: 91 / (1018 + 91),
      pr_flood_suspect: true,
      top_repo_pr_target: "foundation/workflow",
      top_repo_pr_share: 0.6,
      templated_pr_ratio: 0.6,
    };
    const s = score(m);
    const flag = s.red_flags.find((f) => f.flag === "templated_pr_flooding");
    expect(flag).toBeUndefined();
    expect(s.risk_notes?.some((note) => note.flag === "templated_pr_flooding")).toBe(true);
    expect(s.tier).toBe("顶级");
    expect(s.final_score).toBeGreaterThanOrEqual(80);
  });

  it("does not cap contribution quality for low-volume author-closed external PRs", () => {
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
      impact_prestige_score: 0.1,
      impact_pr_count: 23,
      impact_depth_raw: 1.5,
      core_impact_pr_count: 2,
      doc_like_impact_pr_count: 3,
      top_starred_original_repo_quality_score: 0.8,
      self_closed_external_pr_count: 4,
    };
    expect(contributionQualityCap(m)).toBeUndefined();
  });

  it("keeps heavy author-closed external PRs neutral even with old low-trust metadata", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 38,
      total_pr_count: 69,
      issues_created: 65,
      total_stars: 600,
      max_stars: 300,
      recent_merged_pr_sample: 38,
      recent_external_pr_sample: 37,
      recent_external_doc_like_pr_count: 22,
      recent_external_doc_like_pr_ratio: 0.59,
      max_impact_repo_stars: 75125,
      impact_pr_count: 5,
      impact_depth_raw: 7.49,
      impact_quality_cap: 4,
      core_impact_pr_count: 1,
      doc_like_impact_pr_count: 4,
      top_starred_original_repo_quality_score: 0.8,
      self_closed_external_pr_count: 22,
    };
    expect(contributionQualityCap(m)).toBeUndefined();
    expect(score(m)).toEqual(score({...m, self_closed_external_pr_count: 0}));
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
      max_impact_repo_stars: 500,
      impact_pr_count: 19,
      impact_depth_raw: 9.6,
    };
    const sameVolumeHighImpact: RawMetrics = {
      ...bulkSmallRepoHistory,
      max_impact_repo_stars: 146000,
      core_impact_pr_count: 3,
    };

    expect(lowPrestigeBulkContributionCap(bulkSmallRepoHistory)).toBeGreaterThan(20);
    expect(lowPrestigeBulkContributionCap(bulkSmallRepoHistory)).toBeLessThan(24);
    expect(score(bulkSmallRepoHistory).sub_scores.contribution_quality).toBeLessThan(24);
    expect(lowPrestigeBulkContributionCap(sameVolumeHighImpact)).toBe(27);
    expect(score(sameVolumeHighImpact).sub_scores.contribution_quality).toBeGreaterThan(24);
  });

  it("does not cliff a fixture-owner-037 high-impact account into the low-prestige bulk cap", () => {
    const platform: ContribRepoAgg = {
      repo: "foundation/platform",
      owner_login: "foundation",
      stars: 149244,
      is_private: false,
      is_fork: false,
      commits: 12,
      prs: 12,
      active_years: 1,
      pr_sample: 10,
      code_pr_sample: 10,
      months: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
    };
    // Two drive-by PRs no longer carry full prestige.
    expect(
      computeImpactFromContribMap([{ ...platform, commits: 2, prs: 2, months: ["2026-01"] }], "contributor")
        .impact_prestige_score,
    ).toBeLessThan(logRatio(10_000, 100_000));
    const impact = computeImpactFromContribMap([platform], "contributor");
    const m: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 109,
      total_pr_count: 139,
      issues_created: 45,
      max_stars: 1,
      max_impact_repo_stars: impact.max_impact_repo_stars,
      impact_prestige_score: impact.impact_prestige_score,
      impact_pr_count: impact.impact_pr_count,
      impact_depth_raw: 7.7,
      core_impact_pr_count: 5,
    };

    expect(impactPrestigeSignal(m)).toBeGreaterThan(logRatio(10_000, 100_000));
    expect(lowPrestigeBulkContributionCap(m)).toBe(27);
    expect(score(m).sub_scores.contribution_quality).toBeGreaterThan(24);
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
    expect(s.red_flags.some((f) => f.flag === "social_only_dormant_profile")).toBe(false);
    expect(s.risk_notes?.some((f) => f.flag === "social_only_dormant_profile")).toBe(true);
    expect(s.total_penalty).toBe(0);
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

describe("scoring contract (single PR pool, weighted originals, unscaled follow ratio)", () => {
  it("scores contribution volume from the full merged-PR pool", () => {
    const solo: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 200,
      total_pr_count: 200,
      external_merged_pr_count: 37,
      maintainer_closed_unmerged_pr_count: 0,
    };
    const withSplit = score(solo).sub_scores.contribution_quality;
    const withoutSplit = score({ ...solo, external_merged_pr_count: undefined }).sub_scores.contribution_quality;
    expect(withSplit).toBe(withoutSplit);
    expect(withSplit).toBeGreaterThanOrEqual(16);
  });

  it("keeps the tiny-history acceptance formula below three decided PRs", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      merged_pr_count: 2,
      total_pr_count: 2,
      issues_created: 0,
      maintainer_closed_unmerged_pr_count: 0,
    };
    const acceptance = 2 * 1.2;
    expect(score(m).sub_scores.contribution_quality).toBeCloseTo(
      roundHalfEven(logRatio(2, 200) * 16 + acceptance, 1),
      10,
    );
  });

  it("damps own impact depth by the repo's community engagement and counts attributed originals as own", () => {
    const own = (over: Partial<ContribRepoAgg>): ContribRepoAgg => ({
      repo: "me/skill",
      stars: 30000,
      is_private: false,
      is_fork: false,
      owner_login: "me",
      commits: 100,
      prs: 0,
      active_years: 1,
      ...over,
    });
    const engaged = computeImpactFromContribMap([own({ engagement: 0.2 })], "me");
    const viral = computeImpactFromContribMap([own({ engagement: 0.005 })], "me");
    expect(viral.impact_depth_raw).toBeCloseTo(engaged.impact_depth_raw * 0.5, 1);
    expect(viral.impact_prestige_score).toBe(0);

    const attributed = computeImpactFromContribMap(
      [own({ repo: "my-org/tool", owner_login: "my-org", attributed_original: true })],
      "me",
    );
    expect(attributed.impact_prestige_score).toBe(0);
    expect(attributed.impact_depth_raw).toBe(
      computeImpactFromContribMap([own({})], "me").impact_depth_raw,
    );
    // Attributed originals need the own-repo ≥1000★ bar.
    expect(
      computeImpactFromContribMap(
        [own({ repo: "my-org/tool", owner_login: "my-org", attributed_original: true, stars: 600 })],
        "me",
      ).impact_repo_count,
    ).toBe(0);
  });

  it("aggregates the merged-PR window and external search without double counting", () => {
    const node = (id: string, repo: string, stars: number, mergedAt: string) => ({
      id,
      mergedAt,
      repository: { nameWithOwner: repo, stargazerCount: stars, isPrivate: false, isFork: false, owner: { login: repo.split("/")[0] } },
    });
    const repos = aggregateMergedPrNodes([
      node("a", "org/engine", 5000, "2025-01-10T00:00:00Z"),
      node("b", "org/engine", 5000, "2025-03-10T00:00:00Z"),
      node("a", "org/engine", 5000, "2025-01-10T00:00:00Z"),
      node("c", "me/tool", 10, "2026-01-01T00:00:00Z"),
    ]);
    expect(repos.find((r) => r.repo === "org/engine")).toMatchObject({
      prs: 2,
      active_years: 1,
      months: ["2025-01", "2025-03"],
    });
    expect(highStarPrShare([
      node("a", "org/engine", 5000, "2025-01-10T00:00:00Z"),
      node("c", "someone/tiny", 10, "2026-01-01T00:00:00Z"),
    ])).toBe(0.5);
    expect(highStarPrShare([])).toBe(1);
  });

  it("discounts stale and content repos in star totals and skips the profile README", () => {
    const now = new Date("2026-10-13T00:00:00Z");
    const repo = (over: Partial<TopRepo>): TopRepo => ({
      name: "engine",
      owner_login: "me",
      stars: 1000,
      forks: 10,
      open_issues: 0,
      size: 100,
      language: "Go",
      description: null,
      pushed_at: "2026-09-01T00:00:00Z",
      ...over,
    });
    expect(originalRepoStarWeight(repo({}), now)).toBe(1);
    expect(originalRepoStarWeight(repo({ pushed_at: "2025-10-13T00:00:00Z" }), now)).toBeCloseTo(1, 2);
    expect(originalRepoStarWeight(repo({ pushed_at: "2024-10-13T00:00:00Z" }), now)).toBeCloseTo(0.75, 2);
    expect(originalRepoStarWeight(repo({ pushed_at: "2020-01-01T00:00:00Z" }), now)).toBe(0.5);
    expect(originalRepoStarWeight(repo({ name: "chat-dataset-baseline" }), now)).toBeCloseTo(0.5689375);
    expect(originalRepoStarWeight(repo({ topics: ["dataset"] }), now)).toBeCloseTo(0.5689375);
    expect(
      originalRepoStarWeight(repo({ languages: [{ name: "HTML", size: 900 }, { name: "Python", size: 100 }] }), now),
    ).toBeCloseTo(0.271);
    expect(
      originalRepoStarWeight(repo({ languages: [{ name: "Jupyter Notebook", size: 900 }, { name: "Python", size: 100 }] }), now),
    ).toBe(1);
    expect(weightedOriginalStars([repo({}), repo({ name: "notes-dataset", stars: 500 })], now)).toEqual({
      weighted_total_stars: 1284.47,
      weighted_max_stars: 1000,
    });

    expect(isProfileReadmeRepo(repo({ name: "Me" }), "me")).toBe(true);
    expect(isProfileReadmeRepo(repo({ name: "me", owner_login: "my-org", attributed_original: true }), "me")).toBe(false);
    expect(isProfileReadmeRepo(repo({ name: "engine" }), "me")).toBe(false);
  });

  it("uses weighted star totals in Original Project Quality", () => {
    const m: RawMetrics = {
      ...NEUTRAL,
      total_stars: 3000,
      max_stars: 2000,
      top_starred_original_repo_quality_score: 1,
      best_original_repo_quality_score: 1,
    };
    expect(score({ ...m, weighted_total_stars: 1200, weighted_max_stars: 600 }).sub_scores.original_project_quality).toBeLessThan(
      score(m).sub_scores.original_project_quality,
    );
  });

  it("gives follow-ratio points full weight", () => {
    const community = (followers: number) =>
      score({ ...NEUTRAL, followers, following: 1 }).sub_scores.community_influence;
    expect(community(51)).toBeCloseTo(roundHalfEven(logRatio(51, 2000) * 5 + 3, 1), 10);
    expect(community(2000)).toBe(8);
  });

  it("saturates impact depth at 8", () => {
    const depth = (impact_depth_raw: number) =>
      score({ ...NEUTRAL, impact_prestige_score: 0, impact_depth_raw }).sub_scores.ecosystem_impact;
    expect(depth(8)).toBe(11);
    expect(depth(10)).toBe(11);
    expect(depth(20)).toBe(11);
  });
});
