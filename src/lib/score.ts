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

import type { RawMetrics, RedFlag, Scoring, SubScoreKey, SubScores, Tier } from "./types";

/** Max points per sub-dimension (sums to 100). Single source for normalization. */
export const SUBSCORE_MAX: Record<SubScoreKey, number> = {
  account_maturity: 10,
  original_project_quality: 18,
  contribution_quality: 27,
  ecosystem_impact: 20,
  community_influence: 8,
  activity_authenticity: 17,
};

/**
 * Round to `digits` decimals using round-half-to-even (banker's rounding), exactly
 * matching Python's built-in `round()` — so the TS port stays bit-for-bit in parity
 * with the canonical skill even when a sub-score lands on a .x5 boundary (e.g. 17.25).
 */
function round(value: number, digits = 0): number {
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
  return round(Math.max(0, Math.min(value, 100)), 2);
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

export function docLikePrVolumeDiscount(m: RawMetrics, prVolume: number): number {
  const sample = m.recent_external_pr_sample ?? m.recent_merged_pr_sample ?? 0;
  const ratio =
    m.recent_external_doc_like_pr_ratio ??
    m.recent_doc_like_pr_ratio ??
    (sample > 0 && m.recent_external_doc_like_pr_count !== undefined
      ? m.recent_external_doc_like_pr_count / sample
      : sample > 0 && m.recent_doc_like_pr_count !== undefined
        ? m.recent_doc_like_pr_count / sample
      : 0);
  if (sample < 20 || ratio < 0.55) return 0;

  const severity = Math.max(0, Math.min(1, (ratio - 0.55) / 0.075));
  return Math.min(prVolume * 0.55, 2.5 + severity * 3.0);
}

export function contributionQualityCap(m: RawMetrics): number | undefined {
  const sample = m.recent_external_pr_sample ?? m.recent_merged_pr_sample ?? 0;
  const ratio =
    m.recent_external_doc_like_pr_ratio ??
    m.recent_doc_like_pr_ratio ??
    (sample > 0 && m.recent_external_doc_like_pr_count !== undefined
      ? m.recent_external_doc_like_pr_count / sample
      : sample > 0 && m.recent_doc_like_pr_count !== undefined
        ? m.recent_doc_like_pr_count / sample
        : 0);
  if (sample < 20 || ratio < 0.55) return undefined;

  const lowTrustImpact =
    m.impact_quality_cap !== undefined &&
    m.impact_quality_cap <= 4 &&
    (m.core_impact_pr_count ?? 0) <= 2;
  const weakTopStarProject =
    (m.top_starred_original_repo_quality_score ?? 1) < 0.3 && m.total_stars > 0;
  const selfClosedExternal = m.self_closed_external_pr_count ?? 0;
  const totalExternalish =
    m.merged_pr_count + (m.maintainer_closed_unmerged_pr_count ?? 0) + selfClosedExternal;
  const heavySelfClosedExternal =
    totalExternalish >= 20 && selfClosedExternal / totalExternalish >= 0.25;
  const weakOwnProjectSignal =
    m.max_stars < 100 &&
    m.total_stars < 300 &&
    (m.top_starred_original_repo_quality_score ?? 1) < 0.6;
  if (lowTrustImpact && (weakTopStarProject || weakOwnProjectSignal || heavySelfClosedExternal)) {
    return 12;
  }
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
 * Many merged PRs are not automatically top-tier contribution quality. If the
 * history is bulk-heavy but lacks either a 10k-star external repo signal or a
 * genuinely popular own project, cap the PR/issue-derived contribution score.
 * This still lets small-community work score well, but prevents low-stakes PR
 * volume from outranking fewer high-impact core PRs.
 */
export function lowPrestigeBulkContributionCap(m: RawMetrics): number | undefined {
  if (m.merged_pr_count < 80) return undefined;
  if (impactPrestigeSignal(m) >= logRatio(10_000, 100_000)) return undefined;
  if (m.max_stars >= 1000) return undefined;
  return 22;
}

export function templatedPrFloodPenalty(m: RawMetrics): number | undefined {
  if (!(m.pr_flood_suspect ?? false)) return undefined;

  const share = m.top_repo_pr_share ?? 0;
  const templated = m.templated_pr_ratio ?? 0;
  const concentrationSeverity = Math.max(
    0,
    Math.min(1, ((share - 0.5) / 0.5) * 0.5 + ((templated - 0.5) / 0.5) * 0.5),
  );
  const sample = m.recent_merged_pr_sample ?? m.recent_pr_sample ?? 0;
  const docLikeRatio =
    m.recent_external_doc_like_pr_ratio ??
    m.recent_doc_like_pr_ratio ??
    (sample > 0 && m.recent_external_doc_like_pr_count !== undefined
      ? m.recent_external_doc_like_pr_count / sample
      : sample > 0 && m.recent_doc_like_pr_count !== undefined
        ? m.recent_doc_like_pr_count / sample
        : 0);
  const rejection = m.pr_rejection_rate ?? 0;
  const hasPopularImpactSignal =
    (m.impact_pr_count ?? 0) > 0 || (m.max_impact_repo_stars ?? 0) >= 10_000;
  const lowCoreImpact =
    hasPopularImpactSignal &&
    (m.core_impact_pr_count ?? 0) <= 2 &&
    (m.impact_quality_cap !== undefined || (m.max_impact_repo_stars ?? 0) >= 10_000);
  const weakOwnProject =
    m.total_stars < 300 &&
    (m.top_starred_original_repo_quality_score ?? 1) < 0.5;
  const lowQualityEvidence =
    (sample >= 20 && docLikeRatio >= 0.55 ? 1 : 0) +
    (rejection >= 0.35 ? 1 : 0) +
    (lowCoreImpact ? 1 : 0) +
    (weakOwnProject ? 1 : 0);
  const extremeFlood = share >= 0.85 && templated >= 0.75;

  if (lowQualityEvidence >= 2 || (extremeFlood && lowQualityEvidence >= 1)) {
    return 10 + Math.round(10 * concentrationSeverity);
  }
  if (lowQualityEvidence === 1 || extremeFlood) {
    return 6 + Math.round(4 * concentrationSeverity);
  }
  return 4 + Math.round(4 * concentrationSeverity);
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

/** Map a final score to its tier label. Shared by the scorer and the AI-adjust step. */
export function tierFor(final: number): { tier: Tier; tier_label: string } {
  if (final >= 90) return { tier: "夯", tier_label: "封神 · 殿堂级标杆" };
  if (final >= 80) return { tier: "顶级", tier_label: "顶级开发者 · 一线水准" };
  if (final >= 70) return { tier: "人上人", tier_label: "优质贡献者 · 值得信任" };
  if (final >= 40) return { tier: "NPC", tier_label: "普通账号 · 特征平庸存疑" };
  return { tier: "拉完了", tier_label: "低价值 · 疑似刷量/AI 机器人" };
}

/** Ascending tier promotion thresholds, kept in sync with `tierFor`. */
const TIER_THRESHOLDS: { threshold: number; tier: Tier }[] = [
  { threshold: 40, tier: "NPC" },
  { threshold: 70, tier: "人上人" },
  { threshold: 80, tier: "顶级" },
  { threshold: 90, tier: "夯" },
];

/**
 * The next tier a score can be promoted into, and the score line to reach it.
 * Returns null once already in the top tier (夯). Drives the milestone hint.
 */
export function nextTier(final: number): { threshold: number; tier: Tier } | null {
  return TIER_THRESHOLDS.find((t) => final < t.threshold) ?? null;
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
  sub.account_maturity = round(agePts + spanPts, 1);

  // 2. Original Project Quality (18) — stars are only part of quality. A useful
  // 0-star project can still earn substance points, while stars alone cannot
  // max out the dimension without a complete-looking original repo.
  if (m.nonempty_original_repo_count === 0) {
    sub.original_project_quality = 0.0;
  } else {
    const starQuality =
      m.total_stars > 0
        ? Math.max(0, Math.min(m.top_starred_original_repo_quality_score ?? 1, 1))
        : 1;
    const starPts =
      (logRatio(m.total_stars, 5000) * 7 + logRatio(m.max_stars, 2000) * 5) *
      starQuality *
      starEngagementMultiplier(m.top_repo_engagement_ratio);
    const projectSubstance = Math.max(
      0,
      Math.min(m.best_original_repo_quality_score ?? 0, 1),
    ) * 6;
    sub.original_project_quality = round(
      starPts + projectSubstance,
      1,
    );
  }

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
    acceptance +
    issuePts +
    highImpactCorePrBonus(m) -
    authorSelfClosedExternalPenalty(m);
  const contributionCap = Math.min(
    contributionQualityCap(m) ?? Infinity,
    lowPrestigeBulkContributionCap(m) ?? Infinity,
    SUBSCORE_MAX.contribution_quality,
  );
  sub.contribution_quality = round(
    Math.min(contributionQualityRaw, contributionCap),
    1,
  );

  // 4. Ecosystem & Maintainer Impact (20) — substantial PRs into popular repos,
  // whether contributing to others' projects or actively maintaining one's own
  // popular repo. Hardest signal to fake; captures both contributor and
  // creator/maintainer value.
  const prestige = impactPrestigeSignal(m) * 9;
  const depth = Math.min(m.impact_depth_raw / 8.0, 1.0) * 11;
  const ecosystemRaw = prestige + depth;
  sub.ecosystem_impact = round(
    m.impact_quality_cap === undefined
      ? ecosystemRaw
      : Math.min(ecosystemRaw, m.impact_quality_cap),
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
  sub.community_influence = round(
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
  sub.activity_authenticity = round(contribPts + recencyPts + diversityPts, 1);

  const base = round(
    Object.values(sub).reduce((a, b) => a + b, 0),
    1,
  );

  // Red flags (penalties)
  const flags: RedFlag[] = [];
  const flag = (name: string, penalty: number, detail: string): void => {
    flags.push({ flag: name, penalty, detail });
  };

  const fetched = Math.max(m.fetched_repo_count, 1);
  if (m.account_age_years < 1 && m.public_repos > 30) {
    flag(
      "new_account_mass_repos",
      10,
      `Account <1yr old with ${m.public_repos} repos — possible mass creation.`,
    );
  }
  if (m.fork_repo_count / fetched > 0.7 && m.nonempty_original_repo_count <= 2) {
    flag(
      "mostly_forks",
      10,
      `${m.fork_repo_count}/${fetched} repos are forks with little original work.`,
    );
  }
  if (m.nonempty_original_repo_count === 0) {
    flag("no_original_work", 10, "No non-empty original repositories.");
  }
  if (m.empty_original_repo_count >= 5 && m.empty_original_repo_count / fetched > 0.5) {
    flag(
      "mostly_empty_repos",
      5,
      `${m.empty_original_repo_count} empty original repos — likely placeholder/spam.`,
    );
  }
  if (m.following > 1000 && m.followers < m.following * 0.3) {
    flag(
      "follow_farming",
      10,
      `following ${m.following} >> followers ${m.followers} — follow-farming pattern.`,
    );
  }
  if (!m.bio && m.followers < 3 && m.total_stars === 0 && m.merged_pr_count < 2) {
    flag("ghost_profile", 8, "Empty profile with negligible footprint.");
  }
  if (
    m.contribution_years_active <= 1 &&
    m.account_age_years > 2 &&
    (m.days_since_last_activity ?? 999) > 365
  ) {
    flag("burst_then_dormant", 5, "Active in only one year then dormant — burst pattern.");
  }
  if (hasSocialOnlyDormantSignal(m)) {
    flag(
      "social_only_dormant_profile",
      5,
      `${m.followers} followers but 0 last-year contributions, 0 PRs, no external impact, ` +
        "and no strong original project signal — social/profile attention is disconnected from code work.",
    );
  }
  if (m.star_inflation_suspect) {
    flag(
      "possible_star_inflation",
      5,
      "Top repo has many stars but near-zero forks/issues — possible bought stars.",
    );
  }
  const sample = m.recent_merged_pr_sample;
  // Garbage farming into popular community projects: trivial PRs into OTHERS'
  // ≥200★ repos (typo/whitespace PRs to famous repos for a contributor badge).
  // PRs into one's own projects are never counted here.
  const externalTrivial = m.external_trivial_pr_count ?? 0;
  if (sample >= 10 && externalTrivial / sample > 0.5) {
    flag(
      "trivial_pr_farming",
      8,
      `${externalTrivial}/${sample} recent merged PRs are ≤5-line changes into others' ` +
        "≥200★ repos — garbage PR farming into popular community projects.",
    );
  }
  // Templated-PR flooding: title/concentration alone is a pattern risk, not
  // proof of low quality or AI abuse. Heavy penalties require corroborating
  // evidence such as doc-like/trivial work, low core impact, weak own projects,
  // or high maintainer rejection.
  const floodPenalty = templatedPrFloodPenalty(m);
  if (floodPenalty !== undefined) {
    const floodSample = m.recent_pr_sample ?? 0;
    const repo = m.top_repo_pr_target ?? "one repo";
    const share = m.top_repo_pr_share ?? 0;
    const templated = m.templated_pr_ratio ?? 0;
    flag(
      "templated_pr_flooding",
      floodPenalty,
      `近期 ${Math.round(share * 100)}% 的 PR 集中刷向 ${repo}，` +
        `${Math.round(templated * 100)}% 标题高度模板化（${floodSample} 个样本）` +
        ` — 模式化批量贡献风险，需结合 diff 质量人工复核。`,
    );
  }
  // High PR rejection: maintainer-closed unmerged PRs, not self-closed cleanup.
  const rejectedPrs = m.maintainer_closed_unmerged_pr_count ?? m.closed_unmerged_pr_count ?? 0;
  const decidedPrs = m.merged_pr_count + rejectedPrs;
  const rejection = m.pr_rejection_rate ?? 0;
  if (decidedPrs >= 10 && rejection > 0.5) {
    flag(
      "high_pr_rejection",
      rejection > 0.7 ? 10 : 8,
      `${rejectedPrs}/${decidedPrs} 个已决 PR 被维护者关闭未合并（被拒率 ` +
        `${Math.round(rejection * 100)}%）— 低质 / 频繁被拒。`,
    );
  }

  const penalty = Math.min(
    flags.reduce((a, f) => a + f.penalty, 0),
    40,
  );
  // Keep two decimals (not integer) so the leaderboard can rank finely.
  const final = clampScore(round(base - penalty, 2));
  const { tier, tier_label: tierLabel } = tierFor(final);

  return {
    sub_scores: sub,
    base_score: base,
    red_flags: flags,
    total_penalty: penalty,
    final_score: final,
    tier,
    tier_label: tierLabel,
  };
}
