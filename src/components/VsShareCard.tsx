"use client";

import { forwardRef, useEffect, useState } from "react";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import type { Tier } from "@/lib/types";
import { useTranslations } from "next-intl";
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
}

/** One combatant column of the share card (module-level so it isn't recreated
 *  every render). */
function ShareSide({ side, data, win }: { side: VsSide; data: string | null; win: boolean }) {
  const tTier = useTranslations("tiers");
  const style = tierStyle(side.tier);
  return (
    <div className="flex flex-1 flex-col items-center text-center">
      <div
        className={`max-w-full truncate rounded-full bg-black/35 px-3 py-1 text-lg font-black leading-tight ${style.text} ring-1 ${style.ring}`}
      >
        @{side.username}
      </div>
      <TierAvatarFrame
        username={side.username}
        avatarUrl={data}
        tier={side.tier}
        size="md"
        className="mt-3"
      />
      <div className={`mt-3 text-4xl font-black tabular-nums ${style.text}`}>
        {side.score.toFixed(1)}
      </div>
      <div className={`mt-1 text-lg font-bold ${style.text}`}>
        {style.emoji} {tTier(`${TIER_KEY[side.tier]}.name`)}
      </div>
      {win && (
        <div className="mt-1 rounded-full bg-orange-500/20 px-2 py-0.5 text-xs font-bold text-orange-200">
          🏆
        </div>
      )}
    </div>
  );
}

/**
 * The off-screen "flex" card for a PK result, exported to PNG via html-to-image.
 * Fixed 600×540 for a deterministic export. Mirrors {@link ShareCard} but shows
 * two dueling players + the verdict line.
 */
export const VsShareCard = forwardRef<
  HTMLDivElement,
  { a: VsSide; b: VsSide; winner: "a" | "b" | "tie"; verdictLine: string }
>(function VsShareCard({ a, b, winner, verdictLine }, ref) {
  const t = useTranslations("shareCard");
  const avatarA = useAvatarData(a.avatarUrl);
  const avatarB = useAvatarData(b.avatarUrl);
  const styleA = tierStyle(a.tier);
  const styleB = tierStyle(b.tier);

  return (
    <div
      ref={ref}
      data-force-dark
      style={{ width: 600, height: 540 }}
      className="relative flex flex-col justify-between overflow-hidden bg-[#0a0a0b] p-7 font-sans text-white"
    >
      <div
        className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full blur-3xl"
        style={{ background: styleA.glow }}
      />
      <div
        className="pointer-events-none absolute -left-20 -bottom-24 h-72 w-72 rounded-full blur-3xl"
        style={{ background: styleB.glow }}
      />

      {/* Combatants */}
      <div className="flex items-center gap-2">
        <ShareSide side={a} data={avatarA} win={winner === "a"} />
        <div className="shrink-0 text-4xl font-black text-orange-500">VS</div>
        <ShareSide side={b} data={avatarB} win={winner === "b"} />
      </div>

      {/* Verdict */}
      <div className="rounded-xl border border-orange-500/25 bg-orange-500/[0.08] p-4">
        <p className="line-clamp-4 text-[0.95rem] leading-relaxed text-zinc-100">🔥 {verdictLine}</p>
      </div>

      {/* Footer brand */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-zinc-500">{t("brand")}</span>
        <span className="font-black text-orange-400">ghfind.com</span>
      </div>
    </div>
  );
});
