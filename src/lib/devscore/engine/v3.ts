/**
 * Rubric-v3 score (port of devscore src/v3.zig; docs/algorithm-v3.md):
 *
 *   score = min(remap(engine), caps)
 *
 * - remap: the engine (`curve.rate`) ranks like the v3 reviewer but on an
 *   older, lower scale; a linear map fit on the v3 train reviews fixes it.
 * - caps (rules A, B), applied last: slop (`slop.ts` on `ext_prs`) and
 *   influencer (reach far above independently accepted engineering). Without
 *   `ext_prs` there is no slop verdict and no cap.
 * Rule F zeroes a hype repo's adoption credit in the engine (`isHype`) and only
 * sets `Flags.hype` here (the rubric's −5 was rejected on the dev set).
 */
import { collectedYear, type Developer } from "../model";
import { eqlIgnoreCase } from "./ascii";
import * as curve from "./curve";
import * as score from "./score";
import * as slop from "./slop";

export interface Params {
  /** remap(x) = remap_a + remap_b · x, clamped to [0, 100]. */
  remap_a: number;
  remap_b: number;
  /**
   * Influencer: followers ≥ infl_followers and ≥ infl_ratio per independently
   * merged external PR, fewer than infl_max_accepted such PRs, no maintainer
   * track and no own repo with importance and authorship above the thresholds.
   */
  infl_followers: number;
  infl_ratio: number;
  infl_max_accepted: number;
  infl_strong_importance: number;
  infl_strong_authorship: number;
  slop_cap: number;
  infl_cap: number;
  /** A capped score is squeezed into [cap_floor, cap] by the remapped score, so capped people stay ordered. */
  cap_floor: number;
  slop: slop.Params;
}

export const defaultParams: Readonly<Params> = Object.freeze({
  remap_a: 11.0,
  remap_b: 0.807,
  infl_followers: 500,
  infl_ratio: 50,
  infl_max_accepted: 60,
  infl_strong_importance: 0.3,
  infl_strong_authorship: 0.5,
  slop_cap: 35,
  infl_cap: 35,
  cap_floor: 20,
  slop: slop.defaultParams,
});

/** 拉完了 < 40, NPC 40-69, 人上人 70-79, 顶级 80-89, 夯 90+. */
export type Tier = "lawanle" | "npc" | "renshangren" | "dingji" | "hang";

export const TIER_LABEL: Record<Tier, string> = {
  hang: "夯",
  dingji: "顶级",
  renshangren: "人上人",
  npc: "NPC",
  lawanle: "拉完了",
};

export function tierOf(s: number): Tier {
  return s >= 90 ? "hang" : s >= 80 ? "dingji" : s >= 70 ? "renshangren" : s >= 40 ? "npc" : "lawanle";
}

export interface Flags {
  slop: boolean;
  influencer: boolean;
  /** `ext_prs` missing: the slop detector could not run. */
  no_pr_data: boolean;
  /** Rule F: the most-starred own or led repo is a hype project. No points off. */
  hype: boolean;
}

export interface Result {
  score: number;
  tier: Tier;
  /** remap(engine score) */
  remapped: number;
  /** Which caps were applied. */
  flags: Flags;
}

/** External PRs merged by someone other than the user, over non-owned repos (bots only where trusted). */
function independentlyMerged(d: Developer): number {
  let n = 0;
  for (const r of d.repos) {
    if (r.owned || r.is_fork || r.pr_mergers === null) continue;
    for (const [who, v] of Object.entries(r.pr_mergers)) {
      if (who === "[self]" || eqlIgnoreCase(who, d.login)) continue;
      if (who === "[bot]" && (r.contributors_total ?? 0) < score.defaultParams.bot_merge_min_contributors) continue;
      n += v;
    }
  }
  return n;
}

/** Rule B: reach far above independently accepted engineering. */
function influencer(d: Developer, s: score.DevScore, engine: curve.Result, p: Params): boolean {
  const followers = d.followers;
  if (followers === null || followers < p.infl_followers || engine.e_maint > 0) return false;
  const accepted = independentlyMerged(d);
  if (accepted >= p.infl_max_accepted || followers < p.infl_ratio * Math.max(1, accepted)) return false;
  for (const rs of s.repos) {
    if (rs.excluded !== null) continue;
    if ((rs.importance ?? 0) >= p.infl_strong_importance && (rs.authorship ?? 0) >= p.infl_strong_authorship) return false;
  }
  return true;
}

/** The developer's most-starred owned or led repo (ties: first) is a hype project. */
function hypeFlagship(d: Developer, s: score.DevScore): boolean {
  let best = -1;
  let name: string | null = null;
  for (const rs of s.repos) {
    // content/docs repos stay candidates: the most visible repo may be a guide
    if (rs.excluded !== null && rs.excluded !== "excluded_kind") continue;
    const r = d.repos.find((x) => x.name === rs.name);
    if (r === undefined) continue;
    if (!r.owned && !score.leads(r, score.defaultParams)) continue;
    const st = r.stars ?? 0;
    if (st > best) {
      best = st;
      name = rs.name;
    }
  }
  if (name === null) return false;
  return s.repos.find((rs) => rs.name === name)?.hype ?? false;
}

/**
 * Maps [0, 100] linearly onto [lo, hi] (hi ≥ lo); a score already below lo
 * keeps its place in proportion. With lo = hi this is min(v, hi).
 */
export function squeeze(v: number, lo: number, hi: number): number {
  if (lo >= hi) return Math.min(v, hi);
  return lo * Math.min(1, v / lo) + (hi - lo) * Math.min(1, Math.max(0, (v - lo) / (100 - lo)));
}

export function rate(d: Developer, s: score.DevScore, engine: curve.Result, p: Params = defaultParams): Result {
  const remapped = Math.min(100, Math.max(0, p.remap_a + p.remap_b * engine.score));
  const verdict = slop.detect(d, p.slop);
  const flags: Flags = {
    slop: verdict ?? false,
    influencer: influencer(d, s, engine, p),
    no_pr_data: verdict === null,
    hype: hypeFlagship(d, s),
  };
  let v = remapped;
  if (flags.slop) v = squeeze(v, p.cap_floor, p.slop_cap);
  if (flags.influencer) v = squeeze(v, p.cap_floor, p.infl_cap);
  return { score: v, tier: tierOf(v), remapped, flags };
}

/** One developer through the whole pipeline: engine, evidence curve, v3 scale. */
export interface Rated {
  engine: score.DevScore;
  curve: curve.Result;
  v3: Result;
}

/**
 * Per-repo engine (`score`), evidence curve (`curve`), then the v3 scale and
 * caps, all evaluated at the data's own `collected_at` so results do not drift
 * with the wall clock.
 */
export function rateDeveloper(d: Developer): Rated {
  const s = score.scoreDeveloper(d, score.defaultParams);
  const c = curve.rate(d, s, collectedYear(d), curve.defaultParams);
  return { engine: s, curve: c, v3: rate(d, s, c, defaultParams) };
}
