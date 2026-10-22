/**
 * Discover score (versioned, derived, inert by default).
 *
 * `product_score` (rubric project-value-v1) answers "is this product worth
 * using?" for boards. The Discover score answers a different, card-level
 * question: "is this worth a click from a stranger browsing Discover?".
 *
 * It is a pure function of an already-validated assessment artifact. The
 * evaluator never writes it, so there is exactly one implementation (this
 * file) shared by the Next app and the Feed worker. Nothing reads it unless a
 * caller opts in; production ranking and cards keep using product_score until
 * the owner signs off on a rollout.
 */

export const DISCOVER_SCORE_VERSION = "discover-score-v1";

export type DiscoverScorePartition = "agent" | "skill" | "microservice" | "sandbox" | "none";
export type DiscoverScoreBand = "must_try" | "worth_a_look" | "situational" | "weak" | "skip";
export type DiscoverScoreLifecycle =
  | "active_evolution"
  | "stable_maintenance"
  | "feature_complete"
  | "experimental"
  | "abandoned";
export type DiscoverScoreVerification =
  | "metadata_only"
  | "source_inspected"
  | "built"
  | "core_flow_executed";
export type DiscoverScoreExposure = "unknown" | "low" | "emerging" | "established" | "mainstream";
export type DiscoverRiskSeverity = "info" | "low" | "medium" | "high" | "critical";

export type DiscoverScoreInput = {
  pain: number; // 0..25
  effectiveness: number; // 0..30
  experience: number; // 0..30
  valueDensity: number; // 0..15
  productScore: number; // 0..100 (sum of the four)
  confidence: number; // 0..100
  verificationLevel: DiscoverScoreVerification;
  lifecycle: DiscoverScoreLifecycle;
  exposureBand: DiscoverScoreExposure;
  communityStrength: number | null; // 0..100, null when unknown
  risks: ReadonlyArray<{ severity: DiscoverRiskSeverity; category: string }>;
  partition: DiscoverScorePartition;
};

/** Reader-facing components, each 0..1. */
export type DiscoverScoreComponents = {
  /** Distinctive usefulness: real pain that the product actually removes. */
  usefulness: number;
  /** Time-to-first-success. */
  tryability: number;
  /** Benefit per unit of setup / concepts / ops burden. */
  focus: number;
  /** Lifecycle fitness: will it still work next month. */
  maturity: number;
  /** Someone else already relies on it (saturating, never dominant). */
  adoption: number;
};

export type DiscoverScoreCap =
  | "abandoned"
  | "experimental"
  | "metadata_only"
  | "critical_risk"
  | "sandbox_security_risk"
  | "not_discover_eligible";

export type DiscoverScoreReason =
  | "real_pain"
  | "delivers"
  | "quick_start"
  | "focused"
  | "mature"
  | "adopted";

export type DiscoverScoreLimit =
  | "thin_evidence"
  | "early_stage"
  | "abandoned"
  | "steep_setup"
  | "narrow_pain"
  | "partial_delivery"
  | "adoption_risk";

export type DiscoverScoreResult = {
  version: typeof DISCOVER_SCORE_VERSION;
  score: number;
  band: DiscoverScoreBand;
  /** False: never show on Discover (empty repos, fixtures, broken core). */
  eligible: boolean;
  partition: DiscoverScorePartition;
  components: DiscoverScoreComponents;
  /** Weighted composite before confidence shrink and calibration (0..100). */
  raw: number;
  caps: DiscoverScoreCap[];
  /** Up to two strengths, strongest first. Machine codes; UI localizes. */
  reasons: DiscoverScoreReason[];
  /** Up to two limits, most important first. */
  limits: DiscoverScoreLimit[];
};

type Weights = Record<keyof DiscoverScoreComponents, number>;

/**
 * Partition fit = which components matter most for that kind of product.
 * Every row sums to 1.
 */
export const DISCOVER_PARTITION_WEIGHTS: Readonly<Record<DiscoverScorePartition, Weights>> = {
  // Agents are hype-heavy: weight "does it really work" and lifecycle.
  agent: { usefulness: 0.4, tryability: 0.25, focus: 0.1, maturity: 0.15, adoption: 0.1 },
  // Skills/MCP/plugins: instant install and small surface are the whole point.
  skill: { usefulness: 0.35, tryability: 0.3, focus: 0.2, maturity: 0.05, adoption: 0.1 },
  // Service infra: you will operate it; maturity and adoption carry more.
  microservice: { usefulness: 0.35, tryability: 0.2, focus: 0.1, maturity: 0.2, adoption: 0.15 },
  // Sandboxes: isolation must actually hold; usefulness dominates, security caps.
  sandbox: { usefulness: 0.45, tryability: 0.2, focus: 0.1, maturity: 0.15, adoption: 0.1 },
  none: { usefulness: 0.4, tryability: 0.25, focus: 0.1, maturity: 0.15, adoption: 0.1 },
};

const LIFECYCLE_MATURITY: Readonly<Record<DiscoverScoreLifecycle, number>> = {
  stable_maintenance: 1,
  feature_complete: 1,
  active_evolution: 0.85,
  experimental: 0.5,
  abandoned: 0,
};

/** Adoption saturates at "established"; mainstream earns nothing extra. */
const EXPOSURE_ADOPTION: Readonly<Record<DiscoverScoreExposure, number>> = {
  unknown: 0.5,
  low: 0.35,
  emerging: 0.6,
  established: 0.9,
  mainstream: 0.9,
};

/**
 * Fixed calibration curve (raw-after-shrink -> displayed score). Frozen for
 * this version from the 2026-10-23 public corpus so bands keep meaning:
 * roughly top ~9% must_try, ~27% worth_a_look, ~38% situational.
 * Changing knots requires a new DISCOVER_SCORE_VERSION.
 */
export const DISCOVER_CALIBRATION_KNOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [35, 20],
  [50, 40],
  [58, 55],
  [66, 70],
  [76, 85],
  [90, 97],
  [100, 100],
];

const DISCOVER_BAND_FLOORS: ReadonlyArray<readonly [DiscoverScoreBand, number]> = [
  ["must_try", 85],
  ["worth_a_look", 70],
  ["situational", 55],
  ["weak", 40],
  ["skip", 0],
];

const NOT_ELIGIBLE_CEILING = 24;

export function discoverScoreBand(score: number): DiscoverScoreBand {
  for (const [band, floor] of DISCOVER_BAND_FLOORS) if (score >= floor) return band;
  return "skip";
}

export function computeDiscoverScore(input: DiscoverScoreInput): DiscoverScoreResult {
  const pain = ratio(input.pain, 25);
  const effectiveness = ratio(input.effectiveness, 30);
  const components: DiscoverScoreComponents = {
    usefulness: 0.45 * pain + 0.55 * effectiveness,
    tryability: ratio(input.experience, 30),
    focus: ratio(input.valueDensity, 15),
    maturity: LIFECYCLE_MATURITY[input.lifecycle],
    adoption: adoptionSignal(input.communityStrength, input.exposureBand),
  };
  const weights = DISCOVER_PARTITION_WEIGHTS[input.partition];
  const raw =
    100 *
    (weights.usefulness * components.usefulness +
      weights.tryability * components.tryability +
      weights.focus * components.focus +
      weights.maturity * components.maturity +
      weights.adoption * components.adoption);

  // Thin evidence cannot claim a high score. Shrink only downward toward 50
  // so low confidence never lifts a bad project.
  const shrink = clamp(0.6 + (clamp(input.confidence, 0, 100) - 50) / 75, 0.6, 1);
  const shrunk = raw > 50 ? 50 + (raw - 50) * shrink : raw;
  let score = calibrate(shrunk);

  const caps: DiscoverScoreCap[] = [];
  const cap = (limit: number, reason: DiscoverScoreCap) => {
    caps.push(reason);
    score = Math.min(score, limit);
  };
  if (input.lifecycle === "abandoned") cap(39, "abandoned");
  if (input.lifecycle === "experimental") cap(69, "experimental");
  if (input.verificationLevel === "metadata_only") cap(54, "metadata_only");
  if (input.risks.some((risk) => risk.severity === "critical")) cap(54, "critical_risk");
  if (
    input.partition === "sandbox" &&
    input.risks.some((risk) => risk.category === "security" && risk.severity === "high")
  ) {
    cap(54, "sandbox_security_risk");
  }
  const eligible = input.effectiveness >= 8 && input.pain >= 7 && input.productScore >= 25;
  if (!eligible) cap(NOT_ELIGIBLE_CEILING, "not_discover_eligible");

  const rounded = Math.round(clamp(score, 0, 100));
  return {
    version: DISCOVER_SCORE_VERSION,
    score: rounded,
    band: discoverScoreBand(rounded),
    eligible,
    partition: input.partition,
    components: roundComponents(components),
    raw: Math.round(raw * 10) / 10,
    caps,
    reasons: strengths(components, input),
    limits: limits(input, components),
  };
}

function adoptionSignal(community: number | null, exposure: DiscoverScoreExposure): number {
  const communityTerm = community === null ? 0.5 : Math.min(1, Math.sqrt(clamp(community, 0, 100) / 70));
  return 0.6 * communityTerm + 0.4 * EXPOSURE_ADOPTION[exposure];
}

function strengths(c: DiscoverScoreComponents, input: DiscoverScoreInput): DiscoverScoreReason[] {
  const candidates: Array<[DiscoverScoreReason, number, number]> = [
    ["real_pain", ratio(input.pain, 25), 0.8],
    ["delivers", ratio(input.effectiveness, 30), 0.8],
    ["quick_start", c.tryability, 0.8],
    ["focused", c.focus, 0.8],
    ["mature", c.maturity * (input.lifecycle === "active_evolution" ? 0.9 : 1), 0.95],
    ["adopted", c.adoption, 0.8],
  ];
  return candidates
    .filter(([, value, floor]) => value >= floor)
    .sort((a, b) => b[1] - b[2] - (a[1] - a[2]))
    .slice(0, 2)
    .map(([code]) => code);
}

function limits(input: DiscoverScoreInput, c: DiscoverScoreComponents): DiscoverScoreLimit[] {
  const out: DiscoverScoreLimit[] = [];
  if (input.lifecycle === "abandoned") out.push("abandoned");
  if (input.risks.some((risk) => risk.severity === "critical" || risk.severity === "high")) {
    out.push("adoption_risk");
  }
  if (input.lifecycle === "experimental") out.push("early_stage");
  if (input.confidence < 60 || input.verificationLevel === "metadata_only") out.push("thin_evidence");
  if (ratio(input.effectiveness, 30) < 0.55) out.push("partial_delivery");
  if (c.tryability < 0.55) out.push("steep_setup");
  if (ratio(input.pain, 25) < 0.55) out.push("narrow_pain");
  return out.slice(0, 2);
}

function calibrate(x: number): number {
  const knots = DISCOVER_CALIBRATION_KNOTS;
  if (x <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i += 1) {
    const [x1, y1] = knots[i];
    const [x0, y0] = knots[i - 1];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return knots[knots.length - 1][1];
}

function ratio(value: number, max: number): number {
  return clamp(value, 0, max) / max;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function roundComponents(c: DiscoverScoreComponents): DiscoverScoreComponents {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    usefulness: r(c.usefulness),
    tryability: r(c.tryability),
    focus: r(c.focus),
    maturity: r(c.maturity),
    adoption: r(c.adoption),
  };
}

// ---------------------------------------------------------------------------
// Discover copy contract v6 (draft). Linted here so the shadow rescore, the
// TS contract and (on activation) the skill validator share one rule set.

const DISCOVER_HOOK_V6_MAX_CJK = 64;
const DISCOVER_HOOK_V6_MAX_LATIN = 120;

export type DiscoverCopyIssue =
  | "empty"
  | "too_long"
  | "template_lead"
  | "name_lead"
  | "marketing_filler"
  | "report_voice"
  | "truncated";

const V6_TEMPLATE_LEAD =
  /^(?:这是一个|这是一款|这是一种|该项目|本项目|本仓库|该仓库|[^\s，。,]{1,40}?\s*(?:是一个|是一款|是一种|是一套|是面向)|[\w.@+/-]+\s+is\s+(?:a|an|the)\s|(?:a|an)\s[\w\s-]{0,40}(?:tool|library|framework|project|app)\b)/i;
const V6_TYPE_NOUN_LEAD =
  /^(?:一个|一款|一套|一种)[^，。,；;]{0,48}的(?:[^，。,；;]{0,12})(?:工具|项目|库|框架|应用|平台|系统|插件|扩展|运行时|客户端|服务端|夹具|合集|集合|SDK|网站|站点)/;
const V6_MARKETING = /(强大的|高效的|简单易用|新一代|一站式|赋能|极致|革命性|blazing|powerful|next-gen|revolutionary|seamless)/i;
const V6_REPORT_VOICE = /(目标用户|该产品瞄准|没有本项目时|本项目针对|试图|宣称|the target user|this project aims)/i;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

export function lintDiscoverHookV6(hook: string, name?: string): DiscoverCopyIssue[] {
  const text = hook.replace(/\s+/g, " ").trim();
  if (!text) return ["empty"];
  const issues: DiscoverCopyIssue[] = [];
  const limit = CJK.test(text) ? DISCOVER_HOOK_V6_MAX_CJK : DISCOVER_HOOK_V6_MAX_LATIN;
  if ([...text].length > limit) issues.push("too_long");
  if (V6_TEMPLATE_LEAD.test(text) || V6_TYPE_NOUN_LEAD.test(text)) issues.push("template_lead");
  if (name) {
    const lower = text.toLowerCase();
    const short = name.toLowerCase().split("/").pop() ?? "";
    if ((short && lower.startsWith(short)) || lower.startsWith(name.toLowerCase())) issues.push("name_lead");
  }
  if (V6_MARKETING.test(text)) issues.push("marketing_filler");
  if (V6_REPORT_VOICE.test(text)) issues.push("report_voice");
  if (/(…|\.\.\.)$/.test(text)) issues.push("truncated");
  return issues;
}
