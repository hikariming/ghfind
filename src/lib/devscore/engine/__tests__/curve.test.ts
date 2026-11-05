import { describe, expect, it } from "vitest";
import type { Developer, NumMap, Repo } from "../../model";
import { defaultParams as p, evidence, maintRecency, rate, recency, yearUnits, type Result } from "../curve";
import { coreHeat, commitWeight, defaultParams as sp, scoreDeveloper, scoreRepo } from "../score";
import { commit, dev, kinds, repo, size, times } from "./helpers";

const rateAt = (d: Developer, now: number): Result => rate(d, scoreDeveloper(d, sp), now, p);
const years = (from: number, to: number, v: number): NumMap =>
  Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [String(from + i), v]));

/** An important org project others build on (not the developer's own). */
const bigProject = (name: string): Repo =>
  repo({ name, kind: "code", forks: 5000, contributors_total: 800, dependents: 3000, owner_is_org: true, repo_total_commits: 40000 });

const substantial = times(commit("core", 300, 400), 8);

/** A newcomer with `months` months of substantial code in 2026 on the project. */
const newcomer = (code: NumMap, months: number): Repo => ({
  ...bigProject("org/big"),
  user_commits: 4 * months,
  user_merged_prs: 4 * months,
  active_months: months,
  commit_sample: substantial,
  first_contrib_at: "2026-01-01T00:00:00Z",
  last_contrib_at: "2026-08-01T00:00:00Z",
  code_months_by_year: code,
});

/** A creator of one widely used project, code in the given years. */
const creator = (code: NumMap, reviews: NumMap | null = null): Developer =>
  dev({
    login: "u",
    prs_merged_total: 50,
    prs_rejected_by_maintainer: 2,
    repos: [
      repo({
        name: "u/flag", owned: true, kind: "code", forks: 20000, stars: 60000, contributors_total: 800, repo_total_commits: 6000,
        user_commits: 4000, user_rank: 1, user_merged_prs: 50, pr_kinds: kinds({ core: 50 }), active_months: 100,
        first_contrib_at: "2012-01-01T00:00:00Z", last_contrib_at: "2020-12-31T00:00:00Z",
        code_months_by_year: code, reviews_by_year: reviews,
      }),
    ],
  });

describe("recency and review units", () => {
  it("recency halves every half-life and keeps a floor; maintenance fades faster", () => {
    expect(recency(2026, 2026.5, p)).toBeCloseTo(1, 12);
    expect(recency(2023, 2026.5, p)).toBeCloseTo(0.5, 12);
    expect(recency(2000, 2026.5, p)).toBe(p.recency_floor);
    expect(maintRecency(2016, 2026.5, p)).toBeLessThan(recency(2016, 2026.5, p));
  });

  it("reviews are worth less than code and cannot stand alone", () => {
    expect(yearUnits(12, 0, p)).toBeGreaterThan(yearUnits(0, 400, p));
    expect(yearUnits(0, 1e6, p)).toBeCloseTo(3 * p.review_weight, 12);
    expect(yearUnits(6, 120, p)).toBeGreaterThan(yearUnits(6, 0, p));
    expect(yearUnits(6, 1e6, p)).toBeLessThanOrEqual(12 + 3 * p.review_weight + 1e-9);
  });

  it("evidence is 0 at no evidence and monotone in each dimension", () => {
    const q = { ...p, w_contrib: 0.1 };
    expect(evidence(0, 0, 0, 0, q)).toBeCloseTo(0, 12);
    const e0 = evidence(0.5, 3, 0.6, 1, q);
    expect(evidence(0.6, 3, 0.6, 1, q)).toBeGreaterThan(e0);
    expect(evidence(0.5, 4, 0.6, 1, q)).toBeGreaterThan(e0);
    expect(evidence(0.5, 3, 0.7, 1, q)).toBeGreaterThan(e0);
    expect(evidence(0.5, 3, 0.6, 2, q)).toBeGreaterThan(e0);
  });
});

describe("final score", () => {
  it("stopping code decays smoothly and never collapses; reviews help little", () => {
    const hist = years(2012, 2020, 12);
    const [s1, s3, s6, s12] = [2021.9, 2023.9, 2026.9, 2032.9].map((now) => rateAt(creator(hist), now).score);
    expect(s1 > s3 && s3 > s6 && s6 >= s12).toBe(true);
    expect(s3).toBeGreaterThan(s1 * 0.66);
    expect(s6).toBeGreaterThan(s3 * 0.66);
    expect(s12).toBeGreaterThan(0.4 * s1);
    const reviewer = rateAt(creator(hist, years(2021, 2026, 300)), 2026.9).score;
    const coder = rateAt(creator(years(2012, 2026, 12)), 2026.9).score;
    expect(reviewer).toBeGreaterThanOrEqual(s6);
    expect(coder - s6).toBeGreaterThan(3 * (reviewer - s6));
  });

  it("monotone: more evidence never lowers the score", () => {
    // mulberry32: deterministic, like the Zig test's fixed-seed PRNG
    let seed = 0xc0ffee;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let trial = 0; trial < 2000; trial++) {
      const repos = ["u/a", "u/b", "o/c"].map((name, i) => {
        const code: NumMap = {};
        const reviews: NumMap = {};
        for (let y = 2015; y <= 2026; y++) {
          if (rnd() < 0.5) code[y] = Math.floor(rnd() * 12);
          if (rnd() < 0.5) reviews[y] = Math.floor(rnd() * 200);
        }
        const total = 50 + rnd() * 5000;
        return repo({
          name, owned: i < 2, kind: "code", forks: rnd() * 5000, contributors_total: 1 + Math.floor(rnd() * 500),
          repo_total_commits: total, user_commits: rnd() * total, user_merged_prs: rnd() * 50,
          user_rank: Math.floor(1 + rnd() * 8), pr_kinds: kinds({ core: rnd() * 20 }), active_months: 1 + Math.floor(rnd() * 120),
          first_contrib_at: "2015-01-01T00:00:00Z", last_contrib_at: "2026-08-01T00:00:00Z",
          code_months_by_year: code, reviews_by_year: reviews,
        });
      });
      const d = dev({ login: "u", repos, prs_merged_total: 40, prs_rejected_by_maintainer: 5 });
      const before = rateAt(d, 2026.7).score;
      const k = Math.floor(rnd() * 3);
      const r = repos[k];
      const which = Math.floor(rnd() * 5);
      const y = String(2015 + Math.floor(rnd() * 12));
      if (which === 0) repos[k] = { ...r, forks: r.forks! * 2 + 10 };
      else if (which === 1) repos[k] = { ...r, contributors_total: r.contributors_total! * 2 + 5 };
      else if (which === 2) repos[k] = { ...r, user_merged_prs: r.user_merged_prs! + 10 };
      else if (which === 3) repos[k] = { ...r, code_months_by_year: { ...r.code_months_by_year, [y]: Math.min(12, (r.code_months_by_year![y] ?? 0) + 3) } };
      else repos[k] = { ...r, reviews_by_year: { ...r.reviews_by_year, [y]: (r.reviews_by_year![y] ?? 0) + 50 } };
      const after = rateAt(d, 2026.7).score;
      expect(after, `trial ${trial}: repo ${k} change ${which}`).toBeGreaterThanOrEqual(before - 1e-9);
    }
  });

  it("a hugely starred content repo earns at most the content cap; as code it is a flagship", () => {
    const prompts = repo({
      name: "u/prompts", owned: true, kind: "content", stars: 50_000, forks: 8000, contributors_total: 300,
      repo_total_commits: 2000, user_commits: 1500, user_rank: 1, active_months: 36,
      first_contrib_at: "2023-01-01T00:00:00Z", last_contrib_at: "2026-06-01T00:00:00Z",
    });
    const withIt = rateAt(dev({ login: "u", repos: [prompts] }), 2026.7);
    const without = rateAt(dev({ login: "u" }), 2026.7);
    expect(withIt.flagship).toBe(0);
    expect(withIt.main).toBe(without.main);
    expect(withIt.content_bonus).toBeCloseTo(p.content_cap, 9);
    expect(withIt.score).toBeLessThanOrEqual(without.score + p.content_cap + 1e-9);
    expect(rateAt(dev({ login: "u", repos: [{ ...prompts, kind: "code" }] }), 2026.7).flagship).toBeGreaterThan(0.3);
  });

  it("side evidence (language, engagement) never changes the score", () => {
    const plain = repo({ name: "o/lib", kind: "code", stars: 900, forks: 300, contributors_total: 40, repo_total_commits: 2000, user_commits: 300, user_merged_prs: 20, active_months: 24 });
    const owned = { ...plain, name: "u/tool", owned: true };
    const a = rateAt(dev({ login: "u", repos: [plain, owned] }), 2026.7);
    const b = rateAt(
      dev({
        login: "u",
        repos: [
          { ...plain, primary_language: "Zig", issues_total: 5000, prs_total: 3000 },
          { ...owned, primary_language: "Python", issues_total: 0, prs_total: 1 },
        ],
      }),
      2026.7,
    );
    expect(b.score).toBe(a.score);
    expect(b.confidence).toBe(a.confidence);
  });
});

describe("confidence", () => {
  it("a private-work profile is low, an endorsed maintainer is high", () => {
    const quiet = rateAt(
      dev({
        login: "u",
        repos: [
          repo({ name: "u/dotfiles", owned: true, kind: "code", forks: 1, user_commits: 40, repo_total_commits: 40, active_months: 3 }),
          repo({ name: "u/demo", owned: true, kind: "code", forks: 0, user_commits: 12, repo_total_commits: 12, active_months: 1 }),
        ],
      }),
      2026.7,
    );
    expect(quiet.confidence).toBe("low");
    const sizes = times(size(80), 10);
    const busy = rateAt(
      dev({
        login: "u",
        repos: [
          repo({
            name: "o/big", kind: "code", forks: 3000, contributors_total: 400, repo_total_commits: 9000, user_commits: 60,
            user_merged_prs: 60, active_months: 30, pr_mergers: { maintainer: 30 },
            code_months_by_year: { "2019": 10, "2021": 12, "2023": 12, "2025": 8 }, commit_sizes: sizes,
          }),
          repo({ name: "u/lib", owned: true, kind: "code", forks: 1500, contributors_total: 60, repo_total_commits: 900, user_commits: 800, active_months: 40, commit_sizes: sizes }),
        ],
      }),
      2026.7,
    );
    expect(busy.confidence).toBe("high");
  });
});

describe("maintainer credit and track", () => {
  it("a heavy reviewer of someone else's important repo is its author", () => {
    const base = repo({
      name: "org/graph", kind: "code", forks: 400, contributors_total: 161, repo_total_commits: 5000, user_commits: 40,
      user_merged_prs: 12, top_contributor_commits: 1500, active_months: 13, pr_mergers: { "[self]": 12 },
      code_months_by_year: { "2023": 4, "2024": 5, "2025": 4 },
    });
    const maint = { ...base, reviews_by_year: { "2023": 30, "2024": 30, "2025": 30 } };
    const none = { ...base, reviews_by_year: {} };
    const rs = scoreRepo("u", maint, 1, null, sp);
    expect(rs.authorship!).toBeGreaterThanOrEqual(sp.maintainer_authorship);
    expect(rs.endorsement).toBe(1);
    expect(scoreRepo("u", none, 1, null, sp).endorsement).toBe(0);
    const withIt = rateAt(dev({ login: "u", repos: [maint] }), 2026.7);
    const without = rateAt(dev({ login: "u", repos: [none] }), 2026.7);
    expect(withIt.flagship).toBeGreaterThan(without.flagship);
    expect(withIt.score).toBeGreaterThan(without.score);
  });

  it("stopped maintenance counts less than current maintenance", () => {
    const old = { ...bigProject("org/big"), maint_role: "OWNER", merged_others: 100, maint_months_by_year: years(2011, 2016, 10) };
    const cur = { ...old, maint_months_by_year: years(2021, 2026, 10) };
    expect(rateAt(dev({ login: "u", repos: [old] }), 2026.7).e_maint).toBeLessThan(rateAt(dev({ login: "u", repos: [cur] }), 2026.7).e_maint);
  });

  it("veteran maintainer outranks a newcomer; status follows recent activity", () => {
    const vet: Repo = {
      ...bigProject("org/big"), user_commits: 1500, user_merged_prs: 200, user_rank: 3, top_contributor_commits: 4000,
      active_months: 74, commit_sample: substantial, first_contrib_at: "2014-01-01T00:00:00Z", last_contrib_at: "2024-06-01T00:00:00Z",
      code_months_by_year: { ...years(2014, 2019, 12), "2021": 1, "2024": 1 },
      maint_role: "MEMBER", maint_months_by_year: years(2020, 2026, 5), merged_others: 150,
    };
    const v = rateAt(dev({ login: "u", repos: [vet] }), 2026.7);
    const n = rateAt(dev({ login: "u", repos: [newcomer({ "2026": 1 }, 1)] }), 2026.7);
    expect(v.e_maint).toBeGreaterThan(0);
    expect(v.score).toBeGreaterThan(n.score);
    expect(v.status).toBe("maintaining");
    expect(rateAt(dev({ login: "u", repos: [vet] }), 2029.7).status).toBe("inactive");
  });

  it("a verified role in an unused repo stays low", () => {
    const r = rateAt(
      dev({
        login: "u",
        repos: [
          repo({
            name: "u/tiny", owned: true, kind: "code", forks: 3, contributors_total: 2, repo_total_commits: 20, user_commits: 18,
            active_months: 3, maint_role: "OWNER", maint_months_by_year: years(2020, 2026, 12),
          }),
        ],
      }),
      2026.7,
    );
    expect(r.score).toBeLessThan(25);
  });

  it("a pure maintainer of an important project beats a burst contributor", () => {
    const m: Repo = {
      ...bigProject("org/big"), user_commits: 12, user_merged_prs: 4, active_months: 4,
      commit_sample: times(commit("chore", 10, 20), 4), code_months_by_year: { "2019": 1, "2021": 1, "2023": 1, "2025": 1 },
      maint_role: "MEMBER", maint_months_by_year: years(2019, 2026, 8), merged_others: 300,
    };
    const pm = rateAt(dev({ login: "u", repos: [m] }), 2026.7);
    const burst = rateAt(dev({ login: "u", repos: [newcomer({ "2026": 3 }, 3)] }), 2026.7);
    expect(pm.score).toBeGreaterThan(burst.score);
    expect(pm.status).toBe("maintaining");
    expect(burst.status).toBe("active");
  });

  it("an org role with a few comments is not maintenance; merging others' PRs is", () => {
    const base = newcomer({ "2026": 3 }, 3);
    const org = { ...bigProject("org/other"), user_commits: 2, user_merged_prs: 2, active_months: 1 };
    const plain = rateAt(dev({ login: "u", repos: [base, org] }), 2026.7);
    const thin = { ...org, maint_role: "MEMBER", maint_months_by_year: { "2024": 1, "2025": 1 } };
    const withThin = rateAt(dev({ login: "u", repos: [base, thin] }), 2026.7);
    expect(withThin.e_maint).toBe(0);
    expect(withThin.score).toBe(plain.score);
    const steady = { ...thin, maint_months_by_year: { "2024": 4, "2025": 4 }, merged_others: 0 };
    expect(rateAt(dev({ login: "u", repos: [base, steady] }), 2026.7).e_maint).toBe(0);
    expect(rateAt(dev({ login: "u", repos: [base, { ...steady, merged_others: 5 }] }), 2026.7).e_maint).toBeGreaterThan(0);
  });

  it("old data is unchanged: no v11 fields, no maintainer track; a role without a timeline is none", () => {
    const d = creator(years(2018, 2020, 12));
    const r = rateAt(d, 2026.7);
    expect(r.e_maint).toBe(0);
    expect(r.e).toBe(r.e_dev);
    expect(rateAt({ ...d, repos: [{ ...d.repos[0], maint_role: "OWNER" }] }, 2026.7).score).toBe(r.score);
  });
});

describe("core heat", () => {
  it("hot areas weigh more, never less", () => {
    const cold = times(commit("core", 200, 300), 4);
    const hot = times(commit("core", 200, 300, 0.3), 4);
    const zero = times(commit("core", 200, 300, 0), 4);
    const oneHot = [commit("core", 200, 300, 0.9), commit("core", 200, 300)];
    const r: Repo = { ...bigProject("org/big"), user_commits: 40, active_months: 6, commit_sample: cold };
    const wNull = commitWeight(r, 1, sp);
    expect(coreHeat({ ...r, commit_sample: oneHot }, sp)).toBeNull();
    expect(commitWeight({ ...r, commit_sample: zero }, 1, sp)).toBe(wNull);
    expect(commitWeight({ ...r, commit_sample: hot }, 1, sp)).toBeGreaterThan(wNull);
    const sizes = times(size(300), 10);
    expect(commitWeight({ ...r, commit_sample: hot, commit_sizes: sizes }, 1, sp)).toBeGreaterThan(commitWeight({ ...r, commit_sample: cold, commit_sizes: sizes }, 1, sp));
    const sCold = rateAt(dev({ login: "u", repos: [r] }), 2026.7).score;
    expect(rateAt(dev({ login: "u", repos: [{ ...r, commit_sample: hot }] }), 2026.7).score).toBeGreaterThanOrEqual(sCold);
  });
});
