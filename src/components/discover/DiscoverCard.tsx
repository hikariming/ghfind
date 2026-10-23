"use client";

import { Link } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { reportHref } from "@/lib/discover/events";
import type { DiscoverCard as DiscoverCardModel } from "@/lib/discover/types";

export function DiscoverCardView({
  card,
  labels,
}: {
  card: DiscoverCardModel;
  labels: { productScore: string; viewCard: string; audience: string };
}) {
  const report = reportHref(card);
  return (
    <article className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      {card.coverUrl ? (
        <img src={card.coverUrl} alt="" className="aspect-[5/4] w-full object-cover" />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-4">
        <div className="flex items-start justify-between gap-2.5">
          <a
            href={card.canonicalUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={card.repoKey}
            className="min-w-0 hover:underline"
          >
            <span className="block truncate text-xs font-medium text-muted-foreground">{card.ownerLogin}</span>
            <span className="mt-0.5 block line-clamp-1 text-base font-semibold leading-snug text-foreground">{card.name}</span>
          </a>
          {card.discoverScore ? (
            <span
              title={`${card.discoverScore.version} · ${card.discoverScore.band} · try ${card.discoverScore.tryGate.strangerTryability} · product ${card.productScore}`}
              className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-sm font-semibold tabular-nums text-foreground"
            >
              {card.discoverScore.score}
              <span className="ms-1 text-[11px] font-medium text-muted-foreground">{card.discoverScore.band}</span>
            </span>
          ) : (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-sm font-semibold tabular-nums text-foreground">
              {card.productScore}
              <span className="ms-1 text-[11px] font-medium text-muted-foreground">{labels.productScore}</span>
            </span>
          )}
        </div>
        <p title={card.hook} className="line-clamp-2 text-sm leading-5 text-foreground/90">
          {card.hook}
        </p>
        {card.audience ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">{labels.audience}: {card.audience}</p>
        ) : null}
        <div className="mt-auto flex flex-col gap-2 pt-0.5">
          {card.tags.length > 0 ? (
            <div className="flex min-h-6 flex-wrap content-start gap-1">
              {card.tags.slice(0, 4).map((tag) => (
                <Badge key={tag.id} title={tag.label} className="max-w-[9.5rem] truncate text-xs">
                  {tag.label}
                </Badge>
              ))}
              {card.tags.length > 4 ? <Badge>+{card.tags.length - 4}</Badge> : null}
            </div>
          ) : null}
          {report ? (
            <Link href={report} className="text-sm font-semibold text-orange-300 hover:underline">
              {labels.viewCard} →
            </Link>
          ) : null}
        </div>
      </div>
    </article>
  );
}
