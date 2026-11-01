/**
 * Where one raw public fact sits among *all* GitHub accounts (or repositories).
 *
 * The whole population is summarized offline (scripts/github-population.mts)
 * into a monotone "how many members have at least t" table per metric. Online
 * lookups only interpolate that table: no GitHub call, no DB read, and
 * O(log n) per metric, so it is safe on every profile render and API hit.
 *
 * This module is dependency-free on purpose (the build script and its tests
 * import it directly); `github-standing.ts` binds it to the shipped snapshot.
 */

/** Monotone survival table: `at_least[i]` members have value >= `thresholds[i]`. */
export interface PopulationTable {
  /** Strictly ascending; `thresholds[0]` is the metric floor (normally 0). */
  thresholds: number[];
  /** Non-increasing counts aligned with `thresholds`. */
  at_least: number[];
  /** Population size N. `at_least[0]` equals N when `thresholds[0]` is the floor. */
  total: number;
  /**
   * Thresholds whose count came back partial from GitHub Search. Values on
   * them are not treated as measured: they read as approximate.
   */
  incomplete?: number[];
}

export interface PopulationStanding {
  /** Estimated members with a value >= the input (the input itself included). */
  at_least: number;
  /** Size of the comparison group: the population, or its non-zero part. */
  denominator: number;
  /** at_least / denominator, in (0, 1]: "top X" as a share. */
  top_share: number;
  /** Members strictly below the input, as a share in [0, 1). */
  below_share: number;
  /**
   * Bounds on `top_share` from the two measured thresholds around the input
   * (equal when `exact`). The upper bound is the conservative reading.
   */
  top_share_range: [number, number];
  /** True when the input landed exactly on a measured threshold (no interpolation). */
  exact: boolean;
}

export interface StandingOptions {
  /**
   * Compare only against members with a value >= `floor` (e.g. repositories
   * with at least 10 stars). GitHub counts are heavy tailed: 99% of public
   * repositories have fewer than 10 stars, so against the whole population
   * any traction reads as "top 0.0x%". 0 (the default) compares with everyone.
   */
  floor?: number;
}

const lnCount = (count: number) => Math.log(Math.max(count, 1e-9));
const lnValue = (value: number) => Math.log1p(Math.max(0, value));

/** Validate the invariants interpolation relies on. Throws on a bad table. */
export function assertPopulationTable(table: PopulationTable, label = "table"): void {
  const { thresholds, at_least, total } = table;
  if (thresholds.length < 2 || thresholds.length !== at_least.length) {
    throw new Error(`${label}: needs >= 2 aligned thresholds/counts`);
  }
  if (!(total > 0) || at_least[0] > total) throw new Error(`${label}: bad total`);
  for (let i = 1; i < thresholds.length; i++) {
    if (!(thresholds[i] > thresholds[i - 1])) throw new Error(`${label}: thresholds not ascending at ${i}`);
    if (at_least[i] > at_least[i - 1]) throw new Error(`${label}: counts increase at ${i}`);
  }
}

/** Largest i with thresholds[i] <= value, or -1 when value is below the floor. */
function segmentIndex(thresholds: number[], value: number): number {
  let lo = 0;
  let hi = thresholds.length - 1;
  if (value < thresholds[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (thresholds[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Members with value >= `value`. Between two measured thresholds the count is
 * interpolated linearly in (ln(1 + value), ln count): GitHub counts are heavy
 * tailed, so a power-law segment is far closer than a straight line. Past the
 * last threshold the last segment's slope is extended, floored at 1 (you).
 */
export function estimateAtLeast(table: PopulationTable, value: number): { count: number; exact: boolean } {
  const { thresholds, at_least, total } = table;
  if (!Number.isFinite(value)) return { count: total, exact: false };
  const i = segmentIndex(thresholds, value);
  if (i < 0) return { count: total, exact: false };
  if (thresholds[i] === value) {
    return { count: Math.max(1, at_least[i]), exact: !table.incomplete?.includes(value) };
  }

  const last = thresholds.length - 1;
  const [a, b] = i === last ? [last - 1, last] : [i, i + 1];
  const x0 = lnValue(thresholds[a]);
  const x1 = lnValue(thresholds[b]);
  const t = (lnValue(value) - x0) / (x1 - x0);
  const c0 = at_least[a];
  const c1 = at_least[b];
  let count: number;
  if (c0 > 0 && c1 > 0) {
    count = Math.exp(lnCount(c0) + t * (lnCount(c1) - lnCount(c0)));
  } else {
    count = c0 + t * (c1 - c0);
  }
  // Interpolated counts stay inside their segment; extrapolation never
  // exceeds the last measured count and never drops below one member.
  const upper = i === last ? at_least[last] : at_least[i];
  const lower = i === last ? 1 : Math.max(1, at_least[i + 1]);
  return { count: Math.min(upper, Math.max(lower, count)), exact: false };
}

/** Measured counts bracketing `value`: [fewer, more] members at or above it. */
function bracket(table: PopulationTable, value: number): [number, number] {
  const { thresholds, at_least, total } = table;
  const i = segmentIndex(thresholds, value);
  if (i < 0) return [total, total];
  if (thresholds[i] === value) return [Math.max(1, at_least[i]), Math.max(1, at_least[i])];
  if (i === thresholds.length - 1) return [1, Math.max(1, at_least[i])];
  return [Math.max(1, at_least[i + 1]), Math.max(1, at_least[i])];
}

export function populationStanding(
  table: PopulationTable,
  value: number,
  options: StandingOptions = {},
): PopulationStanding {
  const floor = options.floor ?? 0;
  const denominator = floor > 0 && value >= floor
    ? Math.max(1, Math.min(table.total, estimateAtLeast(table, floor).count))
    : table.total;
  const { count, exact } = estimateAtLeast(table, value);
  const atLeast = Math.max(1, Math.min(denominator, count));
  const top = atLeast / denominator;
  const [fewer, more] = bracket(table, value).map((c) => Math.min(denominator, c) / denominator);
  return {
    at_least: Math.round(atLeast),
    denominator: Math.round(denominator),
    top_share: top,
    below_share: Math.max(0, 1 - top),
    top_share_range: [Math.min(fewer, top), Math.max(more, top)],
    exact,
  };
}

/** A percent number in `locale` without grouping, e.g. "4.2" or "4,2". */
function formatPercentNumber(value: number, locale: string, options: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, { useGrouping: false, ...options }).format(value);
}

/**
 * "Top X%" text for a share in (0, 1]. Whole percents from 10%, one decimal
 * from 1%, then two significant digits so 0.087% and 0.0049% stay readable.
 * Decimal separators follow `locale`.
 */
export function formatTopPercent(share: number, locale = "en-US"): string {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  if (pct >= 10) return formatPercentNumber(Math.round(pct), locale, { maximumFractionDigits: 0 });
  if (pct >= 1) return formatPercentNumber(Math.round(pct * 10) / 10, locale, { maximumFractionDigits: 1 });
  if (pct <= 0) return formatPercentNumber(0, locale, { maximumFractionDigits: 0 });
  return formatPercentNumber(pct, locale, { maximumSignificantDigits: 2 });
}

/**
 * An estimated count at three significant digits: grouped below 10,000
 * ("3,540"), compact from there ("20.7万", "207K", "3.63亿").
 */
export function formatApproxCount(value: number, locale: string): string {
  const rounded = Number(Math.max(0, value).toPrecision(3));
  return rounded < 10_000
    ? new Intl.NumberFormat(locale).format(rounded)
    : new Intl.NumberFormat(locale, { notation: "compact", maximumSignificantDigits: 3 }).format(rounded);
}

/**
 * "Older than X%" text for a share in [0, 1). Rounds down, so a share below
 * one never reads as 100%: whole percents below 90%, one decimal below 99%,
 * then two. Closer to 100% it adds decimals until the gap shows (99.9993%),
 * up to six. Decimal separators follow `locale`.
 */
export function formatBeatPercent(share: number, locale = "en-US"): string {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  if (pct >= 100) return formatPercentNumber(100, locale, { maximumFractionDigits: 0 });
  const base = pct < 90 ? 0 : pct < 99 ? 1 : 2;
  const digits = Math.min(6, Math.max(base, Math.ceil(-Math.log10(100 - pct))));
  const scale = 10 ** digits;
  const floored = Math.min(Math.floor(pct * scale + 1e-9), 100 * scale - 1) / scale;
  return formatPercentNumber(floored, locale, { maximumFractionDigits: digits });
}

/**
 * Exact 1-based rank of `value` in a descending list: one more than the
 * number of entries strictly greater, so ties share the best rank.
 */
export function rankAmongDescending(sortedDesc: readonly number[], value: number): number {
  let lo = 0;
  let hi = sortedDesc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDesc[mid] > value) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}
