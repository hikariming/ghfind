"use client";

import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type { Resume } from "@/lib/resume";
import { computePageBreaks, type LineBox } from "@/lib/resume-pagination";
import { ResumePaper } from "./ResumePaper";

const A4_RATIO = 297 / 210;

type Metrics = { breaks: number[]; pageHeight: number; padTop: number; padBottom: number };

/** Line boxes of every rendered text run, plus atomic elements like the
 *  portrait, relative to the paper top. Page breaks must not cross them. */
function collectLineBoxes(paper: HTMLElement): LineBox[] {
  const origin = paper.getBoundingClientRect().top;
  const boxes: LineBox[] = [];
  const walker = document.createTreeWalker(paper, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      boxes.push({ top: rect.top - origin, bottom: rect.bottom - origin });
    }
    range.detach();
  }
  for (const img of paper.querySelectorAll("img")) {
    const rect = img.getBoundingClientRect();
    boxes.push({ top: rect.top - origin, bottom: rect.bottom - origin });
  }
  return boxes.sort((a, b) => a.top - b.top);
}

function sameMetrics(a: Metrics | null, b: Metrics): boolean {
  return !!a &&
    Math.abs(a.pageHeight - b.pageHeight) < .5 &&
    Math.abs(a.padTop - b.padTop) < .5 &&
    Math.abs(a.padBottom - b.padBottom) < .5 &&
    a.breaks.length === b.breaks.length &&
    a.breaks.every((value, index) => Math.abs(value - b.breaks[index]) < .5);
}

/** Caret offset of a click inside an element whose only child is its text, so
 *  the editor can place the caret at the same character. */
function caretOffset(element: HTMLElement, x: number, y: number): number | null {
  const legacy = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const position = document.caretPositionFromPoint?.(x, y);
  const range = position ? null : legacy.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset;
  if (!node || offset === undefined || node.nodeType !== Node.TEXT_NODE || node.parentNode !== element || element.childNodes.length !== 1) return null;
  return offset;
}

// Screen preview as a stack of A4 pages: one full-height copy is measured,
// then each page is an overflow-hidden window onto another copy of the same
// render. Breaks snap to line gaps so a page boundary never slices a line.
export function ResumePagedPaper({ resume, zh, onEdit }: { resume: Resume; zh: boolean; onEdit?: (key: string, offset: number | null) => void }) {
  const measureRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  useLayoutEffect(() => {
    const node = measureRef.current;
    const paper = node?.firstElementChild as HTMLElement | null;
    if (!node || !paper) return;
    const update = () => {
      const width = node.clientWidth;
      if (!width) return;
      const styles = getComputedStyle(paper);
      const padTop = parseFloat(styles.paddingTop) || 0;
      const padBottom = parseFloat(styles.paddingBottom) || 0;
      const pageHeight = width * A4_RATIO;
      const next: Metrics = {
        breaks: computePageBreaks({
          content: paper.offsetHeight,
          pageHeight,
          padTop,
          padBottom,
          lineBoxes: collectLineBoxes(paper),
        }),
        pageHeight,
        padTop,
        padBottom,
      };
      setMetrics(current => sameMetrics(current, next) ? current : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    observer.observe(paper);
    // Web fonts settling can move line boxes without changing the paper height.
    document.fonts?.ready.then(update).catch(() => {});
    return () => observer.disconnect();
  }, [resume, zh]);

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    // Selecting preview text to copy it must not jump to the editor.
    if (!onEdit || !window.getSelection()?.isCollapsed) return;
    const target = (event.target as Element).closest<HTMLElement>("[data-edit]");
    if (target?.dataset.edit) onEdit(target.dataset.edit, caretOffset(target, event.clientX, event.clientY));
  }

  return <div className={onEdit ? "resume-pages resume-pages-editable" : "resume-pages"} onClick={handleClick}>
    {metrics && metrics.breaks.map((start, index) => {
      // Each page's clip ends exactly where the next page starts, so a line
      // never repeats across pages despite snapped (shorter) windows.
      const end = index + 1 < metrics.breaks.length
        ? metrics.breaks[index + 1]
        : start + metrics.pageHeight - metrics.padTop - metrics.padBottom;
      return <div className="resume-page" key={index} style={{ height: metrics.pageHeight }} aria-hidden={index > 0 || undefined}>
        <div className="resume-page-clip" style={{ top: metrics.padTop, bottom: metrics.pageHeight - metrics.padTop - (end - start) }}>
          <div className="resume-page-content" style={{ top: -start }}>
            <ResumePaper resume={resume} zh={zh} />
          </div>
        </div>
      </div>;
    })}
    <div className="resume-pages-measure" ref={measureRef} aria-hidden>
      <ResumePaper resume={resume} zh={zh} />
    </div>
  </div>;
}
