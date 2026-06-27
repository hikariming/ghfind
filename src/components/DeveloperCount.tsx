"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

/**
 * "已经有 N 名开发者参与战斗 ⚔️" — fetches the evaluated-account count and counts
 * up from 0 to N on mount. Renders nothing until there is a positive count (so a
 * cold / DB-less environment shows no broken state).
 */
export function DeveloperCount() {
  const t = useTranslations();
  const [target, setTarget] = useState<number | null>(null);
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => {
        if (alive && typeof d.total === "number") setTarget(d.total);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (target === null || target <= 0) return;
    const duration = 1400;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(Math.round(eased * target));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  if (target === null || target <= 0) return null;

  return (
    <div className="mt-4 text-sm text-zinc-300">
      {t.rich("developerCount", {
        count: display,
        n: (c) => (
          <span className="text-base font-black tabular-nums text-orange-400">{c}</span>
        ),
      })}
    </div>
  );
}
