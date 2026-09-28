import { describe, expect, it } from "vitest";
import { computePageBreaks } from "@/lib/resume-pagination";

const PAGE = { pageHeight: 1000, padTop: 100, padBottom: 100 }; // usable = 800

describe("computePageBreaks", () => {
  it("returns a single page when the content fits", () => {
    expect(
      computePageBreaks({ ...PAGE, content: 900, lineBoxes: [] }),
    ).toEqual([100]);
  });

  it("keeps the seamless slice when no line box is crossed", () => {
    const breaks = computePageBreaks({
      ...PAGE,
      content: 2500,
      lineBoxes: [{ top: 400, bottom: 420 }],
    });
    expect(breaks).toEqual([100, 900, 1700]);
  });

  it("snaps a break above a line it would slice", () => {
    // Ideal break at y=900 would cut the line at 880..910.
    const breaks = computePageBreaks({
      ...PAGE,
      content: 2500,
      lineBoxes: [{ top: 880, bottom: 910 }],
    });
    expect(breaks[1]).toBe(880);
    // The sliced line is fully visible on page 2, and no rows are lost:
    // page 1 shows [100, 880), page 2 starts exactly at 880.
  });

  it("treats a break exactly on a line-box edge as safe", () => {
    const breaks = computePageBreaks({
      ...PAGE,
      content: 2500,
      lineBoxes: [{ top: 820, bottom: 900 }],
    });
    expect(breaks[1]).toBe(900);
  });

  it("breaks at the shared edge of stacked lines", () => {
    // Ideal break at 900 slices the 880..905 line; snapping to its top lands
    // exactly on the boundary with the 855..880 line, which is safe.
    const breaks = computePageBreaks({
      ...PAGE,
      content: 2500,
      lineBoxes: [
        { top: 830, bottom: 855 },
        { top: 855, bottom: 880 },
        { top: 880, bottom: 905 },
      ],
    });
    expect(breaks[1]).toBe(880);
  });

  it("keeps an atomic block whole when it fits one page", () => {
    // An 800px portrait block fits exactly one usable window: page 1 keeps
    // only the 50px above it, page 2 shows the whole block.
    const breaks = computePageBreaks({
      ...PAGE,
      content: 2500,
      lineBoxes: [{ top: 150, bottom: 950 }],
    });
    expect(breaks[1]).toBe(150);
  });

  it("falls back to the seamless slice when no safe break clears the floor", () => {
    // The giant block starts right below the previous break: snapping above
    // it would leave the page nearly empty, so keep the unsnapped break.
    const breaks = computePageBreaks({
      ...PAGE,
      content: 2500,
      lineBoxes: [{ top: 110, bottom: 950 }],
    });
    expect(breaks[1]).toBe(900);
  });

  it("always advances, so pagination terminates on pathological input", () => {
    const breaks = computePageBreaks({
      ...PAGE,
      content: 100000,
      lineBoxes: [{ top: 0, bottom: 100000 }],
    });
    for (let i = 1; i < breaks.length; i++) {
      expect(breaks[i]).toBeGreaterThan(breaks[i - 1]);
    }
    expect(breaks.length).toBeLessThan(200);
  });

  it("covers the whole document without gaps or overlaps", () => {
    const lineBoxes = Array.from({ length: 90 }, (_, i) => ({
      top: 120 + i * 22,
      bottom: 120 + i * 22 + 18,
    }));
    const breaks = computePageBreaks({ ...PAGE, content: 2200, lineBoxes });
    const end = 2200 - PAGE.padBottom;
    for (let i = 0; i < breaks.length; i++) {
      const windowEnd = Math.min(
        i + 1 < breaks.length ? breaks[i + 1] : Number.POSITIVE_INFINITY,
        breaks[i] + 800,
      );
      expect(windowEnd).toBeGreaterThan(breaks[i]);
      if (i + 1 < breaks.length) expect(breaks[i + 1]).toBeLessThanOrEqual(breaks[i] + 800);
      // No break slices a line.
      for (const box of lineBoxes) {
        const y = breaks[i];
        expect(y > box.top + 1 && y < box.bottom - 1).toBe(false);
      }
    }
    expect(breaks[breaks.length - 1] + 800).toBeGreaterThanOrEqual(end - 1);
  });
});
