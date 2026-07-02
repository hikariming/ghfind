"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { RoastLine } from "@/lib/types";

/**
 * The /vs verdict banner. SSR renders the deterministic template (or a stored
 * LLM verdict). When both sides are eligible and no LLM verdict exists yet, this
 * auto-fires `/api/vs-verdict` on mount (human-triggered, so crawlers never spend
 * LLM credit), then swaps in the savage verdict + self-improvement advice and
 * refreshes so the next SSR / OG image serves the stored text.
 */
export function VsVerdictLive({
  a,
  b,
  bucketLabel,
  initialVerdict,
  initialAdvice,
  adviceHeading,
  autoGenerate,
}: {
  a: string;
  b: string;
  bucketLabel: string | null;
  initialVerdict: string;
  initialAdvice: string;
  adviceHeading: string;
  autoGenerate: boolean;
}) {
  const t = useTranslations("vs");
  const locale = useLocale();
  const router = useRouter();
  const [verdictText, setVerdictText] = useState(initialVerdict);
  const [adviceText, setAdviceText] = useState(initialAdvice);
  const [generating, setGenerating] = useState(false);
  const firedRef = useRef(false);

  useEffect(() => {
    if (!autoGenerate || firedRef.current) return;
    firedRef.current = true;
    const ctrl = new AbortController();
    setGenerating(true);
    (async () => {
      try {
        const res = await fetch("/api/vs-verdict", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ a, b }),
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          verdict: RoastLine | null;
          advice?: RoastLine | null;
        };
        if (!data.verdict) return;
        const pick = (r: RoastLine | null | undefined) =>
          !r ? "" : locale === "en" ? r.en || r.zh : r.zh || r.en;
        const v = pick(data.verdict);
        if (v) setVerdictText(v);
        const adv = pick(data.advice);
        if (adv) setAdviceText(adv);
        // Persist to SSR/OG on the next load.
        router.refresh();
      } catch {
        /* aborted / offline — keep the template line */
      } finally {
        setGenerating(false);
      }
    })();
    return () => ctrl.abort();
  }, [autoGenerate, a, b, locale, router]);

  return (
    <div className="mt-6 rounded-2xl border border-orange-500/30 bg-orange-500/[0.07] p-5 text-center">
      {bucketLabel && (
        <div className="mb-2 inline-block rounded-full bg-orange-500/20 px-3 py-0.5 text-xs font-bold uppercase tracking-wide text-orange-200">
          {bucketLabel}
        </div>
      )}
      <p className="text-[0.95rem] leading-relaxed text-zinc-100">🔥 {verdictText}</p>
      {generating && (
        <p className="mt-2 animate-pulse text-xs text-orange-200/80">{t("verdictGenerating")}</p>
      )}
      {adviceText && (
        <div className="mt-4 rounded-xl border border-sky-400/20 bg-sky-500/[0.06] p-4 text-left">
          <div className="mb-1 text-sm font-bold text-sky-200">{adviceHeading}</div>
          <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-200">{adviceText}</p>
        </div>
      )}
    </div>
  );
}
