"use client";

import { useEffect, useRef } from "react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { Heart, RotateCcw, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiscoverCardView } from "./DiscoverCard";
import { DiscoverPreview } from "./DiscoverPreview";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { commandFromKey } from "@/lib/discover/keyboard";
import type { DiscoverAction, DiscoverCard } from "@/lib/discover/types";

const COMMIT_X = 120;
const COMMIT_Y = 120;
const FLY = 600;

export function DiscoverSwipe({
  card,
  labels,
  onAct,
  onUndo,
  canUndo,
  previewOpen,
  onPreviewOpenChange,
}: {
  card: DiscoverCard | undefined;
  labels: {
    productScore: string;
    viewCard: string;
    like: string;
    skip: string;
    superLike: string;
    undo: string;
    keyboard: string;
    hint: string;
    quickPreview: string;
    confidence: string;
    communityStrength: string;
    language: string;
    openFull: string;
  };
  onAct: (action: DiscoverAction, visibleMs: number) => void;
  onUndo: () => void;
  canUndo: boolean;
  previewOpen?: boolean;
  onPreviewOpenChange?: (open: boolean) => void;
}) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-300, 300], [-14, 14]);
  const shownAt = useRef(0);

  useEffect(() => {
    x.set(0);
    y.set(0);
    shownAt.current = Date.now();
  }, [card?.repoKey, x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const command = commandFromKey(event.key);
      if (!command) return;
      event.preventDefault();
      if (command === "undo") onUndo();
      else onAct(command, Date.now() - shownAt.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAct, onUndo]);

  const fly = async (action: DiscoverAction) => {
    const toX = action === "skip" ? -FLY : action === "like" ? FLY : 0;
    const toY = action === "superlike" ? -FLY : 0;
    await animate(x, toX, { duration: 0.3 });
    await animate(y, toY, { duration: 0.3 });
    onAct(action, Date.now() - shownAt.current);
  };

  const preview = <DiscoverPreview card={card} labels={labels} />;
  const deck = (
    <div className="mx-auto w-full max-w-[380px]">
      <div className="relative">
        {card ? (
          <motion.div
            className="relative"
            style={{ x, y, rotate, touchAction: "none" }}
            drag
            dragElastic={0.9}
            onDragEnd={(_, info) => {
              const dx = info.offset.x;
              const dy = info.offset.y;
              const vx = info.velocity.x;
              if (Math.abs(dy) > Math.abs(dx) && dy < -COMMIT_Y) void fly("superlike");
              else if (dx > COMMIT_X || vx > 700) void fly("like");
              else if (dx < -COMMIT_X || vx < -700) void fly("skip");
              else {
                void animate(x, 0, { type: "spring", stiffness: 400, damping: 30 });
                void animate(y, 0, { type: "spring", stiffness: 400, damping: 30 });
              }
            }}
          >
            <DiscoverCardView card={card} labels={labels} compact={false} />
          </motion.div>
        ) : (
          <div className="rounded-2xl border border-dashed border-white/10 p-8 text-sm text-muted-foreground" />
        )}
      </div>
      <div className="mt-4 flex items-center justify-center gap-3.5">
        <Button type="button" size="icon" variant="outline" className="size-11" onClick={onUndo} disabled={!canUndo} aria-label={labels.undo}>
          <RotateCcw className="size-4" />
        </Button>
        <Button type="button" size="icon" variant="outline" className="size-16" onClick={() => void fly("skip")} aria-label={labels.skip}>
          <X className="size-6" />
        </Button>
        <Button type="button" size="icon" variant="secondary" className="size-14" onClick={() => void fly("superlike")} aria-label={labels.superLike}>
          <Star className="size-5" />
        </Button>
        <Button type="button" size="icon" className="size-16 bg-rose-500 text-white hover:bg-rose-500/90" onClick={() => void fly("like")} aria-label={labels.like}>
          <Heart className="size-6 fill-current" />
        </Button>
      </div>
      <p className="mt-3 text-center text-xs text-muted-foreground">{labels.hint}</p>
      <p className="mt-1 text-center text-[11px] text-muted-foreground">{labels.keyboard}</p>
      <Button type="button" variant="ghost" size="sm" className="mt-2 w-full lg:hidden" onClick={() => onPreviewOpenChange?.(true)}>
        {labels.quickPreview}
      </Button>
    </div>
  );

  return (
    <>
      <div className="hidden h-[min(70vh,36rem)] lg:block">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="48%" minSize="40%">{deck}</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="52%" minSize="32%">{preview}</ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <div className="lg:hidden">{deck}</div>
      <Sheet open={previewOpen} onOpenChange={onPreviewOpenChange}>
        <SheetContent side="bottom" className="h-[80vh] lg:hidden">
          <SheetTitle className="sr-only">{labels.quickPreview}</SheetTitle>
          {preview}
        </SheetContent>
      </Sheet>
    </>
  );
}
