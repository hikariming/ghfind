/**
 * Roast-report splitting — pure, so it's unit-testable and shared.
 *
 * The LLM report ends with a savage one-liner marked `🔥 **毒舌点评**: …` (zh) or
 * `🔥 **Roast**: …` (en). Split it so the score card shows only that one-liner
 * while the scoring table/dimensions render separately below. While streaming,
 * the marker may not have arrived yet — then everything is still `body` and
 * `roast` stays empty.
 */

/** Marker that introduces the savage one-liner, in either language. */
const ROAST_MARKER = /🔥\s*\*{0,2}\s*(?:毒舌点评|Roast)\s*\*{0,2}\s*[：:]/i;

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
