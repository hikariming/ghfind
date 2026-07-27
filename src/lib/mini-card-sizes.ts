/**
 * Intrinsic geometry of the mini cards.
 *
 * Split out of `mini-card.ts` so the client-side embed-snippet builder can read
 * the width it must put in `<img width>` without pulling the SVG renderer — and
 * the scoring engine behind it — into the browser bundle.
 *
 * `bars`/`radar` sit at roughly half a README column, so they read as an inline
 * card rather than a full-bleed banner. (Two do NOT fit on one line: a repo
 * README body is ~830px and a profile README's column is narrower still, so
 * 2×440 wraps. Verified, not assumed.) `strip` is the row-height option for an
 * existing shields badge block.
 */

export type MiniCardVariant = "bars" | "radar" | "strip";

export const MINI_CARD_SIZES: Record<MiniCardVariant, { w: number; h: number }> = {
  bars: { w: 440, h: 200 },
  radar: { w: 440, h: 200 },
  strip: { w: 420, h: 88 },
};
