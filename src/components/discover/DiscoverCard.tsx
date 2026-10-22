"use client";

import { Link } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { coverMonogram, coverStyle } from "@/lib/discover/cover";
import { reportHref } from "@/lib/discover/events";
import type { DiscoverCard as DiscoverCardModel } from "@/lib/discover/types";

export function DiscoverCardView({
  card,
  labels,
  compact = true,
}: {
  card: DiscoverCardModel;
  labels: { productScore: string; viewCard: string };
  compact?: boolean;
}) {
  const report = reportHref(card);
  return (
    <article className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="relative aspect-[16/10] w-full" style={coverStyle(card.repoKey)}>
        <span className="absolute inset-0 flex items-center justify-center text-2xl font-black tracking-tight text-white/80">
          {coverMonogram(card.name)}
        </span>
        <span className="absolute right-2 top-2 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums text-white" style={{ background: "rgba(0,0,0,0.55)" }}>
          {card.productScore}
          <span className="ms-1 text-[10px] font-medium text-white/70">{labels.productScore}</span>
        </span>
      </div>
      <div className={`flex min-w-0 flex-1 flex-col ${compact ? "gap-1.5 p-3" : "gap-2 p-4"}`}>
        <a
          href={card.canonicalUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={card.repoKey}
          className="min-w-0 truncate text-sm text-foreground hover:underline"
        >
          <span className="text-muted-foreground">{card.ownerLogin}/</span>
          <strong className="font-semibold">{card.name}</strong>
        </a>
        <p title={card.summary} className="line-clamp-1 text-xs leading-4 text-muted-foreground">
          {card.summary}
        </p>
        {card.tags.length > 0 && (
          <div className="flex min-w-0 flex-nowrap gap-1">
            {card.tags.slice(0, 2).map((tag) => (
              <Badge key={tag.id} title={tag.label} className="min-w-0 truncate">
                {tag.label}
              </Badge>
            ))}
            {card.tags.length > 2 && <Badge>+{card.tags.length - 2}</Badge>}
          </div>
        )}
        {report && (
          <Link href={report} className="mt-1 text-xs font-semibold text-orange-300 hover:underline">
            {labels.viewCard} →
          </Link>
        )}
      </div>
    </article>
  );
}
