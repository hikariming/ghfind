"use client";

import { ArrowUpRight, Link2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { relativeTime } from "@/components/stream/format";
import type { FeedReference } from "./references";

export function FeedReferenceCard({ reference, now }: { reference: FeedReference; now: number }) {
  const t = useTranslations("stream.feed");
  const locale = useLocale();
  const post = reference.post;
  const text = post?.translation?.locale === locale ? post.translation.text : post?.text;
  const handle = post?.original_url ? new URL(post.original_url).pathname.split("/")[1] : undefined;
  return <a href={reference.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="mt-2 block overflow-hidden rounded-xl border border-border text-sm text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    {post ? <>
      <div className="p-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- shared Next/Astro feed media */}
          {post.author.avatar_url ? <img src={post.author.avatar_url} alt="" loading="lazy" className="size-5 shrink-0 rounded-full object-cover" /> : null}
          <span className="truncate font-semibold">{post.author.name}</span>
          {handle && handle !== "i" ? <bdi className="truncate text-muted-foreground">@{handle}</bdi> : null}
          <time dateTime={post.published_at} className="shrink-0 text-xs text-muted-foreground">· {relativeTime(post.published_at, now, locale)}</time>
        </div>
        <p dir="auto" className="mt-1 line-clamp-6 whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]">{text}</p>
      </div>
      {post.media.length ? <div className={post.media.length > 1 ? "grid grid-cols-2 gap-px border-t border-border" : "border-t border-border"}>
        {/* eslint-disable @next/next/no-img-element -- shared Next/Astro feed media */}
        {post.media.map((media) => <img key={media.id} src={media.url} alt={media.alt_text ?? ""} width={media.width ?? undefined} height={media.height ?? undefined} loading="lazy" className="max-h-80 w-full object-cover" />)}
        {/* eslint-enable @next/next/no-img-element */}
      </div> : null}
    </> : <div className="flex items-center gap-3 px-3 py-3">
      <Link2 className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1"><p className="font-medium">{t(reference.kind === "post" ? "viewQuotedPost" : "viewAttachedLink")}</p><p className="mt-0.5 text-xs text-muted-foreground">{t(reference.kind === "post" ? "quotedPostPreviewUnavailable" : "attachedLinkPreviewUnavailable")}</p></div>
      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </div>}
  </a>;
}
