/**
 * Round to `digits` decimals using round-half-to-even (banker's rounding),
 * matching Python's built-in `round()` so stored scores reproduce exactly.
 */
export function roundHalfEven(value: number, digits = 0): number {
  const f = 10 ** digits;
  const scaled = value * f;
  const floor = Math.floor(scaled);
  let r: number;
  if (Math.abs(scaled - floor - 0.5) < 1e-9) {
    r = floor % 2 === 0 ? floor : floor + 1; // exact half → nearest even
  } else {
    r = Math.round(scaled);
  }
  return r / f;
}

/** 0..1 scaled with a log curve: returns 1.0 when value >= full_at. */
export function logRatio(value: number, fullAt: number): number {
  if (value <= 0) return 0.0;
  return Math.min(Math.log10(value + 1) / Math.log10(fullAt + 1), 1.0);
}
