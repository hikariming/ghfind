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
    <article className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
      {card.coverUrl ? (
        <img src={card.coverUrl} alt="" className="aspect-[5/4] w-full object-cover" />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <a
            href={card.canonicalUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={card.repoKey}
            className="min-w-0 text-base font-semibold leading-6 text-foreground hover:underline"
          >
            <span className="block truncate text-sm font-medium text-muted-foreground">{card.ownerLogin}</span>
            <span className="line-clamp-2">{card.name}</span>
          </a>
          <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-sm font-semibold tabular-nums text-foreground">
            {card.productScore}
            <span className="ms-1 text-[11px] font-medium text-muted-foreground">{labels.productScore}</span>
          </span>
        </div>
        <p title={card.summary} className="line-clamp-3 text-sm leading-6 text-foreground/90">
          {card.hook}
        </p>
        {card.audience && (
          <p className="line-clamp-1 text-xs text-muted-foreground">{labels.audience}: {card.audience}</p>
        )}
        {card.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {card.tags.slice(0, 4).map((tag) => (
              <Badge key={tag.id} title={tag.label} className="max-w-full truncate text-xs">
                {tag.label}
              </Badge>
            ))}
            {card.tags.length > 4 && <Badge>+{card.tags.length - 4}</Badge>}
          </div>
        )}
        {report && (
          <Link href={report} className="mt-auto text-sm font-semibold text-orange-300 hover:underline">
            {labels.viewCard} →
          </Link>
        )}
      </div>
    </article>
  );
}
