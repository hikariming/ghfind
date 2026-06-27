"use client";

import { useTranslations } from "next-intl";
import { forwardRef, useEffect, useState } from "react";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import type { Tags, Tier } from "@/lib/types";
import { TierAvatarFrame } from "./TierAvatarFrame";

interface ShareCardProps {
  username: string;
  name: string | null;
  avatarUrl: string | null;
  score: number;
  tier: Tier;
  tierLabel: string;
  beat: number | null;
  tags: Tags;
  roastLine: string;
}

/**
 * The "flex" card rendered off-screen and exported to PNG via html-to-image.
 * Fixed 600×540 so the export is deterministic. The avatar is inlined as a data
 * URL up-front so the cross-origin image never taints the export canvas.
 */
export const ShareCard = forwardRef<HTMLDivElement, ShareCardProps>(function ShareCard(
  { username, name, avatarUrl, score, tier, tierLabel, beat, tags, roastLine },
  ref,
) {
  const t = useTranslations("shareCard");
  const tTier = useTranslations("tiers");
  const style = tierStyle(tier);
  const shownTags = [...(tags?.zh ?? []), ...(tags?.en ?? [])].slice(0, 4);
  const shownRoast = roastLine.trim().slice(0, 96);
  const [avatarData, setAvatarData] = useState<string | null>(null);

  useEffect(() => {
    if (!avatarUrl) return;
    let alive = true;
    fetch(avatarUrl)
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
      .then((d) => alive && setAvatarData(d))
      .catch(() => {
        /* CORS/network — fall back to the initial-letter avatar */
      });
    return () => {
      alive = false;
    };
  }, [avatarUrl]);

  return (
    <div
      ref={ref}
      style={{ width: 600, height: 540 }}
      className="relative flex flex-col justify-between overflow-hidden bg-[#0a0a0b] p-8 font-sans text-white"
    >
      <div
        className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full blur-3xl"
        style={{ background: style.glow }}
      />

      {/* Top: identity + score breathe horizontally. */}
      <div className="grid grid-cols-[auto_1fr] items-center gap-5">
        <div className="flex flex-col items-center text-center">
          <div
            className={`max-w-[240px] truncate rounded-full bg-black/35 px-4 py-1 text-xl font-black leading-tight ${style.text} ring-1 ${style.ring}`}
            style={{ boxShadow: `0 0 28px -10px ${style.glow}` }}
          >
            @{username}
          </div>
          {name && <div className="mt-1 max-w-[220px] truncate text-sm text-zinc-400">{name}</div>}
          <TierAvatarFrame
            username={username}
            avatarUrl={avatarData}
            tier={tier}
            size="md"
            className="mt-3"
          />
        </div>

        <div className="min-w-0 text-left">
          <div className={`text-7xl font-black leading-none tabular-nums ${style.text}`}>
            {score.toFixed(2)}
            <span className="ml-2 text-3xl text-zinc-600">/100</span>
          </div>
          <div className={`mt-2 text-3xl font-bold ${style.text}`}>
            {style.emoji} {tTier(`${TIER_KEY[tier]}.name`)}
          </div>
          <div className="text-sm text-zinc-400">{tierLabel}</div>
          {beat !== null && (
            <div className="mt-3 flex items-baseline gap-2">
              <div className={`text-3xl font-black ${style.text}`}>{beat}%</div>
              <div className="text-xs text-zinc-400">{t("beatLabel")}</div>
            </div>
          )}
        </div>
      </div>

      {/* Savage one-liner */}
      {shownRoast && (
        <div className="rounded-2xl border border-orange-400/20 bg-orange-500/[0.06] p-4 text-left">
          <div className="mb-1 text-xs font-bold uppercase tracking-[0.16em] text-orange-300">
            Roast
          </div>
          <div className="text-base font-semibold leading-snug text-zinc-100">
            {shownRoast}
          </div>
        </div>
      )}

      {/* Tags */}
      {shownTags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {shownTags.map((t, i) => (
            <span
              key={`${t}-${i}`}
              className="rounded-full border border-orange-400/30 bg-orange-500/10 px-3 py-1 text-sm font-medium text-orange-200"
            >
              #{t}
            </span>
          ))}
        </div>
      )}

      {/* Footer brand */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-zinc-500">{t("brand")}</span>
        <span className="font-black text-orange-400">githubroast.icu</span>
      </div>
    </div>
  );
});
