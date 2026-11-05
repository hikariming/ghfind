import { describe, expect, it } from "vitest";
import { fractionalYear, type ExtPr, type Repo, type StarWeek } from "../../model";
import {
  acceptedSizeWeight,
  authorship,
  batchFarmed,
  botLikeness,
  commitWeight,
  defaultParams as p,
  developerProductRatio,
  endorsement,
  importance,
  isHype,
  logScale,
  nature,
  prShare,
  qualityLift,
  scale,
  scoreDeveloper,
  scoreRepo,
  share,
  sizedCommitWeight,
  starSpikeShare,
  unusedByOthers,
  volume,
  wilsonLower,
} from "../score";
import { commit, dev, kinds, repo, size, times } from "./helpers";

const lift = (x: number) => p.importance_floor + (1 - p.importance_floor) * x;

describe("score primitives", () => {
  it("wilson lower bound: textbook 10/10, more evidence at the same rate is higher", () => {
    expect(wilsonLower(0, 0, 1.96)).toBe(0);
    expect(wilsonLower(10, 10, 1.96)).toBeCloseTo(0.7225, 4);
    expect(wilsonLower(80, 100, 1.96)).toBeGreaterThan(wilsonLower(8, 10, 1.96));
    expect(wilsonLower(8, 10, 1.96)).toBeLessThan(0.8);
  });

  it("share: commits, PR fallback capped at 1, owned-unknown is 1, else unknown", () => {
    expect(share(repo({ name: "x/y", user_commits: 25, repo_total_commits: 100 }), p)).toBeCloseTo(0.25, 12);
    expect(share(repo({ name: "x/y", user_merged_prs: 5, repo_total_commits: 2000 }), p)).toBeCloseTo(0.05, 12);
    expect(share(repo({ name: "x/y", user_merged_prs: 3, repo_total_commits: 10 }), p)).toBe(1);
    expect(share(repo({ name: "x/y", owned: true }), p)).toBe(1);
    expect(share(repo({ name: "x/y", user_commits: 5 }), p)).toBeNull();
  });
});

describe("exclusions", () => {
  const base = repo({ name: "a/b", kind: "code", forks: 1000, user_commits: 100, repo_total_commits: 100, active_months: 12 });

  it("forks, the profile repo and non-engineering kinds score 0 work", () => {
    expect(scoreRepo("a", { ...base, is_fork: true }, 1, null, p).excluded).toBe("fork");
    expect(scoreRepo("alice", { ...base, name: "Alice/alice" }, 1, null, p).excluded).toBe("profile_repo");
    for (const kind of ["profile", "list", "config", "content", "docs", "site"]) {
      const s = scoreRepo("a", { ...base, kind }, 1, null, p);
      expect(s.excluded).toBe("excluded_kind");
      expect(s.work).toBe(0);
    }
  });

  it("archived repos still count, unchanged", () => {
    const archived = scoreRepo("a", { ...base, archived: true }, 1, null, p);
    expect(archived.work).toBe(scoreRepo("a", base, 1, null, p).work);
    expect(archived.work).toBeGreaterThan(0);
  });
});

describe("importance", () => {
  it("strongest scale signal wins, forks discounted, floor, unknown", () => {
    // Boost.Graph: 161 contributors outweigh 243 forks
    const boost = repo({ name: "boostorg/graph", forks: 243, stars: 396, contributors_total: 161 });
    expect(importance(boost, null, p)).toBeCloseTo(lift(logScale(160, p.full_contributors, p.scale_noise)), 12);
    expect(importance({ ...boost, dependents: 8000 }, null, p)).toBeCloseTo(lift(logScale(8000, p.full_dependents, p.scale_noise)), 12);
    // log scale: a 10k-contributor kernel is worth more than a 21-contributor library
    const kernel = importance(repo({ name: "t/linux", forks: 65000, contributors_total: 10000 }), null, p)!;
    const smallLib = importance(repo({ name: "d/thiserror", forks: 214, contributors_total: 21 }), null, p)!;
    expect(kernel).toBeGreaterThan(smallLib + 0.2);
    expect(importance(repo({ name: "x/y", contributors_total: 1, forks: 1300 }), null, p)).toBeCloseTo(
      lift(p.fork_weight * logScale(1300, p.full_forks, p.scale_noise)),
      12,
    );
    // a drive-by commit to a huge project stays negligible work
    const util = repo({
      name: "x/y", kind: "code", forks: 3000, contributors_total: 900, repo_total_commits: 400,
      user_commits: 1, user_merged_prs: 1, pr_kinds: kinds({ core: 1 }), active_months: 1,
    });
    expect(scoreRepo("u", util, 1, null, p).work!).toBeLessThan(0.01);
    expect(importance(repo({ name: "x/y", forks: 0, stars: 0 }), null, p)).toBeCloseTo(p.importance_floor, 12);
    expect(importance(repo({ name: "x/y" }), null, p)).toBeNull();
  });

  it("stars never count", () => {
    const now = fractionalYear("2026-09-25T00:00:00Z");
    const plain = repo({
      name: "u/x", owned: true, kind: "code", forks: 10, contributors_total: 2, issue_authors: 4,
      active_months: 12, has_tests: true, created_at: "2022-01-01T00:00:00Z",
    });
    for (const stars of [0, 1, 5_000, 100_000]) {
      const farmed = { ...plain, stars };
      expect(importance(farmed, null, p)).toBe(importance(plain, null, p));
      expect(scoreRepo("u", farmed, 1, now, p).work).toBe(scoreRepo("u", plain, 1, now, p).work);
    }
  });

  it("quality lift: a tested, CI-built, released project rises above the floor, capped, never on top of scale", () => {
    const tool = repo({
      name: "u/tool", owned: true, kind: "code", issue_authors: 3, contributors_total: 1, active_months: 8,
      has_tests: true, has_ci: true, releases_total: 3,
    });
    const imp = importance(tool, null, p)!;
    expect(imp).toBeGreaterThan(lift(scale(tool, p)!));
    expect(imp).toBeCloseTo(p.importance_floor + p.quality_lift + p.quality_tenure_lift * (1 - Math.exp(-8 / p.k_quality_months)), 12);
    // scaffolded tests and CI in a repo nobody uses: no lift
    expect(importance({ ...tool, issue_authors: 0 }, null, p)!).toBeLessThan(p.importance_floor + 1e-6);
    expect(importance({ ...tool, active_months: 5 }, null, p)!).toBeLessThan(imp);
    // someone else's repo the user merely contributed to: no lift; one they lead: like their own
    const ext = { ...tool, owned: false, user_commits: 10, repo_total_commits: 400 };
    expect(importance(ext, null, p)!).toBeLessThan(imp);
    expect(importance({ ...ext, user_commits: 300 }, null, p)).toBeCloseTo(imp, 12);
    expect(importance({ ...tool, active_months: 60 }, null, p)!).toBeGreaterThan(imp);
    // the lift is a floor, never a bonus on top of real scale
    expect(importance({ ...tool, contributors_total: 200 }, null, p)).toBeCloseTo(lift(logScale(199, p.full_contributors, p.scale_noise)), 12);
    expect(qualityLift({ ...tool, releases_total: 1e6, active_months: 1e6 }, p)!).toBeLessThanOrEqual(
      p.importance_floor + p.quality_lift + p.quality_tenure_lift + 1e-9,
    );
  });
});

describe("rule F: hype projects", () => {
  const now = fractionalYear("2026-09-27T00:00:00Z");
  const spike: StarWeek[] = [["2026-03-01", 40], ["2026-03-08", 5000], ["2026-03-15", 3000], ["2026-04-19", 30]];
  const viral = repo({
    name: "u/wrapper", owned: true, kind: "code", stars: 8070, forks: 2000, contributors_total: 3, issue_authors: 2,
    dependents: 0, active_months: 2, last_push_at: "2026-04-01T00:00:00Z", star_history: spike,
  });

  it("earn no adoption credit; stars absent means scored by forks like any repo", () => {
    expect(isHype(viral, now, p)).toBe(true);
    expect(importance(viral, now, p)).toBeCloseTo(p.importance_floor, 12);
    const unstarred = { ...viral, stars: null };
    expect(isHype(unstarred, now, p)).toBe(false);
    expect(importance(unstarred, now, p)!).toBeGreaterThan(p.importance_floor);
  });

  it("real use vetoes hype only while maintained", () => {
    const used = { ...viral, issue_authors: p.hype_veto_issue_authors, last_push_at: "2026-09-20T00:00:00Z" };
    expect(isHype(used, now, p)).toBe(false);
    expect(isHype({ ...used, last_push_at: "2024-01-01T00:00:00Z" }, now, p)).toBe(true);
  });

  it("content repos need the spike; others' repos are never judged", () => {
    const steady: StarWeek[] = [["2020-01-05", 20], ["2021-06-06", 20], ["2023-02-05", 20], ["2025-05-04", 20]];
    expect(isHype({ ...viral, kind: "content", star_history: steady, stars: 80 }, now, p)).toBe(false);
    expect(isHype({ ...viral, kind: "content" }, now, p)).toBe(true);
    expect(isHype({ ...viral, owned: false, user_commits: 5, repo_total_commits: 400 }, now, p)).toBe(false);
  });

  it("starSpikeShare: best window over a sparse weekly history", () => {
    expect(starSpikeShare(null, 4)).toBeNull();
    expect(starSpikeShare([], 4)).toBeNull();
    const h: StarWeek[] = [["2026-01-04", 5], ["2026-03-01", 50], ["2026-03-15", 40], ["2026-06-07", 5]];
    expect(starSpikeShare(h, 4)).toBeCloseTo(0.9, 9);
    const flat: StarWeek[] = [["2025-01-05", 10], ["2025-04-06", 10], ["2025-07-06", 10], ["2025-10-05", 10]];
    expect(starSpikeShare(flat, 4)!).toBeLessThanOrEqual(0.25 + 1e-9);
  });
});

describe("unused gate (rubric v3 I1/I2)", () => {
  const solo = repo({
    name: "u/emu", owned: true, kind: "code", forks: 1, contributors_total: 1, issue_authors: 0, user_commits: 300,
    repo_total_commits: 300, active_months: 20, commit_sample: times(commit("core", 200), 6),
  });

  it("a stray committer is not use; co-maintainers, issue authors and dependents are", () => {
    expect(unusedByOthers(solo, p)).toBe(true);
    const stray = { ...solo, contributors_total: 2, repo_total_commits: 310 };
    expect(unusedByOthers(stray, p)).toBe(true);
    expect(unusedByOthers({ ...stray, repo_total_commits: 300 / (1 - p.used_min_other_share) }, p)).toBe(false);
    // commit totals unknown: any other committer counts
    expect(unusedByOthers({ ...stray, repo_total_commits: null }, p)).toBe(false);
    expect(unusedByOthers({ ...solo, issue_authors: p.used_min_issue_authors - 1 }, p)).toBe(true);
    expect(unusedByOthers({ ...solo, issue_authors: p.used_min_issue_authors }, p)).toBe(false);
    expect(unusedByOthers({ ...solo, dependents: 1 }, p)).toBe(false);
  });

  it("plain forks are not use, and an unused repo gets no quality lift", () => {
    const forked = { ...solo, forks: 500, has_tests: true, has_ci: true };
    expect(unusedByOthers(forked, p)).toBe(true);
    expect(qualityLift(forked, p)).toBeNull();
    expect(qualityLift({ ...forked, issue_authors: p.used_min_issue_authors }, p)).not.toBeNull();
  });

  it("discounts work by unused_work; led org repos are judged the same way", () => {
    const wSolo = scoreRepo("u", solo, 1, null, p).work!;
    expect(wSolo).toBeCloseTo(p.unused_work * scoreRepo("u", solo, 1, null, { ...p, unused_work: 1 }).work!, 9);
    expect(scoreRepo("u", { ...solo, dependents: 1 }, 1, null, p).work!).toBeGreaterThan(wSolo);
    const led = { ...solo, owned: false };
    expect(unusedByOthers(led, p)).toBe(true);
    expect(unusedByOthers({ ...led, user_commits: 10 }, p)).toBe(false);
  });
});

describe("commit weight", () => {
  it("many trivial commits do not outweigh fewer real ones; merges only for maintainers", () => {
    const bulk = repo({
      name: "u/demo", owned: true, kind: "code", user_commits: 2501, repo_total_commits: 2501,
      commit_merge_share: 0, commit_sample: times(commit("core", 2), 12),
    });
    const real = repo({
      name: "o/lib", kind: "code", user_commits: 129, repo_total_commits: 3000, commit_merge_share: 0.375,
      commit_sample: [commit("core", 65), commit("core", 14), commit("core", 300), commit("test"), commit("chore")],
    });
    expect(commitWeight(bulk, 1, p)).toBeCloseTo(p.commit_size_floor, 9);
    expect(commitWeight(real, 1, p)).toBeGreaterThan(commitWeight(bulk, 1, p));
    const syncs = repo({ name: "o/lib", kind: "code", user_commits: 40, user_rank: 12, commit_merge_share: 1, commit_sample: [] });
    expect(commitWeight(syncs, 1, p)).toBe(0);
    const linux = repo({
      name: "t/linux", kind: "code", user_commits: 37579, commit_merge_share: 0.98,
      commit_sample: [commit("core", 23), commit("chore", 4)],
    });
    expect(commitWeight(linux, 1, p)).toBeGreaterThan(0.5);
    const copyedit = repo({
      name: "o/app", kind: "code", user_commits: 800, user_rank: 9, commit_merge_share: 0.25,
      commit_sample: [commit("docs"), commit("docs"), commit("docs"), commit("core", 14)],
    });
    expect(commitWeight(copyedit, 1, p)).toBeLessThan(0.3);
    expect(nature(copyedit, p)).toBeLessThan(0.6);
    expect(commitWeight(repo({ name: "x/y" }), 1, p)).toBe(1);
  });

  it("unknown commit count: merged PRs stand in, weighted by accepted PR substance", () => {
    const r = repo({ name: "o/r", kind: "code", user_merged_prs: 4, pr_substance: [476, 2, 0, 0] });
    expect(volume(r, commitWeight(r, 1, p), p)!).toBeGreaterThan(0);
    expect(commitWeight(r, 1, p)).toBeGreaterThan(p.commit_size_floor);
    const own = { ...r, owned: true };
    expect(commitWeight(own, 1, p)).toBeLessThan(1);
    expect(commitWeight(r, 1, p)).toBeGreaterThan(commitWeight(own, 1, p));
    expect(volume(repo({ name: "o/r" }), 1, p)).toBeNull();
  });

  it("sized commits (v6): lines scaled by the product ratio, kind from the sample", () => {
    const coreSample = times(commit("core", 80, 100), 4);
    const big = repo({ name: "o/lib", kind: "code", user_commits: 5, commit_sample: coreSample, commit_sizes: times(size(500), 5) });
    const tiny = repo({ name: "o/lib", kind: "code", user_commits: 50, commit_sample: coreSample, commit_sizes: times(size(2), 50) });
    expect(commitWeight(big, 1, p)).toBeGreaterThan(commitWeight(tiny, 1, p));
    expect(commitWeight(tiny, 1, p)).toBeCloseTo(p.commit_size_floor, 9);
    const syncs = repo({ name: "o/lib", kind: "code", user_commits: 40, user_rank: 12, commit_sizes: times(size(900, true), 3) });
    expect(commitWeight(syncs, 1, p)).toBe(0);
    // no sample here: the developer ratio (0: all docs elsewhere) sizes the commits
    const unsampled = repo({ name: "o/app", kind: "code", user_commits: 3, pr_kinds: kinds({ core: 1, docs: 1 }), commit_sizes: times(size(400), 3) });
    expect(commitWeight(unsampled, 0, p)).toBeCloseTo(p.commit_size_floor * prShare(unsampled, p), 9);
    expect(developerProductRatio([repo({ name: "u/docs", commit_sample: [commit("docs", 0, 300)] }), unsampled])).toBe(0);
    expect(developerProductRatio([unsampled])).toBe(1);
  });

  it("accepted size: a large accepted change is more than one unit; owned size saturates", () => {
    const one = (owned: boolean, lines: number) =>
      repo({ name: "o/lib", owned, kind: "code", user_commits: 1, pr_kinds: kinds({ core: 1 }), commit_sizes: [size(lines)] });
    expect(commitWeight(one(false, 700), 1, p) / commitWeight(one(false, 20), 1, p)).toBeGreaterThan(1.5);
    expect(acceptedSizeWeight(1e6, p)).toBeCloseTo(p.accepted_size_cap, 12);
    expect(commitWeight(one(true, 700), 1, p)).toBeLessThanOrEqual(1);
    expect(commitWeight(one(true, 700), 1, p) / commitWeight(one(true, 20), 1, p)).toBeLessThan(2);
    const pr = (lines: number) => repo({ name: "o/lib", kind: "code", user_merged_prs: 1, pr_substance: [lines] });
    expect(commitWeight(pr(700), 1, p)).toBeGreaterThan(1.5 * commitWeight(pr(20), 1, p));
  });

  it("bot-like histories weigh bot_penalty; human ones are unaffected", () => {
    const hour = (h: number) => `2025-03-04T${String(h).padStart(2, "0")}:17:00Z`;
    const lines = (i: number) => 1 + ((i * 37) % 400);
    const cron = Array.from({ length: 300 }, (_, i) => size(lines(i), false, hour(3)));
    const same = Array.from({ length: 300 }, (_, i) => size(120, false, hour(i % 24)));
    const human = Array.from({ length: 300 }, (_, i) => size(lines(i), false, hour((i * 7) % 24)));
    const base = repo({ name: "u/farm", owned: true, kind: "code", user_commits: 300 });
    for (const sizes of [cron, same]) {
      const r = { ...base, commit_sizes: sizes };
      expect(botLikeness(sizes, p)).toBe(1);
      expect(commitWeight(r, 1, p)).toBeLessThanOrEqual(0.2 * sizedCommitWeight(r, sizes, 1, p) + 1e-9);
    }
    const r = { ...base, commit_sizes: human };
    expect(botLikeness(human, p)).toBe(0);
    expect(commitWeight(r, 1, p)).toBe(sizedCommitWeight(r, human, 1, p));
    // too few commits, or no timestamps: never judged
    expect(botLikeness(cron.slice(0, 40), p)).toBe(0);
    expect(botLikeness(times(size(120), 300), p)).toBe(0);
  });
});

describe("authorship and nature", () => {
  const auth = (r: Repo) => authorship(share(r, p)!, r, commitWeight(r, 1, p), p);

  it("many own commits or a lead position count despite a tiny share", () => {
    expect(auth(repo({ name: "x/y", user_commits: 37000, repo_total_commits: 1.5e6 }))).toBeGreaterThan(0.99);
    expect(auth(repo({ name: "x/y", user_commits: 2, repo_total_commits: 1000 }))).toBeCloseTo(Math.sqrt(0.002), 12);
    const colead = repo({ name: "x/y", user_commits: 200, repo_total_commits: 30000, user_rank: 3, top_contributor_commits: 250 });
    const aColead = auth(colead);
    expect(aColead).toBeGreaterThan(Math.sqrt(200 / 30000));
    // a distant #3 behind a dominant lead (siyuan: 546 vs 15k) falls back
    expect(auth({ ...colead, top_contributor_commits: 15000 })).toBeLessThan(aColead);
    const fourth = repo({ name: "x/y", user_commits: 200, repo_total_commits: 3500, user_rank: 4 });
    expect(auth(fourth)).toBeCloseTo(Math.max(Math.sqrt(200 / 3500), 0.25 * (1 - Math.exp(-200 / p.k_rank_commits))), 12);
    // a rank needs commits behind it
    expect(auth({ ...fourth, user_commits: 2, user_rank: 1, top_contributor_commits: 2 })).toBeLessThan(0.1);
  });

  it("nature: PR mix beats repo kind; direct commits take the kind; data is capped", () => {
    expect(nature(repo({ name: "x/y", kind: "code", pr_kinds: kinds({ core: 1, docs: 1, site: 0, test: 0, chore: 0 }) }), p)).toBeCloseTo(0.625, 12);
    expect(nature(repo({ name: "x/y", kind: "site", pr_kinds: kinds({ core: 0, docs: 0 }) }), p)).toBeCloseTo(0.15, 12);
    const pushed = repo({ name: "x/y", kind: "code", user_commits: 200, user_merged_prs: 1, pr_kinds: kinds({ docs: 1 }) });
    expect(nature(pushed, p)).toBeCloseTo((0.25 + 199) / 200, 12);
    const routeData = repo({ name: "tm/HighwayData", kind: "data", commit_sample: [commit("data"), commit("data"), commit("data"), commit("core", 40)] });
    expect(nature(routeData, p)).toBeCloseTo(p.nature_data, 12);
    const dataPrs = repo({ name: "x/y", kind: "code", user_merged_prs: 4, user_commits: 4, pr_kinds: kinds({ core: 1, data: 3 }) });
    expect(nature(dataPrs, p)).toBeCloseTo((1 + 3 * p.nature_data) / 4, 12);
    expect(prShare(dataPrs, p)).toBeCloseTo((1 + 3 * p.nature_data) / 4, 12);
  });
});

describe("external contribution and endorsement", () => {
  const big = repo({ name: "big/tool", kind: "code", forks: 3000, contributors_total: 500, repo_total_commits: 20000, active_months: 12 });
  const realSample = [commit("core", 100), commit("core", 300), commit("core", 700), commit("core", 450)];

  it("commits, not PR counts, measure external work", () => {
    const real = { ...big, user_commits: 37, user_merged_prs: 0, commit_sample: realSample };
    const tweaks = { ...big, user_commits: 5, user_merged_prs: 5, pr_kinds: kinds({ core: 5 }), commit_sample: times(commit("core", 2), 5) };
    expect(scoreRepo("u", real, 1, null, p).contrib).toBeGreaterThan(scoreRepo("u", tweaks, 1, null, p).contrib);
    const direct = { ...big, user_commits: 203, user_merged_prs: 1, commit_sample: realSample };
    const sd = scoreRepo("u", direct, 1, null, p);
    expect(sd.contrib).toBeGreaterThan(0.3);
    expect(sd.meaningful).toBe(true);
    expect(sd.contrib).toBeGreaterThanOrEqual(scoreRepo("u", { ...direct, user_merged_prs: 203 }, 1, null, p).contrib);
    const none = { ...direct, user_merged_prs: 0 };
    const many = { ...direct, user_merged_prs: 50 };
    expect(volume(none, commitWeight(none, 1, p), p)).toBe(volume(many, commitWeight(many, 1, p), p));
  });

  it("a small accepted external commit is not multiplied away; owned repos add none; docs are not meaningful", () => {
    const pr = repo({
      name: "big/tool", kind: "code", forks: 3000, repo_total_commits: 5000, user_commits: 1, user_merged_prs: 1,
      pr_kinds: kinds({ core: 1 }), active_months: 1,
    });
    const s = scoreRepo("u", pr, 1, null, p);
    expect(s.work!).toBeLessThan(0.001);
    expect(s.contrib).toBeGreaterThan(50 * s.work!);
    expect(s.meaningful).toBe(true);
    expect(scoreRepo("u", { ...pr, owned: true }, 1, null, p).contrib).toBe(0);
    const sd = scoreRepo("u", { ...pr, pr_kinds: kinds({ docs: 1 }) }, 1, null, p);
    expect(sd.contrib).toBeLessThan(s.contrib);
    expect(sd.meaningful).toBe(false);
  });

  it("reviews given in someone else's repo add stewardship credit past a drive-by", () => {
    const base = repo({ name: "o/tool", kind: "code", forks: 100, contributors_total: 50, repo_total_commits: 4000, user_commits: 5, user_merged_prs: 5, active_months: 6 });
    const none = scoreRepo("u", base, 1, null, p);
    expect(scoreRepo("u", { ...base, reviews_by_year: { "2025": p.review_contrib_min } }, 1, null, p).contrib).toBe(none.contrib);
    const steward = { ...base, reviews_by_year: { "2025": 60 } };
    const s = scoreRepo("u", steward, 1, null, p);
    expect(s.contrib).toBeGreaterThan(none.contrib + 0.5 * p.review_contrib * s.importance!);
    expect(scoreRepo("u", { ...steward, owned: true }, 1, null, p).contrib).toBe(0);
  });

  it("only independently merged PRs count: mutual, self and small-repo bot merges are no verdict", () => {
    const ext = repo({
      name: "b/tool", kind: "code", forks: 800, contributors_total: 8, repo_total_commits: 400, user_commits: 20,
      user_merged_prs: 20, active_months: 6, commit_sample: times(commit("core", 200), 4),
    });
    const unknown = scoreRepo("a", ext, 1, null, p);
    expect(unknown.contrib).toBeGreaterThan(0.1);
    expect(unknown.endorsement).toBeNull();
    const pair = scoreRepo("a", { ...ext, pr_mergers: { b: 20 }, mutual_mergers: ["B"] }, 1, null, p);
    expect(pair.contrib).toBe(0);
    expect(pair.work).toBe(unknown.work);
    expect(scoreRepo("a", { ...ext, pr_mergers: { "[self]": 20 } }, 1, null, p).contrib).toBe(0);
    const smallBot = { ...ext, pr_mergers: { "[bot]": 10, c: 10 } };
    expect(endorsement(smallBot, p)).toBeCloseTo(0.5, 12);
    expect(endorsement({ ...smallBot, contributors_total: 500 }, p)).toBeCloseTo(1, 12);
    expect(scoreRepo("a", { ...ext, pr_mergers: { c: 20 }, mutual_mergers: [] }, 1, null, p).contrib).toBeCloseTo(unknown.contrib, 12);
  });

  it("batch-farmed large PRs: endorsement discounted only when all three conditions hold", () => {
    const farm = repo({
      name: "o/fastdfs", kind: "code", forks: 2000, contributors_total: 30, repo_total_commits: 900, user_commits: 10,
      user_merged_prs: 10, active_months: 1, pr_mergers: { owner: 10 }, pr_batch_share: 0.8,
      pr_substance: [2000, 1800, 900, 700, 650, 600, 550, 500, 40, 10],
    });
    expect(batchFarmed(farm, p)).toBe(true);
    expect(scoreRepo("u", farm, 1, null, p).endorsement).toBeCloseTo(p.batch_penalty, 12);
    expect(scoreRepo("u", { ...farm, pr_batch_share: 0.3 }, 1, null, p).endorsement).toBeCloseTo(1, 12);
    expect(scoreRepo("u", { ...farm, pr_substance: [80, 60, 40, 30, 20, 20, 10, 10, 5, 2] }, 1, null, p).endorsement).toBeCloseTo(1, 12);
    expect(batchFarmed({ ...farm, pr_batch_share: null }, p)).toBe(false);
  });

  it("unreviewed self-merges in a young org repo are activity, not endorsement (H1)", () => {
    const r = repo({
      name: "corp/new", kind: "code", owner_is_org: true, contributors_total: 12, forks: 300, repo_total_commits: 500,
      user_commits: 400, user_merged_prs: 40, active_months: 4, pr_mergers: { "[self]": 40 },
    });
    const pr = (reviewers: string[]): ExtPr => ({
      repo: "corp/new", title: "", state: "MERGED", created_at: "2026-07-01T00:00:00Z", additions: 0, deletions: 0,
      changed_files: 0, merged_by: "u", closed_by: null, reviewers,
    });
    const unreviewed = scoreDeveloper(dev({ login: "u", repos: [r], ext_prs: times(pr([]), 40) }), p);
    const reviewed = scoreDeveloper(dev({ login: "u", repos: [r], ext_prs: times(pr(["alice"]), 40) }), p);
    expect(unreviewed.score).toBeLessThan(reviewed.score);
    expect(unreviewed.contrib).toBeLessThan(reviewed.contrib);
    // no reviewer data (older collections): unchanged
    expect(scoreDeveloper(dev({ login: "u", repos: [r] }), p).score).toBe(reviewed.score);
  });
});

describe("scoreDeveloper", () => {
  it("unknown factors: repo work unknown, contributes 0, weights renormalize", () => {
    const s = scoreDeveloper(
      dev({
        login: "u",
        repos: [
          repo({ name: "u/a", owned: true, kind: "code", forks: 800, user_commits: 400, active_months: 30, first_contrib_at: "2020-01-01", last_contrib_at: "2022-06-01" }),
          repo({ name: "o/b", kind: "code", forks: 800, user_commits: 400 }),
        ],
      }),
      p,
    );
    expect(s.repos[0].name).toBe("u/a");
    expect(s.repos[1].work).toBeNull();
    expect(s.repos[1].share).toBeNull();
    expect(s.breadth).toBe(2);
    expect(s.collab_score).toBeNull();
    const expected =
      (100 * (p.w_impact * s.impact_score + p.w_breadth * s.breadth_score + p.w_longevity * s.longevity_score! + p.w_contrib * s.contrib_score)) /
      (p.w_impact + p.w_breadth + p.w_longevity + p.w_contrib);
    expect(s.score).toBeCloseTo(expected, 9);
  });

  it("contribution score is floored by impact score", () => {
    const s = scoreDeveloper(dev({ login: "u", repos: [repo({ name: "u/a", owned: true, kind: "code", forks: 5000, user_commits: 2000, active_months: 60 })] }), p);
    expect(s.contrib).toBe(0);
    expect(s.contrib_score).toBe(s.impact_score);
  });

  it("collaboration only with ≥ 10 decided PRs", () => {
    expect(scoreDeveloper(dev({ login: "u", prs_merged_total: 5, prs_rejected_by_maintainer: 4 }), p).collab_score).toBeNull();
    expect(scoreDeveloper(dev({ login: "u", prs_merged_total: 5, prs_rejected_by_maintainer: 5 }), p).collab_score).toBeCloseTo(wilsonLower(5, 10, p.wilson_z), 12);
  });

  it("longevity: no meaningful work is 0 years; sparse activity is capped by months", () => {
    expect(scoreDeveloper(dev({ login: "u" }), p).longevity_years).toBe(0);
    const sparse = dev({
      login: "u",
      repos: [repo({ name: "u/a", owned: true, forks: 1000, user_commits: 500, active_months: 3, first_contrib_at: "2012-01-01", last_contrib_at: "2024-01-01" })],
    });
    expect(scoreDeveloper(sparse, p).longevity_years).toBeCloseTo(0.25, 12);
  });
});
