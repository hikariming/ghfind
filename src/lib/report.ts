/**
 * Roast-report splitting — pure, so it's unit-testable and shared.
 *
 * The LLM report ends with a savage one-liner marked `🔥 **毒舌点评**: …` (zh) or
 * `🔥 **Roast**: …` (en). Split it so the score card shows only that one-liner
 * while the scoring table/dimensions render separately below. While streaming,
 * the marker may not have arrived yet — then everything is still `body` and
 * `roast` stays empty.
 */

import type { Lang } from "./lang";

/** Marker that introduces the savage one-liner, in either language. */
const ROAST_MARKER = /🔥\s*\*{0,2}\s*(?:毒舌点评|Roast)\s*\*{0,2}\s*[：:]/i;
const CJK_RE = /[\u3400-\u9fff]/g;
const CHINESE_REPORT_MARKER_RE =
  /(?:\*\*(?:一句话结论|风险标记|人工修正|建议)\*\*|毒舌点评|账号成熟度|原创项目质量|贡献质量|社区影响力|活跃真实性)/;
const ENGLISH_REPORT_CJK_LIMIT = 12;

export function splitReport(md: string): { body: string; roast: string } {
  // Drop the leading "## <username> — <score>/100 · <tier>" heading — the card
  // above already shows score + tier, so it would just be redundant here.
  const stripTitle = (s: string) => s.replace(/^\s*#{1,6}\s+.*(?:\r?\n|$)/, "").trim();
  const m = md.match(ROAST_MARKER);
  if (!m || m.index === undefined) return { body: stripTitle(md), roast: "" };
  return {
    body: stripTitle(md.slice(0, m.index)),
    roast: md.slice(m.index + m[0].length).trim(),
  };
}

export function reportMatchesLang(md: string, lang: Lang): boolean {
  if (lang === "zh") return true;
  if (CHINESE_REPORT_MARKER_RE.test(md)) return false;
  const cjkCount = md.match(CJK_RE)?.length ?? 0;
  return cjkCount <= ENGLISH_REPORT_CJK_LIMIT;
}
