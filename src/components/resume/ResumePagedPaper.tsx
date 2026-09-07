"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { Resume } from "@/lib/resume";
import { ResumePaper } from "./ResumePaper";

const A4_RATIO = 297 / 210;

type Metrics = { content: number; pageHeight: number; padTop: number; padBottom: number };

// Screen preview as a stack of A4 pages: one full-height copy is measured,
// then each page is an overflow-hidden window onto another copy of the same
// render, offset so every page keeps the template's own padding as margins.
export function ResumePagedPaper({ resume, zh }: { resume: Resume; zh: boolean }) {
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
      const next: Metrics = {
        content: paper.offsetHeight,
        pageHeight: width * A4_RATIO,
        padTop: parseFloat(styles.paddingTop) || 0,
        padBottom: parseFloat(styles.paddingBottom) || 0,
      };
      setMetrics(current => current && Object.keys(next).every(key => Math.abs(next[key as keyof Metrics] - current[key as keyof Metrics]) < .5) ? current : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    observer.observe(paper);
    return () => observer.disconnect();
  }, []);

  const usable = metrics ? metrics.pageHeight - metrics.padTop - metrics.padBottom : 0;
  const pageCount = metrics && usable > 0 ? Math.max(1, Math.ceil((metrics.content - metrics.padTop) / usable)) : 0;

  return <div className="resume-pages">
    {metrics && Array.from({ length: pageCount }, (_, index) => <div className="resume-page" key={index} style={{ height: metrics.pageHeight }} aria-hidden={index > 0 || undefined}>
      <div className="resume-page-clip" style={{ top: metrics.padTop, bottom: metrics.padBottom }}>
        <div className="resume-page-content" style={{ top: -(metrics.padTop + index * usable) }}>
          <ResumePaper resume={resume} zh={zh} />
        </div>
      </div>
    </div>)}
    <div className="resume-pages-measure" ref={measureRef} aria-hidden>
      <ResumePaper resume={resume} zh={zh} />
    </div>
  </div>;
}
