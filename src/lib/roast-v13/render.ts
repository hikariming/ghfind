/**
 * Deterministic Markdown skeleton for roast v13. Scores, tier and dimension
 * maxima come from the scan; only prose fields come from the model.
 */
import { TIER_EN, TIER_LABEL_EN } from "../badge";
import type { Lang } from "../lang";
import { SUBSCORE_MAX } from "../score-presentation";
import type { ScanResult } from "../types";
import type { V13Copy } from "./validate";

export const V13_DIMENSIONS = [
  "account_maturity",
  "original_project_quality",
  "contribution_quality",
  "ecosystem_impact",
  "community_influence",
  "activity_authenticity",
] as const;

const DIM_LABEL: Record<Lang, Record<(typeof V13_DIMENSIONS)[number], string>> = {
  zh: {
    account_maturity: "账号成熟度",
    original_project_quality: "原创与主导项目质量",
    contribution_quality: "贡献质量",
    ecosystem_impact: "生态/维护影响力",
    community_influence: "社区影响力",
    activity_authenticity: "活跃真实性",
  },
  en: {
    account_maturity: "Account maturity",
    original_project_quality: "Original & Led Projects",
    contribution_quality: "Contribution quality",
    ecosystem_impact: "Ecosystem / maintenance impact",
    community_influence: "Community influence",
    activity_authenticity: "Activity authenticity",
  },
};

function cell(text: string): string {
  return text.replace(/\|/g, "/").replace(/\s*\n+\s*/g, " ").trim();
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/** Deterministic fallback when the model leaves `risk` empty: the first clause
 * of each scorer note (the disclaimer tail is template text). */
function riskLines(scan: ScanResult, zh: boolean): string[] {
  const notes = [...(scan.scoring.red_flags ?? []), ...(scan.scoring.risk_notes ?? [])] as Array<{
    detail?: string;
    disposition?: string;
  }>;
  const out = notes
    .map((n) => {
      const first = String(n.detail ?? "").split(zh ? /[；;。]/ : /[;.]/)[0].trim();
      if (!first) return "";
      const note = n.disposition === "note";
      return zh ? `${first}${note ? "（提示）" : ""}` : `${first}${note ? " (note)" : ""}`;
    })
    .filter(Boolean);
  return out.length ? [...new Set(out)].slice(0, 3) : [zh ? "有需要人工复核的信号。" : "Signals worth a human look."];
}

export function hasRiskSignals(scan: ScanResult): boolean {
  return (scan.scoring.risk_notes?.length ?? 0) > 0 || (scan.scoring.red_flags?.length ?? 0) > 0;
}

export function renderV13Report(scan: ScanResult, lang: Lang, copy: V13Copy): string {
  const s = scan.scoring;
  const zh = lang !== "en";
  const tier = zh ? s.tier : TIER_EN[s.tier];
  const tierLabel = zh ? s.tier_label : TIER_LABEL_EN[s.tier];
  const lines: string[] = [];
  lines.push(`## ${scan.metrics.username} — ${s.final_score.toFixed(2)}/100  ·  ${tier} (${tierLabel})`);
  lines.push("");
  if (copy.title) {
    lines.push(`${zh ? "**称号**" : "**Title**"}: ${cell(copy.title)}`);
    lines.push("");
  }
  lines.push(`${zh ? "**一句话结论**" : "**TL;DR**"}: ${cell(copy.verdict)}`);
  lines.push("");
  if (copy.findings.length) {
    lines.push(zh ? "**扎心三连**" : "**Three things we noticed**");
    copy.findings.slice(0, 3).forEach((f, i) => {
      const head = f.headline ? `**${cell(f.headline)}** ` : "";
      lines.push(`${i + 1}. ${head}${cell(f.text)}`);
    });
    lines.push("");
  }
  lines.push(zh ? "| 维度 | 得分 | 说明 |" : "| Dimension | Score | Note |");
  lines.push("|------|------|------|");
  for (const key of V13_DIMENSIONS) {
    const score = s.sub_scores[key];
    lines.push(
      `| ${DIM_LABEL[zh ? "zh" : "en"][key]} | ${fmt(score)}/${SUBSCORE_MAX[key]} | ${cell(copy.dimensions[key] ?? "")} |`,
    );
  }
  lines.push("");
  lines.push(zh ? "**风险标记**" : "**Red flags**");
  if (hasRiskSignals(scan) && copy.risk) lines.push(cell(copy.risk));
  else if (hasRiskSignals(scan)) for (const line of riskLines(scan, zh)) lines.push(`- ${cell(line)}`);
  else lines.push(zh ? "无。" : "None.");
  lines.push("");
  if (copy.advice.length) {
    lines.push(zh ? "**建议**" : "**Verdict**");
    for (const a of copy.advice.slice(0, 2)) lines.push(`- ${cell(a)}`);
  }
  return lines.join("\n").trim() + "\n";
}
