"use client";

import { forwardRef, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import { DIMENSIONS, barColor } from "@/lib/dimensions";
import { SUBSCORE_MAX } from "@/lib/score";
import type { SubScores, Tier } from "@/lib/types";
import { TierAvatarFrame } from "./TierAvatarFrame";

/** Inline a cross-origin avatar as a data URL so the export canvas isn't tainted. */
function useAvatarData(url: string | null): string | null {
  const [data, setData] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    fetch(url)
      .then((r) => r.blob())
      .then(
        (b) =>
          new Promise<string>((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result as string);
            fr.onerror = reject;
            fr.readAsDataURL(b);
          }),
      )
      .then((d) => alive && setData(d))
      .catch(() => {
        /* CORS/network — fall back to initial-letter avatar */
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return data;
}

export interface VsSide {
  username: string;
  avatarUrl: string | null;
  score: number;
  tier: Tier;
  subScores: SubScores;
}

/** One combatant column of the poster header (module-level so it isn't recreated
 *  every render). */
function ShareSide({ side, data, win }: { side: VsSide; data: string | null; win: boolean }) {
  const tTier = useTranslations("tiers");
  const style = tierStyle(side.tier);
  return (
    <div className="flex flex-1 flex-col items-center text-center">
      <div
        className={`max-w-full truncate whitespace-nowrap rounded-full bg-black/35 px-3 py-1 text-base font-black leading-tight ${style.text} ring-1 ${style.ring}`}
      >
        @{side.username}
      </div>
      <TierAvatarFrame
        username={side.username}
        avatarUrl={data}
        tier={side.tier}
        size="lg"
        className="mt-4"
      />
      <div className={`mt-3 text-5xl font-black tabular-nums ${style.text}`}>
        {side.score.toFixed(1)}
      </div>
      <div className={`mt-1 whitespace-nowrap text-base font-bold ${style.text}`}>
        {style.emoji} {tTier(`${TIER_KEY[side.tier]}.name`)}
      </div>
      {win && (
        <div className="mt-2 rounded-full bg-orange-500/20 px-2.5 py-0.5 text-xs font-bold text-orange-200">
          🏆 WIN
        </div>
      )}
    </div>
  );
}

/**
 * A tall, shareable "poster" for a PK result, exported to PNG via html-to-image.
 * Fixed 640px wide with natural height (a long strip that reads well on 微信 /
 * 小红书 / X). Carries the full six-dimension duel + verdict + advice — far more
 * flex-worthy than a single boxy card. NOTE: avoid `line-clamp`/`-webkit-box`
 * here (renders blank in html-to-image); truncate in JS instead.
 */
export const VsShareCard = forwardRef<
  HTMLDivElement,
  {
    a: VsSide;
    b: VsSide;
    winner: "a" | "b" | "tie";
    bucketLabel: string;
    verdictLine: string;
    adviceLine?: string;
  }
>(function VsShareCard({ a, b, winner, bucketLabel, verdictLine, adviceLine }, ref) {
  const tShare = useTranslations("shareCard");
  const tDim = useTranslations("dimensions");
  const tVs = useTranslations("vs");
  const avatarA = useAvatarData(a.avatarUrl);
  const avatarB = useAvatarData(b.avatarUrl);
  const styleA = tierStyle(a.tier);
  const styleB = tierStyle(b.tier);
  const gap = Math.abs(a.score - b.score);

  const verdict = verdictLine.length > 240 ? `${verdictLine.slice(0, 240).trimEnd()}…` : verdictLine;
  const advice = adviceLine
    ? adviceLine.length > 200
      ? `${adviceLine.slice(0, 200).trimEnd()}…`
      : adviceLine
    : "";

  return (
    <div
      ref={ref}
      data-force-dark
      style={{ width: 640 }}
      className="relative flex flex-col gap-5 overflow-hidden bg-[#0a0a0b] p-8 font-sans text-white"
    >
      <div
        className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full blur-3xl"
        style={{ background: styleA.glow }}
      />
      <div
        className="pointer-events-none absolute -left-24 top-40 h-80 w-80 rounded-full blur-3xl"
        style={{ background: styleB.glow }}
      />

      {/* Title */}
      <div className="text-center text-lg font-black tracking-wide text-zinc-200">
        ⚔️ {tVs("heading")}
      </div>

      {/* Combatants */}
      <div className="flex items-start gap-2">
        <ShareSide side={a} data={avatarA} win={winner === "a"} />
        <div className="flex shrink-0 flex-col items-center pt-10">
          <span className="text-5xl font-black text-orange-500">VS</span>
          <span className="mt-2 whitespace-nowrap rounded-full bg-orange-500/20 px-3 py-0.5 text-xs font-bold uppercase tracking-wide text-orange-200">
            {bucketLabel}
          </span>
          <span className="mt-1 text-xs tabular-nums text-zinc-500">Δ {gap.toFixed(1)}</span>
        </div>
        <ShareSide side={b} data={avatarB} win={winner === "b"} />
      </div>

      {/* Dimension duel */}
      <div className="flex flex-col gap-2.5 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        {DIMENSIONS.map((key) => {
          const max = SUBSCORE_MAX[key];
          const va = a.subScores[key] ?? 0;
          const vb = b.subScores[key] ?? 0;
          const pa = Math.max(0, Math.min(1, va / max));
          const pb = Math.max(0, Math.min(1, vb / max));
          const w = Math.abs(va - vb) < 0.05 ? "tie" : va > vb ? "a" : "b";
          return (
            <div key={key} className="flex items-center gap-2">
              <span
                className={`w-9 shrink-0 text-right text-xs tabular-nums ${w === "a" ? "font-bold text-emerald-300" : "text-zinc-500"}`}
              >
                {va.toFixed(0)}
              </span>
              <div className="flex flex-1 justify-end">
                <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                  <div className={`ml-auto h-full rounded-full ${barColor(pa)}`} style={{ width: `${pa * 100}%` }} />
                </div>
              </div>
              <span className="w-24 shrink-0 whitespace-nowrap text-center text-[11px] text-zinc-400">
                {tDim(key)}
              </span>
              <div className="flex flex-1">
                <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                  <div className={`h-full rounded-full ${barColor(pb)}`} style={{ width: `${pb * 100}%` }} />
                </div>
              </div>
              <span
                className={`w-9 shrink-0 text-left text-xs tabular-nums ${w === "b" ? "font-bold text-emerald-300" : "text-zinc-500"}`}
              >
                {vb.toFixed(0)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Verdict */}
      <div className="rounded-2xl border border-orange-500/25 bg-orange-500/[0.08] p-5">
        <p className="text-[0.95rem] leading-relaxed text-zinc-100">🔥 {verdict}</p>
      </div>

      {/* Advice */}
      {advice && (
        <div className="rounded-2xl border border-sky-400/20 bg-sky-500/[0.06] p-5">
          <div className="mb-1.5 text-sm font-bold text-sky-200">{tVs("adviceHeading")}</div>
          <p className="whitespace-pre-line text-[0.9rem] leading-relaxed text-zinc-200">{advice}</p>
        </div>
      )}

      {/* Footer brand */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate whitespace-nowrap text-zinc-500">{tShare("brand")}</span>
        <span className="shrink-0 whitespace-nowrap font-black text-orange-400">ghfind.com</span>
      </div>
    </div>
  );
});
