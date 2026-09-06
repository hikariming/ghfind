import rules from "../../config/risk-rules-v10.json";
import type {
  RawMetrics,
  RedFlag,
  RiskAssessment,
  RiskEvidence,
  RiskFamily,
  RiskSignal,
} from "./types";

type ObservedValue = number | string | boolean | null;

interface Candidate {
  signal: RiskSignal;
  raw: number;
}

const WINDOW =
  `bounded public snapshot: up to ${rules.coverage.repository_limit} repositories, ` +
  `up to ${rules.coverage.merged_pr_limit} merged PRs, up to ${rules.coverage.all_pr_limit} all-state PRs`;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function finite(value: number | undefined | null, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rounded(value: number, digits = 4): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const result = Math.abs(scaled - floor - 0.5) < 1e-9
    ? floor % 2 === 0 ? floor : floor + 1
    : Math.round(scaled);
  return result / factor;
}

function sampleFactor(sample: number): number {
  return Math.min(1, Math.max(0, sample) / rules.sampling.full_sample);
}

export function smoothedRate(events: number, sample: number): number {
  const n = Math.max(0, finite(sample));
  const x = Math.max(0, Math.min(n, finite(events)));
  return (x + rules.sampling.smoothing_event_add) /
    (n + rules.sampling.smoothing_sample_add);
}

/** 95% Wilson lower bound for a binomial proportion. */
export function wilsonLower(rejected: number, decided: number, z = rules.thresholds.wilson_z): number {
  const n = Math.max(0, finite(decided));
  if (n <= 0) return 0;
  const x = Math.max(0, Math.min(n, finite(rejected)));
  const p = x / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const numerator =
    p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return clamp01(numerator / denominator);
}

function coverageFor(m: RawMetrics): RiskAssessment["coverage"] {
  const fetchedRepos = Math.max(0, finite(m.fetched_repo_count));
  const publicRepos = Math.max(1, finite(m.public_repos));
  const mergedSample = Math.max(0, finite(m.recent_merged_pr_sample));
  const mergedTotal = Math.max(1, Math.min(finite(m.merged_pr_count), rules.coverage.merged_pr_limit));
  const allSample = Math.max(0, finite(m.recent_pr_sample));
  const allTotal = Math.max(1, Math.min(finite(m.total_pr_count), rules.coverage.all_pr_limit));
  return {
    repo: rounded(clamp01(fetchedRepos / publicRepos)),
    merged_pr: rounded(clamp01(mergedSample / mergedTotal)),
    all_pr: rounded(clamp01(allSample / allTotal)),
  };
}

function evidence(
  m: RawMetrics,
  observed: Record<string, ObservedValue>,
  sampleSize?: number,
  threshold?: Record<string, number>,
): RiskEvidence {
  return {
    observed,
    ...(sampleSize === undefined ? {} : { sample_size: sampleSize }),
    ...(threshold ? { threshold } : {}),
    coverage: { ...coverageFor(m) },
    window: WINDOW,
  };
}

function candidate(
  m: RawMetrics,
  flag: string,
  family: RiskFamily,
  raw: number,
  severity: number,
  confidence: number,
  detail: string,
  observed: Record<string, ObservedValue>,
  sampleSize?: number,
  threshold?: Record<string, number>,
): Candidate {
  return {
    raw: Math.max(0, finite(raw)),
    signal: {
      flag,
      family,
      disposition: "note",
      severity: rounded(clamp01(severity)),
      confidence: rounded(clamp01(confidence)),
      penalty: 0,
      detail,
      evidence: evidence(m, observed, sampleSize, threshold),
    },
  };
}

function addFootprintNote(
  m: RawMetrics,
  result: Candidate[],
  flag: string,
  detail: string,
  observed: Record<string, ObservedValue>,
  severity: number,
): void {
  const coverage = coverageFor(m);
  const confidence = 0.4 * coverage.repo + 0.4 * coverage.merged_pr + 0.2 * coverage.all_pr;
  result.push(candidate(m, flag, "footprint", 0, severity, confidence, detail, observed, m.fetched_repo_count));
}

function applyFamilyCap(candidates: Candidate[], family: RiskFamily, cap: number): number {
  const familyCandidates = candidates.filter((item) => item.signal.family === family && item.raw > 0);
  const rawTotal = familyCandidates.reduce((sum, item) => sum + item.raw, 0);
  if (rawTotal <= 0) return 0;
  const target = rounded(Math.min(cap, rawTotal), 2);
  const factor = target / rawTotal;
  let assigned = 0;
  familyCandidates.forEach((item, index) => {
    const penalty = index === familyCandidates.length - 1
      ? rounded(Math.max(0, target - assigned), 2)
      : rounded(item.raw * factor, 2);
    item.signal.penalty = penalty;
    item.signal.disposition = penalty > 0 ? "penalty" : "note";
    assigned = rounded(assigned + penalty, 2);
  });
  return assigned;
}

function socialRawPair(
  m: RawMetrics,
  followRaw: number,
  starRaw: number,
  follow: Candidate,
  star: Candidate,
): number {
  if (followRaw <= 0 || starRaw <= 0) return 0;
  // One point of synergy is split between the two signals so red_flags remains
  // compatible with the old flat list while the structured detail shows why the
  // pair is stronger than either signal alone.
  follow.raw = followRaw + 0.5;
  star.raw = starRaw + 0.5;
  void m;
  return follow.raw + star.raw;
}

function hasSocialOnlyDormantSignal(m: RawMetrics): boolean {
  return (
    m.followers >= 500 &&
    m.last_year_contributions === 0 &&
    m.merged_pr_count === 0 &&
    (m.impact_pr_count ?? 0) === 0 &&
    (m.max_impact_repo_stars ?? 0) === 0 &&
    m.total_stars <= 300 &&
    (m.best_original_repo_quality_score ?? 0) < 0.85
  );
}

/** Public v10 risk assessment. It never reads or changes the six base dimensions. */
export function assessRisk(m: RawMetrics): {
  risk_assessment: RiskAssessment;
  risk_notes: RiskAssessment["signals"];
  red_flags: RedFlag[];
  total_penalty: number;
} {
  const candidates: Candidate[] = [];
  const coverage = coverageFor(m);
  const coverageConfidence = 0.4 * coverage.repo + 0.4 * coverage.merged_pr + 0.2 * coverage.all_pr;
  const fetched = Math.max(1, finite(m.fetched_repo_count));

  // Public footprint is context only. It is intentionally never a penalty.
  if (m.account_age_years < 1 && m.public_repos > 30) {
    addFootprintNote(m, candidates, "new_account_mass_repos", "新账号公开仓库较多，说明采集到的足迹可能来自批量建仓；这本身不等于作弊。", {
      account_age_years: m.account_age_years,
      public_repos: m.public_repos,
    }, 0.5);
  }
  if (m.fork_repo_count / fetched > 0.7 && m.nonempty_original_repo_count <= 2) {
    addFootprintNote(m, candidates, "mostly_forks", "公开仓库以 Fork 为主，原创足迹有限；这本身不等于作弊。", {
      fork_repo_count: m.fork_repo_count,
      fetched_repo_count: fetched,
      nonempty_original_repo_count: m.nonempty_original_repo_count,
    }, 0.5);
  }
  if (m.nonempty_original_repo_count === 0) {
    addFootprintNote(m, candidates, "no_original_work", "当前公开采集范围内没有非空原创仓库；这只代表足迹有限，不代表作弊。", {
      nonempty_original_repo_count: m.nonempty_original_repo_count,
    }, 0.7);
  }
  if (m.empty_original_repo_count >= 5 && m.empty_original_repo_count / fetched > 0.5) {
    addFootprintNote(m, candidates, "mostly_empty_repos", "公开原创仓库中空仓库占比较高；这只作为足迹提示，不扣分。", {
      empty_original_repo_count: m.empty_original_repo_count,
      fetched_repo_count: fetched,
    }, 0.5);
  }
  if (!m.bio && m.followers < 3 && m.total_stars === 0 && m.merged_pr_count < 2) {
    addFootprintNote(m, candidates, "ghost_profile", "个人资料和公开项目足迹都很少，当前数据不足以判断行为真实性。", {
      has_bio: false,
      followers: m.followers,
      total_stars: m.total_stars,
      merged_pr_count: m.merged_pr_count,
    }, 0.6);
  }
  if (m.contribution_years_active <= 1 && m.account_age_years > 2 && (m.days_since_last_activity ?? 999) > 365) {
    addFootprintNote(m, candidates, "burst_then_dormant", "活动集中在较短时期且近期长期不活跃；这是时间覆盖提示，不扣分。", {
      contribution_years_active: m.contribution_years_active,
      account_age_years: m.account_age_years,
      days_since_last_activity: m.days_since_last_activity,
    }, 0.5);
  }
  if (hasSocialOnlyDormantSignal(m)) {
    addFootprintNote(m, candidates, "social_only_dormant_profile", "社交关注度与当前公开代码足迹不匹配；这是待解释现象，不扣分。", {
      followers: m.followers,
      last_year_contributions: m.last_year_contributions,
      merged_pr_count: m.merged_pr_count,
      total_stars: m.total_stars,
    }, 0.5);
  }

  const mergedSample = Math.max(0, finite(m.recent_merged_pr_sample));
  const externalTrivial = Math.max(0, finite(m.external_trivial_pr_count));
  const trivialRate = smoothedRate(externalTrivial, mergedSample);
  const trivialSeverity = clamp01((trivialRate - rules.thresholds.trivial_rate) / rules.thresholds.trivial_transition) * sampleFactor(mergedSample);
  const trivialObserved = mergedSample > 0 && externalTrivial > 0 && externalTrivial / mergedSample > 0.3;
  const trivialRaw = mergedSample >= rules.sampling.minimum_contribution_sample && trivialRate > rules.thresholds.trivial_rate
    ? 8 * clamp01((trivialRate - rules.thresholds.trivial_rate) / rules.thresholds.trivial_transition) * sampleFactor(mergedSample)
    : 0;
  let trivial: Candidate | undefined;
  if (trivialObserved) {
    trivial = candidate(m, "trivial_pr_farming", "contribution", trivialRaw, trivialSeverity, coverageConfidence * Math.max(sampleFactor(mergedSample), 0.25),
      mergedSample < rules.sampling.minimum_contribution_sample
        ? "外部热门仓库中的低实质 PR 比例偏高，但合并样本不足 20 个，仅作风险提示。"
        : "外部热门仓库中的低实质 PR 比例达到量化阈值；仅统计他人仓库，不惩罚正常自提 PR。", {
        external_trivial_pr_count: externalTrivial,
        merged_pr_sample: mergedSample,
        smoothed_rate: rounded(trivialRate),
      }, mergedSample, { minimum_sample: rules.sampling.minimum_contribution_sample, smoothed_rate: rules.thresholds.trivial_rate });
    candidates.push(trivial);
  }

  const rejected = m.maintainer_closed_unmerged_pr_count === undefined
    ? 0
    : Math.max(0, finite(m.maintainer_closed_unmerged_pr_count));
  const decided = Math.max(0, finite(m.merged_pr_count)) + rejected;
  const rejectionMeasured = m.maintainer_closed_unmerged_pr_count !== undefined;
  const rejectionLower = rejectionMeasured ? wilsonLower(rejected, decided) : 0;
  const rejectionSeverity = clamp01((rejectionLower - rules.thresholds.rejection_wilson_lower) / rules.thresholds.rejection_wilson_lower) * sampleFactor(decided);
  const rejectionRaw = rejectionMeasured && decided >= rules.sampling.minimum_rejection_decisions && rejectionLower >= rules.thresholds.rejection_wilson_lower
    ? 4 * clamp01((rejectionLower - rules.thresholds.rejection_wilson_lower) / rules.thresholds.rejection_wilson_lower)
    : 0;
  let rejection: Candidate | undefined;
  if (rejectionMeasured && decided > 0 && rejected > 0) {
    rejection = candidate(m, "high_pr_rejection", "contribution", rejectionRaw, rejectionSeverity, coverageConfidence * Math.max(sampleFactor(decided), 0.25),
      decided < rules.sampling.minimum_rejection_decisions || rejectionLower < rules.thresholds.rejection_wilson_lower
        ? "维护者关闭未合并的 PR 比例偏高，但样本量或 Wilson 95% 下界未达到扣分门槛，仅作风险提示。"
        : "维护者关闭未合并的 PR 的 Wilson 95% 下界达到量化阈值。", {
        maintainer_closed_unmerged_pr_count: rejected,
        merged_pr_count: m.merged_pr_count,
        decided_pr_count: decided,
        wilson_lower: rounded(rejectionLower),
      }, decided, { minimum_decisions: rules.sampling.minimum_rejection_decisions, wilson_lower: rules.thresholds.rejection_wilson_lower });
    candidates.push(rejection);
  }

  const floodSample = Math.max(0, finite(m.recent_pr_sample));
  const share = clamp01(finite(m.top_repo_pr_share));
  const templatedRatio = clamp01(finite(m.templated_pr_ratio));
  // `pr_flood_suspect` is produced by the bounded collector only after it has
  // verified that the top target is external. Do not reconstruct this from
  // share/title ratios: the same pattern in a user's own repository is normal.
  const floodObserved = m.pr_flood_suspect;
  const patternPass = floodSample >= rules.sampling.minimum_flood_sample &&
    share >= rules.thresholds.template_target_share && templatedRatio >= rules.thresholds.template_title_ratio;
  const patternSeverity = clamp01(((share - rules.thresholds.template_target_share) / (1 - rules.thresholds.template_target_share) +
    (templatedRatio - rules.thresholds.template_title_ratio) / (1 - rules.thresholds.template_title_ratio)) / 2);
  const corroboratingSeverity = Math.max(trivialSeverity, rejectionSeverity);
  const templateRaw = patternPass && corroboratingSeverity > 0 ? 8 * patternSeverity * corroboratingSeverity : 0;
  let template: Candidate | undefined;
  if (floodObserved) {
    const corroboration = corroboratingSeverity > 0;
    template = candidate(m, "templated_pr_flooding", "contribution", templateRaw, patternSeverity, coverageConfidence * Math.max(sampleFactor(floodSample), 0.25),
      patternPass && corroboration
        ? "PR 目标集中且标题模板化，并有外部低实质贡献或维护者拒绝率作为第二项证据；已按贡献风险族封顶。"
        : "PR 目标集中或标题模板化，但缺少第二项独立质量证据；仅作风险提示，不单独扣分。", {
        recent_pr_sample: floodSample,
        top_repo_pr_share: share,
        templated_pr_ratio: templatedRatio,
        corroborating_evidence: corroboration,
      }, floodSample, {
        minimum_sample: rules.sampling.minimum_flood_sample,
        target_share: rules.thresholds.template_target_share,
        title_ratio: rules.thresholds.template_title_ratio,
      });
    candidates.push(template);
  }

  const following = Math.max(0, finite(m.following));
  const followers = Math.max(0, finite(m.followers));
  const followerRatio = followers / Math.max(following, 1);
  const followObserved = following > 0 && followerRatio < rules.thresholds.follow_ratio;
  const followRaw = following >= rules.thresholds.follow_minimum && followerRatio < rules.thresholds.follow_ratio
    ? 4 * clamp01((rules.thresholds.follow_ratio - followerRatio) / rules.thresholds.follow_ratio) * clamp01((following - rules.thresholds.follow_minimum) / 3000)
    : 0;
  const follow = candidate(m, "follow_farming", "social", 0, clamp01((rules.thresholds.follow_ratio - followerRatio) / rules.thresholds.follow_ratio), coverageConfidence,
    "关注数量与粉丝数量明显失衡；当前只有单次快照，没有关注增长时间序列，不能单独判定刷粉。", {
      following,
      followers,
      follower_ratio: rounded(followerRatio),
    }, undefined, { minimum_following: rules.thresholds.follow_minimum, follower_ratio: rules.thresholds.follow_ratio });
  if (followObserved) candidates.push(follow);

  const engagement = m.top_repo_engagement_ratio;
  const starObserved = m.star_inflation_suspect;
  const starRaw = starObserved && m.max_stars >= rules.thresholds.star_minimum && engagement !== undefined
    ? 4 * clamp01((rules.thresholds.star_engagement_ratio - finite(engagement)) / rules.thresholds.star_engagement_ratio)
    : 0;
  const star = candidate(m, "possible_star_inflation", "social", 0, starRaw > 0 ? clamp01(starRaw / 4) : starObserved ? 0.5 : 0, coverageConfidence,
    starRaw > 0
      ? "高星标仓库的可测 engagement ratio 很低，且存在星标膨胀形态；只有与关注失衡同时出现才扣分。"
      : "存在星标/互动失衡迹象，但缺少足够星标或可公平测量的 engagement ratio，仅作风险提示。", {
      max_stars: m.max_stars,
      star_inflation_suspect: m.star_inflation_suspect,
      engagement_ratio: engagement ?? null,
    }, undefined, { minimum_stars: rules.thresholds.star_minimum, engagement_ratio: rules.thresholds.star_engagement_ratio });
  if (starObserved) candidates.push(star);

  if (follow && star) {
    socialRawPair(m, followRaw, starRaw, follow, star);
    if (followRaw <= 0 || starRaw <= 0) {
      follow.raw = 0;
      star.raw = 0;
      follow.signal.detail = "关注失衡是单一社交异常；没有第二项独立星标证据，不扣分。";
      star.signal.detail = "星标/互动异常是单一热度异常；没有第二项独立关注证据，不扣分。";
    }
  }

  const contributionPenalty = applyFamilyCap(candidates, "contribution", rules.caps.contribution);
  const socialPenalty = applyFamilyCap(candidates, "social", rules.caps.social);
  const totalPenalty = rounded(Math.min(rules.caps.total_penalty, contributionPenalty + socialPenalty), 2);
  const signals = candidates.map(({ signal }) => signal);
  const riskNotes = signals.filter((signal) => signal.penalty <= 0.005).map((signal) => ({
    ...signal,
    penalty: 0,
    disposition: "note" as const,
  }));
  const redFlags: RedFlag[] = signals
    .filter((signal) => signal.penalty > 0.005)
    .map((signal) => ({ flag: signal.flag, penalty: signal.penalty, detail: signal.detail }));
  const riskScore = rounded(totalPenalty / rules.caps.total_penalty * 100, 2);
  const level = riskScore >= rules.risk_levels.high_minimum
    ? "high"
    : riskScore >= rules.risk_levels.review_minimum
      ? "review"
      : "none";
  return {
    risk_assessment: {
      version: "v10",
      risk_score: riskScore,
      level,
      confidence: rounded(coverageConfidence * 100, 2),
      applied_penalty: totalPenalty,
      signals,
      coverage,
    },
    risk_notes: riskNotes,
    red_flags: redFlags,
    total_penalty: totalPenalty,
  };
}
