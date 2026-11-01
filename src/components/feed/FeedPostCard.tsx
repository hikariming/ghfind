"use client";

import { useRef, useState, type ReactNode } from "react";
import { Bookmark, ChartNoAxesColumn, Heart, Link2, MessageCircle, MoreHorizontal, Repeat2, Share2, ThumbsDown, Trash2, UserMinus, UserPlus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Link } from "@/i18n/navigation";
import { feedClient, type FeedAction } from "@/lib/social-feed/client";
import type { FeedPost } from "@/lib/social-feed/contract";
import { useMountEffect } from "@/lib/use-mount-effect";
import { cn } from "@/lib/utils";
import { FeedAuthorHoverCard } from "./FeedAuthorHoverCard";
import { FeedAvatar } from "./FeedAvatar";
import { XMark } from "@/components/stream/StreamPost";
import { relativeTime } from "@/components/stream/format";

import { feedReferences } from "./references";
import { FeedReferenceCard } from "./FeedReferenceCard";

interface FeedPostCardProps {
  posts?: Record<string, FeedPost>;
  post: FeedPost;
  now: number;
  pending: boolean;
  onOpen: (id: string) => void;
  onReply: (id: string) => void;
  onAction: (id: string, action: FeedAction) => void;
  onFollow: (id: string, following: boolean) => void;
  onCopy: (id: string) => void;
  focused?: boolean;
  connected?: boolean;
}


function PostText({ text }: { text: string }) {
  return text.split(/(https?:\/\/[^\s<>]+)/g).map((part, index) => /^https?:\/\//.test(part)
    ? <a key={index} href={part} target="_blank" rel="noopener noreferrer nofollow ugc" className="text-[var(--link)] hover:underline">{part}</a>
    : part);
}

function useQualifiedView(post: FeedPost) {
  const ref = useRef<HTMLElement | null>(null);
  useMountEffect(() => {
    if (!post.view_token || post.status !== "published" || !ref.current || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    let sent = false;
    const eventId = crypto.randomUUID();
    const update = () => {
      clearTimeout(timer);
      if (visible && !document.hidden && !sent) {
        timer = setTimeout(() => {
          sent = true;
          void feedClient.view(post, eventId).catch(() => { /* Telemetry failure never blocks reading. */ });
        }, 2_200);
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.5);
      update();
    }, { threshold: 0.5 });
    observer.observe(ref.current);
    document.addEventListener("visibilitychange", update);
    return () => { clearTimeout(timer); observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  });
  return ref;
}

export function FeedPostCard({ post, posts = {}, now, pending, onOpen, onReply, onAction, onFollow, onCopy, focused = false, connected = false }: FeedPostCardProps) {
  const t = useTranslations("stream");
  const locale = useLocale();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const ref = useQualifiedView(post);
  const counts = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const available = post.status === "published";
  const viewer = post.viewer;
  // The API omits translations for the source language; the locale check also guards a stale cached post.
  const translation = available && post.translation?.locale === locale ? post.translation : null;
  const translated = Boolean(translation) && !showOriginal;
  const content = feedReferences(post, translated ? translation!.text : post.text, posts);
  const actions: { label: string; icon: typeof Heart; action?: FeedAction; count?: number; active?: boolean; run?: () => void }[] = [
    { label: t(available ? "replySend" : "feed.viewReplies"), icon: MessageCircle, count: post.metrics.direct_replies, run: () => available ? onReply(post.id) : onOpen(post.id) },
    { label: t(viewer?.reposted ? "feed.undoRepost" : "feed.repost"), icon: Repeat2, count: post.metrics.reposts, action: "repost", active: viewer?.reposted },
    { label: t(viewer?.reaction === "like" ? "unlike" : "like"), icon: Heart, count: post.metrics.likes, action: "like", active: viewer?.reaction === "like" },
    { label: t(viewer?.reaction === "dislike" ? "feed.undoDislike" : "feed.dislike"), icon: ThumbsDown, action: "dislike", active: viewer?.reaction === "dislike" },
    { label: t(viewer?.bookmarked ? "unsave" : "save"), icon: Bookmark, action: "bookmark", active: viewer?.bookmarked },
  ];
  const postMenu = (<DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t("more")}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {focused ? <DropdownMenuItem disabled={pending || !available} onSelect={() => onAction(post.id, "dislike")}><ThumbsDown className="me-2 size-4" />{t(viewer?.reaction === "dislike" ? "feed.undoDislike" : "feed.dislike")}</DropdownMenuItem> : null}
                <DropdownMenuItem onSelect={() => onCopy(post.id)}><Link2 className="me-2 size-4" />{t("copyLink")}</DropdownMenuItem>
                {!viewer?.can_delete ? <DropdownMenuItem disabled={pending} onSelect={() => onFollow(post.author.id, Boolean(viewer?.following_author))}>{viewer?.following_author ? <UserMinus className="me-2 size-4" /> : <UserPlus className="me-2 size-4" />}{t(viewer?.following_author ? "feed.unfollow" : "follow")} @{post.author.github_login}</DropdownMenuItem> : null}
                {viewer?.can_delete && available ? <DropdownMenuItem onSelect={() => setConfirmDelete(true)}><Trash2 className="me-2 size-4" />{t("feed.deletePost")}</DropdownMenuItem> : null}
              </DropdownMenuContent>
            </DropdownMenu>);
  return <>
    <article
      ref={ref}
      tabIndex={focused ? undefined : 0}
      aria-label={focused ? undefined : t("feed.openConversation", { name: post.author.name })}
      className={cn("relative border-b border-border bg-background px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4", focused ? "border-b-0" : "cursor-pointer hover:bg-foreground/[0.015]")}
      onClick={(event) => { if (!focused && !(event.target as HTMLElement).closest("a, button, input, textarea, [role=menuitem]")) onOpen(post.id); }}
      onKeyDown={(event) => { if (!focused && event.target === event.currentTarget && event.key === "Enter") onOpen(post.id); }}
    >
      {post.reposted_by ? <p className="mb-2 flex items-center gap-2 ps-[50px] text-xs text-muted-foreground"><Repeat2 className="size-3.5" aria-hidden /><span>{t("feed.repostedBy", { name: post.reposted_by.name })}</span></p> : null}
      <div className={cn(focused ? "grid grid-cols-[40px_minmax(0,1fr)] gap-x-3" : "flex gap-2.5")}>
        <div className="relative shrink-0">
          <FeedAuthorHoverCard author={post.author} following={Boolean(viewer?.following_author)} pending={pending} onFollow={onFollow}><Link href={`/u/${post.author.github_login}`} prefetch={false} aria-label={post.author.name}><FeedAvatar key={post.author.avatar_url} name={post.author.name} src={post.author.avatar_url} score={post.author.publication_score} /></Link></FeedAuthorHoverCard>
          {connected ? <div aria-hidden className="absolute inset-x-0 top-12 mx-auto h-[calc(100%-2rem)] w-px bg-border" /> : null}
        </div>
        <div className={focused ? "contents" : "min-w-0 flex-1"}>
          <div className={cn("flex min-w-0 items-start gap-1.5 leading-5", focused ? "text-[15px]" : "text-sm")}>
            <div className="min-w-0 flex-1">
              <FeedAuthorHoverCard author={post.author} following={Boolean(viewer?.following_author)} pending={pending} onFollow={onFollow}><Link href={`/u/${post.author.github_login}`} prefetch={false} className={cn("font-semibold text-foreground hover:underline", focused && "block truncate font-bold")}>{post.author.name}</Link></FeedAuthorHoverCard>{" "}
              <a href={`https://github.com/${post.author.github_login}`} target="_blank" rel="noopener noreferrer" className={cn("text-muted-foreground hover:underline", focused && "block truncate")}><bdi>@{post.author.github_login}</bdi></a>
              {!focused ? <>
              <span className="text-muted-foreground"> · </span>
              <a href={`?post=${encodeURIComponent(post.id)}`} onClick={(event) => { event.preventDefault(); onOpen(post.id); }} className="whitespace-nowrap text-muted-foreground hover:underline"><time dateTime={post.published_at} title={new Date(post.published_at).toLocaleString(locale)}>{relativeTime(post.published_at, now, locale)}</time></a>
              </> : null}
            </div>
            {post.origin === "x" && post.original_url ? <a href={post.original_url} target="_blank" rel="noopener noreferrer" title={t("feed.viewOnX")} aria-label={t("feed.viewOnX")} className="-me-1 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"><XMark className={focused ? "size-[18px]" : "size-3.5"} /></a> : null}
            {focused ? postMenu : null}
          </div>
          {available ? <>
            <div dir="auto" lang={translated ? translation!.locale : post.source_lang ?? undefined} className={cn("mt-1 whitespace-pre-wrap break-words leading-6 text-foreground [overflow-wrap:anywhere]", focused ? "col-span-2 mt-4 text-xl leading-7" : "text-[15px]")}><PostText text={content.text} /></div>
            {translation ? <ToggleGroup type="single" value={translated ? "translated" : "original"} onValueChange={(value) => { if (value) setShowOriginal(value === "original"); }} aria-label={t("feed.translationToggle")} className={cn("mt-1.5 w-fit", focused && "col-span-2")}>
              <ToggleGroupItem value="original" className="h-6 px-2 text-xs">{t("feed.showOriginal")}</ToggleGroupItem>
              <ToggleGroupItem value="translated" className="h-6 px-2 text-xs">{t("feed.showTranslated")}</ToggleGroupItem>
            </ToggleGroup> : null}
            {content.references.length ? <div className={focused ? "col-span-2" : undefined}>{content.references.map((reference) => <FeedReferenceCard key={reference.url} reference={reference} now={now} />)}</div> : null}
            {post.media.length ? <div className={cn("mt-2 grid gap-1 overflow-hidden rounded-xl border border-border", post.media.length > 1 && "grid-cols-2", focused && "col-span-2")}>
              {/* eslint-disable-next-line @next/next/no-img-element -- original media is shared by Astro and Next, without Next image optimization */}
              {post.media.map((media) => <a key={media.id} href={media.url} target="_blank" rel="noopener noreferrer" aria-label={media.alt_text || t("feed.openImage")}><img src={media.url} alt={media.alt_text ?? ""} width={media.width ?? undefined} height={media.height ?? undefined} loading="lazy" className="max-h-96 w-full object-cover" /></a>)}
            </div> : null}
          </> : <p className={cn("py-3 text-sm text-muted-foreground", focused && "col-span-2")}>{t(post.status === "deleted" ? "feed.deleted" : "feed.unavailable")}</p>}
          {focused ? <p className="col-span-2 my-4 text-[15px] text-muted-foreground">
            <time dateTime={post.published_at}>{new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(post.published_at))}{" · "}{new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(post.published_at))}</time>
            {" · "}<span className="font-semibold text-foreground">{counts.format(post.metrics.views)}</span>{" "}{t("feed.views")}
          </p> : null}
          <div className={cn("flex items-center justify-between gap-0.5", focused ? "col-span-2 min-h-[49px] border-y border-border [&_button]:min-h-10 [&_svg]:size-5" : "-ms-2 mt-1.5")} aria-label={t("feed.localInteractions")}>
            {actions.filter(({ action }) => !focused || action !== "dislike").map(({ label, icon: Icon, action, count, active, run }) => <Button key={label} type="button" variant="ghost" size="sm" className={cn("h-9 min-w-9 gap-1 px-1.5 text-xs text-muted-foreground", active && "text-foreground")} title={label} aria-label={count ? `${label} ${count}` : label} aria-pressed={action ? Boolean(active) : undefined} disabled={Boolean(action) && (pending || (!available && action !== "bookmark"))} onClick={() => run ? run() : action && onAction(post.id, action)}><Icon className={cn("size-4", active && (action === "like" || action === "bookmark") && "fill-current")} aria-hidden />{count ? counts.format(count) : null}</Button>)}
            {!focused ? <span className="flex h-9 min-w-7 items-center gap-1 text-xs text-muted-foreground" title={`${t("feed.views")} ${post.metrics.views}`}><ChartNoAxesColumn className="size-3.5" aria-hidden /><span>{post.metrics.views ? counts.format(post.metrics.views) : ""}</span><span className="sr-only">{t("feed.views")}</span></span> : <Button type="button" variant="ghost" size="icon" className="size-9 text-muted-foreground" onClick={() => onCopy(post.id)} aria-label={t("copyLink")} title={t("copyLink")}><Share2 className="size-5" /></Button>}
            {!focused ? postMenu : null}
          </div>
        </div>
      </div>
    </article>
    <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}><DialogContent><DialogTitle>{t("feed.deletePost")}</DialogTitle><DialogDescription>{t("feed.deleteHint")}</DialogDescription><div className="flex justify-end gap-2"><DialogClose asChild><Button variant="outline">{t("feed.cancel")}</Button></DialogClose><Button onClick={() => { setConfirmDelete(false); onAction(post.id, "delete"); }}>{t("feed.deletePost")}</Button></div></DialogContent></Dialog>
  </>;
}

export function FeedMessage({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="px-5 py-8 text-center text-sm leading-6 text-muted-foreground"><p>{children}</p>{action ? <div className="mt-3">{action}</div> : null}</div>;
}
