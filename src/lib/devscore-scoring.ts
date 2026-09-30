/**
 * devscore → ghfind `Scoring`. The public score is devscore's v3
 * score; the six ghfind dimensions are display values derived from devscore's
 * intermediate factors (see .slim/deepwork/devscore-migration.md "六维映射")
 * and never feed the final score:
 *
 * - account_maturity (10)         ← sustained code-years
 * - original_project_quality (18) ← flagship strength
 * - contribution_quality (27)     ← independently accepted external work (engine `contrib`)
 * - ecosystem_impact (20)         ← max(engine impact, maintainer track)
 * - community_influence (8)       ← merge record (`collab_score`) + PR reviews given; never followers
 * - activity_authenticity (17)    ← recent share / status, cut when a slop or influencer cap applied
 *
 * `base_score` stays the sum of the six (profile pages rebuild it) and
 * `total_penalty` = max(0, base − final); v3 flags become auditable v11 risk
 * signals. Pure: no I/O.
 */
import type { Developer } from "@/lib/devscore/model";
import type { Rated } from "@/lib/devscore/engine";
import { sat } from "@/lib/devscore/engine/score";
import { SUBSCORE_MAX, roundHalfEven, tierFor } from "@/lib/score";
import type {
  DevscoreRepoFactors,
  DevscoreSummary,
  RiskAssessment,
  RiskSignal,
  Scoring,
  SubScores,
} from "@/lib/types";

const TOP_REPOS = 10;
const EVIDENCE_WINDOW = "devscore contract v15 collection";
const CONFIDENCE_PERCENT = { high: 90, med: 60, low: 30 } as const;

/** Compact, JSON-safe explanation of one `rateDeveloper` result. */
export function devscoreSummary(dev: Developer, rated: Rated): DevscoreSummary {
  const owned = new Map(dev.repos.map((r) => [r.name, r.owned]));
  const topRepos: DevscoreRepoFactors[] = rated.engine.repos
    .filter((r) => r.excluded === null)
    .slice(0, TOP_REPOS)
    .map((r) => ({
      name: r.name,
      owned: owned.get(r.name) ?? false,
      kind: r.kind,
      importance: r.importance,
      share: r.share,
      authorship: r.authorship,
      volume: r.volume,
      nature: r.nature,
      durability: r.durability,
      work: r.work,
      endorsement: r.endorsement,
      contrib: r.contrib,
      hype: r.hype,
    }));
  let reviews = 0;
  for (const repo of dev.repos) {
    for (const n of Object.values(repo.reviews_by_year ?? {})) reviews += n;
  }
  const { curve, engine, v3 } = rated;
  return {
    version: "v11",
    collected_at: dev.collected_at,
    v3: { score: v3.score, tier: v3.tier, remapped: v3.remapped, flags: { ...v3.flags } },
    curve: {
      score: curve.score,
      main: curve.main,
      content_bonus: curve.content_bonus,
      confidence: curve.confidence,
      e: curve.e,
      e_dev: curve.e_dev,
      e_maint: curve.e_maint,
      maint_flagship: curve.maint_flagship,
      maint_sustained: curve.maint_sustained,
      status: curve.status,
      flagship: curve.flagship,
      sustained: curve.sustained,
      recent_share: curve.recent_share,
    },
    engine: {
      score: engine.score,
      impact_score: engine.impact_score,
      breadth: engine.breadth,
      breadth_score: engine.breadth_score,
      longevity_years: engine.longevity_years,
      longevity_score: engine.longevity_score,
      collab_score: engine.collab_score,
      contrib: engine.contrib,
      contrib_score: engine.contrib_score,
      top_repos: topRepos,
    },
    reviews,
    followers: dev.followers,
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Structural check for a summary read back from an untrusted snapshot. */
export function isDevscoreSummary(value: unknown): value is DevscoreSummary {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<DevscoreSummary>;
  const flags = s.v3?.flags;
  return (
    s.version === "v11" &&
    finite(s.v3?.score) &&
    finite(s.v3?.remapped) &&
    ["lawanle", "npc", "renshangren", "dingji", "hang"].includes(String(s.v3?.tier)) &&
    !!flags &&
    [flags.slop, flags.influencer, flags.no_pr_data, flags.hype].every((f) => typeof f === "boolean") &&
    finite(s.curve?.sustained) &&
    finite(s.curve?.flagship) &&
    finite(s.curve?.e_maint) &&
    (s.curve?.recent_share === null || finite(s.curve?.recent_share)) &&
    ["high", "med", "low"].includes(String(s.curve?.confidence)) &&
    ["active", "maintaining", "inactive"].includes(String(s.curve?.status)) &&
    finite(s.engine?.impact_score) &&
    finite(s.engine?.contrib) &&
    (s.engine?.collab_score === null || finite(s.engine?.collab_score)) &&
    Array.isArray(s.engine?.top_repos) &&
    finite(s.reviews)
  );
}

/** The six display dimensions, each in [0, SUBSCORE_MAX[key]] at 0.1 precision. */
export function devscoreSubScores(s: DevscoreSummary): SubScores {
  const capped = s.v3.flags.slop || s.v3.flags.influencer;
  const review = sat(s.reviews, 300);
  const community = s.engine.collab_score === null ? review : 0.5 * s.engine.collab_score + 0.5 * review;
  const statusFloor = s.curve.status === "active" ? 0.7 : s.curve.status === "maintaining" ? 0.5 : 0;
  const recent = s.curve.recent_share === null ? 0 : sat(s.curve.recent_share, 0.2);
  const activity = Math.max(recent, statusFloor) * (capped ? 0.3 : 1);
  const unit: SubScores = {
    account_maturity: sat(s.curve.sustained, 3),
    original_project_quality: sat(s.curve.flagship, 0.8),
    contribution_quality: sat(s.engine.contrib, 3),
    ecosystem_impact: Math.max(s.engine.impact_score, sat(s.curve.e_maint, 0.6)),
    community_influence: community,
    activity_authenticity: activity,
  };
  const out = {} as SubScores;
  for (const key of Object.keys(SUBSCORE_MAX) as (keyof SubScores)[]) {
    out[key] = roundHalfEven(SUBSCORE_MAX[key] * Math.min(1, Math.max(0, unit[key])), 1);
  }
  return out;
}

function signal(
  flag: string,
  family: RiskSignal["family"],
  penalty: number,
  severity: number,
  confidence: number,
  detail: string,
  observed: RiskSignal["evidence"]["observed"],
): RiskSignal {
  return {
    flag,
    family,
    disposition: penalty > 0 ? "penalty" : "note",
    severity,
    confidence,
    penalty,
    detail,
    evidence: { observed, window: EVIDENCE_WINDOW },
  };
}

function riskSignals(s: DevscoreSummary): RiskSignal[] {
  const { flags } = s.v3;
  // The caps squeeze the remapped score; attribute the reduction to the first applied cap.
  const capCut = roundHalfEven(Math.max(0, s.v3.remapped - s.v3.score), 2);
  const confidence = CONFIDENCE_PERCENT[s.curve.confidence] / 100;
  const out: RiskSignal[] = [];
  if (flags.slop) {
    out.push(signal("devscore_slop", "contribution", capCut, 1, confidence,
      "外部 PR 呈现批量低实质特征（slop 规则 A），分数被封顶。", { remapped: s.v3.remapped, score: s.v3.score }));
  }
  if (flags.influencer) {
    out.push(signal("devscore_influencer", "social", flags.slop ? 0 : capCut, 1, confidence,
      "关注者规模远超被独立接受的工程贡献（规则 B），分数被封顶。",
      { followers: s.followers, remapped: s.v3.remapped, score: s.v3.score }));
  }
  if (flags.hype) {
    out.push(signal("devscore_hype", "footprint", 0, 0.5, confidence,
      "最受关注的自有项目属于炒作型项目（规则 F），其采用度不计分，不额外扣分。", { hype: true }));
  }
  if (flags.no_pr_data) {
    out.push(signal("no_pr_data", "contribution", 0, 0, confidence,
      "缺少外部 PR 明细，未运行 slop 检测。", { ext_prs: null }));
  }
  if (s.curve.confidence === "low") {
    out.push(signal("low_evidence_confidence", "footprint", 0, 0.3, confidence,
      "公开证据较少，分数置信度低（不代表能力低）。", { confidence: s.curve.confidence }));
  }
  return out;
}

/** Deterministic v11 `Scoring` from a stored devscore summary. */
export function scoringFromDevscore(s: DevscoreSummary): Scoring {
  const subScores = devscoreSubScores(s);
  const base = roundHalfEven(Object.values(subScores).reduce((a, b) => a + b, 0), 1);
  // Truncate (not round) to two decimals so the ghfind tier always equals the
  // devscore v3 tier: 89.996 stays 顶级 instead of rounding up into 夯.
  const final = Math.max(0, Math.min(100, Math.floor(s.v3.score * 100) / 100));
  const penalty = roundHalfEven(Math.max(0, base - final), 2);
  const signals = riskSignals(s);
  const capped = s.v3.flags.slop || s.v3.flags.influencer;
  const riskAssessment: RiskAssessment = {
    version: "v11",
    risk_score: capped ? 100 : s.v3.flags.hype ? 40 : 0,
    level: capped ? "high" : s.v3.flags.hype ? "review" : "none",
    confidence: CONFIDENCE_PERCENT[s.curve.confidence],
    applied_penalty: penalty,
    signals,
    coverage: {
      repo: s.engine.top_repos.length === 0
        ? 0
        : s.engine.top_repos.filter((r) => r.work !== null).length / s.engine.top_repos.length,
      merged_pr: s.v3.flags.no_pr_data ? 0 : 1,
      all_pr: s.v3.flags.no_pr_data ? 0 : 1,
    },
  };
  const { tier, tier_label } = tierFor(final);
  return {
    sub_scores: subScores,
    base_score: base,
    red_flags: signals
      .filter((x) => x.penalty > 0)
      .map(({ flag, penalty: p, detail }) => ({ flag, penalty: p, detail })),
    risk_assessment: riskAssessment,
    risk_notes: signals.filter((x) => x.penalty <= 0),
    total_penalty: penalty,
    final_score: final,
    tier,
    tier_label,
  };
}

/** Persisted `bot_score` (0..10): 10 when the slop detector capped the score. */
export function devscoreBotScore(s: DevscoreSummary): number {
  return s.v3.flags.slop ? 10 : 0;
}
