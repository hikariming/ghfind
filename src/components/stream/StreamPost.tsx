"use client";

import { useState } from "react";
import { BadgeCheck, ChartNoAxesColumn, Heart, Languages, MessageCircle, Repeat2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { StreamItem } from "@/lib/stream/types";
import { cn } from "@/lib/utils";
import { compactNumber, relativeTime, tierIconSrc } from "./format";
import { StreamActions } from "./StreamActions";
import { StatusBadge, StreamAvatar, useViewTracking, type StreamCardHandlers } from "./StreamCard";

type PostExtra = Extract<NonNullable<StreamItem["extra"]>, { kind: "post" }>;

export function postExtra(item: StreamItem): PostExtra | null {
  return item.extra?.kind === "post" ? item.extra : null;
}

/** X brand mark (lucide has no brand icons), same approach as the sidebar GitHub mark. */
export function XMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("fill-current", className)}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function CategoryChip({ category }: { category: string }) {
  const t = useTranslations("stream");
  const known = ["researcher", "builder", "media", "developer"].includes(category);
  if (!known) return null;
  return <span className="rounded-md bg-foreground/10 px-1.5 py-0.5 text-[11px] font-medium text-foreground/80">{t(`xCategory.${category}`)}</span>;
}

/** Live X numbers, shown as X shows them. */
export function XMetrics({ extra, className }: { extra: PostExtra; className?: string }) {
  const t = useTranslations("stream");
  const locale = useLocale();
  const entries = [
    { key: "replies", icon: MessageCircle, value: extra.metrics.replies },
    { key: "reposts", icon: Repeat2, value: extra.metrics.reposts },
    { key: "likes", icon: Heart, value: extra.metrics.likes },
    { key: "views", icon: ChartNoAxesColumn, value: extra.metrics.views },
  ].filter((entry): entry is { key: string; icon: typeof Heart; value: number } => entry.value != null && entry.value > 0);
  if (entries.length === 0) return null;
  return (
    <div className={cn("flex items-center gap-4 text-xs tabular-nums text-muted-foreground", className)}>
      {entries.map(({ key, icon: Icon, value }) => (
        <span key={key} className="inline-flex items-center gap-1" title={`${t(`xMetrics.${key}`)} ${value.toLocaleString(locale)}`}>
          <Icon className="size-3.5" aria-hidden />
          {compactNumber(value, locale)}
        </span>
      ))}
    </div>
  );
}

/**
 * Post text as written (never rewritten), with optional media and quoted
 * block. A post in another language offers the agent's translation behind a
 * toggle, like X's "Translate post"; the original always stays one tap away.
 */
export function PostBody({ item, extra, clamp, translated = false }: { item: StreamItem; extra: PostExtra; clamp: boolean; translated?: boolean }) {
  const t = useTranslations("stream");
  const [showTranslation, setShowTranslation] = useState(translated);
  const translation = extra.translation;
  return (
    <>
      <p dir="auto" className={cn("whitespace-pre-line break-words text-[15px] leading-6 text-foreground", clamp && "line-clamp-6")}>
        {translation && showTranslation ? translation : item.summary}
      </p>
      {translation ? (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setShowTranslation((value) => !value);
            }}
            className="inline-flex items-center gap-1 font-medium text-[var(--link)] hover:underline"
          >
            <Languages className="size-3.5" aria-hidden />
            {showTranslation ? t("showOriginal") : t("showTranslation")}
          </button>
          {showTranslation ? <span className="text-muted-foreground">{t("translatedBy")}</span> : null}
        </p>
      ) : null}
      {extra.media ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote X media
        <img src={extra.media.url} alt={extra.media.alt ?? ""} loading="lazy" className="mt-2 max-h-80 w-full rounded-xl border border-border object-cover" />
      ) : null}
      {extra.quote ? (
        <a
          href={extra.quote.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className="mt-2 block rounded-xl border border-border px-3 py-2 hover:bg-white/[0.02]"
        >
          {extra.quote.author ? <span className="block text-xs font-semibold text-muted-foreground">{extra.quote.author}</span> : null}
          <span dir="auto" className="line-clamp-3 text-sm leading-5 text-foreground/85">{extra.quote.text}</span>
        </a>
      ) : null}
    </>
  );
}

function AuthorLine({ item, extra, now }: { item: StreamItem; extra: PostExtra; now: number }) {
  const locale = useLocale();
  return (
    <header className="flex min-w-0 items-center gap-1.5 text-sm">
      <span className="truncate font-semibold text-foreground">{item.author.name}</span>
      {extra.verified ? <BadgeCheck className="size-4 shrink-0 fill-sky-500 text-background" aria-hidden /> : null}
      <span className="truncate text-muted-foreground"><bdi>@{extra.handle}</bdi></span>
      {item.publishedAt ? <span className="shrink-0 text-xs text-muted-foreground">· {relativeTime(item.publishedAt, now, locale)}</span> : null}
      <XMark className="ms-auto size-3.5 shrink-0 text-muted-foreground" />
    </header>
  );
}

function GhfindBadge({ item }: { item: StreamItem }) {
  if (item.score == null || !item.scoreLabel) return null;
  return (
    <span className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-foreground" title="ghfind">
      ghfind {item.score}
      {/* eslint-disable-next-line @next/next/no-img-element -- static tier artwork */}
      <img src={tierIconSrc(item.scoreLabel)} alt="" className="size-3" />
    </span>
  );
}

/** X-style row for a curated post. */
export function StreamPostListCard({ item, now, handlers }: { item: StreamItem; now: number; handlers: StreamCardHandlers }) {
  const ref = useViewTracking(item);
  const extra = postExtra(item);
  if (!extra) return null;
  return (
    <article ref={ref} onClick={() => handlers.onOpen(item)} className="flex cursor-pointer gap-3 border-b border-border px-3 py-3 transition-colors hover:bg-white/[0.02] sm:px-4">
      <StreamAvatar src={item.author.avatarUrl} name={item.author.name} />
      <div className="min-w-0 flex-1">
        <AuthorLine item={item} extra={extra} now={now} />
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <CategoryChip category={extra.category} />
          <GhfindBadge item={item} />
          <StatusBadge item={item} />
        </div>
        <div className="mt-1.5">
          <PostBody item={item} extra={extra} clamp />
        </div>
        {item.tags.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-[var(--link)]">
            {item.tags.map((tag) => <bdi key={tag}>#{tag}</bdi>)}
          </div>
        ) : null}
        <XMetrics extra={extra} className="mt-2" />
        <StreamActions item={item} className="mt-1.5 max-w-md" onComment={() => handlers.onOpen(item)} onShare={() => handlers.onShare(item)} />
      </div>
    </article>
  );
}

/** Grid tile: the quote is the visual. */
export function StreamPostTile({ item, handlers }: { item: StreamItem; handlers: StreamCardHandlers }) {
  const t = useTranslations("stream");
  const locale = useLocale();
  const ref = useViewTracking(item);
  const extra = postExtra(item);
  if (!extra) return null;
  return (
    <article ref={ref} onClick={() => handlers.onOpen(item)} className="cursor-pointer overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/20">
      <div className="bg-gradient-to-br from-foreground/10 to-transparent p-3">
        <div className="flex items-center gap-1.5">
          <StreamAvatar src={item.author.avatarUrl} name={item.author.name} className="size-6 text-[10px]" />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{item.author.name}</span>
          {extra.verified ? <BadgeCheck className="size-3.5 shrink-0 fill-sky-500 text-background" aria-hidden /> : null}
          <XMark className="size-3 shrink-0 text-muted-foreground" />
        </div>
        <p dir="auto" className="mt-2 line-clamp-[8] whitespace-pre-line break-words text-sm font-medium leading-5 text-foreground">{extra.translation ?? item.summary}</p>
        {extra.translation ? <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground"><Languages className="size-3" aria-hidden />{t("translatedBy")}</p> : null}
        {extra.media ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote X media
          <img src={extra.media.url} alt="" loading="lazy" className="mt-2 aspect-video w-full rounded-lg object-cover" />
        ) : null}
      </div>
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <CategoryChip category={extra.category} />
        {/* X's own like count; liking on ghfind happens in the detail view. */}
        <span className="ms-auto inline-flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground" title="X">
          <XMark className="size-2.5" />
          <Heart className="size-3" aria-hidden />
          {compactNumber(extra.metrics.likes, locale)}
        </span>
      </div>
    </article>
  );
}

/** Detail body for a post: full text, live X numbers, link out, ghfind profile. */
export function PostDetailSection({ item, onOpenUser }: { item: StreamItem; onOpenUser: (username: string) => void }) {
  const t = useTranslations("stream");
  const extra = postExtra(item);
  if (!extra) return null;
  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <CategoryChip category={extra.category} />
        {extra.verified ? <BadgeCheck className="size-4 fill-sky-500 text-background" aria-hidden /> : null}
        <span className="text-xs text-muted-foreground"><bdi>@{extra.handle}</bdi></span>
      </div>
      <div className="mt-2">
        <PostBody item={item} extra={extra} clamp={false} translated />
      </div>
      <XMetrics extra={extra} className="mt-3" />
      <p className="mt-1 text-[11px] text-muted-foreground">{t("xSource")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={item.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-semibold text-background hover:opacity-90">
          <XMark className="size-3" />
          {t("viewOnX")}
        </a>
        {extra.github ? (
          <button type="button" onClick={() => onOpenUser(extra.github ?? "")} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-white/[0.03]">
            {t("ghfindProfile")}
            <GhfindBadge item={item} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** "Lately on X" for developer/talent detail: their curated posts in the pool. */
export function XLatest({ item, pool, onOpen }: { item: StreamItem; pool: StreamItem[]; onOpen: (item: StreamItem) => void }) {
  const t = useTranslations("stream");
  const locale = useLocale();
  const x = item.author.x;
  if (!x) return null;
  const posts = pool.filter((entry) => entry.kind === "post" && entry.author.id === item.author.id).slice(0, 3);
  return (
    <section className="mt-4">
      <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-foreground">
        <XMark className="size-3.5" />
        {t("xLatest")}
        <a href={`https://x.com/${x.handle}`} target="_blank" rel="noopener noreferrer" className="ms-auto inline-flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground">
          <bdi>@{x.handle}</bdi>
          {x.verified ? <BadgeCheck className="size-3.5 fill-sky-500 text-background" aria-hidden /> : null}
        </a>
      </h4>
      {posts.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {posts.map((entry) => (
            <li key={entry.id}>
              <button type="button" onClick={() => onOpen(entry)} className="block w-full rounded-xl border border-border px-3 py-2 text-start hover:bg-white/[0.02]">
                <span dir="auto" className="line-clamp-3 whitespace-pre-line text-sm leading-5 text-foreground">{entry.summary}</span>
                {entry.publishedAt ? <span className="mt-1 block text-[11px] text-muted-foreground">{new Date(entry.publishedAt).toLocaleDateString(locale)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
