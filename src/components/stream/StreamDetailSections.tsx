"use client";

import type { ReactNode } from "react";
import { ArrowUpRight, Bot, ListOrdered, Star, Swords, TrendingDown, TrendingUp } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { barColor } from "@/lib/dimensions";
import type { StreamDeveloperDetail, StreamItemDetail } from "@/lib/stream/detail";
import type { StreamItem, StreamMeter } from "@/lib/stream/types";
import { cn } from "@/lib/utils";
import { KIND_STYLE, compactNumber, tierIconSrc } from "./format";
import { StreamAvatar } from "./StreamCard";

const REACTION_EMOJI = { like: "👍", fire: "🔥", salute: "🫡", clown: "🤡", kick: "🦶", poop: "💩" } as const;

export function Section({ title, icon, action, children, className }: { title: string; icon?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("mt-4", className)}>
      <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-foreground">
        {icon}
        {title}
        {action ? <span className="ms-auto text-xs font-normal">{action}</span> : null}
      </h4>
      {children}
    </section>
  );
}

function Meters({ meters, label }: { meters: StreamMeter[]; label: (key: string) => string }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
      {meters.map((meter) => {
        const ratio = meter.max > 0 ? Math.min(1, meter.value / meter.max) : 0;
        return (
          <div key={meter.key}>
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted-foreground">{label(meter.key)}</span>
              <span className="tabular-nums text-foreground">{meter.value}<span className="text-muted-foreground">/{meter.max}</span></span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full", barColor(ratio))} style={{ width: `${Math.max(4, ratio * 100)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="mt-4 space-y-2" aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="h-4 animate-pulse rounded bg-muted" style={{ width: `${90 - index * 15}%` }} />
      ))}
    </div>
  );
}

function DeveloperSections({ item, body, onOpenUser }: { item: StreamItem; body: StreamDeveloperDetail; onOpenUser: (username: string) => void }) {
  const t = useTranslations("stream");
  const dims = useTranslations("dimensions");
  const locale = useLocale();
  const reactions = (Object.entries(body.reactions) as [keyof typeof REACTION_EMOJI, number][]).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  return (
    <>
      {body.roast ? (
        <figure className="mt-4 rounded-xl border border-orange-500/30 bg-orange-500/10 px-3 py-2.5">
          <figcaption className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-orange-300">
            <Bot className="size-3.5" aria-hidden />
            {t("aiRoast")}
            <span className="font-normal text-muted-foreground">· {t("aiNote")}</span>
          </figcaption>
          <blockquote className="text-[15px] font-semibold leading-6 text-foreground">“{body.roast}”</blockquote>
        </figure>
      ) : null}

      {body.beat != null || body.delta != null ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {body.beat != null ? <span className="font-semibold text-foreground">{t("beat", { percent: Math.round(body.beat) })}</span> : null}
          {body.rank != null && body.total != null ? <span className="text-muted-foreground">{t("rankOf", { rank: compactNumber(body.rank, locale), total: compactNumber(body.total, locale) })}</span> : null}
          {body.delta != null && body.delta !== 0 ? (
            <span className={cn("inline-flex items-center gap-0.5 font-semibold", body.delta > 0 ? "text-emerald-300" : "text-rose-400")}>
              {body.delta > 0 ? <TrendingUp className="size-3.5" aria-hidden /> : <TrendingDown className="size-3.5" aria-hidden />}
              {t("weekDelta", { delta: `${body.delta > 0 ? "+" : ""}${Math.round(body.delta)}` })}
            </span>
          ) : null}
        </div>
      ) : null}

      <Section title={t("dimsTitle")}>
        <Meters meters={body.meters} label={(key) => dims(key)} />
      </Section>

      {body.facts.length > 0 ? (
        <dl className="mt-3 grid grid-cols-3 gap-1.5 sm:grid-cols-5">
          {body.facts.map((fact) => (
            <div key={fact.key} className="rounded-lg border border-border bg-white/[0.02] px-2 py-1.5">
              <dt className="truncate text-[11px] text-muted-foreground">{t(`facts.${fact.key}`)}</dt>
              <dd className="text-sm font-semibold tabular-nums text-foreground">{compactNumber(fact.value, locale)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {body.bio ? <p className="mt-3 text-sm leading-6 text-foreground/80">{body.bio}</p> : null}

      {body.topRepos.length > 0 ? (
        <Section title={t("topRepos")}>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {body.topRepos.map((repo) => (
              <li key={repo.name}>
                <a href={`https://github.com/${repo.name.includes("/") ? repo.name : `${item.author.id}/${repo.name}`}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 hover:bg-white/[0.02]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[13px] font-semibold text-foreground">{repo.name}</span>
                    {repo.description ? <span className="block truncate text-xs text-muted-foreground">{repo.description}</span> : null}
                  </span>
                  {repo.language ? <span className="shrink-0 text-[11px] text-muted-foreground">{repo.language}</span> : null}
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-muted-foreground"><Star className="size-3" aria-hidden />{compactNumber(repo.stars, locale)}</span>
                </a>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {body.battles.length > 0 ? (
        <Section title={t("battles")} icon={<Swords className="size-4 text-muted-foreground" aria-hidden />}>
          <ul className="flex flex-col gap-1.5">
            {body.battles.map((battle) => (
              <li key={battle.opponent}>
                <a href={`${item.href.replace(/\/u\/[^/]+$/, "")}/vs/${item.author.id}/${battle.opponent}`} className="block rounded-xl border border-border px-3 py-2 hover:bg-white/[0.02]">
                  <span className="flex items-center gap-2 text-sm">
                    <span className={cn("inline-flex size-5 items-center justify-center rounded text-[11px] font-black", battle.won === true ? "bg-emerald-500/15 text-emerald-300" : battle.won === false ? "bg-rose-500/15 text-rose-400" : "bg-muted text-muted-foreground")}>
                      {battle.won === true ? t("battleWon") : battle.won === false ? t("battleLost") : t("battleDraw")}
                    </span>
                    <span className="font-semibold tabular-nums text-foreground">{battle.myScore} : {battle.theirScore}</span>
                    <span className="truncate text-muted-foreground"><bdi>@{battle.opponent}</bdi></span>
                    {battle.views > 0 ? <span className="ms-auto shrink-0 text-[11px] text-muted-foreground">{t("battleViews", { count: compactNumber(battle.views, locale) })}</span> : null}
                  </span>
                  {battle.verdict ? <span className="mt-1 line-clamp-2 block text-xs leading-5 text-foreground/80">{battle.verdict}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {reactions.length > 0 ? (
        <Section title={t("reactionsTitle")} action={<a href={item.href} className="text-muted-foreground hover:text-foreground">{t("reactionsCta")} →</a>}>
          <div className="flex flex-wrap gap-1.5">
            {reactions.map(([reaction, count]) => (
              <span key={reaction} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-sm">
                <span aria-hidden>{REACTION_EMOJI[reaction]}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      {body.similar.length > 0 ? (
        <Section title={t("similar")}>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {body.similar.map((dev) => (
              <button key={dev.username} type="button" onClick={() => onOpenUser(dev.username)} className="flex items-center gap-2 rounded-xl border border-border px-2 py-1.5 text-start hover:bg-white/[0.02]">
                <StreamAvatar src={dev.avatarUrl} name={dev.name} className="size-7 text-xs" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-foreground">{dev.name}</span>
                  <span className="flex items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground">
                    {dev.score}
                    {/* eslint-disable-next-line @next/next/no-img-element -- static tier artwork */}
                    <img src={tierIconSrc(dev.tier)} alt="" className="size-3" />
                  </span>
                </span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}
    </>
  );
}

/**
 * The kind-specific middle of the detail view. Embedded `extra` renders at
 * once; lazily loaded `detail.body` shows a skeleton until it arrives.
 */
export function StreamKindSections({
  item,
  detail,
  loading,
  onOpenUser,
}: {
  item: StreamItem;
  detail: StreamItemDetail | null;
  loading: boolean;
  onOpenUser: (username: string) => void;
}) {
  const t = useTranslations("stream");
  const locale = useLocale();
  const body = detail?.body ?? null;
  const extra = item.extra;
  const style = KIND_STYLE[item.kind];

  if (item.kind === "developer") {
    if (body?.kind === "developer") return <DeveloperSections item={item} body={body} onOpenUser={onOpenUser} />;
    return loading ? <Skeleton lines={5} /> : null;
  }

  if (extra?.kind === "project") {
    return (
      <>
        <Section title={t("projectScoreTitle")}>
          <Meters meters={extra.meters} label={(key) => t(`projectDims.${key}`)} />
        </Section>
        {extra.audience ? (
          <Section title={t("audience")}>
            <p className="text-sm leading-6 text-foreground/85">{extra.audience}</p>
          </Section>
        ) : null}
        {extra.risks.length > 0 ? (
          <Section title={t("risks")}>
            <ul className="list-disc space-y-1 ps-5 text-sm leading-6 text-foreground/80">
              {extra.risks.map((risk) => <li key={risk}>{risk}</li>)}
            </ul>
          </Section>
        ) : null}
      </>
    );
  }

  if (extra?.kind === "talent") {
    return (
      <>
        {extra.projects.length > 0 ? (
          <Section title={t("talentProjects")}>
            <ul className="flex flex-col gap-1.5">
              {extra.projects.map((project) => (
                <li key={project.name} className="rounded-xl border border-border px-3 py-2">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    {project.url ? <a href={project.url} target="_blank" rel="noopener noreferrer" className="truncate hover:underline">{project.name}</a> : <span className="truncate">{project.name}</span>}
                    <span className={cn("shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold", project.relationship === "own" ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground")}>
                      {project.relationship === "own" ? t("ownProject") : t("prProject")}
                    </span>
                  </p>
                  {project.description ? <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{project.description}</p> : null}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {extra.sources.length > 0 ? (
          <Section title={t("sources")}>
            <ul className="flex flex-col gap-1">
              {extra.sources.map((source) => (
                <li key={source.title} className="flex items-center gap-1.5 text-sm">
                  <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="truncate text-foreground hover:underline">{source.title}</a> : <span className="truncate text-foreground">{source.title}</span>}
                  <span className="shrink-0 text-xs text-muted-foreground">{source.publisher}</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </>
    );
  }

  if (item.kind === "article") {
    if (body?.kind !== "article") return loading ? <Skeleton lines={4} /> : null;
    return (
      <>
        {body.toc.length > 0 ? (
          <Section title={t("toc")} icon={<ListOrdered className="size-4 text-muted-foreground" aria-hidden />}>
            <ol className="space-y-1 border-s-2 border-border ps-3 text-sm">
              {body.toc.map((heading, index) => (
                <li key={heading} className="flex gap-2 text-foreground/85">
                  <span className={cn("w-4 shrink-0 font-semibold tabular-nums", style.text)}>{index + 1}</span>
                  <span className="line-clamp-1">{heading}</span>
                </li>
              ))}
            </ol>
          </Section>
        ) : null}
        {body.excerpt.length > 0 ? (
          <Section title={t("excerpt")}>
            <div className="relative space-y-2 text-sm leading-6 text-foreground/85">
              {body.excerpt.map((paragraph) => <p key={paragraph.slice(0, 40)}>{paragraph}</p>)}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
            </div>
            <a href={item.href} className={cn("mt-2 inline-flex items-center gap-1 text-sm font-semibold", style.text)}>{t("readFull")} →</a>
          </Section>
        ) : null}
      </>
    );
  }

  if (item.kind === "collection") {
    return (
      <>
        {body?.kind === "collection" && body.excerpt.length > 0 ? (
          <div className="mt-3 space-y-2 text-sm leading-6 text-foreground/85">
            {body.excerpt.map((paragraph) => <p key={paragraph.slice(0, 40)}>{paragraph}</p>)}
          </div>
        ) : loading ? <Skeleton lines={2} /> : null}
        {extra?.kind === "collection" && extra.picks.length > 0 ? (
          <Section title={t("picksTitle")} action={<span className="text-muted-foreground tabular-nums">{extra.picks.length}</span>}>
            <ol className="flex flex-col divide-y divide-border rounded-xl border border-border">
              {extra.picks.map((pick, index) => (
                <li key={pick.id}>
                  <a href={pick.href} target={pick.kind === "repo" ? "_blank" : undefined} rel={pick.kind === "repo" ? "noopener noreferrer" : undefined} className="flex items-start gap-2.5 px-3 py-2 hover:bg-white/[0.02]">
                    <span className={cn("mt-0.5 w-4 shrink-0 text-sm font-black tabular-nums", style.text)}>{index + 1}</span>
                    <StreamAvatar src={`https://github.com/${pick.id.split("/")[0]}.png?size=64`} name={pick.id} className="size-7 rounded-lg text-xs" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-[13px] font-semibold text-foreground">{pick.id}</span>
                        {pick.score != null ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{pick.score}</span> : null}
                        {/* eslint-disable-next-line @next/next/no-img-element -- static tier artwork */}
                        {pick.tier ? <img src={tierIconSrc(pick.tier)} alt="" className="size-3.5 shrink-0" /> : null}
                        {pick.stars ? <span className="ms-auto inline-flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground"><Star className="size-3" aria-hidden />{compactNumber(pick.stars, locale)}</span> : null}
                      </span>
                      {pick.blurb ? <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-muted-foreground">{pick.blurb}</span> : null}
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          </Section>
        ) : null}
      </>
    );
  }

  if (item.kind === "job") {
    if (body?.kind !== "job") return loading ? <Skeleton lines={4} /> : null;
    return (
      <Section title={t("jobDescription")} action={body.website ? <a href={body.website} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground">{t("companySite")} ↗</a> : null}>
        <div className="space-y-2 text-sm leading-6 text-foreground/85">
          {body.description.map((paragraph) => <p key={paragraph.slice(0, 40)}>{paragraph}</p>)}
        </div>
      </Section>
    );
  }

  return null;
}
