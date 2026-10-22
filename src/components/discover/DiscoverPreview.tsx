"use client";

import { Link } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { coverMonogram, coverStyle } from "@/lib/discover/cover";
import { reportHref } from "@/lib/discover/events";
import type { DiscoverCard } from "@/lib/discover/types";

export function DiscoverPreview({
  card,
  labels,
}: {
  card: DiscoverCard | undefined;
  labels: {
    quickPreview: string;
    productScore: string;
    confidence: string;
    communityStrength: string;
    language: string;
    openFull: string;
    viewCard: string;
  };
}) {
  if (!card) {
    return <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 text-sm text-muted-foreground" />;
  }
  const report = reportHref(card);
  return (
    <section className="flex h-full min-h-0 flex-col rounded-2xl border border-border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{labels.quickPreview}</p>
      <h2 className="mt-1 truncate text-xl font-bold tracking-tight">
        {card.ownerLogin}/{card.name}
      </h2>
      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{card.summary}</p>
      <div className="mt-3 flex gap-2">
        <div className="size-16 overflow-hidden rounded-lg" style={coverStyle(card.repoKey)}>
          <span className="flex size-full items-center justify-center text-sm font-bold text-white/80">{coverMonogram(card.name)}</span>
        </div>
      </div>
      <ScrollArea className="mt-4 min-h-0 flex-1">
        <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">{labels.productScore}</dt>
          <dd className="tabular-nums font-semibold text-orange-300">{card.productScore}</dd>
          <dt className="text-muted-foreground">{labels.confidence}</dt>
          <dd className="tabular-nums">{card.confidence}%</dd>
          {card.communityStrength != null && (
            <>
              <dt className="text-muted-foreground">{labels.communityStrength}</dt>
              <dd className="tabular-nums">{card.communityStrength}/100</dd>
            </>
          )}
          {card.language && (
            <>
              <dt className="text-muted-foreground">{labels.language}</dt>
              <dd>{card.language}</dd>
            </>
          )}
        </dl>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full" style={{ width: `${Math.max(4, Math.min(100, card.productScore))}%`, background: "var(--link)" }} />
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {card.tags.map((tag) => (
            <Badge key={tag.id}>{tag.label}</Badge>
          ))}
        </div>
      </ScrollArea>
      {report ? (
        <Button asChild className="mt-4 h-10 w-full rounded-full text-sm">
          <Link href={report}>{labels.openFull}</Link>
        </Button>
      ) : (
        <Button asChild variant="outline" className="mt-4 h-10 w-full rounded-full text-sm">
          <a href={card.canonicalUrl} target="_blank" rel="noopener noreferrer">{labels.viewCard}</a>
        </Button>
      )}
    </section>
  );
}
