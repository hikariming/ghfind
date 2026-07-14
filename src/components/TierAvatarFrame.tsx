import {
  TIER_AVATAR_FRAME_VECTORS,
  tierAvatarFrame,
  tierAvatarFrameIconPath,
} from "@/lib/tier";
import type { TierAvatarFrameEmojiSize } from "@/lib/tier";
import type { Tier } from "@/lib/types";

type AvatarFrameSize = "sm" | "md" | "lg";

interface TierAvatarFrameProps {
  username: string;
  avatarUrl: string | null;
  tier: Tier;
  size?: AvatarFrameSize;
  className?: string;
}

const SIZE_CLASS: Record<
  AvatarFrameSize,
  {
    shell: string;
    avatar: string;
    emojiIcon: Record<TierAvatarFrameEmojiSize, string>;
    initial: string;
  }
> = {
  sm: {
    shell: "h-16 w-16",
    avatar: "h-12 w-12",
    emojiIcon: { normal: "h-[13px] w-[13px]", large: "h-[18px] w-[18px]" },
    initial: "text-xl",
  },
  md: {
    shell: "h-24 w-24",
    avatar: "h-[72px] w-[72px]",
    emojiIcon: { normal: "h-[17px] w-[17px]", large: "h-6 w-6" },
    initial: "text-3xl",
  },
  lg: {
    shell: "h-28 w-28",
    avatar: "h-20 w-20",
    emojiIcon: { normal: "h-5 w-5", large: "h-[30px] w-[30px]" },
    initial: "text-4xl",
  },
};

export function TierAvatarFrame({
  username,
  avatarUrl,
  tier,
  size = "md",
  className = "",
}: TierAvatarFrameProps) {
  const frame = tierAvatarFrame(tier);
  const classes = SIZE_CLASS[size];
  const emojiIconClass = classes.emojiIcon[frame.emojiSize];
  const initial = username.slice(0, 1).toUpperCase();

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center rounded-full ${classes.shell} ${frame.bg} ring-2 ${frame.ring} ${className}`}
      style={{ boxShadow: `0 0 34px -10px ${frame.glow}` }}
      aria-label={`${tier} avatar frame`}
    >
      <div className="absolute inset-2 rounded-full border border-white/10" />
      {frame.placements.map((placement) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`${frame.emoji}-${placement}`}
          src={tierAvatarFrameIconPath(frame.icon)}
          alt=""
          aria-hidden="true"
          className={`tier-avatar-emoji-shell absolute z-10 block border-0 bg-transparent shadow-none ${emojiIconClass}`}
          style={{
            left: `${50 + TIER_AVATAR_FRAME_VECTORS[placement].x * 50}%`,
            top: `${50 + TIER_AVATAR_FRAME_VECTORS[placement].y * 50}%`,
            transform: "translate(-50%, -50%)",
            backgroundColor: "transparent",
            border: "none",
            boxShadow: "none",
          }}
        />
      ))}

      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={username}
          className={`relative rounded-full object-cover ring-2 ring-black/80 ${classes.avatar}`}
        />
      ) : (
        <div
          className={`relative flex items-center justify-center rounded-full bg-white/10 font-black text-zinc-100 ring-2 ring-black/80 ${classes.avatar} ${classes.initial}`}
        >
          {initial}
        </div>
      )}
    </div>
  );
}
