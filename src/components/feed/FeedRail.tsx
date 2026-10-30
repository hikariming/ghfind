"use client";

import { Code2, Flame, Megaphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import type { FeedPost } from "@/lib/social-feed/contract";
import type { StreamProjectPick, StreamVoice } from "@/lib/stream/types";
import { FeedAvatar } from "./FeedAvatar";

export function FeedRail({ projects, posts, voices }: { projects: StreamProjectPick[]; posts: FeedPost[]; voices: StreamVoice[] }) {
  const t = useTranslations("stream");
  const authors = [...new Map(posts.filter((post) => post.status === "published").map((post) => [post.author.id, post.author])).values()].slice(0, 8);
  return <div className="flex flex-col gap-3">
    <section className="rounded-2xl border border-border bg-background p-3">
      <h2 className="flex items-center gap-1.5 text-sm font-bold"><Flame className="size-4 text-orange-500" aria-hidden />{t("railCtaTitle")}</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("railCtaBody")}</p>
      <Button asChild size="sm" shape="pill" className="mt-2 w-full"><Link href="/" prefetch={false}>{t("railCtaButton")}</Link></Button>
    </section>
    <section className="rounded-2xl border border-border bg-background p-3">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold"><Code2 className="size-4 text-muted-foreground" aria-hidden />{t("railDailyProjects")}</h2>
      {projects.length ? <ul className="divide-y divide-border">{projects.map((project) => <li key={project.repoKey} className="py-2 first:pt-0"><a href={project.href} target="_blank" rel="noopener noreferrer" className="block"><span className="block truncate text-sm font-semibold hover:underline">{project.repoKey}</span><span className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{project.summary}</span></a></li>)}</ul> : <p className="text-xs leading-5 text-muted-foreground">{t("railDailyProjectsEmpty")}</p>}
      <Link href="/projects" prefetch={false} className="mt-2 inline-block text-xs font-medium hover:underline">{t("railDailyProjectsMore")}</Link>
    </section>
    {authors.length || voices.length ? <section className="rounded-2xl border border-border bg-background p-3">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold"><Megaphone className="size-4 text-muted-foreground" aria-hidden />{t("railVoices")}</h2>
      <ul className="flex flex-col gap-2">
        {authors.map((author) => <li key={author.id}><Link href={`/u/${author.github_login}`} prefetch={false} className="flex items-center gap-2 rounded-md py-0.5 hover:bg-accent"><FeedAvatar key={author.avatar_url} name={author.name} src={author.avatar_url} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{author.name}</span><span className="block truncate text-xs text-muted-foreground"><bdi>@{author.github_login}</bdi></span></span></Link></li>)}
        {!authors.length ? voices.map((voice) => <li key={voice.handle}><a href={voice.github ? `https://github.com/${voice.github}` : `https://x.com/${voice.handle}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md py-0.5 hover:bg-accent"><FeedAvatar key={voice.avatarUrl} name={voice.name} src={voice.avatarUrl} /><span className="min-w-0"><span className="block truncate text-sm font-semibold">{voice.name}</span>{voice.github ? <span className="block truncate text-xs text-muted-foreground">@{voice.github}</span> : null}</span></a></li>) : null}
      </ul>
    </section> : null}
  </div>;
}
