"use client";

import { useRef, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { GitHubMark } from "@/components/ui/github-mark";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { FeedAvatar } from "./FeedAvatar";
import { XMark } from "@/components/stream/StreamPost";
import { tierFor } from "@/lib/score-presentation";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import { feedClient } from "@/lib/social-feed/client";
import type { FeedAuthor, FeedAuthorSummary } from "@/lib/social-feed/contract";

export function FeedAuthorHoverCard({ author, following, pending, onFollow, children }: {
  author: FeedAuthor; following: boolean; pending: boolean;
  onFollow: (id: string, following: boolean) => void; children: ReactNode;
}) {
  const t = useTranslations("stream.feed.authorCard");
  const tTier = useTranslations("tiers");
  const [summary, setSummary] = useState<FeedAuthorSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const loading = useRef(false);
  async function load(open: boolean) {
    if (!open || loading.current) return;
    loading.current = true;
    setFailed(false);
    try { setSummary(await feedClient.author(author.id)); }
    catch { setFailed(true); }
    finally { loading.current = false; }
  }
  const score = summary?.score;
  const tier = score != null ? tierFor(score).tier : null;
  const xHandle = summary?.x_handle ?? (summary?.x_url ? /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/?$/i.exec(summary.x_url)?.[1] : null);
  return <HoverCard openDelay={250} closeDelay={180} onOpenChange={load}>
    <HoverCardTrigger asChild>{children}</HoverCardTrigger>
    <HoverCardContent align="start" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <div className="flex items-center gap-3">
        <Link href={`/u/${author.github_login}`} prefetch={false} aria-label={author.name}>
          <FeedAvatar key={author.avatar_url} name={author.name} src={author.avatar_url} score={score} size="sm" />
        </Link>
        {score != null && tier ? <div className={`flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 ${tierStyle(tier).text}`}>
          <strong aria-label={`${t("score")} ${score.toFixed(1)}`} className="text-2xl font-bold tabular-nums">{score.toFixed(1)}</strong>
          <span className="text-2xl font-bold">{tTier(`${TIER_KEY[tier]}.name`)}</span>
        </div> : null}
        <Button className="ms-auto shrink-0" variant="outline" size="sm" disabled={pending} onClick={() => onFollow(author.id, !following)}>{t(following ? "followingAction" : "follow")}</Button>
      </div>
      <Link href={`/u/${author.github_login}`} prefetch={false} className="mt-3 block truncate font-semibold hover:underline">{author.name}</Link>
      <p className="truncate text-sm text-muted-foreground">@{author.github_login}</p>
      {summary?.follows_you ? <span className="text-xs text-muted-foreground">{t("followsYou")}</span> : null}
      <div className="my-3 text-sm">
        {failed ? <Button variant="ghost" size="sm" onClick={() => void load(true)}>{t("retry")}</Button>
          : !summary ? <p role="status" className="text-muted-foreground">{t("loading")}</p>
          : <>
            {score == null ? <p className="text-muted-foreground">{t("unscored")}</p> : null}
            <div className="mt-2 flex gap-4"><span><strong>{summary.following}</strong> {t("following")}</span><span><strong>{summary.followers}</strong> {t("followers")}</span></div>
          </>}
      </div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <a href={`https://github.com/${author.github_login}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline"><GitHubMark /> @{author.github_login}</a>
        {summary?.x_url ? <a aria-label={xHandle ? `X @${xHandle}` : "X"} href={summary.x_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline"><XMark className="size-4" /> {xHandle ? `@${xHandle}` : null}</a> : null}
      </div>
      <Button asChild variant="outline" className="w-full"><Link href={`/u/${author.github_login}`} prefetch={false}>Profile <ExternalLink className="size-3.5" /></Link></Button>
    </HoverCardContent>
  </HoverCard>;
}
