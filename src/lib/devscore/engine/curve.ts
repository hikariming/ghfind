/**
 * Continuous scoring (port of devscore src/curve.zig; docs/tuning.md rounds 5 and 15).
 *
 *   score = 100 · (1 − (1 + E/k_final)^−tail)
 *   E = max(geometric mean of the evidence dimensions, accepted-work floor)
 *
 * The dimensions: flagship (authored projects others depend on, the 2nd and
 * 3rd counting 1/2 and 1/3, scaled by recency on each), sustained
 * (recency-weighted code-years; reviews count review_weight of code and only
 * on top of code), base (the engine score) and accepted external work. The
 * geometric mean punishes a weak dimension without a cliff; the power tail
 * makes each point near the top cost more evidence.
 *
 * Recency: work from y years before collection counts
 * max(recency_floor, 0.5^(y / half_life)), so achievements fade but never vanish.
 *
 * v8: the main score counts engineering only. Owned non-engineering repos add
 * a capped `content_bonus`, and `confidence` says how much public evidence the
 * score rests on.
 */
import type { Developer, NumMap, Repo } from "../model";
import { parseUint } from "./ascii";
import { sat, type DevScore, type RepoScore } from "./score";

export interface Params {
  half_life: number;
  recency_floor: number;
  /** One PR review is worth this fraction of a code unit. */
  review_weight: number;
  /** A code month equals this many reviews at full weight. */
  reviews_per_month: number;
  /** Weight of endorsed external work (RepoScore.contrib) as a flagship candidate. */
  contrib_flagship: number;
  /** Flagship strength: importance · min(1, authorship/auth_ref) · sat(months, k_months) · nature · volume. */
  k_months: number;
  auth_ref: number;
  /** Own-commit volume bonus in one repo: × (1 + sat(commits, k_mass_commits)). */
  k_mass_commits: number;
  /** Code months of fresh work on a flagship that count as "still maintaining it". */
  k_fresh: number;
  /** Sustained code counts importance lightly: × (floor + (1−floor)·importance). */
  sustained_imp_floor: number;
  /** Geometric-mean exponents (sum 1) and offsets (docs/tuning.md round 5). */
  w_flagship: number;
  w_sustained: number;
  w_base: number;
  eps_flagship: number;
  eps_sustained: number;
  eps_base: number;
  base_scale: number;
  /** Accepted external work (substance-weighted). */
  w_contrib: number;
  eps_contrib: number;
  k_final: number;
  /** Power-tail exponent of `finalCurve`: smaller keeps more room above 90. */
  tail: number;
  /** E floor from accepted external work (`acceptedFloor`). */
  accepted_floor: number;
  k_accepted: number;
  /** Content bonus: min(cap, scale · Σ sat(forks + other contributors, k_content)). */
  content_cap: number;
  content_bonus_scale: number;
  k_content: number;
  /** Confidence (`confidence`, `gatherEvidence`). */
  conf_strong_importance: number;
  conf_strong_authorship: number;
  conf_strong_weight: number;
  conf_top_repos: number;
  conf_high_evidence: number;
  conf_high_completeness: number;
  conf_high_years: number;
  conf_low_evidence: number;
  conf_low_completeness: number;
  /** Maintainer track: strength = importance · sat(Σ recency-weighted months, k_maint_months). */
  k_maint_months: number;
  /** E_maint = maint_scale · evidence(maint flagship, maint sustained, base, 0). */
  maint_scale: number;
  /** E = max(E_dev, E_maint) + other_track_bonus · min(E_dev, E_maint). */
  other_track_bonus: number;
  /** A role counts only with this many maintainer months in total. */
  maint_min_months: number;
  /** ... and gatekeeping (others' PRs merged) or ownership (authorship). */
  maint_min_merged: number;
  maint_min_authorship: number;
  /** `status`: months in the current and previous calendar year. */
  status_min_months: number;
  /** Maintenance fades faster than code. */
  maint_half_life: number;
  maint_recency_floor: number;
}

export const defaultParams: Readonly<Params> = Object.freeze({
  half_life: 3,
  recency_floor: 0.4,
  review_weight: 0.3,
  reviews_per_month: 20,
  contrib_flagship: 0.7,
  k_months: 6,
  auth_ref: 1.0,
  k_mass_commits: 5000,
  k_fresh: 6,
  sustained_imp_floor: 0.2,
  w_flagship: 0.45,
  w_sustained: 0.05,
  w_base: 0.5,
  eps_flagship: 0.1,
  eps_sustained: 0.5,
  eps_base: 0.2,
  base_scale: 1.5,
  w_contrib: 0.05,
  eps_contrib: 0.5,
  k_final: 1.6,
  tail: 3,
  accepted_floor: 0.35,
  k_accepted: 0.5,
  content_cap: 5,
  content_bonus_scale: 5,
  k_content: 20,
  conf_strong_importance: 0.3,
  conf_strong_authorship: 0.5,
  conf_strong_weight: 3,
  conf_top_repos: 10,
  conf_high_evidence: 15,
  conf_high_completeness: 0.6,
  conf_high_years: 3,
  conf_low_evidence: 3,
  conf_low_completeness: 0.3,
  k_maint_months: 24,
  maint_scale: 1.1,
  other_track_bonus: 0.25,
  maint_min_months: 6,
  maint_min_merged: 3,
  maint_min_authorship: 0.3,
  status_min_months: 2,
  maint_half_life: 2,
  maint_recency_floor: 0.2,
});

export type Confidence = "high" | "med" | "low";

/** What the developer does lately (contract v11): shown, never scored. */
export type Status = "active" | "maintaining" | "inactive";

export interface Result {
  /** min(100, main + content_bonus) */
  score: number;
  /** Engineering score from E. */
  main: number;
  /** Capped bonus for owned non-engineering repos others use. */
  content_bonus: number;
  /** How much public evidence backs the score; low is not low skill. */
  confidence: Confidence;
  /** max(E_dev, E_maint) + other_track_bonus · min(E_dev, E_maint). */
  e: number;
  /** Developer track: max(evidence, accepted-work floor). */
  e_dev: number;
  /** Maintainer track (contract v11); 0 without verified maintainer data. */
  e_maint: number;
  maint_flagship: number;
  maint_sustained: number;
  status: Status;
  flagship: number;
  /** Recency-weighted code-years. */
  sustained: number;
  /** Share of the developer's code units from the last 3 years (null: no timeline). */
  recent_share: number | null;
}

/** Recency weight of work done in calendar `year` when collected at `now`. */
export function recency(year: number, now: number, p: Params): number {
  return decay(year, now, p.half_life, p.recency_floor);
}

export function maintRecency(year: number, now: number, p: Params): number {
  return decay(year, now, p.maint_half_life, p.maint_recency_floor);
}

function decay(year: number, now: number, halfLife: number, floor: number): number {
  const age = Math.max(0, now - (year + 0.5));
  return Math.max(floor, Math.pow(0.5, age / halfLife));
}

/**
 * Code-month equivalents of one year: reviews add review_weight ·
 * reviews / reviews_per_month, never more than the year's code months plus a
 * small allowance: review alone cannot make a year of code.
 */
export function yearUnits(codeMonths: number, reviews: number, p: Params): number {
  const rev = (p.review_weight * reviews) / p.reviews_per_month;
  return codeMonths + Math.min(rev, codeMonths + 3 * p.review_weight);
}

/** Calendar years 2000..2000+YEAR_SPAN-1 tracked by the timeline. */
const YEAR_SPAN = 40;

interface Timeline {
  weighted: number;
  raw: number;
  recent: number;
  fresh: number;
  /** Recency-weighted code units per calendar year (index = year − 2000). */
  by_year: number[];
}

/** Value of a per-year map for `year` (0 when absent). */
function yearValue(m: NumMap | null, year: number): number {
  return m !== null && Object.hasOwn(m, String(year)) ? m[String(year)] : 0;
}

function repoTimeline(r: Repo, now: number, p: Params): Timeline | null {
  if (r.code_months_by_year === null && r.reviews_by_year === null) return null;
  const t: Timeline = { weighted: 0, raw: 0, recent: 0, fresh: 0, by_year: new Array<number>(YEAR_SPAN).fill(0) };
  for (let y = 2000; y <= now; y++) {
    const code = yearValue(r.code_months_by_year, y);
    const u = yearUnits(code, yearValue(r.reviews_by_year, y), p);
    if (u === 0) continue;
    const w = recency(y, now, p);
    t.raw += u;
    t.weighted += u * w;
    if (y - 2000 < YEAR_SPAN) t.by_year[y - 2000] = u * w;
    // "Still maintaining the flagship" needs code: reviews do not restore the author's recency.
    t.fresh += (code * (w - p.recency_floor)) / (1 - p.recency_floor);
    if (now - y < 3) t.recent += u;
  }
  return t;
}

/**
 * Flagship recency multiplier in [recency_floor, 1): floor plus the fresh part
 * of the repo's work, saturating at `k_fresh` code months.
 */
export function flagshipRecency(fresh: number, p: Params): number {
  return p.recency_floor + (1 - p.recency_floor) * sat(fresh, p.k_fresh);
}

/**
 * Flagship strength of one repo: adoption × authorship × sustained months ×
 * nature × own-code volume; only engineering (not excluded, not content).
 * In someone else's repo, accepted work (`rs.contrib`) is a candidate at
 * `contrib_flagship` weight.
 */
function flagshipStrength(rs: RepoScore, p: Params): number {
  if (rs.excluded !== null || isContentKind(rs.kind)) return 0;
  if (rs.importance === null || rs.authorship === null || rs.active_months === null) return 0;
  const vol = rs.volume ?? 0;
  const own = rs.importance * Math.min(1.0, rs.authorship / p.auth_ref) * sat(rs.active_months, p.k_months) * (rs.nature ?? 1) * vol;
  return Math.max(own, p.contrib_flagship * rs.contrib);
}

/**
 * Non-engineering repo kinds: content, list, docs, site. `data` repos are not
 * content: they stay in the main score, weighted by `nature_data`.
 */
function isContentKind(kind: string | null): boolean {
  return kind === "content" || kind === "list" || kind === "docs" || kind === "site";
}

/**
 * Capped bonus for the developer's own non-engineering repos: each counts
 * sat(forks + other contributors, k_content), stars never; at most content_cap.
 */
export function contentBonus(d: Developer, s: DevScore, p: Params): number {
  let sum = 0;
  for (const rs of s.repos) {
    if (!isContentKind(rs.kind)) continue;
    if (rs.excluded !== null && rs.excluded !== "excluded_kind") continue; // forks, profile repo
    const r = findRepo(d, rs.name);
    if (r === null || !r.owned) continue;
    const others = Math.max(0, (r.contributors_total ?? 1) - 1);
    sum += sat((r.forks ?? 0) + others, p.k_content);
  }
  return Math.min(p.content_cap, p.content_bonus_scale * sum);
}

/**
 * Public evidence behind a score: independently endorsed external merged PRs
 * plus conf_strong_weight per strong repo (`evidence`); the share of the top
 * repos the collector measured (`completeness`); distinct calendar years with
 * own code (`code_years`).
 */
export interface Evidence {
  evidence: number;
  completeness: number;
  code_years: number;
}

/** high: evidence ≥ 15, completeness ≥ 0.6, ≥ 3 code-years; low: evidence < 3 or completeness < 0.3. */
export function confidence(ev: Evidence, p: Params): Confidence {
  if (ev.evidence < p.conf_low_evidence || ev.completeness < p.conf_low_completeness) return "low";
  if (ev.evidence >= p.conf_high_evidence && ev.completeness >= p.conf_high_completeness && ev.code_years >= p.conf_high_years) {
    return "high";
  }
  return "med";
}

/** Gathers `Evidence` from the scored repos (sorted by work, best first). */
export function gatherEvidence(d: Developer, s: DevScore, p: Params): Evidence {
  const ev: Evidence = { evidence: 0, completeness: 0, code_years: 0 };
  let top = 0;
  let sized = 0;
  const years = new Set<number>();
  for (const rs of s.repos) {
    const r = findRepo(d, rs.name);
    if (r === null) continue;
    for (const [k, v] of Object.entries(r.code_months_by_year ?? {})) {
      const y = parseUint(k, 65535);
      if (y !== null && v > 0 && y >= 2000 && y < 2128) years.add(y);
    }
    if (rs.excluded !== null) continue;
    if (top < p.conf_top_repos) {
      top += 1;
      if ((r.commit_sizes !== null && r.commit_sizes.length > 0) || r.contributors_total !== null) sized += 1;
    }
    if (!r.owned) ev.evidence += (r.user_merged_prs ?? 0) * (rs.endorsement ?? 1);
    // A verified maintainer of an important repo is backed like its author: one credit either way.
    const strongAuthor = (rs.importance ?? 0) >= p.conf_strong_importance && (rs.authorship ?? 0) >= p.conf_strong_authorship;
    const strongMaint =
      maintCounts(r, rs, p) && (rs.importance ?? 0) >= p.conf_strong_importance && monthsSince(r.maint_months_by_year, 0) >= 12;
    if (strongAuthor || strongMaint) ev.evidence += p.conf_strong_weight;
  }
  ev.completeness = top > 0 ? sized / top : 0;
  ev.code_years = years.size !== 0 ? years.size : (s.longevity_years ?? 0);
  return ev;
}

/** Keeps the three largest values seen, descending. */
function insertTop(top: number[], v: number): void {
  let x = v;
  for (let i = 0; i < top.length; i++) {
    if (x > top[i]) {
      const y = top[i];
      top[i] = x;
      x = y;
    }
  }
}

function findRepo(d: Developer, name: string): Repo | null {
  return d.repos.find((r) => r.name === name) ?? null;
}

/**
 * Weighted geometric mean with offsets, shifted so all-zero evidence gives
 * E = 0. `contrib` is DevScore.contrib (not saturated).
 */
export function evidence(flagship: number, sustained: number, base01: number, contrib: number, p: Params): number {
  const g = (fl: number, su: number, ba: number, co: number) =>
    Math.pow(fl + p.eps_flagship, p.w_flagship) *
    Math.pow(su + p.eps_sustained, p.w_sustained) *
    Math.pow(p.base_scale * ba + p.eps_base, p.w_base) *
    Math.pow(co + p.eps_contrib, p.w_contrib);
  return g(flagship, sustained, base01, contrib) - g(0, 0, 0, 0);
}

/** E floor from accepted external work: accepted_floor·sat(contrib, k_accepted). */
export function acceptedFloor(contrib: number, p: Params): number {
  return p.accepted_floor * sat(contrib, p.k_accepted);
}

/**
 * Final score from evidence E: 100·(1 − (1 + E/k_final)^−tail). A power tail
 * keeps room above 90, so the very top can still separate.
 */
export function finalCurve(e: number, p: Params): number {
  return 100 * (1 - Math.pow(1 + Math.max(0, e) / p.k_final, -p.tail));
}

export function rate(d: Developer, s: DevScore, now: number, p: Params = defaultParams): Result {
  const top = [0, 0, 0];
  // Per calendar year, the best weighted code-months over the repos, capped at
  // 12: a year has 12 months however many repos they were spread over.
  const yearBest = new Array<number>(YEAR_SPAN).fill(0);
  let raw = 0;
  let recent = 0;
  let anyTimeline = false;
  for (const rs of s.repos) {
    if (rs.excluded !== null) continue;
    const r = findRepo(d, rs.name);
    if (r === null) continue;
    let rec = 1; // no timeline recorded: neutral
    const t = repoTimeline(r, now, p);
    if (t !== null) {
      anyTimeline = true;
      rec = flagshipRecency(t.fresh, p);
      const imp = rs.importance ?? 0;
      // A repo nobody uses with little own code adds little to sustained years.
      const k = (rs.nature ?? 1) * (rs.volume ?? 0) * (p.sustained_imp_floor + (1 - p.sustained_imp_floor) * imp);
      for (let i = 0; i < YEAR_SPAN; i++) yearBest[i] = Math.max(yearBest[i], Math.min(12, yearBest[i] + t.by_year[i] * k));
      raw += t.raw;
      recent += t.recent;
    }
    const v = flagshipStrength(rs, p) * rec;
    insertTop(top, v * (1 + sat(rs.user_commits ?? 0, p.k_mass_commits)));
  }
  const flagship = top[0] + top[1] / 2 + top[2] / 3;
  let sustained = 0;
  for (const m of yearBest) sustained += m;
  const sustainedYears = sustained / 12;
  // Accepted external work is a floor under E: substantial code independent
  // maintainers merged into important projects counts even without a flagship.
  const eDev = Math.max(evidence(flagship, sustainedYears, s.score / 100, s.contrib, p), acceptedFloor(s.contrib, p));
  const mt = maintainerTrack(d, s, now, p);
  // The two tracks: the stronger counts, plus a little for the other.
  const e = Math.max(eDev, mt.e) + p.other_track_bonus * Math.min(eDev, mt.e);
  const main = finalCurve(e, p);
  const bonus = contentBonus(d, s, p);
  return {
    score: Math.min(100, main + bonus),
    main,
    content_bonus: bonus,
    confidence: confidence(gatherEvidence(d, s, p), p),
    e,
    e_dev: eDev,
    e_maint: mt.e,
    maint_flagship: mt.flagship,
    maint_sustained: mt.sustained,
    status: status(d, now, p),
    flagship,
    sustained: sustainedYears,
    recent_share: anyTimeline && raw > 0 ? recent / raw : null,
  };
}

/**
 * A repo counts for the maintainer track with a GitHub-verified role
 * (`maint_role`), ≥ maint_min_months maintainer months, engineering kind, and
 * gatekeeping (≥ maint_min_merged of others' PRs merged) or authorship.
 */
function maintCounts(r: Repo, rs: RepoScore, p: Params): boolean {
  return (
    r.maint_role !== null &&
    monthsSince(r.maint_months_by_year, 0) >= p.maint_min_months &&
    rs.excluded === null &&
    !isContentKind(rs.kind) &&
    ((r.merged_others ?? 0) >= p.maint_min_merged || (rs.authorship ?? 0) >= p.maint_min_authorship)
  );
}

interface MaintTrack {
  e: number;
  flagship: number;
  sustained: number;
}

/**
 * Maintainer track (contract v11), mirroring the developer track: flagship =
 * top-3 of importance · sat(recency-weighted months, k_maint_months);
 * sustained = per calendar year the best importance-scaled weighted months
 * (≤ 12), in years; E = maint_scale · evidence(flagship, sustained, base, 0).
 * 0 without any maintainer months.
 */
function maintainerTrack(d: Developer, s: DevScore, now: number, p: Params): MaintTrack {
  const top = [0, 0, 0];
  const yearBest = new Array<number>(YEAR_SPAN).fill(0);
  let any = false;
  for (const rs of s.repos) {
    const r = findRepo(d, rs.name);
    if (r === null || !maintCounts(r, rs, p)) continue;
    const imp = rs.importance ?? 0;
    let wm = 0; // Σ_y maintainer months(y) · recency(y)
    for (let y = 2000; y <= now; y++) wm += yearValue(r.maint_months_by_year, y) * maintRecency(y, now, p);
    if (!(wm > 0)) continue;
    any = true;
    insertTop(top, imp * sat(wm, p.k_maint_months));
    const k = p.sustained_imp_floor + (1 - p.sustained_imp_floor) * imp;
    for (let i = 0; i < YEAR_SPAN; i++) {
      const y = 2000 + i;
      const m = yearValue(r.maint_months_by_year, y);
      if (m === 0 || y > now) continue;
      yearBest[i] = Math.max(yearBest[i], Math.min(12, m * maintRecency(y, now, p) * k));
    }
  }
  if (!any) return { e: 0, flagship: 0, sustained: 0 };
  const flagship = top[0] + top[1] / 2 + top[2] / 3;
  let months = 0;
  for (const m of yearBest) months += m;
  const sustained = months / 12;
  return { e: p.maint_scale * evidence(flagship, sustained, s.score / 100, 0, p), flagship, sustained };
}

/**
 * Recent activity from the current and previous calendar year: active with ≥
 * status_min_months code months, else maintaining with as many maintainer
 * months in verified repos, else inactive.
 */
export function status(d: Developer, now: number, p: Params): Status {
  const y0 = Math.floor(now) - 1;
  let code = 0;
  let maint = 0;
  for (const r of d.repos) {
    code += monthsSince(r.code_months_by_year, y0);
    if (r.maint_role !== null) maint += monthsSince(r.maint_months_by_year, y0);
  }
  if (code >= p.status_min_months) return "active";
  if (maint >= p.status_min_months) return "maintaining";
  return "inactive";
}

/** Σ of a per-year map over years ≥ y0. */
function monthsSince(m: NumMap | null, y0: number): number {
  let sum = 0;
  for (const [k, v] of Object.entries(m ?? {})) {
    const y = parseUint(k, 65535);
    if (y !== null && y >= y0) sum += v;
  }
  return sum;
}
