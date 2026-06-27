import { tierAvatarFrame } from "@/lib/tier";
import type { Tier } from "@/lib/types";

type AvatarFrameSize = "sm" | "md" | "lg";

interface TierAvatarFrameProps {
  username: string;
  avatarUrl: string | null;
  tier: Tier;
  size?: AvatarFrameSize;
  className?: string;
}

const EMOJI_POSITIONS = [
  "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2",
  "right-[8%] top-[8%] translate-x-1/2 -translate-y-1/2",
  "right-0 top-1/2 translate-x-1/2 -translate-y-1/2",
  "bottom-[8%] right-[8%] translate-x-1/2 translate-y-1/2",
  "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2",
  "bottom-[8%] left-[8%] -translate-x-1/2 translate-y-1/2",
  "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2",
  "left-[8%] top-[8%] -translate-x-1/2 -translate-y-1/2",
];

const SIZE_CLASS: Record<
  AvatarFrameSize,
  {
    shell: string;
    avatar: string;
    emoji: string;
    emojiShell: string;
    initial: string;
  }
> = {
  sm: {
    shell: "h-16 w-16",
    avatar: "h-12 w-12",
    emoji: "text-[13px]",
    emojiShell: "h-5 w-5",
    initial: "text-xl",
  },
  md: {
    shell: "h-24 w-24",
    avatar: "h-[72px] w-[72px]",
    emoji: "text-[17px]",
    emojiShell: "h-7 w-7",
    initial: "text-3xl",
  },
  lg: {
    shell: "h-28 w-28",
    avatar: "h-20 w-20",
    emoji: "text-[20px]",
    emojiShell: "h-8 w-8",
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
  const initial = username.slice(0, 1).toUpperCase();

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center rounded-full ${classes.shell} ${frame.bg} ring-2 ${frame.ring} ${className}`}
      style={{ boxShadow: `0 0 34px -10px ${frame.glow}` }}
      aria-label={`${tier} avatar frame`}
    >
      <div className="absolute inset-2 rounded-full border border-white/10" />
      {EMOJI_POSITIONS.map((position, i) => (
        <span
          key={`${frame.emoji}-${i}`}
          aria-hidden="true"
          className={`absolute z-10 flex items-center justify-center rounded-full bg-[#0a0a0b] leading-none drop-shadow ${classes.emojiShell} ${classes.emoji} ${position}`}
        >
          {frame.emoji}
        </span>
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
