import { describe, expect, it } from "vitest";
import population from "@/generated/github-population.json";
import topRepos from "@/generated/github-top-repo-stars.json";
import { githubStandings, repoStarStanding } from "../github-standing";

// Runs against the shipped snapshot: assertions are about shape and ordering,
// not about this month's counts.

const repo = (stars: number, extra: { attribution_share?: number } = {}) => ({ name_with_owner: "octo/app", stars, ...extra });
const asOf = Date.parse(`${population.metrics.account_age_days.as_of}T00:00:00Z`);
const DAY = 86_400_000;

describe("githubStandings", () => {
  it("lists the best repository, then account age", () => {
    const rows = githubStandings({ created_at: "2016-03-10T08:00:00Z" }, repo(1_240));
    expect(rows.map((r) => r.metric)).toEqual(["top_repo_stars", "account_age_days"]);
    expect(rows[0].repo).toEqual({ name_with_owner: "octo/app" });
  });

  it("keeps a co-built repository's credited share for the label, not for the rank", () => {
    const [own] = githubStandings({ created_at: null }, repo(120_000));
    const [coBuilt] = githubStandings({ created_at: null }, repo(120_000, { attribution_share: 0.1 }));
    expect(coBuilt.repo?.attribution_share).toBe(0.1);
    expect(coBuilt.rank).toBe(own.rank);
  });

  it("skips repositories below 10 stars and missing creation dates", () => {
    expect(githubStandings({ created_at: null }, repo(9))).toEqual([]);
    expect(githubStandings({ created_at: null }, repo(10)).map((r) => r.metric)).toEqual(["top_repo_stars"]);
  });

  it("places older accounts above more of the population", () => {
    const [old] = githubStandings({ created_at: "2009-01-01T00:00:00Z" });
    const [young] = githubStandings({ created_at: "2024-01-01T00:00:00Z" });
    expect(old.comparison_floor).toBe(0);
    expect(old.rank).toBeUndefined();
    expect(old.below_share).toBeGreaterThan(young.below_share);
  });

  it("keeps shares unrounded", () => {
    const [oldest] = githubStandings({ created_at: "2008-09-01T00:00:00Z" });
    expect(oldest.below_share).toBeLessThan(1);
    expect(oldest.below_share).toBeGreaterThan(0.9999);
  });

  it("measures age from the UTC creation day, as the age table counts", () => {
    const yesterdayMorning = new Date(asOf - DAY + 10 * 3_600_000).toISOString();
    const [row] = githubStandings({ created_at: yesterdayMorning });
    expect(row.value).toBe(1);
  });

  it("shows accounts created after the snapshot as newer than everyone", () => {
    const created = asOf + 30 * DAY;
    const [row] = githubStandings({ created_at: new Date(created).toISOString() }, undefined, created + 5 * DAY);
    expect(row.value).toBe(0);
    expect(row.below_share).toBe(0);
    expect(row.age_days_now).toBeCloseTo(5, 6);
  });

  it("displays the age now, not at the snapshot date", () => {
    const created = Date.parse("2016-03-10T08:00:00Z");
    const now = asOf + 365 * DAY;
    const [row] = githubStandings({ created_at: "2016-03-10T08:00:00Z" }, undefined, now);
    expect(row.age_days_now).toBeCloseTo((now - created) / DAY, 6);
    expect(row.value).toBeLessThan(row.age_days_now!);
  });
});

describe("repoStarStanding", () => {
  it("is null below 10 stars", () => {
    expect(repoStarStanding(0)).toBeNull();
    expect(repoStarStanding(9)).toBeNull();
  });

  it("ranks among all repositories and compares percents only with repos of 10+ stars", () => {
    const s = repoStarStanding(279)!;
    expect(s.population_size).toBe(population.metrics.repo_stars.total);
    expect(s.comparison_floor).toBe(10);
    expect(s.comparison_size).toBe(population.metrics.repo_stars.at_least[population.metrics.repo_stars.thresholds.indexOf(10)]);
    // Rank and percent describe the same repositories with more stars.
    expect(s.rank! / s.comparison_size).toBeCloseTo(s.top_share, 3);
  });

  it("gives more stars a better rank", () => {
    const ranks = [50, 279, 4_072].map((stars) => repoStarStanding(stars)!.rank!);
    expect(ranks[1]).toBeLessThan(ranks[0]);
    expect(ranks[2]).toBeLessThan(ranks[1]);
  });

  it("interpolates ranks below the exact-rank list", () => {
    expect(repoStarStanding(279)?.rank_exact).toBe(false);
  });

  it("matches the profile's best-repo row", () => {
    const [row] = githubStandings({ created_at: null }, repo(279));
    expect(row.rank).toBe(repoStarStanding(279)?.rank);
  });
});

describe("counted repository ranks", () => {
  it("counts ranks from the list floor up, #1 for the most-starred repository", () => {
    expect(repoStarStanding(topRepos.stars[0])?.rank).toBe(1);
    expect(repoStarStanding(topRepos.min_stars)?.rank_exact).toBe(true);
    // At the floor: at most every listed repository is ahead.
    expect(repoStarStanding(topRepos.min_stars)?.rank).toBeLessThanOrEqual(topRepos.stars.length + 1);
    expect(repoStarStanding(topRepos.min_stars - 1)?.rank_exact).toBe(false);
  });

  it("agrees with the interpolated rank at the list floor", () => {
    // The table and the list come from separate requests, so they can
    // differ by a repository or two; a large gap means one of them is wrong.
    const below = repoStarStanding(topRepos.min_stars - 1)!.rank!;
    const at = repoStarStanding(topRepos.min_stars)!.rank!;
    expect(Math.abs(at - below)).toBeLessThanOrEqual(below * 0.01);
  });

  it("does not count a repository's own list entry when its star count is older", () => {
    // The most-starred repository, read from a scan that predates the list.
    const [top, second] = [topRepos.repos[0], topRepos.stars[1]];
    const stale = topRepos.stars[0] - 1;
    expect(stale).toBeGreaterThan(second);
    expect(repoStarStanding(stale, top)?.rank).toBe(1);
    expect(repoStarStanding(stale, top.toUpperCase())?.rank).toBe(1);
    // Without the name, the stale count ranks below its own entry.
    expect(repoStarStanding(stale)?.rank).toBe(2);
    // A newer, higher count needs no correction.
    expect(repoStarStanding(topRepos.stars[0] + 100, top)?.rank).toBe(1);
  });

  it("counts other repositories normally for a named repository", () => {
    const i = 100;
    const name = topRepos.repos[i];
    expect(repoStarStanding(topRepos.stars[i], name)?.rank).toBe(repoStarStanding(topRepos.stars[i])?.rank);
    expect(githubStandings({ created_at: null }, { name_with_owner: name, stars: topRepos.stars[i] - 1 })[0].rank)
      .toBe(repoStarStanding(topRepos.stars[i] - 1)!.rank! - 1);
  });

  it("ships a descending list that starts at the floor, one name per entry", () => {
    const stars = topRepos.stars;
    for (let i = 1; i < stars.length; i++) expect(stars[i]).toBeLessThanOrEqual(stars[i - 1]);
    expect(stars[stars.length - 1]).toBeGreaterThanOrEqual(topRepos.min_stars);
    expect(topRepos.repos).toHaveLength(stars.length);
    expect(new Set(topRepos.repos).size).toBe(stars.length);
    for (const name of topRepos.repos) expect(name).toBe(name.toLowerCase());
  });
});
