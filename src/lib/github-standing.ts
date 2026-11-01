/**
 * Whole-GitHub position of a profile's public facts, read from the shipped
 * population snapshot (src/generated/github-population.json, rebuilt by
 * scripts/github-population.mts). Pure lookups: no GitHub call, no DB read.
 *
 * Repositories are placed by rank ("#3,588 of 363M"), with a percent among
 * repositories that have at least 10 stars as a secondary figure. Star counts
 * are heavy tailed: 99% of public repositories have fewer than 10 stars, so
 * against all of them every repository with some traction is in the top 1%
 * and percents hide the differences that matter.
 *
 * This is a different measurement from the site percentile in rank.ts: that
 * one compares ghfind scores among accounts scanned here. The ghfind score
 * itself is not placed on this scale.
 */
import snapshot from "@/generated/github-population.json";
import { estimateAtLeast, populationStanding, type PopulationTable } from "./github-population";

type GithubStandingMetric = "top_repo_stars" | "account_age_days";

interface SnapshotTable extends PopulationTable {
  population: string;
  source: string;
  as_of: string;
}

interface SnapshotFile {
  populations: Record<string, { total: number; definition: string }>;
  metrics: Record<string, SnapshotTable | undefined>;
}

const FILE = snapshot as unknown as SnapshotFile;

/**
 * Which snapshot table each standing reads, and the floor of its percent
 * comparison. Repositories below the floor get no standing at all.
 */
const METRICS: Record<GithubStandingMetric, { table: string; floor: number }> = {
  top_repo_stars: { table: "repo_stars", floor: 10 },
  account_age_days: { table: "account_age_days", floor: 0 },
};

export interface GithubStanding {
  metric: GithubStandingMetric;
  /**
   * The value looked up in the snapshot table: stars, or the account's age in
   * days at `as_of` (the table's own date).
   */
  value: number;
  /** Population key in the snapshot: `github_repos` or `github_users`. */
  population: string;
  /** Size of the whole population, the denominator of `rank`. */
  population_size: number;
  /** Percents compare only against members with a value >= this (0: everyone). */
  comparison_floor: number;
  /** Size of the percent comparison group. */
  comparison_size: number;
  /**
   * Share of the comparison group at or above `value`, in (0, 1] ("top X%").
   * Unrounded: views format it (formatTopPercent) at render time.
   */
  top_share: number;
  /** Share of the comparison group strictly below `value`, in [0, 1). Unrounded. */
  below_share: number;
  /** False when `value` was interpolated or its threshold count was partial. */
  exact: boolean;
  /** Where the population counts came from (`github_search`). */
  source: string;
  as_of: string;
  /** `top_repo_stars` only: rank by stars among all `population_size` repositories. */
  rank?: number;
  /** True when `rank` was counted; false when interpolated from the table. */
  rank_exact?: boolean;
  /** `top_repo_stars` on a profile: the repository that was ranked. */
  repo?: Omit<GithubStandingRepo, "stars">;
  /** `account_age_days` only: the account's age in days now, for display. */
  age_days_now?: number;
}

/** The profile repository a standing ranks: its identity and raw star count. */
export interface GithubStandingRepo {
  name_with_owner: string;
  stars: number;
  /**
   * The scan's credited share when the repository is co-built (as on the
   * profile's works list). The rank describes the repository itself.
   */
  attribution_share?: number;
}

/** Raw profile facts the standings read: a field of the stored metrics blob. */
export interface GithubStandingInput {
  created_at: string | null;
}

/** Repositories with more stars, plus one, interpolated from the table. */
function repoRank(table: PopulationTable, stars: number): { rank: number; rank_exact: boolean } {
  return { rank: Math.round(estimateAtLeast(table, stars + 1).count) + 1, rank_exact: false };
}

function standing(metric: GithubStandingMetric, value: number): GithubStanding | null {
  const { table: key, floor } = METRICS[metric];
  const table = FILE.metrics[key];
  if (!table || !Number.isFinite(value) || value < floor) return null;
  const s = populationStanding(table, value, { floor });
  return {
    metric,
    value,
    population: table.population,
    population_size: table.total,
    comparison_floor: floor,
    comparison_size: s.denominator,
    top_share: s.top_share,
    below_share: s.below_share,
    exact: s.exact,
    source: table.source,
    as_of: table.as_of,
    ...(metric === "top_repo_stars" ? repoRank(table, value) : {}),
  };
}

const DAY = 86_400_000;

/**
 * Account age against the age table. The table counts accounts created on or
 * before `as_of - d` days, so age is measured from the UTC day of creation:
 * an account created yesterday at 10:00 is 1 day old, as the table counts it.
 * Accounts created after `as_of` are newer than the whole table (age 0).
 */
function accountAge(createdAt: string | null, asOf: string | undefined, now: number): { atAsOf: number; now: number } | null {
  if (!createdAt || !asOf) return null;
  const created = Date.parse(createdAt);
  const at = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(created) || !Number.isFinite(at)) return null;
  const creationDay = Math.floor(created / DAY) * DAY;
  return {
    atAsOf: Math.max(0, Math.floor((at - creationDay) / DAY)),
    now: Math.max(0, (now - created) / DAY),
  };
}

/**
 * Standings in display order: the user's most-starred repository, then
 * account age. A repository below the floor, a missing table and a missing
 * creation date each omit their row.
 *
 * `topRepo` is the user's most-starred repository from the snapshot's
 * `top_repos`, with its raw star count. `now` only sets the displayed age.
 */
export function githubStandings(m: GithubStandingInput, topRepo?: GithubStandingRepo, now = Date.now()): GithubStanding[] {
  const out: GithubStanding[] = [];
  if (topRepo) {
    const s = repoStarStanding(topRepo.stars);
    if (s) {
      const { name_with_owner, attribution_share } = topRepo;
      out.push({ ...s, repo: { name_with_owner, ...(attribution_share !== undefined ? { attribution_share } : {}) } });
    }
  }
  const age = accountAge(m.created_at, FILE.metrics.account_age_days?.as_of, now);
  if (age) {
    const s = standing("account_age_days", age.atAsOf);
    if (s) out.push({ ...s, age_days_now: age.now });
  }
  return out;
}

/** Where one repository sits among public non-fork repositories by stars. */
export function repoStarStanding(stars: number): GithubStanding | null {
  if (!(stars >= 1)) return null;
  return standing("top_repo_stars", Math.floor(stars));
}
