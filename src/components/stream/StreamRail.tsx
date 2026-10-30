"use client";

import type { ReactNode } from "react";
import { BadgeCheck, Flame, Megaphone, Code2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import type { StreamItem, StreamProjectPick, StreamVoice } from "@/lib/stream/types";
import { StreamAvatar } from "./StreamCard";
import { XMark } from "./StreamPost";

function RailSection({ title, icon: Icon, action, children }: { title: string; icon: typeof Flame; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-background p-3">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-foreground">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        {title}
        {action ? <span className="ms-auto">{action}</span> : null}
      </h2>
      {children}
    </section>
  );
}

/** Desktop right rail: score CTA, daily open-source projects and X authors. */
export function StreamRail({ items, projects, voices, onOpen }: { items: StreamItem[]; projects: StreamProjectPick[]; voices: StreamVoice[]; onOpen: (item: StreamItem) => void }) {
  const t = useTranslations("stream");
  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-2xl border border-border bg-background p-3">
        <h2 className="flex items-center gap-1.5 text-sm font-bold text-foreground">
          <Flame className="size-4 text-orange-300" aria-hidden />
          {t("railCtaTitle")}
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("railCtaBody")}</p>
        <Button asChild size="sm" shape="pill" className="mt-2 w-full">
          <Link href="/" prefetch={false}>{t("railCtaButton")}</Link>
        </Button>
      </section>

      <RailSection title={t("railDailyProjects")} icon={Code2}>
        {projects.length > 0 ? (
          <ul className="divide-y divide-border">
            {projects.map((project) => (
              <li key={project.repoKey} className="py-2 first:pt-0">
                <a href={project.href} target="_blank" rel="noopener noreferrer" className="block rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="block truncate text-sm font-semibold text-foreground hover:underline">{project.repoKey}</span>
                  <span className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{project.summary}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs leading-5 text-muted-foreground">{t("railDailyProjectsEmpty")}</p>}
        <Link href="/projects" prefetch={false} className="mt-2 inline-block text-xs font-medium text-foreground hover:underline">{t("railDailyProjectsMore")}</Link>
      </RailSection>

      {voices.length > 0 ? (
        <RailSection title={t("railVoices")} icon={Megaphone}>
          <p className="-mt-1 mb-2 text-[11px] leading-4 text-muted-foreground">{t("railVoicesHint")}</p>
          <ul className="flex flex-col gap-2">
            {voices.map((voice) => {
              const latest = items.find((item) => item.kind === "post" && item.author.x?.handle === voice.handle);
              return (
                <li key={voice.handle} className="flex items-center gap-2">
                  <button type="button" disabled={!latest} onClick={() => latest && onOpen(latest)} className="flex min-w-0 flex-1 items-center gap-2 text-start">
                    <StreamAvatar src={voice.avatarUrl} name={voice.name} className="size-8" />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="flex items-center gap-1 truncate text-sm font-semibold text-foreground">
                        <span className="truncate">{voice.name}</span>
                        {voice.verified ? <BadgeCheck className="size-3.5 shrink-0 fill-sky-500 text-background" aria-hidden /> : null}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{t(`xCategory.${voice.category}`)} · <bdi>@{voice.handle}</bdi></span>
                    </span>
                  </button>
                  <a href={`https://x.com/${voice.handle}`} target="_blank" rel="noopener noreferrer" aria-label={`@${voice.handle}`} className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-foreground hover:bg-white/[0.04]">
                    <XMark className="size-3" />
                  </a>
                </li>
              );
            })}
          </ul>
        </RailSection>
      ) : null}

    </div>
  );
}
