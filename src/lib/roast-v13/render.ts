/**
 * Deterministic Markdown skeleton for roast v13. Scores, tier and dimension
 * maxima come from the scan; only prose fields come from the model.
 *
 * Layout (parsed by RoastReport): stacked dimension cards with progress bars,
 * callout verdict, numbered findings with title chips, bulleted advice —
 * no narrow 3-column table (that wrapped dimension names on mobile).
 */
import { formatAdventurerLevel, realmForScore } from "../realm";
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
  const realm = realmForScore(s.final_score);
  const realmName = zh ? realm.nameZh : realm.nameEn;
  const realmBlurb = zh ? realm.blurbZh : realm.blurbEn;
  const lines: string[] = [];
  lines.push(`## ${scan.metrics.username} — ${formatAdventurerLevel(s.final_score)}  ·  ${realmName} (${realmBlurb})`);
  lines.push("");
  if (copy.title) {
    lines.push(`${zh ? "**称号**" : "**Title**"}: ${cell(copy.title)}`);
    lines.push("");
  }
  // Blockquote callout — RoastReport styles this as a highlighted verdict.
  lines.push(zh ? "> **小总评**" : "> **Quick Verdict**");
  lines.push(`>`);
  lines.push(`> ${cell(copy.verdict)}`);
  lines.push("");
  if (copy.findings.length) {
    const n = Math.min(copy.findings.length, 3);
    lines.push(zh ? `### 笑点${["一", "两", "三"][n - 1]}连` : `### ${["One witty take", "Two witty takes", "Three witty takes"][n - 1]}`);
    lines.push("");
    copy.findings.slice(0, 3).forEach((f, i) => {
      const head = f.headline ? `**${cell(f.headline)}**` : "";
      lines.push(`${i + 1}. ${head}`);
      lines.push("");
      lines.push(`   ${cell(f.text)}`);
      lines.push("");
    });
  }
  lines.push(zh ? "### 维度评分" : "### Dimensions");
  lines.push("");
  for (const key of V13_DIMENSIONS) {
    const score = s.sub_scores[key];
    const max = SUBSCORE_MAX[key];
    // h4 "Name · score/max" — RoastReport turns this into a card + progress bar.
    lines.push(`#### ${DIM_LABEL[zh ? "zh" : "en"][key]} · ${fmt(score)}/${max}`);
    lines.push("");
    lines.push(cell(copy.dimensions[key] ?? ""));
    lines.push("");
  }
  if (hasRiskSignals(scan) && copy.risk) {
    lines.push(zh ? "### 风险标记" : "### Red flags");
    lines.push("");
    lines.push(cell(copy.risk));
    lines.push("");
  } else if (hasRiskSignals(scan)) {
    lines.push(zh ? "### 风险标记" : "### Red flags");
    lines.push("");
    for (const line of riskLines(scan, zh)) lines.push(`- ${cell(line)}`);
    lines.push("");
  } else {
    // Single inline line — not a section — when there is nothing to flag.
    lines.push(zh ? "**风险标记**：无" : "**Red flags**: None");
    lines.push("");
  }
  if (copy.advice.length) {
    lines.push(zh ? "### 建议" : "### Next");
    lines.push("");
    for (const a of copy.advice.slice(0, 4)) lines.push(`- ${cell(a)}`);
  }
  return lines.join("\n").trim() + "\n";
}
