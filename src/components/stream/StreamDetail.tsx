"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Heart, Library, SquareArrowOutUpRight, UserCheck, UserPlus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { StreamItemDetail } from "@/lib/stream/detail";
import { relatedItems } from "@/lib/stream/rank";
import { useStreamStore } from "@/lib/stream/store";
import type { StreamItem } from "@/lib/stream/types";
import { cn } from "@/lib/utils";
import { KIND_STYLE, relativeTime } from "./format";
import { CounterChip, StreamActions } from "./StreamActions";
import { KindBadge, ScorePill, StatusBadge, StreamAvatar, StreamVisual, isTextTile, type StreamCardHandlers } from "./StreamCard";
import { StreamComments } from "./StreamComments";
import { Section, StreamKindSections } from "./StreamDetailSections";
import { PostDetailSection, XLatest } from "./StreamPost";

const STAT_KEYS = new Set(["confidence", "community", "language", "lookups", "delta", "location", "project", "stars", "salary"]);
/** Kinds whose detail needs the /feed/item round trip (body or comments). */
const LAZY_KINDS = new Set(["developer", "article", "collection", "job"]);

const detailCache = new Map<string, Promise<StreamItemDetail | null>>();

function fetchDetail(item: StreamItem): Promise<StreamItemDetail | null> {
  const cached = detailCache.get(item.id);
  if (cached) return cached;
  const base = window.location.pathname.replace(/\/$/, "");
  const params = new URLSearchParams({ id: item.id });
  if (item.comments) params.set("thread", `${item.comments.kind}:${item.comments.key}`);
  const request = fetch(`${base}/item?${params.toString()}`)
    .then((response) => (response.ok ? (response.json() as Promise<StreamItemDetail>) : null))
    .catch(() => null);
  detailCache.set(item.id, request);
  // A failed load may succeed on the next open.
  void request.then((value) => { if (!value) detailCache.delete(item.id); });
  return request;
}

function useItemDetail(item: StreamItem | null) {
  const needsFetch = item != null && (LAZY_KINDS.has(item.kind) || item.comments != null);
  const [state, setState] = useState<{ id: string | null; detail: StreamItemDetail | null }>({ id: null, detail: null });
  useEffect(() => {
    if (!item || !needsFetch) return;
    let alive = true;
    void fetchDetail(item).then((detail) => { if (alive) setState({ id: item.id, detail }); });
    return () => { alive = false; };
  }, [item, needsFetch]);
  const current = item && state.id === item.id ? state.detail : null;
  return { detail: current, loading: needsFetch && state.id !== item?.id };
}

export function FollowButton({ authorId, name, onFollowed }: { authorId: string; name: string; onFollowed?: (name: string) => void }) {
  const t = useTranslations("stream");
  const following = useStreamStore((state) => Boolean(state.following[authorId]));
  const toggleFollow = useStreamStore((state) => state.toggleFollow);
  return (
    <Button
      type="button"
      size="sm"
      shape="pill"
      variant={following ? "outline" : "default"}
      onClick={(event) => {
        event.stopPropagation();
        if (toggleFollow(authorId)) onFollowed?.(name);
      }}
      className="h-7 shrink-0 px-3"
    >
      {following ? <UserCheck className="size-3.5" aria-hidden /> : <UserPlus className="size-3.5" aria-hidden />}
      {following ? t("following") : t("follow")}
    </Button>
  );
}

function MiniCard({ item, onOpen }: { item: StreamItem; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-center gap-2.5 py-2 text-start">
      <StreamAvatar src={item.author.avatarUrl} name={item.author.name} className="size-8" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-1 text-sm font-semibold text-foreground">{item.title}</span>
        <span className="line-clamp-1 text-xs text-muted-foreground">{item.kind === "post" ? `${item.author.name} ${item.author.handle ?? ""}` : item.summary}</span>
      </span>
      <KindBadge item={item} />
    </button>
  );
}

/**
 * Detail view. Full-screen on phones, a wide modal on desktop. The URL carries
 * `?item=<id>` (pushed by StreamApp), so Back closes it and links deep-link.
 * Every exit inside it (similar people, editor's picks, more from the author,
 * related) swaps in place, which keeps the reader inside the stream.
 */
export function StreamDetail({
  item,
  pool,
  now,
  handlers,
  onClose,
  onFollowed,
}: {
  item: StreamItem | null;
  pool: StreamItem[];
  now: number;
  handlers: StreamCardHandlers;
  onClose: () => void;
  onFollowed: (name: string) => void;
}) {
  const t = useTranslations("stream");
  const locale = useLocale();
  const toggleLike = useStreamStore((state) => state.toggleLike);
  const liked = useStreamStore((state) => (item ? Boolean(state.liked[item.id]) : false));
  const [burst, setBurst] = useState(0);
  const lastTap = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const commentsRef = useRef<HTMLDivElement | null>(null);
  const { detail, loading } = useItemDetail(item);

  const open = (next: StreamItem) => {
    handlers.onOpen(next);
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const openUser = (username: string) => {
    const match = pool.find((entry) => entry.kind === "developer" && entry.author.id.toLowerCase() === username.toLowerCase());
    if (match) open(match);
    else window.location.href = new URL(item ? item.href.replace(/\/u\/[^/]+$/, `/u/${username}`) : `/u/${username}`, window.location.origin).href;
  };

  const onVisualTap = () => {
    if (!item) return;
    const at = Date.now();
    if (at - lastTap.current < 300) {
      if (!liked) toggleLike(item);
      setBurst((value) => value + 1);
      lastTap.current = 0;
    } else {
      lastTap.current = at;
    }
  };

  const shown = new Set(item ? [item.id] : []);
  const editorPicks = item
    ? pool.filter((entry) => entry.badge === "editor" && entry.id !== item.id).slice(0, 6)
    : [];
  editorPicks.forEach((entry) => shown.add(entry.id));
  const sameAuthor = item && item.author.id !== "ghfind"
    ? pool.filter((entry) => entry.author.id === item.author.id && !shown.has(entry.id)).slice(0, 3)
    : [];
  sameAuthor.forEach((entry) => shown.add(entry.id));
  const related = item ? relatedItems(item, pool, 5, shown) : [];
  const style = item ? KIND_STYLE[item.kind] : null;
  const person = item?.kind === "developer" || item?.kind === "talent";

  return (
    <Dialog open={item != null} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent
        aria-describedby={undefined}
        className="inset-0 flex h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(90dvh,860px)] sm:w-[min(calc(100vw-2rem),44rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border"
      >
        {item && style ? (
          <>
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
              <DialogClose asChild>
                <button type="button" aria-label={t("close")} className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
                  <ArrowLeft className="size-4" aria-hidden />
                </button>
              </DialogClose>
              <StreamAvatar src={item.author.avatarUrl} name={item.author.name} className="size-8" />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-sm font-semibold text-foreground">{item.author.name}</p>
                {item.author.handle ? <p className="truncate text-xs text-muted-foreground"><bdi>{item.author.handle}</bdi></p> : null}
              </div>
              {item.kind !== "article" ? <FollowButton authorId={item.author.id} name={item.author.name} onFollowed={onFollowed} /> : null}
            </header>

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <div className="px-4 pb-4 pt-3">
                {isTextTile(item) ? null : (
                  <div className="relative select-none" onClick={onVisualTap}>
                    <StreamVisual item={item} variant="detail" />
                    <AnimatePresence>
                      {burst > 0 ? (
                        <motion.span
                          key={burst}
                          initial={{ scale: 0.3, opacity: 0 }}
                          animate={{ scale: [0.3, 1.2, 1], opacity: [0, 1, 1] }}
                          exit={{ scale: 1.4, opacity: 0 }}
                          transition={{ duration: 0.45 }}
                          onAnimationComplete={() => window.setTimeout(() => setBurst(0), 250)}
                          className="pointer-events-none absolute inset-0 flex items-center justify-center"
                        >
                          <Heart className="size-20 fill-rose-500 text-rose-500 drop-shadow-lg" aria-hidden />
                        </motion.span>
                      ) : null}
                    </AnimatePresence>
                  </div>
                )}

                <div className={cn("flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground", !isTextTile(item) && "mt-3")}>
                  <KindBadge item={item} />
                  <StatusBadge item={item} />
                  {item.sponsored ? <span>{t("sponsored")}</span> : null}
                  {item.publishedAt ? <span>{relativeTime(item.publishedAt, now, locale)}</span> : null}
                  {item.readingMinutes ? <span>· {t("minutesRead", { minutes: item.readingMinutes })}</span> : null}
                  <CounterChip counter={item.counter} className="ms-auto" />
                </div>

                {item.kind === "post" ? (
                  <>
                    <DialogTitle className="sr-only">{item.title}</DialogTitle>
                    <PostDetailSection item={item} onOpenUser={openUser} />
                  </>
                ) : (
                  <>
                    <div className="mt-2 flex items-start justify-between gap-3">
                      <DialogTitle className="text-xl font-black leading-snug tracking-tight">{item.title}</DialogTitle>
                      {!person ? <ScorePill item={item} size="lg" /> : null}
                    </div>
                    {item.summary ? <DialogDescription className="mt-1.5 text-[15px] leading-6 text-foreground/85">{item.summary}</DialogDescription> : null}
                  </>
                )}
                {item.body
                  ? item.body.split(/\n{2,}/).map((paragraph) => (
                      <p key={paragraph.slice(0, 40)} className="mt-2 text-sm leading-6 text-foreground/80">{paragraph}</p>
                    ))
                  : null}

                {person ? <XLatest item={item} pool={pool} onOpen={open} /> : null}

                <StreamKindSections item={item} detail={detail} loading={loading} onOpenUser={openUser} />

                {item.stats.length > 0 && item.kind !== "developer" ? (
                  <dl className="mt-4 grid grid-cols-3 gap-1.5">
                    {item.stats.map((stat) => (
                      <div key={stat.label} className="rounded-lg border border-border bg-white/[0.02] px-2.5 py-1.5">
                        <dt className="text-[11px] text-muted-foreground">{STAT_KEYS.has(stat.label) ? t(`stats.${stat.label}`) : stat.label}</dt>
                        <dd className="truncate text-sm font-semibold tabular-nums text-foreground">{stat.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {item.tags.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {item.tags.map((tag) => (
                      <span key={tag} className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", style.tint, style.text)}>#{tag}</span>
                    ))}
                  </div>
                ) : null}

                {item.kind === "post" ? null : <a
                  href={item.href}
                  target={item.external ? "_blank" : undefined}
                  rel={item.external ? "noopener noreferrer" : undefined}
                  className="mt-4 flex items-center justify-between rounded-xl border border-border px-3 py-2.5 text-sm font-semibold text-foreground hover:bg-white/[0.03]"
                >
                  {t("openOriginal")}
                  <SquareArrowOutUpRight className="size-4 text-muted-foreground" aria-hidden />
                </a>}

                <div ref={commentsRef} className="mt-5 border-t border-border pt-4">
                  <StreamComments item={item} comments={detail?.comments ?? []} loading={loading} />
                </div>
              </div>

              {editorPicks.length > 0 ? (
                <section className="border-t border-border py-3">
                  <h4 className="flex items-center gap-1.5 px-4 text-sm font-bold text-foreground">
                    <Library className="size-4 text-amber-300" aria-hidden />
                    {t("editorPicks")}
                  </h4>
                  <div className="mt-2 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
                    {editorPicks.map((entry) => (
                      <button key={entry.id} type="button" onClick={() => open(entry)} className="w-44 shrink-0 overflow-hidden rounded-xl border border-border bg-gradient-to-br from-amber-500/15 to-transparent p-2.5 text-start hover:border-foreground/20">
                        <span className="line-clamp-3 text-[13px] font-bold leading-snug text-foreground">{entry.title}</span>
                        <span className="mt-1.5 flex items-center gap-1.5">
                          <StreamAvatar src={entry.author.avatarUrl} name={entry.author.name} className="size-4 text-[9px]" />
                          <span className="truncate text-[11px] text-muted-foreground">{entry.author.name}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {sameAuthor.length > 0 ? (
                <Section title={t("moreFrom", { name: item.author.name })} className="mt-0 border-t border-border px-4 py-3">
                  <div className="divide-y divide-border">
                    {sameAuthor.map((entry) => <MiniCard key={entry.id} item={entry} onOpen={() => open(entry)} />)}
                  </div>
                </Section>
              ) : null}

              {related.length > 0 ? (
                <Section title={t("related")} className="mt-0 border-t border-border px-4 py-3">
                  <div className="divide-y divide-border">
                    {related.map((entry) => <MiniCard key={entry.id} item={entry} onOpen={() => open(entry)} />)}
                  </div>
                </Section>
              ) : null}
            </div>

            <footer className="border-t border-border px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              <StreamActions
                item={item}
                onComment={() => commentsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                onShare={() => handlers.onShare(item)}
              />
            </footer>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
