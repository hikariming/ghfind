import type { ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import type { AccountDetail } from "@/lib/profile-presentation";
import { tierStyle } from "@/lib/tier";
import { AdventurerLevel } from "@/components/realm/AdventurerLevel";
import { RealmChip } from "@/components/realm/RealmGlyph";
import { realmCssVars, realmForScore } from "@/lib/realm";
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
  const realm = realmForScore(detail.final_score);
  const realmVars = realmCssVars(realm);
  return (
    <div
      data-realm={realm.id}
      className="flex flex-1 flex-col items-center rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-center"
      style={{ ...realmVars, boxShadow: `0 0 80px -20px ${realm.colors.glow}`, borderColor: `color-mix(in srgb, ${realm.colors.ring} 12%, transparent)` }}
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
        score={detail.final_score}
        tier={detail.tier}
        realm={realm}
        realmName={tierName ?? undefined}
        size="lg"
        className="mt-5"
      />
      <div className="mt-4">
        <AdventurerLevel score={detail.final_score} realm={realm} caption="" size="lg" />
      </div>
      <div className="mt-2">
        <RealmChip realm={realm} name={tierName ?? realm.nameZh} />
      </div>
      {winLabel && (
        <div className="mt-3 rounded-full bg-orange-500/20 px-3 py-1 text-sm font-bold text-orange-200 ring-1 ring-orange-400/40">
          {winLabel}
        </div>
      )}
    </div>
  );
}
