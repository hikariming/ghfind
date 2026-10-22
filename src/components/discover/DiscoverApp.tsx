"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Compass, LayoutGrid, SlidersHorizontal } from "lucide-react";
import { fetchMe } from "@/lib/me-client";
import { useDiscoverStore } from "@/lib/discover/store";
import type { DiscoverAction, DiscoverCard, DiscoverMode } from "@/lib/discover/types";
import type { ProjectBoard } from "@/lib/project-analysis-db";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DiscoverGrid } from "./DiscoverGrid";
import { DiscoverSwipe } from "./DiscoverSwipe";

export function DiscoverApp({
  locale,
  initialCards,
  initialBoard = "treasure",
  initialOffset,
}: {
  locale: string;
  initialCards: DiscoverCard[];
  initialBoard?: ProjectBoard;
  initialOffset?: number | null;
}) {
  const t = useTranslations("discover");
  const search = useSearchParams();
  const requested: DiscoverMode = search.get("mode") === "swipe" ? "swipe" : "grid";
  const initialMode = useRef<DiscoverMode>(requested);
  const [previewOpen, setPreviewOpen] = useState(false);
  const mode = useDiscoverStore((state) => state.mode);
  const items = useDiscoverStore((state) => state.items);
  const banner = useDiscoverStore((state) => state.banner);
  const loading = useDiscoverStore((state) => state.loading);
  const card = useDiscoverStore((state) => state.items[state.index]);
  const canUndo = useDiscoverStore((state) => state.history.length > 0);
  const setModeStore = useDiscoverStore((state) => state.setMode);
  const loadMore = useDiscoverStore((state) => state.loadMore);
  const act = useDiscoverStore((state) => state.act);
  const undo = useDiscoverStore((state) => state.undo);
  const initialKey = initialCards.map((item) => item.repoKey).join("|");
  const initialCardsRef = useRef(initialCards);
  useEffect(() => {
    initialCardsRef.current = initialCards;
  }, [initialCards]);

  useEffect(() => {
    let alive = true;
    fetchMe().then((me) => {
      if (!alive) return;
      void useDiscoverStore.getState().hydrate({
        locale,
        githubLogin: me.user?.login ?? null,
        initial: initialCardsRef.current,
        mode: initialMode.current,
        board: initialBoard,
        nextOffset: initialOffset,
      });
    });
    return () => { alive = false; };
  }, [initialBoard, initialKey, initialOffset, locale]);

  const setMode = useCallback((next: DiscoverMode) => {
    setModeStore(next);
    const url = new URL(window.location.href);
    if (next === "swipe") url.searchParams.set("mode", "swipe");
    else url.searchParams.delete("mode");
    window.history.replaceState(null, "", url.pathname + url.search);
  }, [setModeStore]);

  const onAct = useCallback((action: DiscoverAction, visibleMs?: number) => act(action, visibleMs), [act]);
  const onUndo = useCallback(() => { void undo(); }, [undo]);

  const labels = {
    productScore: t("productScore"),
    viewCard: t("viewCard"),
    like: t("like"),
    skip: t("skip"),
    superLike: t("superLike"),
    undo: t("undo"),
    keyboard: t("keyboard"),
    hint: t("hint"),
    quickPreview: t("quickPreview"),
    confidence: t("confidence"),
    communityStrength: t("communityStrength"),
    language: t("language"),
    openFull: t("openFull"),
  };

  return (
    <TooltipProvider>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-8 sm:px-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Compass className="size-4" aria-hidden />
              {t("title")}
              <Badge>{t("beta")}</Badge>
            </p>
            <h1 className="mt-1 text-2xl font-black tracking-tight sm:text-3xl">{t("heading")}</h1>
          </div>
          <div className="flex items-center gap-2">
            <ToggleGroup type="single" value={mode} onValueChange={(value) => { if (value === "grid" || value === "swipe") setMode(value); }}>
              <ToggleGroupItem value="grid" aria-label={t("modeGrid")}><LayoutGrid className="size-3.5" />{t("modeGrid")}</ToggleGroupItem>
              <ToggleGroupItem value="swipe" aria-label={t("modeSwipe")}>{t("modeSwipe")}</ToggleGroupItem>
            </ToggleGroup>
            <Sheet>
              <SheetTrigger asChild>
                <Button type="button" variant="outline" size="sm"><SlidersHorizontal className="size-3.5" />{t("filters")}</Button>
              </SheetTrigger>
              <SheetContent side="right" className="sm:max-w-sm">
                <SheetTitle>{t("filters")}</SheetTitle>
                <p className="mt-3 text-sm text-muted-foreground">{t("filtersBody")}</p>
              </SheetContent>
            </Sheet>
          </div>
        </header>
        {banner === "signed_out" && (
          <p className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-muted-foreground">{t("signedOutBanner")}</p>
        )}
        {banner === "feed_unavailable" && (
          <p className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-muted-foreground">{t("feedUnavailable")}</p>
        )}
        {mode === "grid" ? (
          <DiscoverGrid items={items} loading={loading} onLoadMore={loadMore} labels={labels} />
        ) : (
          <DiscoverSwipe
            card={card}
            labels={labels}
            onAct={onAct}
            onUndo={onUndo}
            canUndo={canUndo}
            previewOpen={previewOpen}
            onPreviewOpenChange={setPreviewOpen}
          />
        )}
        {items.length === 0 && !loading && (
          <p className="py-12 text-center text-sm text-muted-foreground">{t("empty")}</p>
        )}
      </main>
    </TooltipProvider>
  );
}
