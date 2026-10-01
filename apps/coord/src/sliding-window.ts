/**
 * Upstash `Ratelimit.slidingWindow` (single-region), reimplemented over plain
 * counters so a Durable Object can run it atomically. Same weighting, same
 * return values, same window/reset math as @upstash/ratelimit's Lua script:
 * the previous fixed window counts in proportion to how much of it still
 * overlaps the sliding window (floored), and the current window counts fully.
 */
export interface WindowCounts {
  /** Requests counted in fixed window `index`. */
  get(index: number): number;
  set(index: number, count: number): void;
}

export interface SlidingWindowResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms when the current fixed window ends. */
  reset: number;
}

export function slidingWindowLimit(
  counts: WindowCounts,
  tokens: number,
  windowMs: number,
  now: number,
): SlidingWindowResult {
  const currentWindow = Math.floor(now / windowMs);
  const reset = (currentWindow + 1) * windowMs;
  const inCurrent = counts.get(currentWindow);
  const percentageInCurrent = (now % windowMs) / windowMs;
  const inPrevious = Math.floor((1 - percentageInCurrent) * counts.get(currentWindow - 1));

  if (inPrevious + inCurrent >= tokens) {
    return { success: false, limit: tokens, remaining: 0, reset };
  }
  const newValue = inCurrent + 1;
  counts.set(currentWindow, newValue);
  const remaining = tokens - (newValue + inPrevious);
  return { success: remaining >= 0, limit: tokens, remaining: Math.max(0, remaining), reset };
}
