"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { BadgeCheck, Clock, EyeOff, Flame, Link2, MoreHorizontal, SquareArrowOutUpRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStreamStore } from "@/lib/stream/store";
import type { StreamItem } from "@/lib/stream/types";
import { cn } from "@/lib/utils";
import { KIND_STYLE, compactNumber, initials, isTierKey, relativeTime, tierIconSrc } from "./format";
import { StreamActions } from "./StreamActions";
import { StreamPostListCard, StreamPostTile } from "./StreamPost";

export type StreamCardHandlers = {
  onOpen: (item: StreamItem) => void;
  onShare: (item: StreamItem) => void;
  onHide: (item: StreamItem) => void;
  onCopyLink: (item: StreamItem) => void;
};

/** Seen ≥50% for 1s counts a view; 4s more counts as dwell (an interest signal). */
const VIEW_MS = 1_000;
const DWELL_MS = 4_000;

export function useViewTracking(item: StreamItem) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const timers: number[] = [];
    const clear = () => timers.splice(0).forEach((timer) => window.clearTimeout(timer));
    const observer = new IntersectionObserver(
      ([entry]) => {
        clear();
        if (!entry?.isIntersecting) return;
        timers.push(window.setTimeout(() => useStreamStore.getState().markViewed(item), VIEW_MS));
        timers.push(window.setTimeout(() => useStreamStore.getState().signal(item, "dwell"), VIEW_MS + DWELL_MS));
      },
      { threshold: 0.5 },
    );
    observer.observe(node);
    return () => {
      clear();
      observer.disconnect();
    };
  }, [item]);
  return ref;
}

export function StreamAvatar({ src, name, className }: { src: string | null; name: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={cn("inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-semibold text-muted-foreground", className)}>
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- shared with the Astro island; remote avatars
        <img src={src} alt="" loading="lazy" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        initials(name)
      )}
    </span>
  );
}

function TierIcon({ tier, className }: { tier: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- static tier artwork
  return <img src={tierIconSrc(tier)} alt="" className={cn("self-center", className)} />;
}

export function KindBadge({ item }: { item: StreamItem }) {
  const t = useTranslations("stream");
  const style = KIND_STYLE[item.kind];
  const Icon = style.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium", style.tint, style.text)}>
      <Icon className="size-3" aria-hidden />
      {t(`kindOne.${item.kind}`)}
    </span>
  );
}

const BADGE_STYLE = {
  hot: "bg-orange-500/15 text-orange-300",
  new: "bg-sky-500/15 text-sky-300",
  editor: "bg-amber-400/20 text-amber-300",
} as const;

/** Hot (real top slice), New (real date) or Editor's pick. */
export function StatusBadge({ item }: { item: StreamItem }) {
  const t = useTranslations("stream");
  if (!item.badge) return null;
  return (
    <span className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold", BADGE_STYLE[item.badge])}>
      {item.badge === "hot" ? <Flame className="me-0.5 size-3" aria-hidden /> : null}
      {t(`badge.${item.badge}`)}
    </span>
  );
}

export function ScorePill({ item, size = "sm" }: { item: StreamItem; size?: "sm" | "lg" }) {
  const t = useTranslations("stream");
  if (item.score == null) return null;
  const tier = isTierKey(item.scoreLabel) ? item.scoreLabel : null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-baseline gap-1 rounded-md bg-muted font-semibold tabular-nums text-foreground",
        size === "lg" ? "px-2 py-1 text-xl" : "px-1.5 py-0.5 text-sm",
      )}
      title={item.kind === "project" ? t("productScore") : t("score")}
    >
      {item.score}
      {tier ? <TierIcon tier={tier} className={size === "lg" ? "size-5" : "size-3.5"} /> : null}
    </span>
  );
}

function MoreMenu({ item, handlers }: { item: StreamItem; handlers: StreamCardHandlers }) {
  const t = useTranslations("stream");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("more")}
          onClick={(event) => event.stopPropagation()}
          className="-me-1.5 inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={() => handlers.onHide(item)}>
          <EyeOff className="size-4" aria-hidden />
          {t("notInterested")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => handlers.onCopyLink(item)}>
          <Link2 className="size-4" aria-hidden />
          {t("copyLink")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={item.href} target={item.external ? "_blank" : undefined} rel={item.external ? "noopener noreferrer" : undefined}>
            <SquareArrowOutUpRight className="size-4" aria-hidden />
            {t("openOriginal")}
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function isPerson(item: StreamItem): boolean {
  return item.kind === "developer" || item.kind === "talent";
}

/** Text kinds without a cover get a title tile; it would only repeat the heading in the detail view. */
export function isTextTile(item: StreamItem): boolean {
  return !item.coverUrl && (item.kind === "article" || item.kind === "collection" || item.kind === "post");
}

/** Cover image, or a generated tile in the kind's accent (小红书-style text card). */
export function StreamVisual({ item, variant }: { item: StreamItem; variant: "masonry" | "detail" }) {
  const t = useTranslations("stream");
  const style = KIND_STYLE[item.kind];
  const [broken, setBroken] = useState(false);
  if (item.coverUrl && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- shared with the Astro island; remote covers
      <img
        src={item.coverUrl}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className={cn("aspect-[1.91/1] w-full bg-muted object-cover", variant === "detail" && "rounded-xl")}
      />
    );
  }
  const aspect =
    variant === "detail"
      ? "aspect-[2.4/1] rounded-xl"
      : item.kind === "article" || item.kind === "collection"
        ? "aspect-[3/4]"
        : item.kind === "job"
          ? "aspect-[4/3]"
          : "aspect-square";
  const person = isPerson(item);
  const tier = isTierKey(item.scoreLabel) ? item.scoreLabel : null;
  return (
    <div className={cn("relative flex w-full flex-col justify-between overflow-hidden bg-gradient-to-br to-transparent p-3", variant === "masonry" && "pt-9", style.tile, aspect)}>
      <style.icon className={cn("absolute -bottom-3 -end-3 size-20 opacity-10", style.text)} aria-hidden />
      {person ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <StreamAvatar src={item.author.avatarUrl} name={item.title} className="size-16 text-xl ring-2 ring-white/10" />
          {item.score != null ? (
            <span className="text-2xl font-black tabular-nums text-foreground">
              {item.score}
              {tier ? <TierIcon tier={tier} className="ms-1 inline size-5" /> : null}
            </span>
          ) : null}
          {item.scoreLabel === "available" ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">{t("available")}</span>
          ) : null}
        </div>
      ) : item.kind === "project" && item.score != null ? (
        <div className="flex flex-1 flex-col justify-center">
          <span className={cn("text-[40px] font-black leading-none tabular-nums", style.text)}>{item.score}</span>
          <span className="mt-1 text-[11px] font-medium text-muted-foreground">{t("productScore")}</span>
          <span className="mt-3 line-clamp-1 font-mono text-sm font-semibold text-foreground">{item.author.name}/{item.title}</span>
        </div>
      ) : item.kind === "job" ? (
        <div className="flex flex-1 flex-col justify-center gap-2">
          <StreamAvatar src={item.author.avatarUrl} name={item.author.name} className="size-10 rounded-lg" />
          {item.scoreLabel ? <span className="text-xl font-black text-foreground">{item.scoreLabel}</span> : null}
        </div>
      ) : (
        <p className="relative line-clamp-5 text-lg font-black leading-snug tracking-tight text-foreground">{item.title}</p>
      )}
      {item.tags.length > 0 && variant === "masonry" ? (
        <div className="relative mt-2 flex flex-wrap gap-1">
          {item.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">#{tag}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Meta({ item, now }: { item: StreamItem; now: number }) {
  const t = useTranslations("stream");
  const locale = useLocale();
  const parts: ReactNode[] = item.publishedAt ? [<span key="time">{relativeTime(item.publishedAt, now, locale)}</span>] : [];
  if (item.readingMinutes) {
    parts.push(
      <span key="read" className="inline-flex items-center gap-0.5">
        <Clock className="size-3" aria-hidden />
        {t("minutesRead", { minutes: item.readingMinutes })}
      </span>,
    );
  }
  return <>{parts.flatMap((part, index) => (index > 0 ? [<span key={`dot${index}`} aria-hidden>·</span>, part] : [part]))}</>;
}

/** X-style row: avatar column, header line, title + summary, optional cover, action bar. */
export function StreamListCard({ item, now, handlers }: { item: StreamItem; now: number; handlers: StreamCardHandlers }) {
  if (item.kind === "post") return <StreamPostListCard item={item} now={now} handlers={handlers} />;
  return <StreamEntryCard item={item} now={now} handlers={handlers} />;
}

function StreamEntryCard({ item, now, handlers }: { item: StreamItem; now: number; handlers: StreamCardHandlers }) {
  const t = useTranslations("stream");
  const ref = useViewTracking(item);
  return (
    <article
      ref={ref}
      onClick={() => handlers.onOpen(item)}
      className="flex cursor-pointer gap-3 border-b border-border px-3 py-3 transition-colors hover:bg-white/[0.02] sm:px-4"
    >
      <StreamAvatar src={item.author.avatarUrl} name={item.author.name} />
      <div className="min-w-0 flex-1">
        <header className="flex items-center gap-1.5 text-sm">
          <span className="truncate font-semibold text-foreground">{item.author.name}</span>
          {item.kind === "developer" && item.score != null && item.score >= 85 ? (
            <BadgeCheck className="size-3.5 shrink-0 text-sky-300" aria-hidden />
          ) : null}
          {item.author.handle ? <span className="truncate text-muted-foreground"><bdi>{item.author.handle}</bdi></span> : null}
          {item.publishedAt || item.readingMinutes ? (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <span aria-hidden>·</span>
              <Meta item={item} now={now} />
            </span>
          ) : null}
          <span className="ms-auto" />
          <MoreMenu item={item} handlers={handlers} />
        </header>
        <div className="mt-0.5 flex items-center gap-1.5">
          <KindBadge item={item} />
          <StatusBadge item={item} />
          {item.sponsored ? <span className="text-[11px] font-medium text-muted-foreground">{t("sponsored")}</span> : null}
          {item.scoreLabel === "available" ? <span className="text-[11px] font-semibold text-emerald-300">{t("available")}</span> : null}
        </div>
        <div className="mt-1.5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {isPerson(item) ? null : <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug text-foreground">{item.title}</h3>}
            {item.summary ? <p className={cn("line-clamp-3 text-sm leading-5", isPerson(item) ? "text-foreground" : "mt-0.5 text-foreground/80")}>{item.summary}</p> : null}
          </div>
          <ScorePill item={item} />
        </div>
        {item.coverUrl ? (
          <div className="mt-2 overflow-hidden rounded-xl border border-border">
            <StreamVisual item={item} variant="masonry" />
          </div>
        ) : null}
        {item.tags.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-[var(--link)]">
            {item.tags.slice(0, 4).map((tag) => <span key={tag}>#{tag}</span>)}
          </div>
        ) : null}
        <StreamActions item={item} className="mt-2 max-w-md" onComment={() => handlers.onOpen(item)} onShare={() => handlers.onShare(item)} />
      </div>
    </article>
  );
}

/** 小红书-style tile: visual on top, two-line title, author + real counter + like. */
export function StreamMasonryCard({ item, handlers }: { item: StreamItem; handlers: StreamCardHandlers }) {
  if (item.kind === "post") return <StreamPostTile item={item} handlers={handlers} />;
  return <StreamEntryTile item={item} handlers={handlers} />;
}

function StreamEntryTile({ item, handlers }: { item: StreamItem; handlers: StreamCardHandlers }) {
  const t = useTranslations("stream");
  const locale = useLocale();
  const ref = useViewTracking(item);
  return (
    <article
      ref={ref}
      onClick={() => handlers.onOpen(item)}
      className="group relative cursor-pointer overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/20"
    >
      <div className="relative">
        <StreamVisual item={item} variant="masonry" />
        <span className="absolute start-2 top-2"><KindBadge item={item} /></span>
        {item.sponsored ? (
          <span className="absolute end-2 top-2 rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{t("sponsored")}</span>
        ) : item.badge ? (
          <span className="absolute end-2 top-2"><StatusBadge item={item} /></span>
        ) : null}
      </div>
      <div className="p-2.5">
        {isTextTile(item) ? (
          <p className="line-clamp-2 text-xs leading-snug text-foreground/80">{item.summary}</p>
        ) : (
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{item.title}</h3>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <StreamAvatar src={item.author.avatarUrl} name={item.author.name} className="size-5 text-[10px]" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground"><bdi>{isPerson(item) ? item.author.handle ?? item.author.name : item.author.name}</bdi></span>
          {item.counter ? <span className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline">{compactNumber(item.counter.value, locale)}</span> : null}
          <StreamActions item={item} compact onShare={() => handlers.onShare(item)} />
        </div>
      </div>
    </article>
  );
}
