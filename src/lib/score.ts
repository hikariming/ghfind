import { presentationDiscount, ecosystemPresentationDiscount, externalPrShare } from "./presentation-concentration";
import type { ImpactRepo } from "./types";
/**
 * Deterministic 0-100 value/trust scorer.
 *
 * Direct port of `score()` + `_log_ratio()` from the canonical Python skill
 * (`github-account-value/scripts/fetch_github_profile.py`). The formula is the
 * single source of truth for the number; the LLM only writes prose/roast on top
 * of this output.
 *
 * See `github-account-value/references/scoring_rubric.md` for the rubric.
 */

import { SUBSCORE_MAX, tierFor } from "./score-presentation";
import { assessRisk } from "./risk";
import type { RawMetrics, Scoring, SubScores } from "./types";

export { SUBSCORE_MAX, nextTier, tierFor } from "./score-presentation";

/**
 * Round to `digits` decimals using round-half-to-even (banker's rounding), exactly
 * matching Python's built-in `round()` — so the TS port stays bit-for-bit in parity
 * with the canonical skill even when a sub-score lands on a .x5 boundary (e.g. 17.25).
 */
export function roundHalfEven(value: number, digits = 0): number {
  const f = 10 ** digits;
  const scaled = value * f;
  const floor = Math.floor(scaled);
  let r: number;
  if (Math.abs(scaled - floor - 0.5) < 1e-9) {
    r = floor % 2 === 0 ? floor : floor + 1; // exact half → nearest even
  } else {
    r = Math.round(scaled);
  }
  return r / f;
}

/** 0..1 scaled with a log curve: returns 1.0 when value >= full_at. */
export function logRatio(value: number, fullAt: number): number {
  if (value <= 0) return 0.0;
  return Math.min(Math.log10(value + 1) / Math.log10(fullAt + 1), 1.0);
}

/** Clamp a score to [0, 100] and round to 2 decimals. */
/**
 * Discount star points when the top-starred repo's community engagement
 * ((watchers + issues + PRs) / stars) says the stars are an audience, not a
 * community. Viral listicle / agent-skill repos run <1% (archify: 5.7k★, 18
 * issues ever, 2 contributors → 0.97%); every top-30 heavyweight flagship
 * measured ≥5% (2026-07 regression, zero false positives at these cutoffs).
 * undefined = not measured (repo <500★ or fetch failed) → no penalty.
 */
export function starEngagementMultiplier(ratio: number | undefined): number {
  if (ratio === undefined) return 1;
  if (ratio >= 0.04) return 1;
  if (ratio >= 0.02) return 0.85;
  if (ratio >= 0.01) return 0.7;
  return 0.5;
}

export function clampScore(value: number): number {
  return roundHalfEven(Math.max(0, Math.min(value, 100)), 2);
}

/**
 * Hidden 0-10 spam-PR / bot likelihood (0 = clean, 10 = heavy farming / bot).
 * Stored in the DB only — never shown publicly. Deterministic from the metrics.
 *
 * Designed to separate genuine solo devs from farmers: self-PRs into one's own
 * ~0-star repo count LESS when those PRs are substantial (real solo-dev workflow)
 * and MORE when they are trivial (count padding). Templated PR flooding (one-repo
 * batchy/concentrated PR activity is one signal, but heavy penalties require
 * corroborating evidence.
 */
export function spamBotScore(m: RawMetrics): number {
  let s = 0;

  // 1. Templated PR flooding — strongest bot signal (3..7).
  if (m.pr_flood_suspect ?? false) {
    const share = m.top_repo_pr_share ?? 0;
    const templated = m.templated_pr_ratio ?? 0;
    const sev = Math.max(
      0,
      Math.min(1, ((share - 0.5) / 0.5) * 0.5 + ((templated - 0.5) / 0.5) * 0.5),
    );
    s += 3 + 4 * sev;
  }

  const mergedSample = m.recent_merged_pr_sample ?? 0;

  // 2. Garbage PRs into popular EXTERNAL repos (0..4). Self-PRs never counted.
  const extTrivialRatio =
    mergedSample > 0 ? (m.external_trivial_pr_count ?? 0) / mergedSample : 0;
  if (mergedSample >= 8 && extTrivialRatio > 0.3) {
    s += Math.min(4, ((extTrivialRatio - 0.3) / 0.6) * 4);
  }

  // 3. High PR rejection (0..2).
  const rejected =
    m.maintainer_closed_unmerged_pr_count ??
    (m.self_closed_external_pr_count === undefined &&
    m.self_closed_own_repo_pr_count === undefined
      ? m.closed_unmerged_pr_count
      : 0) ??
    0;
  const decided = m.merged_pr_count + rejected;
  if (decided >= 10 && (m.pr_rejection_rate ?? 0) > 0.5) {
    s += Math.min(2, (((m.pr_rejection_rate ?? 0) - 0.5) / 0.5) * 2);
  }

  // 4. Other classic farm/bot red flags.
  if (m.following > 1000 && m.followers < m.following * 0.3) s += 2; // follow farming
  if (m.account_age_years < 1 && m.public_repos > 30) s += 1.5; // new-account mass repos
  const fetched = Math.max(m.fetched_repo_count, 1);
  if (m.fork_repo_count / fetched > 0.7 && m.nonempty_original_repo_count <= 2) s += 1.5; // mostly forks
  if (!m.bio && m.followers < 3 && m.total_stars === 0 && m.merged_pr_count < 2) s += 1; // ghost

  return Math.round(Math.max(0, Math.min(s, 10)) * 10) / 10;
}

/** Retained API: v15 replaces binary caps with evidence-based continuous weighting. */
export function docLikePrVolumeDiscount(m: RawMetrics, prVolume: number): number {
  const share = Math.min(1, Math.max(0, m.external_merged_pr_count ?? 0) / Math.max(1, m.merged_pr_count));
  return prVolume * share * (1 - presentationDiscount(m)) * 0.8;
}
export function contributionQualityCap(_m: RawMetrics): number | undefined {
  return undefined;
}

/**
 * Give contribution quality a small deterministic lift when the user has
 * inspectable core PRs in truly high-impact repos. This keeps an Apache/dify-
 * scale backend/core change from being treated as equivalent to the same number
 * of low-stakes PRs in small community repos. The bonus is intentionally small:
 * ecosystem_impact already carries most of this signal.
 */
export function highImpactCorePrBonus(m: RawMetrics): number {
  const core = m.core_impact_pr_count ?? 0;
  const starSignal = impactPrestigeSignal(m);
  if (core < 2 || starSignal < 0.5) return 0;

  const coreSignal = Math.min(core / 5, 1);
  return Math.min(2, starSignal * 0.8 + coreSignal * 1.2);
}

/** Own-repo merged PRs saturate at 200. */
const OWN_PR_VOLUME_FULL_AT = 200;
/**
 * 209ff9f5 community extra on own-repo PR volume. In that formula own volume
 * was `(4 + 6·A)·logRatio(own, 200)` capped at 10; v10 already counts own PRs
 * in the 16-point combined pool (the 4), so v13 restores only `6·A·logRatio`.
 */
const OWN_PR_COMMUNITY_BONUS = 6;

/**
 * Extra contribution-quality points when own-repo merged PRs landed in an
 * outside community. `A` is `own_pr_community` (0..1). Snapshots without
 * `external_merged_pr_count` keep the v10 single-pool score (credit 0).
 */
export function ownPrCommunityCredit(m: RawMetrics): number {
  if (m.external_merged_pr_count == null) return 0;
  const community = Math.max(0, Math.min(m.own_pr_community ?? 0, 1));
  if (community === 0) return 0;
  const external = Math.max(0, Math.min(m.external_merged_pr_count, m.merged_pr_count));
  const own = Math.max(0, m.merged_pr_count - external);
  return logRatio(own, OWN_PR_VOLUME_FULL_AT) * OWN_PR_COMMUNITY_BONUS * community;
}

export function impactPrestigeSignal(m: RawMetrics): number {
  return Math.max(
    0,
    Math.min(
      m.impact_prestige_score ?? logRatio(m.max_impact_repo_stars, 100_000),
      1,
    ),
  );
}

/**
 * Bulk volume needs prestige and independent adoption to approach full credit.
 * Own project stars cannot bypass either constraint. Own PRs earn adoption
 * through the measured outside community, including attributed org projects.
 * Missing external counts are unknown: retain the prestige cap alone.
 */
/** Log-sum-exp soft minimum. Approaches the smaller input; never a hard cut. */
export function softMin(values: number[], k = 6): number {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return Infinity;
  const peak = Math.max(...finite.map((value) => -k * value));
  const sum = finite.reduce((total, value) => total + Math.exp(-k * value - peak), 0);
  return -(peak + Math.log(sum)) / k;
}

/**
 * Evidence ceiling for contribution quality. v19 no longer returns a value
 * that `min(raw, cap)` can slam into: callers saturate toward this ceiling.
 * Missing external counts stay unknown and omit recognition, matching v18.
 */
export function contributionEvidenceCeiling(m: RawMetrics): number {
  const smooth = (value: number) => { const x = Math.max(0, Math.min(1, value)); return x*x*(3-2*x); };
  const volume = smooth((m.merged_pr_count - 40) / 80);
  const prestige = impactPrestigeSignal(m);
  const strongPrestige = smooth((prestige - .65) / .15);
  const coreProtection = smooth(((m.core_impact_pr_count ?? 0) - 40) / 60);
  const prestigeCap = 20 + 3*smooth((prestige-.3)/.5) + 4*strongPrestige + 2.5*coreProtection*(1-strongPrestige);
  const cap = 27 - (27 - prestigeCap) * volume;
  const bounds = [SUBSCORE_MAX.contribution_quality, cap];
  if (m.external_merged_pr_count != null) {
    const external = Math.max(0, Math.min(m.external_merged_pr_count, m.merged_pr_count));
    const own = Math.max(0, m.merged_pr_count - external);
    const community = Math.max(0, Math.min(m.own_pr_community ?? 0, 1));
    // 80 effective landings earn 63% of the seven points above the legacy floor;
    // roughly 396 are needed for this ceiling to approach 27.0.
    bounds.push(20 + 7 * (1 - Math.exp(-(external + own * community) / 80)));
  }
  const legacy = contributionQualityCap(m);
  if (legacy != null) bounds.push(legacy);
  return softMin(bounds, 6);
}

/**
 * v18 hard cap, retained so tests can show the cliff this release removes.
 * Same prestige and recognition curves; combines them with `min`.
 */
export function lowPrestigeBulkContributionCap(m: RawMetrics): number | undefined {
  const ceiling = contributionEvidenceCeiling(m);
  if (!Number.isFinite(ceiling)) return undefined;
  // Reconstruct the v18 min() of the same evidence bounds for callers that
  // still inspect the legacy cap. The live score uses the soft ceiling.
  const smooth = (value: number) => { const x = Math.max(0, Math.min(1, value)); return x*x*(3-2*x); };
  const volume = smooth((m.merged_pr_count - 40) / 80);
  const prestige = impactPrestigeSignal(m);
  const strongPrestige = smooth((prestige - .65) / .15);
  const coreProtection = smooth(((m.core_impact_pr_count ?? 0) - 40) / 60);
  const prestigeCap = 20 + 3*smooth((prestige-.3)/.5) + 4*strongPrestige + 2.5*coreProtection*(1-strongPrestige);
  const cap = 27 - (27 - prestigeCap) * volume;
  if (m.external_merged_pr_count == null) return Math.min(cap, SUBSCORE_MAX.contribution_quality);
  const external = Math.max(0, Math.min(m.external_merged_pr_count, m.merged_pr_count));
  const own = Math.max(0, m.merged_pr_count - external);
  const community = Math.max(0, Math.min(m.own_pr_community ?? 0, 1));
  const recognitionCap = 20 + 7 * (1 - Math.exp(-(external + own * community) / 80));
  return Math.min(cap, recognitionCap, SUBSCORE_MAX.contribution_quality);
}

/**
 * Smooth stand-in for `min(raw, ceiling)`. Far below the ceiling the value
 * stays on the raw curve. Within about one point it bends, and past the
 * ceiling it approaches the ceiling instead of being cut flat.
 */
export function saturateToward(raw: number, ceiling: number): number {
  if (!(raw > 0)) return 0;
  if (!Number.isFinite(ceiling)) return raw;
  if (!(ceiling > 0)) return 0;
  return softMin([raw, ceiling], 3);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * How much of the sampled impact work is code rather than docs, tiny edits,
 * or presentation churn. Missing classification is unknown and stays neutral.
 */
export function impactSubstance(m: RawMetrics): number {
  const trivialCount = Math.max(0, m.external_trivial_pr_count ?? 0);
  const sample = Math.max(0, m.recent_merged_pr_sample ?? 0);
  const trivialKnown = sample > 0 || trivialCount > 0;
  const trivialShare = trivialKnown ? trivialCount / Math.max(sample, trivialCount, 1) : 0;
  const core = Math.max(0, m.core_impact_pr_count ?? 0);
  const docLike = Math.max(0, m.doc_like_impact_pr_count ?? 0);
  const classKnown = core + docLike > 0;
  // Core work earns full credit. A docs-only sample keeps a floor so a
  // documentation-heavy history is discounted without going to zero.
  const classQuality = classKnown ? 0.45 + 0.55 * (core / (core + docLike)) : 1;
  const presentationKnown = m.presentation_churn_share != null;
  const presentation = presentationKnown ? clamp01(m.presentation_churn_share ?? 0) : 0;
  if (!trivialKnown && !classKnown && !presentationKnown) return 1;
  // A short recent sample must not define a large lifetime. Coverage is how
  // much of the landed impact work that sample actually saw.
  const work = Math.max(m.impact_pr_count ?? 0, sample, trivialCount, core + docLike, 1);
  const trivialCoverage = trivialKnown ? Math.min(1, Math.max(sample, trivialCount) / work) : 0;
  const classCoverage = classKnown ? Math.min(1, (core + docLike) / work) : 0;
  const presentationCoverage = presentationKnown
    ? Math.min(1, Math.max(m.presentation_pr_sample ?? sample, 0) / work)
    : 0;
  const quality =
    (1 - trivialCoverage * 0.55 * trivialShare) *
    (1 - classCoverage * (1 - classQuality)) *
    (1 - presentationCoverage * 0.5 * presentation);
  return Math.max(0.18, Math.min(1, 0.22 + 0.78 * quality));
}

/** Cross-repo spread in (0.62, 1]. One repo or one dominant share sits near 0.62.
 * Sustained work in the dominant repo softens concentration so a long-term
 * co-maintainer of one mid-size project is not damped like a drive-by. */
export function impactBreadth(m: RawMetrics): number {
  const repos = (m.impact_repos ?? []).filter((repo) => repo && typeof repo.repo === "string");
  let concentration = 0;
  let known = false;
  if (repos.length > 0) {
    known = true;
    concentration = repoConcentration(repos);
  } else if ((m.impact_repo_count ?? 0) > 0) {
    // No per-repo weights. A single qualifying repo is concentrated.
    // Several repos stay neutral until the repo list is present; the recent
    // PR share is a flood signal, not a lifetime diversity measure.
    known = true;
    concentration = (m.impact_repo_count ?? 0) <= 1 ? 1 : 0;
  }
  if (!known) return 1;
  const work = dominantRepoWork(m, repos);
  // ~0.05 at 3 PRs, ~0.49 at 40, ~0.95 at 180 — drive-bys keep nearly full
  // concentration; long co-maintainers recover part of the breadth floor.
  const maintainerRelief = 1 - Math.exp(-work / 60);
  const effectiveConcentration = concentration * (1 - 0.4 * maintainerRelief);
  const spread = Math.pow(1 - effectiveConcentration, 1.15);
  return 0.62 + 0.38 * spread;
}

/** Dominant-repo landed work (PRs + commits/4). Count-only snapshots fall back
 * to aggregate impact counts so the single-repo path still gets relief. */
function dominantRepoWork(m: RawMetrics, repos: ImpactRepo[]): number {
  if (repos.length > 0) {
    let maxWork = 0;
    for (const repo of repos) {
      const work = Math.max(0, repo.prs ?? 0) + Math.max(0, repo.commits ?? 0) / 4;
      if (work > maxWork) maxWork = work;
    }
    return maxWork;
  }
  return Math.max(0, m.impact_pr_count ?? 0) + Math.max(0, m.impact_commit_count ?? 0) / 4;
}

function repoConcentration(repos: ImpactRepo[]): number {
  const weights = repos.map((repo) => Math.max(0, repo.prs ?? 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = total > 0
    ? weights.map((weight) => weight / total)
    : repos.map(() => 1 / repos.length);
  const hhi = shares.reduce((sum, share) => sum + share * share, 0);
  if (repos.length <= 1) return 1;
  const equal = 1 / repos.length;
  return clamp01((hhi - equal) / (1 - equal));
}

/**
 * Concave credit for landed popular-repo work. Commits count at 1/4 of a PR
 * so commit-only maintainers are not treated as a drive-by. Unknown stays 1.
 */
export function impactTouch(m: RawMetrics): number {
  const prsKnown = m.impact_pr_count != null && Number.isFinite(m.impact_pr_count);
  const commitsKnown = m.impact_commit_count != null && Number.isFinite(m.impact_commit_count);
  const reposKnown = (m.impact_repos?.length ?? 0) > 0 || (m.impact_repo_count ?? 0) > 0;
  if (!prsKnown && !commitsKnown && !reposKnown) return 1;
  if (prsKnown && m.impact_pr_count === 0 && !commitsKnown && !reposKnown) return 1;
  const prs = prsKnown ? Math.max(0, m.impact_pr_count) : 0;
  const commits = commitsKnown ? Math.max(0, m.impact_commit_count ?? 0) : 0;
  const landed = 1 - Math.exp(-(prs + commits / 4) / 18);
  const core = Math.max(0, m.core_impact_pr_count ?? 0);
  const docLike = Math.max(0, m.doc_like_impact_pr_count ?? 0);
  if (core + docLike <= 0) return landed;
  const coverage = Math.min(1, (core + docLike) / Math.max(prs, core + docLike, 1));
  const coreMix = 0.35 + 0.65 * (core / (core + docLike));
  return landed * (1 - coverage * (1 - coreMix));
}

/**
 * Author-closed external PRs are not maintainer rejections: people close PRs
 * after rebases, wrong-base mistakes, upstream direction changes, or duplicate
 * submissions. Keep them out of both the acceptance denominator and scoring
 * penalties; they remain only as a report/display fact.
 */
export function authorSelfClosedExternalPenalty(m: RawMetrics): number {
  void m;
  return 0;
}

function hasSocialOnlyDormantSignal(m: RawMetrics): boolean {
  const bestProjectQuality = m.best_original_repo_quality_score ?? 0;
  return (
    m.followers >= 500 &&
    m.last_year_contributions === 0 &&
    m.merged_pr_count === 0 &&
    (m.impact_pr_count ?? 0) === 0 &&
    (m.max_impact_repo_stars ?? 0) === 0 &&
    m.total_stars <= 300 &&
    bestProjectQuality < 0.85
  );
}

/** Only star points are discounted; independently measured substance survives. */
export function contentSkillDiscount(m: RawMetrics): number {
  const share = Math.max(0, Math.min(1, m.content_skill_star_share ?? 0));
  const confidence = Math.max(0, Math.min(1, m.content_skill_confidence ?? 0));
  const external = Math.max(0, m.external_merged_pr_count ?? 0);
  const engineering = Math.max(Math.max(0, m.core_impact_pr_count ?? 0) * externalPrShare({ ...m, merged_pr_count: m.merged_pr_count ?? 0 }), external * (1 - Math.max(0, Math.min(1, m.presentation_churn_share ?? 0))) / 20);
  const starMass = Math.max(0, m.total_stars) / (Math.max(0, m.total_stars) + 5000);
  return 1 - 0.9 * share * share * (3 - 2 * share) * confidence * starMass / (1 + engineering);
}

export function originalProjectQuality(m: RawMetrics): number {
  if (m.nonempty_original_repo_count === 0) {
    return 0.0;
  } else {
    const starQuality =
      m.total_stars > 0
        ? Math.max(0, Math.min(m.top_starred_original_repo_quality_score ?? 1, 1))
        : 1;
    const starPts =
      (logRatio(m.weighted_total_stars ?? m.total_stars, 5000) * 7 + logRatio(m.weighted_max_stars ?? m.max_stars, 2000) * 5) *
      starQuality *
      starEngagementMultiplier(m.top_repo_engagement_ratio) * contentSkillDiscount(m);
    const projectSubstance = Math.max(
      0,
      Math.min(m.best_original_repo_quality_score ?? 0, 1),
    ) * 6;
    return roundHalfEven(
      starPts + projectSubstance,
      1,
    );
  }

}

export function score(m: RawMetrics): Scoring {
  const sub: SubScores = {
    account_maturity: 0,
    original_project_quality: 0,
    contribution_quality: 0,
    ecosystem_impact: 0,
    community_influence: 0,
    activity_authenticity: 0,
  };

  // 1. Account Maturity (10)
  const agePts = Math.min(m.account_age_years / 6.0, 1.0) * 7;
  const years = m.contribution_years_active;
  const spanPts = years === 0 ? 0 : years === 1 ? 1 : years === 2 ? 2 : 3;
  sub.account_maturity = roundHalfEven(agePts + spanPts, 1);

  // 2. Original Project Quality (18) — stars are only part of quality. A useful
  // 0-star project can still earn substance points, while stars alone cannot
  // max out the dimension without a complete-looking original repo.
  sub.original_project_quality = Math.max(originalProjectQuality(m), Math.max(0, Math.min(18, m.personal_original_project_quality_score ?? 0)));

  // 3. Contribution Quality (27) — merged-PR volume, acceptance, issue engagement.
  // PRs into one's own projects count normally (solo-dev work / learning / testing
  // is legitimate); spam is judged separately by the external-trivial / flood flags.
  const prVolumeRaw = logRatio(m.merged_pr_count, 200) * 16;
  const prVolume = Math.max(0, prVolumeRaw - docLikePrVolumeDiscount(m, prVolumeRaw));
  let acceptance: number;
  const hasClosedPrBreakdown =
    m.maintainer_closed_unmerged_pr_count !== undefined ||
    m.self_closed_external_pr_count !== undefined ||
    m.self_closed_own_repo_pr_count !== undefined;
  const acceptanceTotal = hasClosedPrBreakdown
    ? Math.max(
        m.merged_pr_count,
        m.merged_pr_count + (m.maintainer_closed_unmerged_pr_count ?? 0),
      )
    : Math.max(m.merged_pr_count, m.total_pr_count);
  if (acceptanceTotal >= 3) {
    acceptance = (m.merged_pr_count / acceptanceTotal) * 6;
  } else {
    acceptance = m.merged_pr_count * 1.2; // tiny history: ~1pt per merged
  }
  acceptance = Math.min(acceptance, 6.0);
  const issuePts = logRatio(m.issues_created, 100) * 5;
  const contributionQualityRaw =
    prVolume +
    ownPrCommunityCredit(m) +
    acceptance - docLikePrVolumeDiscount(m, acceptance) +
    issuePts +
    highImpactCorePrBonus(m) * (1 - (1 - presentationDiscount(m)) * 0.8) -
    authorSelfClosedExternalPenalty(m);
  // Soft saturation toward the evidence ceiling. A large raw approaches the
  // ceiling without the v18 hard min() cut.
  sub.contribution_quality = roundHalfEven(
    saturateToward(Math.max(0, contributionQualityRaw), contributionEvidenceCeiling(m)),
    1,
  );

  // 4. Ecosystem & Maintainer Impact (20) — substantial, repeated work across
  // popular repos. A few tiny PRs into one mega-repo, or every PR in a single
  // repo, approach the 9+11 budget slowly instead of filling it.
  const substance = impactSubstance(m);
  const breadth = impactBreadth(m);
  const prestige =
    9 * impactPrestigeSignal(m) * substance * impactTouch(m) * (0.72 + 0.28 * breadth);
  const depth =
    11 * (1 - Math.exp(-Math.max(0, m.impact_depth_raw) / 4)) * substance * breadth;
  const ecosystemRaw = (prestige + depth) * ecosystemPresentationDiscount(m) *
    (1 - (1 - contentSkillDiscount(m)) * (1 - externalPrShare(m)));
  sub.ecosystem_impact = roundHalfEven(
    ecosystemRaw,
    1,
  );

  // 5. Community Influence (8)
  const followerPts = logRatio(m.followers, 2000) * 5;
  const following = m.following;
  const followers = m.followers;
  let ratioPts: number;
  if (following > 2000 && followers < following * 0.3) {
    ratioPts = 0.0;
  } else if (following === 0) {
    ratioPts = followers > 0 ? 3.0 : 0.0;
  } else {
    const ratio = followers / following;
    ratioPts = ratio >= 2 ? 3 : ratio >= 1 ? 2 : ratio >= 0.5 ? 1.5 : 1;
  }
  const communityRaw = followerPts + ratioPts;
  sub.community_influence = roundHalfEven(
    hasSocialOnlyDormantSignal(m) ? Math.min(communityRaw, 2.5) : communityRaw,
    1,
  );

  // 6. Activity Authenticity (17)
  const contribPts = logRatio(m.last_year_contributions, 2000) * 8;
  const days = m.days_since_last_activity;
  let recencyPts: number;
  if (days === null) recencyPts = 0.0;
  else if (days <= 90) recencyPts = 4.5;
  else if (days <= 365) recencyPts = 2.0;
  else recencyPts = 0.0;
  const diversityPts = Math.min(m.activity_type_count, 4) * 1.125;
  sub.activity_authenticity = roundHalfEven(contribPts + recencyPts + diversityPts, 1);

  const base = roundHalfEven(
    Object.values(sub).reduce((a, b) => a + b, 0),
    1,
  );

  const risk = assessRisk(m);
  const penalty = risk.total_penalty;
  // Keep two decimals (not integer) so the leaderboard can rank finely.
  const final = clampScore(roundHalfEven(base - penalty, 2));
  const { tier, tier_label: tierLabel } = tierFor(final);

  return {
    sub_scores: sub,
    base_score: base,
    red_flags: risk.red_flags,
    risk_assessment: risk.risk_assessment,
    risk_notes: risk.risk_notes,
    total_penalty: penalty,
    final_score: final,
    tier,
    tier_label: tierLabel,
  };
}
