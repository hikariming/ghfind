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
}

/**
 * The "flex" card rendered off-screen and exported to PNG via html-to-image.
 * Fixed 600×540 so the export is deterministic. The avatar is inlined as a data
 * URL up-front so the cross-origin image never taints the export canvas.
 */
export const ShareCard = forwardRef<HTMLDivElement, ShareCardProps>(function ShareCard(
  { username, name, avatarUrl, score, tier, tierLabel, beat, tags },
  ref,
) {
  const t = useTranslations("shareCard");
  const tTier = useTranslations("tiers");
  const style = tierStyle(tier);
  const shownTags = [...(tags?.zh ?? []), ...(tags?.en ?? [])].slice(0, 4);
  const [avatarData, setAvatarData] = useState<string | null>(null);
  const [avatarReady, setAvatarReady] = useState(!avatarUrl);

  useEffect(() => {
    setAvatarData(null);
    setAvatarReady(!avatarUrl);
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
      .then((d) => {
        if (!alive) return;
        setAvatarData(d);
        setAvatarReady(true);
      })
      .catch(() => {
        if (alive) setAvatarReady(true);
      });
    return () => {
      alive = false;
    };
  }, [avatarUrl]);

  return (
    <div
      ref={ref}
      data-force-dark
      data-share-card-ready={avatarReady ? "true" : "false"}
      style={{ width: 600, height: 540 }}
      className="relative flex flex-col justify-between overflow-hidden bg-[#0a0a0b] p-7 font-sans text-white"
    >
      <div
        className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full blur-3xl"
        style={{ background: style.glow }}
      />

      {/* Header: highlighted handle, then tier-framed avatar before the score. */}
      <div className="flex flex-col items-center text-center">
        <div
          className={`max-w-full rounded-full bg-black/35 px-4 py-1 text-2xl font-black leading-tight ${style.text} ring-1 ${style.ring}`}
          style={{ boxShadow: `0 0 28px -10px ${style.glow}` }}
        >
          @{username}
        </div>
        {name && <div className="mt-1 max-w-full truncate text-sm text-zinc-400">{name}</div>}
        <TierAvatarFrame
          username={username}
          avatarUrl={avatarData}
          tier={tier}
          size="md"
          className="mt-3"
        />
      </div>

      {/* Score */}
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div className={`text-6xl font-black tabular-nums ${style.text}`}>
            {score.toFixed(2)}
            <span className="text-3xl text-zinc-600">/100</span>
          </div>
          <div className={`mt-1 text-3xl font-bold ${style.text}`}>
            {style.emoji} {tTier(`${TIER_KEY[tier]}.name`)}
          </div>
          <div className="text-sm text-zinc-400">{tierLabel}</div>
        </div>
        {beat !== null && (
          <div className="mb-1 text-right">
            <div className={`text-4xl font-black ${style.text}`}>{beat.toFixed(1)}%</div>
            <div className="text-xs text-zinc-400">{t("beatLabel")}</div>
          </div>
        )}
      </div>

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
        <span className="font-black text-orange-400">ghfind.com</span>
      </div>
    </div>
  );
});
