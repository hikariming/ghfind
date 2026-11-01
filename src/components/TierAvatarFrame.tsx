import type { ReactNode } from "react";
import {
  realmCssVars,
  realmForScore,
  realmForTier,
  type RealmDef,
} from "@/lib/realm";
import type { Tier } from "@/lib/types";

type AvatarFrameSize = "feed" | "sm" | "md" | "lg";

interface TierAvatarFrameProps {
  avatarContent?: ReactNode;
  username: string;
  avatarUrl: string | null;
  /** Preferred: derive realm from numeric score. */
  score?: number | null;
  /** Fallback when score is unavailable (stored Tier key). */
  tier?: Tier | null;
  realm?: RealmDef;
  realmName?: string;
  size?: AvatarFrameSize;
  className?: string;
}

const SIZE_CLASS: Record<
  AvatarFrameSize,
  {
    shell: string;
    avatar: string;
    initial: string;
    glowSpread: string;
  }
> = {
  feed: {
    shell: "h-10 w-10",
    avatar: "h-8 w-8",
    initial: "text-sm",
    glowSpread: "18px -3px",
  },
  sm: {
    shell: "h-16 w-16",
    avatar: "h-12 w-12",
    initial: "text-xl",
    glowSpread: "28px -5px",
  },
  md: {
    shell: "h-24 w-24",
    avatar: "h-[72px] w-[72px]",
    initial: "text-3xl",
    glowSpread: "34px -6px",
  },
  lg: {
    shell: "h-28 w-28",
    avatar: "h-20 w-20",
    initial: "text-4xl",
    glowSpread: "34px -6px",
  },
};

function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Realm-tinted avatar shell. Ring + glow from realm colors (inline — no purge).
 * Double ring + aurora for 大乘; soft glow for 炼虚+.
 */
export function TierAvatarFrame({
  avatarContent,
  username,
  avatarUrl,
  score,
  tier,
  realm: realmProp,
  realmName,
  size = "md",
  className = "",
}: TierAvatarFrameProps) {
  const realm =
    realmProp ??
    (typeof score === "number" ? realmForScore(score) : tier ? realmForTier(tier) : realmForScore(0));
  const classes = SIZE_CLASS[size];
  const initial = username.slice(0, 1).toUpperCase();
  const ring = realm.colors.ring;
  const softBg = withAlpha(realm.colors.fg, 0.14);
  const glow = realm.colors.glow;
  const vars = realmCssVars(realm, "dark");
  const label = realmName ?? realm.nameZh;

  const shellShadow = realm.effects.doubleRing
    ? `0 0 0 2px ${ring}, 0 0 0 4px rgba(255,227,138,0.60), 0 0 ${classes.glowSpread} ${glow}`
    : `0 0 0 2px ${ring}, 0 0 ${classes.glowSpread} ${glow}`;

  return (
    <div
      data-realm={realm.id}
      className={`relative flex shrink-0 items-center justify-center rounded-full ${classes.shell} ${className}`}
      style={{
        ...vars,
        backgroundColor: softBg,
        boxShadow: shellShadow,
      }}
      aria-label={`${label} avatar frame`}
    >
      {realm.effects.aurora ? <div className="realm-avatar-aurora" /> : null}
      <div
        className={`absolute ${size === "feed" ? "inset-1" : "inset-2"} rounded-full`}
        style={{ boxShadow: `inset 0 0 0 1px ${withAlpha(realm.colors.fg, 0.35)}` }}
      />

      {avatarContent ? (
        <div className={`relative z-[1] overflow-hidden rounded-full ring-2 ring-black/80 ${classes.avatar}`}>
          {avatarContent}
        </div>
      ) : avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={username}
          className={`relative z-[1] rounded-full object-cover ring-2 ring-black/80 ${classes.avatar}`}
        />
      ) : (
        <div
          className={`relative z-[1] flex items-center justify-center rounded-full bg-white/10 font-black text-zinc-100 ring-2 ring-black/80 ${classes.avatar} ${classes.initial}`}
        >
          {initial}
        </div>
      )}
    </div>
  );
}
