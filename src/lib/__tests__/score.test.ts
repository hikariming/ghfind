import { describe, expect, it } from "vitest";
import {
  computeClosedPrBreakdown,
  computeFloodSignals,
  computeImpactFromContribMap,
  isEcosystemImpactPr,
  isExternalTrivialFarmPr,
  type ContribRepoAgg,
} from "../github";
import { logRatio, score, spamBotScore, tierFor } from "../score";
import type { RawMetrics, RecentPr } from "../types";
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

describe("spam-PR red flags", () => {
  it("does not fire on a neutral account", () => {
    expect(score(NEUTRAL).red_flags).toHaveLength(0);
  });

  it("flags templated_pr_flooding and scales the penalty 12→30 by severity", () => {
    const mk = (share: number, templated: number): RawMetrics => ({
      ...NEUTRAL,
      pr_flood_suspect: true,
      recent_pr_sample: 18,
      top_repo_pr_target: "langgenius/dify",
      top_repo_pr_share: share,
      templated_pr_ratio: templated,
    });
    const pen = (m: RawMetrics) =>
      score(m).red_flags.find((f) => f.flag === "templated_pr_flooding")?.penalty;
    expect(pen(mk(0.5, 0.5))).toBe(12); // just-suspect → min
    expect(pen(mk(1.0, 1.0))).toBe(30); // egregious one-repo bot → max
    const cq = pen(mk(1.0, 0.67))!; // cqjjjzr-ish (all PRs to one repo, 67% templated)
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

  it("flags trivial_pr_farming for garbage PRs into popular external repos", () => {
    const m: RawMetrics = { ...NEUTRAL, recent_merged_pr_sample: 18, external_trivial_pr_count: 12 };
    expect(hasFlag(m, "trivial_pr_farming")).toBe(true);
  });

  it("does NOT flag a heavy self-PR dev (no external garbage)", () => {
    // iamPulakesh-like: lots of own-repo PRs, zero external-trivial → no spam flags.
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
    // iamPulakesh-like: real engineering on own 0-star project. No external garbage,
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

  it("is HIGH for templated PR flooding of an external repo (cqjjjzr-like)", () => {
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
  it("flags a cqjjjzr-style one-repo templated burst", () => {
    const titles = [
      ...Array.from({ length: 15 }, (_, i) => `refactor(api): migrate ${i} endpoints to BaseModel`),
      "refactor(api): remove legacy field compatibility",
      "refactor(api): remove member field compatibility",
      "chore: rehearse ordered BaseModel migration merge",
    ];
    const prs = titles.map((title) => ({ title, repo: "langgenius/dify" }));
    const s = computeFloodSignals(prs);
    expect(s.pr_flood_suspect).toBe(true);
    expect(s.top_repo_pr_target).toBe("langgenius/dify");
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

describe("isExternalTrivialFarmPr (garbage into popular community repos)", () => {
  const me = "alice";
  it("flags a trivial PR into someone else's ≥200★ repo", () => {
    expect(
      isExternalTrivialFarmPr(pr({ repo: "facebook/react", repo_stars: 200000, trivial: true }), me),
    ).toBe(true);
  });
  it("does NOT flag PRs into your own repo (any size/substance)", () => {
    expect(
      isExternalTrivialFarmPr(pr({ repo: "alice/toy", repo_stars: 0, trivial: true }), me),
    ).toBe(false);
  });
  it("does NOT flag substantial external PRs, or trivial PRs to small repos", () => {
    expect(
      isExternalTrivialFarmPr(pr({ repo: "facebook/react", repo_stars: 200000, trivial: false }), me),
    ).toBe(false);
    expect(
      isExternalTrivialFarmPr(pr({ repo: "someone/tiny", repo_stars: 12, trivial: true }), me),
    ).toBe(false);
  });
});

/**
 * Parity test: the TS port of `score()` must reproduce, byte-for-byte, the output
 * of the canonical Python skill (`fetch_github_profile.py`). Fixtures are the
 * Python `score()` output captured for representative account shapes — see
 * scripts that regenerate them in the README. If these drift, the website and the
 * open-source skill would disagree on the number.
 */
describe("score() parity with Python skill", () => {
  for (const [name, { input, expected }] of Object.entries(fixtures)) {
    it(`matches Python output for "${name}"`, () => {
      const result = score(input as unknown as RawMetrics);
      expect(result).toEqual(expected);
    });
  }
});

describe("isEcosystemImpactPr (dimension 4 qualification)", () => {
  const me = "karpathy";

  it("counts a substantial PR into your OWN ≥1000★ repo (maintainer value)", () => {
    // karpathy → nanoGPT etc.: maintaining a hugely popular project you created.
    expect(isEcosystemImpactPr(pr({ repo: "karpathy/nanoGPT", repo_stars: 30000 }), me)).toBe(true);
  });

  it("does NOT count PRs into your own <1000★ repo (self-PR-farming pattern)", () => {
    // AsperforMias → own 0-star repos: self-review/self-merge inflation.
    expect(isEcosystemImpactPr(pr({ repo: "asper/junk", repo_stars: 0 }), "asper")).toBe(false);
    expect(isEcosystemImpactPr(pr({ repo: "karpathy/sidequest", repo_stars: 500 }), me)).toBe(false);
  });

  it("counts a substantial PR into an external ≥200★ repo", () => {
    expect(isEcosystemImpactPr(pr({ repo: "langgenius/dify", repo_stars: 5000 }), me)).toBe(true);
  });

  it("does NOT count an external repo below 200★", () => {
    expect(isEcosystemImpactPr(pr({ repo: "someone/tiny", repo_stars: 100 }), me)).toBe(false);
  });

  it("never counts trivial (≤5-line) PRs, even into huge repos", () => {
    expect(
      isEcosystemImpactPr(pr({ repo: "torvalds/linux", repo_stars: 200000, trivial: true }), me),
    ).toBe(false);
  });
});

describe("computeImpactFromContribMap (all-time PR + commit impact)", () => {
  const me = "syhily";
  const agg = (over: Partial<ContribRepoAgg>): ContribRepoAgg => ({
    repo: "apache/flink",
    stars: 24000,
    is_private: false,
    is_fork: false,
    owner_login: "apache",
    commits: 0,
    prs: 0,
    ...over,
  });

  it("credits old high-star external work via commits even with no recent PRs", () => {
    // The syhily/apache-flink case: lots of 2022 commits, outside any recent-PR window.
    const m = computeImpactFromContribMap([agg({ commits: 30, prs: 0 })], me);
    expect(m.max_impact_repo_stars).toBe(24000);
    expect(m.impact_depth_raw).toBeGreaterThan(0);
    expect(m.impact_repo_count).toBe(1);
    expect(m.impact_commit_count).toBe(30);
    expect(m.impact_repos[0].repo).toBe("apache/flink");
  });

  it("credits a single landed PR into an external ≥200★ repo", () => {
    const m = computeImpactFromContribMap([agg({ repo: "langgenius/dify", owner_login: "langgenius", stars: 5000, prs: 1 })], me);
    expect(m.impact_repo_count).toBe(1);
  });

  it("ignores a single drive-by commit (needs ≥2 commits or ≥1 PR)", () => {
    const m = computeImpactFromContribMap([agg({ commits: 1, prs: 0 })], me);
    expect(m.impact_repo_count).toBe(0);
    expect(m.max_impact_repo_stars).toBe(0);
  });

  it("excludes forks and private repos", () => {
    const m = computeImpactFromContribMap(
      [
        agg({ repo: "me/flink-fork", is_fork: true, commits: 50 }),
        agg({ repo: "me/secret", is_private: true, commits: 50 }),
      ],
      me,
    );
    expect(m.impact_repo_count).toBe(0);
  });

  it("applies the higher ≥1000★ bar to the user's OWN repos", () => {
    const own500 = computeImpactFromContribMap([agg({ repo: "syhily/proj", owner_login: "syhily", stars: 500, commits: 50 })], me);
    expect(own500.impact_repo_count).toBe(0);
    const own2000 = computeImpactFromContribMap([agg({ repo: "syhily/proj", owner_login: "syhily", stars: 2000, commits: 50 })], me);
    expect(own2000.impact_repo_count).toBe(1);
  });

  it("does NOT count an external repo below 200★", () => {
    const m = computeImpactFromContribMap([agg({ repo: "someone/tiny", owner_login: "someone", stars: 100, commits: 50 })], me);
    expect(m.impact_repo_count).toBe(0);
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
