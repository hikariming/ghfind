/**
 * Percentile math, kept pure so it can be unit-tested without a live DB.
 */

/**
 * Percent of ranked accounts you beat: `below / total * 100`, rounded to 1 decimal.
 *
 * `total` includes yourself (your row is upserted before the count), `below` is
 * the number of accounts scoring strictly lower. Returns `null` when you are the
 * only ranked account (or the board is empty) — there is no one to beat yet.
 */
export function beatPercent(below: number, total: number): number | null {
  if (total <= 1) return null;
  const pct = (below / total) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}
