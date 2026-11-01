"use client";

import { motion } from "motion/react";
import { Eye, Heart, Layers, MessageCircle, Share2, Star } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useStreamStore } from "@/lib/stream/store";
import type { StreamCounter, StreamItem } from "@/lib/stream/types";
import { cn } from "@/lib/utils";
import { compactNumber } from "./format";

const COUNTER_ICON = { lookups: Eye, stars: Star, items: Layers } as const;

/** The item's one real public number (lookups, stars, picks). */
export function CounterChip({ counter, className }: { counter: StreamCounter | null; className?: string }) {
  const t = useTranslations("stream");
  const locale = useLocale();
  if (!counter) return null;
  const Icon = COUNTER_ICON[counter.kind];
  const label = t(`counter.${counter.kind}`, { count: compactNumber(counter.value, locale) });
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground", className)} title={label}>
      <Icon className="size-3.5" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}

function ActionButton({
  label,
  active,
  activeClass,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  activeClass?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "-mx-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        active && activeClass,
      )}
    >
      {children}
    </button>
  );
}

export function LikeIcon({ liked, className }: { liked: boolean; className?: string }) {
  return (
    <motion.span
      key={liked ? "on" : "off"}
      initial={liked ? { scale: 0.6 } : false}
      animate={{ scale: liked ? [0.6, 1.35, 1] : 1 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="inline-flex"
    >
      <Heart className={cn("size-4", liked && "fill-current", className)} aria-hidden />
    </motion.span>
  );
}

/**
 * Engagement row shared by list cards and the detail view. Likes are
 * the viewer's own (no public count yet); the only number shown is the item's
 * real counter. `compact` (grid tiles) keeps just the like toggle.
 */
export function StreamActions({
  item,
  compact = false,
  onComment,
  onShare,
  className,
}: {
  item: StreamItem;
  compact?: boolean;
  onComment?: () => void;
  onShare: () => void;
  className?: string;
}) {
  const t = useTranslations("stream");
  const liked = useStreamStore((state) => Boolean(state.liked[item.id]));
  const toggleLike = useStreamStore((state) => state.toggleLike);

  const like = (
    <ActionButton label={liked ? t("unlike") : t("like")} active={liked} activeClass="text-rose-500 hover:text-rose-500" onClick={() => toggleLike(item)}>
      <LikeIcon liked={liked} />
    </ActionButton>
  );

  if (compact) return <div className={cn("flex items-center", className)}>{like}</div>;

  return (
    <div className={cn("flex items-center gap-5", className)}>
      {item.comments ? (
        <ActionButton label={t("comments")} onClick={() => onComment?.()}>
          <MessageCircle className="size-4" aria-hidden />
        </ActionButton>
      ) : null}
      {like}
      <ActionButton label={t("share")} onClick={onShare}>
        <Share2 className="size-4" aria-hidden />
      </ActionButton>
      <CounterChip counter={item.counter} className="ms-auto min-w-0" />
    </div>
  );
}
