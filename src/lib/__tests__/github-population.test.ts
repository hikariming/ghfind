import { describe, expect, it } from "vitest";
import {
  assertPopulationTable,
  estimateAtLeast,
  formatApproxCount,
  formatBeatPercent,
  formatTopPercent,
  populationStanding,
  rankAmongDescending,
  type PopulationTable,
} from "../github-population";

// Shape of the real followers table (GitHub Search, 2026-11): heavy tailed.
const followers: PopulationTable = {
  thresholds: [0, 1, 10, 100, 1_000, 10_000],
  at_least: [180_000_000, 20_000_000, 2_300_000, 157_000, 8_700, 365],
  total: 180_000_000,
};

describe("estimateAtLeast", () => {
  it("returns measured counts exactly on a threshold", () => {
    expect(estimateAtLeast(followers, 100)).toEqual({ count: 157_000, exact: true });
    expect(estimateAtLeast(followers, 0)).toEqual({ count: 180_000_000, exact: true });
  });

  it("interpolates monotonically inside a segment", () => {
    const counts = [100, 150, 300, 600, 999].map((v) => estimateAtLeast(followers, v).count);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThan(counts[i - 1]);
    expect(counts[0]).toBe(157_000);
    expect(counts[4]).toBeGreaterThan(8_700);
  });

  it("interpolates in log space, not linearly", () => {
    // Halfway in ln(1+v) between 100 and 1000 is ~317; the count there should
    // be near the geometric mean of the two measured counts, not the average.
    const mid = estimateAtLeast(followers, Math.sqrt(101 * 1001) - 1).count;
    expect(mid).toBeCloseTo(Math.sqrt(157_000 * 8_700), -2);
  });

  it("extrapolates past the last threshold without dropping below one", () => {
    const past = estimateAtLeast(followers, 50_000).count;
    expect(past).toBeLessThan(365);
    expect(past).toBeGreaterThanOrEqual(1);
    expect(estimateAtLeast(followers, 1e12).count).toBe(1);
  });

  it("does not call a value on a partially counted threshold measured", () => {
    const partial = { ...followers, incomplete: [100] };
    expect(estimateAtLeast(partial, 100)).toEqual({ count: 157_000, exact: false });
    expect(estimateAtLeast(partial, 1_000).exact).toBe(true);
  });

  it("treats non-finite or below-floor input as the whole population", () => {
    expect(estimateAtLeast(followers, Number.NaN).count).toBe(180_000_000);
    expect(estimateAtLeast(followers, -3).count).toBe(180_000_000);
  });
});

describe("populationStanding", () => {
  it("reports top and below shares that sum to one", () => {
    const s = populationStanding(followers, 100);
    expect(s.top_share).toBeCloseTo(157_000 / 180_000_000, 12);
    expect(s.top_share + s.below_share).toBeCloseTo(1, 12);
    expect(s.exact).toBe(true);
  });

  it("puts a zero at the top 100% with nobody below", () => {
    const s = populationStanding(followers, 0);
    expect(s.top_share).toBe(1);
    expect(s.below_share).toBe(0);
  });

  it("can compare only against members at or above a floor", () => {
    const all = populationStanding(followers, 100);
    const floored = populationStanding(followers, 100, { floor: 10 });
    expect(floored.denominator).toBe(2_300_000);
    expect(floored.top_share).toBeCloseTo(157_000 / 2_300_000, 12);
    expect(floored.top_share).toBeGreaterThan(all.top_share);
    expect(populationStanding(followers, 10, { floor: 10 }).top_share).toBe(1);
    // Below the floor the whole population is the denominator.
    expect(populationStanding(followers, 5, { floor: 10 }).denominator).toBe(180_000_000);
  });

  it("brackets interpolated values with the measured neighbours", () => {
    const s = populationStanding(followers, 183, { floor: 1 });
    expect(s.exact).toBe(false);
    expect(s.top_share_range[0]).toBeCloseTo(8_700 / 20_000_000, 12);
    expect(s.top_share_range[1]).toBeCloseTo(157_000 / 20_000_000, 12);
    expect(s.top_share).toBeGreaterThan(s.top_share_range[0]);
    expect(s.top_share).toBeLessThan(s.top_share_range[1]);
    const exact = populationStanding(followers, 1_000);
    expect(exact.top_share_range).toEqual([exact.top_share, exact.top_share]);
  });
});

describe("formatTopPercent", () => {
  it("uses coarser precision for larger shares", () => {
    expect(formatTopPercent(0.374)).toBe("37");
    expect(formatTopPercent(0.0421)).toBe("4.2");
    expect(formatTopPercent(0.000872)).toBe("0.087");
    expect(formatTopPercent(0.0000485)).toBe("0.0049");
    expect(formatTopPercent(1)).toBe("100");
  });

  it("uses the locale's decimal separator", () => {
    expect(formatTopPercent(0.0421, "pt-BR")).toBe("4,2");
    expect(formatTopPercent(0.0000485, "es")).toBe("0,0049");
    expect(formatTopPercent(0.374, "zh-CN")).toBe("37");
  });
});

describe("formatApproxCount", () => {
  it("keeps three significant digits, compact from 10,000", () => {
    expect(formatApproxCount(3_541.7, "en-US")).toBe("3,540");
    expect(formatApproxCount(207_073, "en-US")).toBe("207K");
    expect(formatApproxCount(363_266_215, "en-US")).toBe("363M");
    expect(formatApproxCount(207_073, "zh-CN")).toBe("20.7万");
    expect(formatApproxCount(363_266_215, "zh-CN")).toBe("3.63亿");
  });
});

describe("formatBeatPercent", () => {
  it("rounds down so a share below one never reads as 100%", () => {
    expect(formatBeatPercent(0.9997)).toBe("99.97");
    expect(formatBeatPercent(0.948)).toBe("94.8");
    expect(formatBeatPercent(0.899)).toBe("89");
    expect(formatBeatPercent(0)).toBe("0");
  });

  it("adds decimals near 100% until the gap shows", () => {
    expect(formatBeatPercent(0.99999333)).toBe("99.9993");
    expect(formatBeatPercent(0.9999999)).toBe("99.99999");
    expect(formatBeatPercent(1 - 1e-12)).toBe("99.999999");
    expect(formatBeatPercent(1)).toBe("100");
  });

  it("uses the locale's decimal separator", () => {
    expect(formatBeatPercent(0.948, "pt-BR")).toBe("94,8");
    expect(formatBeatPercent(0.9997, "vi")).toBe("99,97");
  });
});

describe("assertPopulationTable", () => {
  it("rejects tables interpolation cannot trust", () => {
    expect(() => assertPopulationTable({ thresholds: [0, 1], at_least: [10, 20], total: 10 })).toThrow();
    expect(() => assertPopulationTable({ thresholds: [1, 1], at_least: [10, 5], total: 10 })).toThrow();
    expect(() => assertPopulationTable({ thresholds: [0], at_least: [10], total: 10 })).toThrow();
    expect(() => assertPopulationTable(followers)).not.toThrow();
  });
});

describe("rankAmongDescending", () => {
  const stars = [500_000, 120_000, 120_000, 40_000, 10_000];

  it("is one more than the entries strictly above", () => {
    expect(rankAmongDescending(stars, 600_000)).toBe(1);
    expect(rankAmongDescending(stars, 500_000)).toBe(1);
    expect(rankAmongDescending(stars, 499_999)).toBe(2);
    expect(rankAmongDescending(stars, 40_001)).toBe(4);
    expect(rankAmongDescending(stars, 10_000)).toBe(5);
  });

  it("gives ties the best rank", () => {
    expect(rankAmongDescending(stars, 120_000)).toBe(2);
    expect(rankAmongDescending(stars, 119_999)).toBe(4);
  });

  it("ranks below the list after every entry", () => {
    expect(rankAmongDescending(stars, 9_999)).toBe(6);
    expect(rankAmongDescending([], 1)).toBe(1);
  });
});
