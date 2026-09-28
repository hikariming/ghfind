/**
 * Paged-preview pagination for the résumé paper.
 *
 * The screen preview renders one tall paper and shows it through per-page
 * clip windows. A break that lands inside a text line slices the glyphs
 * between two pages, which reads as swallowed text. `computePageBreaks`
 * snaps every break up to the nearest line gap so no line is ever split.
 */

/** Vertical interval (paper-relative pixels) a page break must not cross:
 *  one rendered text line or an atomic element such as the portrait. */
export interface LineBox {
  top: number;
  bottom: number;
}

/** Breaks exactly on a line-box edge are safe; strictly inside is not. */
const EDGE_EPSILON = 1;
/** Never snap a break so far up that a page ends up nearly empty; if no safe
 *  break exists above that floor, keep the seamless slice as a fallback. */
const MIN_PAGE_ADVANCE = 24;

function cutsLineBox(y: number, lineBoxes: LineBox[]): LineBox | null {
  for (const box of lineBoxes) {
    if (y > box.top + EDGE_EPSILON && y < box.bottom - EDGE_EPSILON) return box;
  }
  return null;
}

/**
 * Greedy page breaks in paper content coordinates. `breaks[0]` is the top
 * padding (the first window starts below the paper's own padding); every
 * later break is the highest safe position no lower than one usable page
 * below the previous break. Page `i` shows content rows
 * `[breaks[i], breaks[i + 1] ?? content)`.
 */
export function computePageBreaks(input: {
  content: number;
  pageHeight: number;
  padTop: number;
  padBottom: number;
  lineBoxes: LineBox[];
}): number[] {
  const usable = input.pageHeight - input.padTop - input.padBottom;
  const breaks = [input.padTop];
  if (usable <= 0) return breaks;
  const end = input.content - input.padBottom;
  while (breaks[breaks.length - 1] + usable < end - EDGE_EPSILON) {
    const start = breaks[breaks.length - 1];
    const ideal = start + usable;
    let candidate = ideal;
    for (;;) {
      const hit = cutsLineBox(candidate, input.lineBoxes);
      if (!hit) break;
      candidate = hit.top;
      if (candidate <= start + MIN_PAGE_ADVANCE) {
        candidate = ideal;
        break;
      }
    }
    breaks.push(candidate);
  }
  return breaks;
}
