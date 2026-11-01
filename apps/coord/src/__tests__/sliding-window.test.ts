import { describe, expect, it } from "vitest";
import { slidingWindowLimit, type WindowCounts } from "../sliding-window";

function counts(initial: Record<number, number> = {}) {
  const map = new Map<number, number>(Object.entries(initial).map(([k, v]) => [Number(k), v]));
  const c: WindowCounts & { map: Map<number, number> } = {
    map,
    get: (i) => map.get(i) ?? 0,
    set: (i, n) => void map.set(i, n),
  };
  return c;
}

const MIN = 60_000;

describe("slidingWindowLimit", () => {
  it("allows up to the limit within one window, then blocks", () => {
    const c = counts();
    const t0 = 10 * MIN; // start of window 10
    const results = Array.from({ length: 4 }, (_, i) => slidingWindowLimit(c, 3, MIN, t0 + i));
    expect(results.map((r) => r.success)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results.every((r) => r.reset === 11 * MIN && r.limit === 3)).toBe(true);
    // A blocked request does not consume budget.
    expect(c.map.get(10)).toBe(3);
  });

  it("weights the previous window by its remaining overlap (floored)", () => {
    // 10 requests in window 9; at 30% into window 10, 70% of them still count → floor(7) = 7.
    const c = counts({ 9: 10 });
    const r = slidingWindowLimit(c, 10, MIN, 10 * MIN + 0.3 * MIN);
    expect(r).toEqual({ success: true, limit: 10, remaining: 2, reset: 11 * MIN });
    expect(c.map.get(10)).toBe(1);
  });

  it("blocks when weighted previous + current reach the limit", () => {
    const c = counts({ 9: 10, 10: 3 });
    // 70% of 10 = 7, plus 3 current = 10 ≥ 10.
    expect(slidingWindowLimit(c, 10, MIN, 10 * MIN + 0.3 * MIN).success).toBe(false);
    // Later in the window the previous weight decays: 20% of 10 = 2, plus 3 = 5 < 10.
    expect(slidingWindowLimit(c, 10, MIN, 10 * MIN + 0.8 * MIN).success).toBe(true);
  });

  it("ignores windows older than the previous one", () => {
    const c = counts({ 5: 1000 });
    expect(slidingWindowLimit(c, 1, MIN, 10 * MIN).success).toBe(true);
  });

  it("handles day windows", () => {
    const DAY = 86_400_000;
    const c = counts();
    const r = slidingWindowLimit(c, 60, DAY, 20_000 * DAY + 5);
    expect(r).toEqual({ success: true, limit: 60, remaining: 59, reset: 20_001 * DAY });
  });
});
