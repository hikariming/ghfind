/**
 * devscore algorithm (devscore SPEC.md "Algorithm"; port of src/score.zig).
 * Pure functions, no I/O.
 *
 * Every per-repo factor is kept in `RepoScore` so a UI can explain a score.
 * `null` from the data model means "no evidence": a factor that cannot be
 * computed makes that repo's work unknown (counted as 0), and a developer-level
 * component that cannot be computed drops out of the final weighted mean,
 * whose weights renormalize over the remaining components.
 */
import { fractionalYear, type Commit, type CommitSize, type Developer, type ExtPr, type Repo, type StarWeek } from "../model";
import { eqlIgnoreCase, parseUint } from "./ascii";

/** All tunable constants (devscore docs/tuning.md records their history). */
export interface Params {
  /**
   * Project worth (`importance`): stars never count. scale = max over
   * logScale(contributors − 1, full_contributors), logScale(dependents,
   * full_dependents), issue_weight·logScale(issue_authors, full_issue_authors),
   * fork_weight·logScale(forks, full_forks); forks are the cheapest to fake.
   */
  full_forks: number;
  fork_weight: number;
  /** Contributors other than the user. */
  full_contributors: number;
  /** Registry packages that depend on a package built from the repo. */
  full_dependents: number;
  /** Distinct outside issue authors among the last 50 issues. */
  full_issue_authors: number;
  /** Issue authors cap near 50: they cannot tell a kernel from a busy library. */
  issue_weight: number;
  /** Counts well below this stay near 0 in `logScale` (a person and friends). */
  scale_noise: number;
  /** `qualityLift` for own/led code repos with ≥ quality_min_months active months. */
  quality_min_months: number;
  quality_lift: number;
  /** The lift also applies to a repo the user leads (≥ this share of its commits). */
  quality_led_share: number;
  /** Rubric v3 I1/I2: an own or led repo with no outside use keeps this much of its work. */
  unused_work: number;
  /** Rule F, hype projects (`isHype`). Stars are only the numerator of this test. */
  hype_min_stars: number;
  hype_star_ratio: number;
  /** No downstream: ≤ this many outside contributors and issue authors, no dependent. */
  hype_max_downstream: number;
  /** Spike: ≥ share of all stars in the best `weeks`, ≤ max_months active, idle ≥ idle_days. */
  hype_spike_share: number;
  hype_spike_weeks: number;
  hype_spike_max_months: number;
  hype_idle_days: number;
  /** Real use vetoes hype when pushed within hype_veto_active_days. */
  hype_veto_issue_authors: number;
  hype_veto_contributors: number;
  hype_veto_active_days: number;
  /** Use: others wrote ≥ used_min_other_share of commits, ≥ used_min_issue_authors, or a dependent. */
  used_min_other_share: number;
  used_min_issue_authors: number;
  quality_tenure_lift: number;
  k_quality_months: number;
  /** Commit weight from diffs: owned sizeWeight, others' repos acceptedSizeWeight. */
  k_commit_lines: number;
  commit_size_floor: number;
  accepted_size_cap: number;
  /** Bot-like commit history (`botLikeness`) weighs bot_penalty of a human one. */
  bot_penalty: number;
  bot_min_commits: number;
  bot_hour_share: number;
  bot_cv: number;
  /** A bot merge (merge queue) is independent only with this many contributors. */
  bot_merge_min_contributors: number;
  /** Human merger weight: floor + (1 − floor)·standing^exp. */
  merger_floor: number;
  merger_exp: number;
  /** Staff self-merges in an org repo with ≥ staff_min_contributors (`isOrgStaffRepo`). */
  staff_self_merge_weight: number;
  staff_min_contributors: number;
  /** Direct pushes dominate an org repo (`directPushEndorsement`). */
  direct_push_share: number;
  direct_push_commits_per_pr: number;
  direct_push_min_commits: number;
  /** Weight of a merge commit by a top-3 contributor; other merges weigh 0. */
  maintainer_merge_credit: number;
  /** Maintainer credit (`isMaintained`). */
  maintainer_min_reviews: number;
  maintainer_min_importance: number;
  maintainer_endorsement: number;
  maintainer_authorship: number;
  /** Batch-farmed PRs (`batchFarmed`). */
  batch_share_min: number;
  batch_min_prs: number;
  batch_large_lines: number;
  batch_large_share: number;
  batch_penalty: number;
  /** Obscurity discounts work, it does not zero it. */
  importance_floor: number;
  pr_commit_equiv: number;
  k_vol: number;
  k_durability: number;
  k_impact: number;
  /** impact = Σ_k work_(k) / k^impact_rank_exp over repos sorted by work. */
  impact_rank_exp: number;
  /** authorship = max(sqrt(share), standing·sat(uc, k_rank_commits), sat(uc, k_own)). */
  k_own: number;
  lead_exp: number;
  rank_exp: number;
  k_rank_commits: number;
  /** work = Π factor^exponent. */
  e_importance: number;
  e_authorship: number;
  e_volume: number;
  e_nature: number;
  e_durability: number;
  breadth_min_work: number;
  /** Meaningful also with ≥ 1 effective commit and importance ≥ this. */
  meaningful_min_importance: number;
  /** External contribution (contrib) saturation constants. */
  k_contrib: number;
  k_contrib_commits: number;
  /** Rubric v3 G3: reviews given in someone else's repo. */
  review_contrib: number;
  k_review_contrib: number;
  review_contrib_min: number;
  /** Weight of a chore PR toward the substantive share. */
  chore_credit: number;
  k_breadth: number;
  k_longevity: number;
  collab_min_decided: number;
  wilson_z: number;
  /** Component weights of the engine score; they sum to 1. */
  w_impact: number;
  w_breadth: number;
  w_longevity: number;
  w_collab: number;
  w_contrib: number;
  nature_core: number;
  nature_test: number;
  nature_chore: number;
  nature_docs: number;
  nature_site: number;
  /** Data files (contract v14). */
  nature_data: number;
  /** Core heat (`heatFactor`): bonus only. */
  heat_bonus: number;
  k_heat: number;
  heat_min_commits: number;
  /** Unreviewed self-driven repos (`unreviewedSelfDriven`). */
  unrev_min_prs: number;
  unrev_share: number;
  unrev_adopted: number;
}

export const defaultParams: Readonly<Params> = Object.freeze({
  full_forks: 30000,
  fork_weight: 0.7,
  full_contributors: 3000,
  full_dependents: 2000,
  full_issue_authors: 30,
  issue_weight: 0.6,
  scale_noise: 20,
  quality_min_months: 6,
  quality_lift: 0.15,
  quality_led_share: 0.5,
  unused_work: 0.1,
  hype_min_stars: 50,
  hype_star_ratio: 20,
  hype_max_downstream: 3,
  hype_spike_share: 0.5,
  hype_spike_weeks: 4,
  hype_spike_max_months: 3,
  hype_idle_days: 21,
  hype_veto_issue_authors: 10,
  hype_veto_contributors: 5,
  hype_veto_active_days: 365,
  used_min_other_share: 0.5,
  used_min_issue_authors: 3,
  quality_tenure_lift: 0.1,
  k_quality_months: 36,
  k_commit_lines: 20,
  commit_size_floor: 0.3,
  accepted_size_cap: 2,
  bot_penalty: 0.1,
  bot_min_commits: 50,
  bot_hour_share: 0.8,
  bot_cv: 0.15,
  bot_merge_min_contributors: 20,
  merger_floor: 0.5,
  merger_exp: 0.5,
  staff_self_merge_weight: 1.0,
  staff_min_contributors: 10,
  direct_push_share: 0.8,
  direct_push_commits_per_pr: 15,
  direct_push_min_commits: 30,
  maintainer_merge_credit: 0.6,
  maintainer_min_reviews: 30,
  maintainer_min_importance: 0.3,
  maintainer_endorsement: 1.0,
  maintainer_authorship: 0.5,
  batch_share_min: 0.6,
  batch_min_prs: 8,
  batch_large_lines: 500,
  batch_large_share: 0.6,
  batch_penalty: 0.3,
  importance_floor: 0.05,
  pr_commit_equiv: 20,
  k_vol: 30,
  k_durability: 6,
  k_impact: 0.6,
  impact_rank_exp: 2,
  k_own: 1000,
  lead_exp: 1.0,
  rank_exp: 1.0,
  k_rank_commits: 500,
  e_importance: 0.7,
  e_authorship: 1,
  e_volume: 0.8,
  e_nature: 1,
  e_durability: 1,
  breadth_min_work: 0.02,
  meaningful_min_importance: 0.1,
  k_contrib: 0.2,
  k_contrib_commits: 10,
  review_contrib: 0.7,
  k_review_contrib: 10,
  review_contrib_min: 2,
  chore_credit: 0.25,
  k_breadth: 2,
  k_longevity: 4,
  collab_min_decided: 10,
  wilson_z: 1.96,
  w_impact: 0.56,
  w_breadth: 0.08,
  w_longevity: 0.096,
  w_collab: 0.064,
  w_contrib: 0.2,
  nature_core: 1.0,
  nature_test: 0.7,
  nature_chore: 0.4,
  nature_docs: 0.25,
  nature_site: 0.15,
  nature_data: 0.1,
  heat_bonus: 0.3,
  k_heat: 0.1,
  heat_min_commits: 2,
  unrev_min_prs: 20,
  unrev_share: 0.7,
  unrev_adopted: 50,
});

/**
 * Saturating map [0,∞) → [0,1): `1 − e^(−x/k)`; `sat(k, k) ≈ 0.63`,
 * `sat(3k, k) ≈ 0.95`. Unlike `x/(x+k)` it actually saturates.
 */
export function sat(x: number, k: number): number {
  if (!(x > 0)) return 0;
  return 1 - Math.exp(-x / k);
}

/** Wilson score interval lower bound for `successes` out of `n` trials. */
export function wilsonLower(successes: number, n: number, z: number): number {
  if (!(n > 0)) return 0;
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

export type Exclusion = "fork" | "profile_repo" | "excluded_kind";

export interface RepoScore {
  name: string;
  excluded: Exclusion | null;
  importance: number | null;
  share: number | null;
  authorship: number | null;
  volume: number | null;
  nature: number | null;
  durability: number | null;
  /** null when any factor is unknown; such repos contribute 0 to impact. */
  work: number | null;
  /** Share of the user's merged PRs here merged by independent people; null when unknown or owned. */
  endorsement: number | null;
  /** External accepted-work term (0 for owned or excluded repos), scaled by `endorsement`. */
  contrib: number;
  /** Counts toward breadth and longevity. */
  meaningful: boolean;
  /** Raw evidence kept for the continuous curve (curve.ts). */
  kind: string | null;
  active_months: number | null;
  forks: number | null;
  user_commits: number | null;
  user_rank: number | null;
  /** Side evidence, never scored. */
  primary_language: string | null;
  /** (issues_total + prs_total) / max(1, stars). */
  engagement: number | null;
  /** Project age in years at collection. */
  age_years: number | null;
  review_depth: number | null;
  /** Rule F hype project (`isHype`). */
  hype: boolean;
}

export interface DevScore {
  login: string;
  /** 0..100 */
  score: number;
  impact_score: number;
  breadth: number;
  breadth_score: number;
  longevity_years: number | null;
  longevity_score: number | null;
  collab_score: number | null;
  /** Σ of per-repo `contrib`. */
  contrib: number;
  /** max(sat(contrib, k_contrib), impact_score). */
  contrib_score: number;
  /** Sorted by work descending; excluded and unknown-work repos last. */
  repos: RepoScore[];
}

/**
 * Repo kinds that are not engineering: docs, sites, guides, lists and content
 * feed the capped content bonus (curve.contentBonus), never the main score.
 */
export function isExcludedKind(kind: string): boolean {
  return ["profile", "list", "config", "content", "docs", "site"].includes(kind);
}

function exclusion(login: string, r: Repo): Exclusion | null {
  if (r.is_fork) return "fork";
  const slash = r.name.indexOf("/");
  if (slash >= 0 && eqlIgnoreCase(r.name.slice(0, slash), login) && eqlIgnoreCase(r.name.slice(slash + 1), login)) {
    return "profile_repo";
  }
  if (r.kind !== null && isExcludedKind(r.kind)) return "excluded_kind";
  return null;
}

/**
 * How many people other than the user build on, depend on or use the project,
 * in [0, 1]: the strongest of other contributors, dependents, outside issue
 * authors (issue_weight) and forks (fork_weight), each as `logScale`.
 * Stars never count. Unknown signals are skipped; null when all are unknown.
 */
export function scale(r: Repo, p: Params): number | null {
  const contributors = r.contributors_total !== null ? Math.max(0, r.contributors_total - 1) : null;
  const ev: [number | null, number, number][] = [
    [contributors, p.full_contributors, 1],
    [r.dependents, p.full_dependents, 1],
    [r.issue_authors, p.full_issue_authors, p.issue_weight],
    [r.forks, p.full_forks, p.fork_weight],
  ];
  let best: number | null = null;
  for (const [x, full, w] of ev) {
    if (x !== null) best = Math.max(best ?? 0, w * logScale(x, full, p.scale_noise));
  }
  return best;
}

/**
 * log(1 + x/noise) / log(1 + full/noise), capped at 1: every tenfold step of
 * adoption adds the same amount until `full`; counts well below `noise` stay near 0.
 */
export function logScale(x: number, full: number, noise: number): number {
  if (!(x > 0)) return 0;
  return Math.min(1, Math.log(1 + x / noise) / Math.log(1 + full / noise));
}

/** Days from an ISO timestamp to `now` (fractional year); null when either is unknown. */
function daysSince(ts: string | null, now: number | null): number | null {
  if (ts === null) return null;
  const t = fractionalYear(ts);
  if (t === null || now === null) return null;
  return Math.max(0, (now - t) * 365.25);
}

/**
 * Largest share of all stars gained in `weeks` consecutive weeks of a sparse
 * weekly `star_history` (missing weeks gained 0); null without history or stars.
 */
export function starSpikeShare(hist: StarWeek[] | null, weeks: number): number | null {
  if (hist === null) return null;
  let total = 0;
  for (const w of hist) total += w[1];
  if (!(total > 0)) return null;
  const span = (weeks * 7) / 365.25;
  let best = 0;
  for (let i = 0; i < hist.length; i++) {
    const t0 = fractionalYear(hist[i][0]);
    if (t0 === null) continue;
    let sum = 0;
    for (let j = i; j < hist.length; j++) {
      const t = fractionalYear(hist[j][0]);
      if (t === null) continue;
      if (t - t0 >= span - 1e-9) break;
      sum += hist[j][1];
    }
    best = Math.max(best, sum);
  }
  return best / total;
}

/** isHype's verdict inputs once every gate up to F1 has passed; null when one fails (never hype). */
interface HypeGates {
  /** content/docs/site repos need F4. */
  content: boolean;
  f3: boolean;
  /** F4 without the spike: ≤ hype_spike_max_months active and idle ≥ hype_idle_days (idle known). */
  quiet: boolean;
}

/** The repo fields rule F's gates read (everything but `star_history`). */
export type HypeRepo = Pick<
  Repo,
  "owned" | "kind" | "stars" | "contributors_total" | "issue_authors" | "dependents" | "last_push_at" | "last_contrib_at" | "active_months" | "repo_total_commits" | "user_commits"
>;

/** Owned or led, judged kind, ≥ hype_min_stars, no veto, F1; then F3 and F4's short-life/idle part. */
function hypeGates(r: HypeRepo, now: number | null, p: Params): HypeGates | null {
  if (!r.owned && !leads(r, p)) return null;
  const k = r.kind ?? "code";
  if (k === "profile" || k === "list" || k === "config") return null;
  const stars = r.stars;
  if (stars === null || stars < p.hype_min_stars) return null;
  const others = Math.max(0, (r.contributors_total ?? 1) - 1);
  const ia = r.issue_authors ?? 0;
  const dep = r.dependents ?? 0;
  const idle = daysSince(r.last_push_at ?? r.last_contrib_at, now);
  const veto =
    (ia >= p.hype_veto_issue_authors || others >= p.hype_veto_contributors || dep >= 1) &&
    (idle !== null ? idle <= p.hype_veto_active_days : true);
  if (veto) return null;
  const f1 = stars >= p.hype_star_ratio * Math.max(1, others + ia + dep);
  if (!f1) return null;
  // unknown issue authors are not "no use": F3 needs the count
  const f3 = r.issue_authors !== null && dep < 1 && others <= p.hype_max_downstream && ia <= p.hype_max_downstream;
  const quiet = (r.active_months ?? 0) <= p.hype_spike_max_months && (idle !== null ? idle >= p.hype_idle_days : false);
  return { content: k === "content" || k === "docs" || k === "site", f3, quiet };
}

/**
 * Rule F (rubric v3 F): a promotion-driven project whose attention far exceeds
 * its use. Owned or led, not a profile/list/config repo, ≥ hype_min_stars stars;
 *   F1  stars ≥ hype_star_ratio · max(1, others + issue authors + dependents)
 *   F3  no downstream (few outside contributors/issue authors, no dependent)
 *   F4  promotion spike: most stars in a few weeks, short life, idle since
 *   veto  real use and pushed within a year
 * hype = ¬veto ∧ F1 ∧ (F3 ∨ F4); content/docs/site repos need F4.
 */
export function isHype(r: Repo, now: number | null, p: Params): boolean {
  const g = hypeGates(r, now, p);
  if (g === null) return false;
  const sh = starSpikeShare(r.star_history, p.hype_spike_weeks);
  const spike = sh !== null ? sh >= p.hype_spike_share : false;
  const f4 = spike && g.quiet;
  return g.content ? f4 : g.f3 || f4;
}

/**
 * Whether `star_history` can change `isHype(r, now, p)`: only F4's spike reads
 * it, and F4 decides only when the gates up to F1 pass, F3 does not already
 * settle a non-content repo, and the short-life/idle part of F4 holds. The
 * collector fetches star histories only for these repos (null elsewhere).
 */
export function hypeNeedsStarHistory(r: HypeRepo, now: number | null, p: Params = defaultParams): boolean {
  const g = hypeGates(r, now, p);
  return g !== null && (g.content || !g.f3) && g.quiet;
}

/** Project age in years at collection time (≥ 0); null when unknown. */
export function projectAge(r: Repo, now: number | null): number | null {
  if (now === null || r.created_at === null) return null;
  const created = fractionalYear(r.created_at);
  if (created === null) return null;
  return Math.max(0, now - created);
}

/**
 * Engineering-quality lift for a real personal project: an owned or led code
 * repo with ≥ quality_min_months active months that others use (not
 * `unusedByOthers`) gets importance ≥ importance_floor +
 * quality_lift·(has_tests + has_ci + has releases)/3 +
 * quality_tenure_lift·sat(active months, k_quality_months). null when the repo
 * does not qualify or none of the three signals is known.
 */
export function qualityLift(r: Repo, p: Params): number | null {
  if (!r.owned && !leads(r, p)) return null;
  if (unusedByOthers(r, p)) return null;
  if (r.kind === null || r.kind !== "code") return null;
  if ((r.active_months ?? 0) < p.quality_min_months) return null;
  if (r.has_tests === null && r.has_ci === null && r.releases_total === null) return null;
  const hits = Number(r.has_tests ?? false) + Number(r.has_ci ?? false) + Number((r.releases_total ?? 0) >= 1);
  return p.importance_floor + (p.quality_lift * hits) / 3 + p.quality_tenure_lift * sat(r.active_months ?? 0, p.k_quality_months);
}

/**
 * An own or led repo nobody else uses (see `Params.unused_work`): other
 * committers show use only with ≥ used_min_other_share of the commits (share
 * unknown, or the user's count above the total: any other committer counts);
 * issue reports need ≥ used_min_issue_authors authors. Fork counts are not use.
 */
export function unusedByOthers(r: Repo, p: Params): boolean {
  if (!r.owned && !leads(r, p)) return false;
  const others = Math.max(0, (r.contributors_total ?? 1) - 1);
  const total = r.repo_total_commits ?? 0;
  const mine = r.user_commits ?? 0;
  const otherShare = total > 0 && mine <= total ? (total - mine) / total : 1;
  const helped = others >= 1 && otherShare >= p.used_min_other_share;
  return !helped && (r.issue_authors ?? 0) < p.used_min_issue_authors && (r.dependents ?? 0) < 1;
}

/** The user wrote at least `quality_led_share` of a repo's commits. */
export function leads(r: Pick<Repo, "repo_total_commits" | "user_commits">, p: Params): boolean {
  const total = r.repo_total_commits;
  if (total === null || !(total > 0)) return false;
  return (r.user_commits ?? 0) / total >= p.quality_led_share;
}

/**
 * Project worth, owned and external alike: importance_floor +
 * (1 − importance_floor)·scale, raised to `qualityLift` where that applies;
 * a hype project gets only the floor. null when scale is unknown and no lift applies.
 */
export function importance(r: Repo, now: number | null, p: Params): number | null {
  let worth: number | null;
  if (isHype(r, now, p)) worth = p.importance_floor;
  else {
    const s = scale(r, p);
    worth = s !== null ? p.importance_floor + (1 - p.importance_floor) * s : null;
  }
  const lift = qualityLift(r, p);
  if (lift === null) return worth;
  return Math.max(worth ?? 0, lift);
}

/**
 * Share of the user's sampled merged PRs in a repo they do not own that
 * someone independent merged, weighted by who they are, in [0, 1]:
 * Σ counts·weight(merger) / Σ all counts. Self-merges count only as org staff
 * (`isOrgStaffRepo`); mutual mergers 0; bots only in repos with ≥
 * bot_merge_min_contributors; humans by `mergerWeight`. null when unknown.
 */
export function endorsement(r: Repo, p: Params): number | null {
  if (r.pr_mergers === null) return null;
  const botOk = (r.contributors_total ?? 0) >= p.bot_merge_min_contributors;
  const staff = isOrgStaffRepo(r, p);
  let total = 0;
  let independent = 0;
  for (const [who, v] of Object.entries(r.pr_mergers)) {
    const n = Math.max(0, v);
    total += n;
    if ((r.mutual_mergers ?? []).some((m) => eqlIgnoreCase(m, who))) continue;
    if (who === "[self]") {
      if (staff) independent += n * p.staff_self_merge_weight;
      continue;
    }
    if (who === "[bot]") {
      if (botOk) independent += n;
      continue;
    }
    independent += n * mergerWeight(r, who, p);
  }
  return total > 0 ? independent / total : null;
}

/**
 * An organization's public repo with a real contributor base: an employee's
 * direct pushes and self-merges there are work the organization accepted.
 */
function isOrgStaffRepo(r: Repo, p: Params): boolean {
  return !r.owned && (r.owner_is_org ?? false) && (r.contributors_total ?? 0) >= p.staff_min_contributors;
}

/**
 * Endorsement of work pushed straight to an org staff repo's default branch
 * (full as staff); null when not staff or most work went through PRs.
 */
function directPushEndorsement(r: Repo, p: Params): number | null {
  if (!isOrgStaffRepo(r, p)) return null;
  const uc = r.user_commits;
  if (uc === null) return null;
  // A PR's own commits land on the default branch too; only a real volume beyond the PRs is push work.
  const direct = Math.max(0, uc - p.direct_push_commits_per_pr * (r.user_merged_prs ?? 0));
  if (direct < p.direct_push_min_commits || direct / uc < p.direct_push_share) return null;
  return p.staff_self_merge_weight;
}

function mergerWeight(r: Repo, login: string, p: Params): number {
  if (r.merger_standing === null) return 1;
  for (const [k, v] of Object.entries(r.merger_standing)) {
    if (eqlIgnoreCase(k, login)) {
      const s = Math.min(1, Math.max(0, v));
      return p.merger_floor + (1 - p.merger_floor) * Math.pow(s, p.merger_exp);
    }
  }
  return 1;
}

/** Total PR reviews by the user in the repo (Σ `reviews_by_year`). */
function totalReviews(r: Repo): number {
  let sum = 0;
  for (const n of Object.values(r.reviews_by_year ?? {})) sum += Math.max(0, n);
  return sum;
}

/**
 * A repo the user maintains without owning it: importance ≥
 * maintainer_min_importance and ≥ maintainer_min_reviews PR reviews in total.
 */
export function isMaintained(r: Repo, rsImportance: number | null, p: Params): boolean {
  if (r.owned || rsImportance === null) return false;
  return rsImportance >= p.maintainer_min_importance && totalReviews(r) >= p.maintainer_min_reviews;
}

/**
 * Batch-farmed external PRs, all three required: most merged in same-day
 * batches, enough of them, and most sampled PRs large (a PR-reward campaign,
 * not review). Unknown share or substance: false.
 */
export function batchFarmed(r: Repo, p: Params): boolean {
  if (r.owned || r.pr_batch_share === null) return false;
  if (r.pr_batch_share < p.batch_share_min || (r.user_merged_prs ?? 0) < p.batch_min_prs) return false;
  const subs = r.pr_substance;
  if (subs === null || subs.length === 0) return false;
  let large = 0;
  for (const s of subs) if (s >= p.batch_large_lines) large += 1;
  return large / subs.length >= p.batch_large_share;
}

export function share(r: Repo, p: Params): number | null {
  const total = r.repo_total_commits;
  if (total !== null && total > 0) {
    if (r.user_commits !== null) return Math.min(1, r.user_commits / total);
    if (r.user_merged_prs !== null) return Math.min(1, r.user_merged_prs / Math.max(1, total / p.pr_commit_equiv));
  }
  if (r.owned) return 1.0;
  return null;
}

/**
 * Work measured by the user's own commits weighted by `w` (the repo's
 * `commitWeight`); merged PRs only stand in for an unknown commit count.
 */
export function volume(r: Repo, w: number, p: Params): number | null {
  if (r.user_commits === null && r.user_merged_prs === null) return null;
  return sat(effectiveCommits(r, w), p.k_vol);
}

/**
 * Own commits scaled by the mean commit weight `w`. In someone else's repo a
 * squash merge may land a PR as one unlinked commit, so the count is
 * max(commits, merged PRs); in own repos commits decide.
 */
export function effectiveCommits(r: Repo, w: number): number {
  const prs = r.user_merged_prs ?? 0;
  const uc = r.user_commits;
  const n = uc !== null ? (r.owned ? uc : Math.max(uc, prs)) : prs;
  return n * w;
}

/**
 * Mean weight of the user's commits in this repo:
 *   merge_share × merge credit + (1 − merge_share) × own
 * with `own` from sized commits (v6), else the commit sample (v5), else
 * `prFallbackWeight`. Bot-like sized histories scale by
 * 1 − (1 − bot_penalty)·botLikeness; hot core areas by `heatFactor` (never the
 * PR fallback).
 */
export function commitWeight(r: Repo, devRatio: number, p: Params): number {
  if (r.commit_sizes !== null && r.commit_sizes.length > 0) {
    const bot = botLikeness(r.commit_sizes, p);
    return heatFactor(r, p) * (1 - (1 - p.bot_penalty) * bot) * sizedCommitWeight(r, r.commit_sizes, devRatio, p);
  }
  const sample = r.commit_sample;
  if (sample === null) return prFallbackWeight(r, p);
  const ms = Math.min(1, Math.max(0, r.commit_merge_share ?? 0));
  let own = 0;
  if (sample.length > 0) {
    let sum = 0;
    for (const c of sample) sum += kindWeight(c.kind, p) * sizeWeight(c.substance, p);
    own = sum / sample.length;
  } else if (ms < 1) return prFallbackWeight(r, p);
  return heatFactor(r, p) * (ms * mergeCredit(r, p) + (1 - ms) * own);
}

/**
 * Mean `heat` over the sampled core commits that carry one; null with fewer
 * than heat_min_commits such commits (unknown, not cold).
 */
export function coreHeat(r: Repo, p: Params): number | null {
  let sum = 0;
  let n = 0;
  for (const c of r.commit_sample ?? []) {
    if (c.kind !== "core" || c.heat === null) continue;
    sum += Math.min(1, Math.max(0, c.heat));
    n += 1;
  }
  return n > 0 && n >= p.heat_min_commits ? sum / n : null;
}

/** 1 + heat_bonus·sat(coreHeat, k_heat), 1 when unknown: a bonus only. */
export function heatFactor(r: Repo, p: Params): number {
  const h = coreHeat(r, p);
  if (h === null) return 1;
  return 1 + p.heat_bonus * sat(h, p.k_heat);
}

/** v6 commit weight from the sized commit list (see `commitWeight`). */
export function sizedCommitWeight(r: Repo, sizes: CommitSize[], devRatio: number, p: Params): number {
  const ratio = r.commit_sample !== null ? (productRatio([r.commit_sample]) ?? devRatio) : devRatio;
  let merges = 0;
  let sizeSum = 0;
  for (const c of sizes) {
    if (c.merge) merges += 1;
    else sizeSum += changeWeight(r, c.lines * ratio, p);
  }
  const n = sizes.length;
  const ms = merges / n;
  const own = merges < n ? (sampleKindFactor(r, p) * sizeSum) / (n - merges) : 0;
  return ms * mergeCredit(r, p) + (1 - ms) * own;
}

/**
 * How machine-made a commit history looks, in {0, 1} (v8), judged only with ≥
 * bot_min_commits timestamped commits: 1 when ≥ bot_hour_share of them share
 * one UTC hour (a cron job) or the non-merge sizes have a coefficient of
 * variation below bot_cv (generated, same-shaped commits).
 */
export function botLikeness(sizes: CommitSize[], p: Params): number {
  const hours = new Array<number>(24).fill(0);
  let timed = 0;
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (const c of sizes) {
    if (c.at !== null) {
      // hour of "YYYY-MM-DDTHH:…"
      const h = c.at.length >= 13 && c.at[10] === "T" ? parseUint(c.at.slice(11, 13), 255) : null;
      if (h !== null && h < 24) {
        hours[h] += 1;
        timed += 1;
      }
    }
    if (c.merge) continue;
    n += 1;
    sum += c.lines;
    sumSq += c.lines * c.lines;
  }
  if (timed < p.bot_min_commits) return 0;
  if (Math.max(...hours) >= p.bot_hour_share * timed) return 1;
  if (n < p.bot_min_commits) return 0;
  const mean = sum / n;
  if (!(mean > 0)) return 1; // only empty commits
  const variance = Math.max(0, sumSq / n - mean * mean);
  return Math.sqrt(variance) / mean < p.bot_cv ? 1 : 0;
}

/** Mean kind weight of the sampled non-merge commits; `prShare` without any. */
function sampleKindFactor(r: Repo, p: Params): number {
  let sum = 0;
  let n = 0;
  for (const c of r.commit_sample ?? []) {
    if (c.kind === "merge") continue;
    sum += kindWeight(c.kind, p);
    n += 1;
  }
  return n > 0 ? sum / n : prShare(r, p);
}

/**
 * Fraction of changed lines that are hand-written product code over sampled
 * commits with a known line count (Σ substance / Σ lines, clamped to [0, 1]);
 * null without lines. `productRatio` of one repo, `developerProductRatio` of all.
 */
function productRatio(samples: Commit[][]): number | null {
  let substance = 0;
  let lines = 0;
  for (const sample of samples) {
    for (const c of sample) {
      if (c.lines > 0) {
        substance += c.substance;
        lines += c.lines;
      }
    }
  }
  if (!(lines > 0)) return null;
  return Math.min(1, Math.max(0, substance / lines));
}

/**
 * The developer's product-code ratio across every repo's commit sample, for
 * repos sized without a sample of their own; 1 without any sample.
 */
export function developerProductRatio(repos: Repo[]): number {
  return productRatio(repos.map((r) => r.commit_sample ?? [])) ?? 1;
}

function mergeCredit(r: Repo, p: Params): number {
  const maintainer = r.user_rank !== null ? r.user_rank >= 1 && r.user_rank <= 3 : r.owned || (r.user_commits ?? 0) >= 1000;
  return maintainer ? p.maintainer_merge_credit : 0;
}

/** One change in an owned repo: max(commit_size_floor, sat(lines, k_commit_lines)). */
function sizeWeight(lines: number, p: Params): number {
  return Math.max(p.commit_size_floor, sat(lines, p.k_commit_lines));
}

/**
 * One accepted change in someone else's repo:
 * clamp(log2(1 + lines/k_commit_lines), commit_size_floor, accepted_size_cap).
 */
export function acceptedSizeWeight(lines: number, p: Params): number {
  const units = Math.log2(1 + Math.max(0, lines) / p.k_commit_lines);
  return Math.min(p.accepted_size_cap, Math.max(p.commit_size_floor, units));
}

function changeWeight(r: Repo, lines: number, p: Params): number {
  return r.owned ? sizeWeight(lines, p) : acceptedSizeWeight(lines, p);
}

/**
 * Commit weight without a commit sample: each sampled merged PR's product-code
 * lines as one change, scaled by the PR-kind share; else the share alone.
 */
function prFallbackWeight(r: Repo, p: Params): number {
  const ks = prShare(r, p);
  const subs = r.pr_substance;
  if (subs === null || subs.length === 0) return ks;
  let sum = 0;
  for (const lines of subs) sum += changeWeight(r, lines, p);
  return (ks * sum) / subs.length;
}

function kindWeight(kind: string, p: Params): number {
  if (kind === "core" || kind === "test") return 1;
  if (kind === "docs") return p.nature_docs;
  if (kind === "site") return p.nature_site;
  if (kind === "data") return p.nature_data;
  if (kind === "chore") return p.chore_credit;
  return 0; // merge
}

/**
 * Fraction of the user's classified merged PRs that are real work (core and
 * test fully, docs/site/data by nature, chore by chore_credit, merges 0); 1
 * without PR data.
 */
export function prShare(r: Repo, p: Params): number {
  const k = r.pr_kinds;
  if (k === null) return 1;
  const core = k.core ?? 0;
  const tst = k.test ?? 0;
  const docs = k.docs ?? 0;
  const site = k.site ?? 0;
  const chore = k.chore ?? 0;
  const data = k.data ?? 0;
  const merge = k.merge ?? 0;
  const n = core + tst + docs + site + chore + data + merge;
  if (n === 0) return 1;
  return (core + tst + docs * p.nature_docs + site * p.nature_site + chore * p.chore_credit + data * p.nature_data) / n;
}

function kindNature(kind: string | null, p: Params): number {
  if (kind === null) return p.nature_core; // unclassified: assume code
  if (kind === "code") return p.nature_core;
  if (kind === "docs") return p.nature_docs;
  if (kind === "site") return p.nature_site;
  if (kind === "data") return p.nature_data;
  return 0; // profile / list / config / content (excluded before this)
}

function commitNature(kind: string, p: Params): number {
  if (kind === "core") return p.nature_core;
  if (kind === "test") return p.nature_test;
  if (kind === "docs") return p.nature_docs;
  if (kind === "site") return p.nature_site;
  if (kind === "data") return p.nature_data;
  if (kind === "chore") return p.nature_chore;
  return 0;
}

/**
 * Nature of the user's work in this repo. With ≥ 4 sampled commits the sample
 * (merges excluded, each capped at the repo kind) decides; otherwise PR kinds
 * plus the repo kind for commits beyond the PR count; else the repo kind.
 */
export function nature(r: Repo, p: Params): number {
  const kn = kindNature(r.kind, p);
  if (kn === 0) return 0;
  // Fewer than 4 sampled commits is too little to override the repo kind.
  if (r.commit_sample !== null && r.commit_sample.length >= 4) {
    let sum = 0;
    let n = 0;
    for (const c of r.commit_sample) {
      if (c.kind === "merge") continue;
      // A commit is never "more code" than its repo.
      sum += Math.min(kn, commitNature(c.kind, p));
      n += 1;
    }
    if (n > 0) return sum / n;
  }
  const k = r.pr_kinds;
  if (k !== null) {
    const core = k.core ?? 0;
    const tst = k.test ?? 0;
    const docs = k.docs ?? 0;
    const site = k.site ?? 0;
    const chore = k.chore ?? 0;
    const data = k.data ?? 0;
    const merge = k.merge ?? 0;
    const n = core + tst + docs + site + chore + data + merge;
    if (n > 0) {
      const direct = Math.max(0, (r.user_commits ?? 0) - (r.user_merged_prs ?? 0));
      const own = n - merge + direct;
      if (own <= 0) return kn;
      return (
        (core * p.nature_core + tst * p.nature_test + chore * p.nature_chore + docs * p.nature_docs + site * p.nature_site + data * p.nature_data + direct * kn) /
        own
      );
    }
  }
  return kn;
}

export function durability(r: Repo, p: Params): number | null {
  if (r.active_months === null) return null;
  return sat(r.active_months, p.k_durability);
}

/**
 * Best of three views of "how much of this is theirs": sqrt(share); the lead
 * ratio (own commits vs the #1 contributor, rank as fallback) ×
 * sat(commits, k_rank_commits); sat(commits, k_own). Commit counts are
 * weighted by `w`, the repo's `commitWeight`.
 */
export function authorship(shareV: number, r: Repo, w: number, p: Params): number {
  const uc = effectiveCommits(r, w);
  // w can exceed 1 in others' repos (accepted size); a share stays ≤ 1.
  let a = Math.max(Math.sqrt(Math.min(1, shareV * w)), sat(uc, p.k_own));
  let standing: number | null = null;
  const top = r.top_contributor_commits;
  if (top !== null && r.user_commits !== null && top > 0) {
    standing = Math.pow(Math.min(1, r.user_commits / top), p.lead_exp);
  } else if (r.user_rank !== null && r.user_rank >= 1) {
    standing = Math.pow(r.user_rank, -p.rank_exp);
  }
  if (standing !== null) a = Math.max(a, standing * sat(uc, p.k_rank_commits));
  return a;
}

/** Weighted geometric form of the five factors; exponents < 1 soften a penalty. */
export function work(i: number, a: number, v: number, n: number, d: number, p: Params): number {
  return (
    Math.pow(i, p.e_importance) * Math.pow(a, p.e_authorship) * Math.pow(v, p.e_volume) * Math.pow(n, p.e_nature) * Math.pow(d, p.e_durability)
  );
}

/** Side evidence: (issues_total + prs_total) / max(1, stars); never scored. */
export function engagement(r: Repo): number | null {
  if (r.issues_total === null || r.prs_total === null) return null;
  return (r.issues_total + r.prs_total) / Math.max(1, r.stars ?? 0);
}

/** Scores one repo. `devRatio` is `developerProductRatio`; `now` the collection year. */
export function scoreRepo(login: string, r: Repo, devRatio: number, now: number | null, p: Params): RepoScore {
  return scoreRepoHype(login, r, isHype(r, now, p), devRatio, now, p);
}

/**
 * `scoreRepo` with the rule-F verdict decided by the caller on the repo's true
 * adoption signals (the H1 rewrite in `scoreDeveloper` hides them from this
 * user's credit, but it does not make a used project unused).
 */
export function scoreRepoHype(login: string, r: Repo, hype: boolean, devRatio: number, now: number | null, p: Params): RepoScore {
  const rs: RepoScore = {
    name: r.name,
    excluded: null,
    importance: null,
    share: null,
    authorship: null,
    volume: null,
    nature: null,
    durability: null,
    work: null,
    endorsement: null,
    contrib: 0,
    meaningful: false,
    kind: r.kind,
    active_months: r.active_months,
    forks: r.forks,
    user_commits: r.user_commits,
    user_rank: r.user_rank,
    primary_language: r.primary_language,
    engagement: engagement(r),
    age_years: projectAge(r, now),
    review_depth: r.review_depth,
    hype,
  };
  const e = exclusion(login, r);
  if (e !== null) {
    rs.excluded = e;
    rs.work = 0;
    return rs;
  }
  const w = commitWeight(r, devRatio, p);
  rs.importance = hype ? p.importance_floor : importance(r, null, p);
  rs.share = share(r, p);
  rs.authorship = rs.share !== null ? authorship(rs.share, r, w, p) : null;
  const maintained = isMaintained(r, rs.importance, p);
  if (maintained) rs.authorship = Math.max(rs.authorship ?? 0, p.maintainer_authorship);
  rs.volume = volume(r, w, p);
  const nat = nature(r, p);
  rs.nature = nat;
  rs.durability = durability(r, p);
  if (rs.importance !== null && rs.authorship !== null && rs.volume !== null && rs.durability !== null) {
    rs.work = work(rs.importance, rs.authorship, rs.volume, nat, rs.durability, p);
    if (unusedByOthers(r, p)) rs.work = rs.work * p.unused_work;
  }
  const imp = rs.importance ?? 0;
  // External contribution: the user's own commits in someone else's repo,
  // weighted by what they changed and by nature, counted only as far as an
  // independent person accepted them.
  const eff = effectiveCommits(r, w);
  if (!r.owned) {
    rs.endorsement = directPushEndorsement(r, p) ?? endorsement(r, p);
    if (maintained) {
      rs.endorsement = Math.max(rs.endorsement ?? 0, p.maintainer_endorsement);
    } else if (batchFarmed(r, p)) {
      rs.endorsement = (rs.endorsement ?? 1) * p.batch_penalty;
    }
    rs.contrib = (rs.endorsement ?? 1) * imp * nat * sat(eff, p.k_contrib_commits);
    // Reviews given here count as stewardship (Params.review_contrib).
    rs.contrib += p.review_contrib * imp * sat(Math.max(0, totalReviews(r) - p.review_contrib_min), p.k_review_contrib);
  }
  // Accepted external work with ≥ 1 commit's worth of change also counts for
  // breadth/longevity even when `work` is tiny, unless nobody independent merged it.
  rs.meaningful =
    (rs.work ?? 0) >= p.breadth_min_work || (!r.owned && eff >= 1 && imp >= p.meaningful_min_importance && (rs.endorsement ?? 1) > 0);
  return rs;
}

/**
 * Years with meaningful work: union of [first, last] contribution intervals of
 * meaningful repos, capped by their summed active months.
 */
function longevityYears(repos: Repo[], scores: RepoScore[]): number | null {
  const intervals: { start: number; end: number }[] = [];
  let months = 0;
  let anyMeaningful = false;
  let anyEvidence = false;
  repos.forEach((r, i) => {
    if (!scores[i].meaningful) return;
    anyMeaningful = true;
    if (r.active_months !== null) {
      months += r.active_months;
      anyEvidence = true;
    }
    const a = r.first_contrib_at !== null ? fractionalYear(r.first_contrib_at) : null;
    const b = r.last_contrib_at !== null ? fractionalYear(r.last_contrib_at) : null;
    if (a === null || b === null) return;
    if (b >= a) intervals.push({ start: a, end: b + 1.0 / 12.0 });
  });
  if (!anyMeaningful) return 0;
  if (!anyEvidence) return null;
  intervals.sort((x, y) => (x.start < y.start ? -1 : y.start < x.start ? 1 : 0));
  let span = 0;
  let cur: { start: number; end: number } | null = null;
  for (const iv of intervals) {
    if (cur !== null) {
      if (iv.start <= cur.end) {
        cur.end = Math.max(cur.end, iv.end);
        continue;
      }
      span += cur.end - cur.start;
    }
    cur = { ...iv };
  }
  if (cur !== null) span += cur.end - cur.start;
  const byMonths = months / 12;
  return intervals.length === 0 ? byMonths : Math.min(span, byMonths);
}

/**
 * Rubric v3 H1: a non-owned repo where, over 24 months (`ext_prs`, contract
 * v13), ≥ unrev_min_prs of the user's PRs were merged and ≥ unrev_share of
 * them self-merged with no reviewer, is one person driving a repo nobody
 * checks. Without reviewer data: false.
 */
export function unreviewedSelfDriven(d: Developer, repo: string, p: Params): boolean {
  if (d.ext_prs === null) return false;
  let merged = 0;
  let unreviewed = 0;
  for (const x of d.ext_prs) {
    if (x.state !== "MERGED" || !eqlIgnoreCase(x.repo, repo)) continue;
    if (x.reviewers === null) return false; // v12 data: no reviewer info
    merged += 1;
    const self = x.merged_by !== null ? eqlIgnoreCase(x.merged_by, d.login) : false;
    if (self && x.reviewers.length === 0) unreviewed += 1;
  }
  return merged >= p.unrev_min_prs && unreviewed >= p.unrev_share * merged;
}

/**
 * Whether H1 can apply to `r` whatever the reviewers are: a non-owned repo
 * with < unrev_adopted outside contributors and ≥ unrev_min_prs MERGED PRs of
 * `prs` in it (`unreviewedSelfDriven`'s repo match). Reviewers of other PRs
 * never change the score, so the collector fetches them only for these repos.
 */
export function unreviewedCandidate(
  r: Pick<Repo, "name" | "owned" | "contributors_total">,
  prs: readonly Pick<ExtPr, "state" | "repo">[] | null,
  p: Params = defaultParams,
): boolean {
  if (r.owned || prs === null || Math.max(0, (r.contributors_total ?? 0) - 1) >= p.unrev_adopted) return false;
  return prs.filter((x) => x.state === "MERGED" && eqlIgnoreCase(x.repo, r.name)).length >= p.unrev_min_prs;
}

export function scoreDeveloper(d: Developer, p: Params = defaultParams): DevScore {
  const scores: RepoScore[] = [];
  let contrib = 0;
  let breadth = 0;
  const devRatio = developerProductRatio(d.repos);
  // Project ages are measured at collection, not by the wall clock.
  const now = d.collected_at !== null ? fractionalYear(d.collected_at) : null;
  for (const r of d.repos) {
    let repo = r;
    if (unreviewedCandidate(r, d.ext_prs, p) && unreviewedSelfDriven(d, r.name, p)) {
      // self-merges no longer count as org-endorsed staff work, nor its size for this user
      repo = { ...r, owner_is_org: false, contributors_total: 1, forks: 0, issue_authors: 0, dependents: 0 };
    }
    const s = scoreRepoHype(d.login, repo, isHype(r, now, p), devRatio, now, p);
    scores.push(s);
    contrib += s.contrib;
    if (s.meaningful) breadth += 1;
  }
  const years = longevityYears(d.repos, scores);
  // stable, like Zig's std.mem.sort
  scores.sort((a, b) => (b.work ?? 0) - (a.work ?? 0));
  // The k-th best repo counts 1/k^impact_rank_exp: many small repos cannot add up to a flagship.
  let impact = 0;
  scores.forEach((s, i) => {
    impact += (s.work ?? 0) / Math.pow(i + 1, p.impact_rank_exp);
  });

  // Rejections are only observable on others' repos, so pair them with external merges.
  let collab: number | null = null;
  const merged = d.prs_merged_external ?? d.prs_merged_total;
  const rejected = d.prs_rejected_by_maintainer;
  if (merged !== null && rejected !== null && merged + rejected >= p.collab_min_decided) {
    collab = wilsonLower(merged, merged + rejected, p.wilson_z);
  }

  const impactScore = sat(impact, p.k_impact);
  const breadthScore = sat(breadth, p.k_breadth);
  const longevityScore = years !== null ? sat(years, p.k_longevity) : null;
  // Accepted external work is a floor under impact, not a second reward for it.
  const contribScore = Math.max(sat(contrib, p.k_contrib), impactScore);

  let num = p.w_impact * impactScore + p.w_breadth * breadthScore + p.w_contrib * contribScore;
  let den = p.w_impact + p.w_breadth + p.w_contrib;
  if (longevityScore !== null) {
    num += p.w_longevity * longevityScore;
    den += p.w_longevity;
  }
  if (collab !== null) {
    num += p.w_collab * collab;
    den += p.w_collab;
  }
  return {
    login: d.login,
    score: (100 * num) / den,
    impact_score: impactScore,
    breadth,
    breadth_score: breadthScore,
    longevity_years: years,
    longevity_score: longevityScore,
    collab_score: collab,
    contrib,
    contrib_score: contribScore,
    repos: scores,
  };
}
