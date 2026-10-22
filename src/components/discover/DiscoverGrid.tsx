"use client";

import { useEffect, useRef } from "react";
import { DiscoverCardView } from "./DiscoverCard";
import { Skeleton } from "@/components/ui/skeleton";
import type { DiscoverCard as DiscoverCardModel } from "@/lib/discover/types";

export function DiscoverGrid({
  items,
  loading,
  onLoadMore,
  labels,
}: {
  items: DiscoverCardModel[];
  loading: boolean;
  onLoadMore: () => void;
  labels: { productScore: string; viewCard: string };
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const armed = useRef(true);
  useEffect(() => {
    armed.current = true;
  }, [items.length]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || loading) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (!visible) {
        armed.current = true;
        return;
      }
      if (!armed.current) return;
      armed.current = false;
      onLoadMore();
    }, { rootMargin: "400px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [items.length, loading, onLoadMore]);

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
      {items.map((card) => (
        <DiscoverCardView key={card.repoKey} card={card} labels={labels} />
      ))}
      {loading && Array.from({ length: 4 }).map((_, i) => (
        <div key={`sk-${i}`} className="overflow-hidden rounded-2xl border border-white/10">
          <Skeleton className="aspect-[16/10] w-full rounded-none" />
          <div className="space-y-2 p-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-full" />
          </div>
        </div>
      ))}
      <div ref={sentinel} className="col-span-full h-1" />
    </div>
  );
}
