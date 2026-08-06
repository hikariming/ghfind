import type { ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import type { AccountDetail } from "@/lib/profile-presentation";
import { tierStyle } from "@/lib/tier";
import { TierAvatarFrame } from "./TierAvatarFrame";

/**
 * One combatant's identity card on the /vs page. When `detail` is null the side
 * hasn't been scored yet — the card renders a placeholder plus whatever summon
 * CTA is passed as `children`. The winner's card gets a highlighted ring/badge.
 */
export function VsPlayerCard({
  username,
  detail,
  tierName,
  notRatedLabel,
  winLabel,
  children,
}: {
  username: string;
  detail: AccountDetail | null;
  tierName: string | null;
  notRatedLabel: string;
  winLabel?: string | null;
  children?: ReactNode;
}) {
  if (!detail) {
    return (
      <div className="flex flex-1 flex-col items-center rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-center">
        <a
          href={`https://github.com/${username}`}
          target="_blank"
          rel="noopener noreferrer"
          className="max-w-full break-all rounded-full bg-black/35 px-4 py-1.5 text-lg font-black leading-tight text-zinc-300 ring-1 ring-white/10 hover:bg-black/45"
        >
          @{username}
        </a>
        <div className="mt-5 flex h-20 w-20 items-center justify-center rounded-full bg-white/10 text-3xl text-zinc-500">
          ?
        </div>
        <div className="mt-4 text-sm font-medium text-zinc-500">{notRatedLabel}</div>
        {children && <div className="mt-4">{children}</div>}
      </div>
    );
  }

  const style = tierStyle(detail.tier);
  return (
    <div
      className={`flex flex-1 flex-col items-center rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-center ring-1 ${style.ring}`}
      style={{ boxShadow: `0 0 80px -20px ${style.glow}` }}
    >
      <Link
        href={`/u/${detail.username}`}
        className={`max-w-full break-all rounded-full bg-black/35 px-4 py-1.5 text-lg font-black leading-tight ${style.text} ring-1 ${style.ring} hover:bg-black/45`}
      >
        @{detail.username}
      </Link>
      <TierAvatarFrame
        username={detail.username}
        avatarUrl={detail.avatar_url}
        tier={detail.tier}
        size="lg"
        className="mt-5"
      />
      <div className={`mt-4 text-5xl font-black tabular-nums ${style.text}`}>
        {detail.final_score.toFixed(2)}
        <span className="text-xl text-zinc-600">/100</span>
      </div>
      <div className={`mt-1 text-xl font-bold ${style.text}`}>
        {style.emoji} {tierName}
      </div>
      {winLabel && (
        <div className="mt-3 rounded-full bg-orange-500/20 px-3 py-1 text-sm font-bold text-orange-200 ring-1 ring-orange-400/40">
          {winLabel}
        </div>
      )}
    </div>
  );
}
