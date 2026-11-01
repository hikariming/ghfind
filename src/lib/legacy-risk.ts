import type { RedFlag, RiskAssessment, RiskFamily, RiskSignal } from "./types";

/** Keep the structured wire shape, while identifying the restored v9 policy. */
export function legacyRiskDetails(
  legacy: { red_flags: RedFlag[]; total_penalty: number },
  eligibility: { risk_assessment: RiskAssessment; risk_notes: RiskSignal[] },
) {
  const { risk_assessment: previous } = eligibility;
  const names = new Set(legacy.red_flags.map((flag) => flag.flag));
  const notes = eligibility.risk_notes.filter((signal) => !names.has(signal.flag));
  const signals: RiskSignal[] = legacy.red_flags.map((flag) => {
    const measured = previous.signals.find((signal) => signal.flag === flag.flag);
    const family: RiskFamily = flag.flag === "follow_farming" || flag.flag === "possible_star_inflation"
      ? "social"
      : ["trivial_pr_farming", "templated_pr_flooding", "high_pr_rejection"].includes(flag.flag)
        ? "contribution" : "footprint";
    return {
      flag: flag.flag, penalty: flag.penalty, detail: flag.detail,
      family, disposition: "penalty", severity: measured?.severity ?? 0,
      confidence: measured?.confidence ?? 0,
      evidence: {
        ...measured?.evidence,
        observed: measured?.evidence.observed ?? {}, coverage: { ...previous.coverage },
        window: measured?.evidence.window ?? "bounded public snapshot",
        threshold: { total_penalty_cap: 40 },
      },
    };
  });
  const riskScore = legacy.total_penalty / 40 * 100;
  return {
    red_flags: legacy.red_flags,
    risk_notes: notes,
    risk_assessment: {
      ...previous, version: "v9" as const, applied_penalty: legacy.total_penalty,
      risk_score: riskScore, level: riskScore >= 60 ? "high" as const : riskScore >= 20 ? "review" as const : "none" as const,
      signals: [...signals, ...notes],
    },
  };
}
