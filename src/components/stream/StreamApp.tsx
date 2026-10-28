"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Users, Compass, Flame, House, LayoutGrid, LayoutList, RefreshCw, Trophy } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Link } from "@/i18n/navigation";
import { rankStream } from "@/lib/stream/rank";
import { useStreamStore } from "@/lib/stream/store";
import type { StreamAffinity, StreamItem, StreamProjectPick, StreamLayout, StreamVoice } from "@/lib/stream/types";
import { cn } from "@/lib/utils";
import { StreamListCard, StreamMasonryCard, type StreamCardHandlers } from "./StreamCard";
import { FollowButton, StreamDetail } from "./StreamDetail";
import { StreamRail } from "./StreamRail";

type Tab = "foryou" | "following";
type Toast = { id: number; message: string; action?: { label: string; run: () => void } };

const PAGE = 10;
/** Likes + hides since the last ranking before we offer a re-rank. */
const RETUNE_AFTER = 3;
const ITEM_PARAM = "item";

/** Rank inputs frozen at the last refresh, so the list never reorders under the reader. */
type Snapshot = { affinity: StreamAffinity; seen: ReadonlySet<string>; seed: number; signals: number; version: number };

function signalCount(state: { liked: object; hidden: string[] }): number {
  return Object.keys(state.liked).length + state.hidden.length;
}

function takeSnapshot(previous: Snapshot): Snapshot {
  const state = useStreamStore.getState();
  return {
    affinity: state.affinity,
    seen: new Set(Object.keys(state.viewed)),
    seed: state.seed,
    signals: signalCount(state),
    version: previous.version + 1,
  };
}

/** Rough tile height in column widths, used to balance masonry columns. */
function estimateHeight(item: StreamItem): number {
  const visual = item.coverUrl ? 0.52 : item.kind === "article" || item.kind === "collection" ? 1.33 : item.kind === "job" ? 0.75 : 1;
  return visual + 0.45;
}

function useColumnCount(ref: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(2);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setColumns((entry?.contentRect.width ?? 0) >= 560 ? 3 : 2));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return columns;
}

function distribute(items: StreamItem[], columns: number): StreamItem[][] {
  const out: StreamItem[][] = Array.from({ length: columns }, () => []);
  const heights = new Array<number>(columns).fill(0);
  for (const item of items) {
    const shortest = heights.indexOf(Math.min(...heights));
    out[shortest].push(item);
    heights[shortest] += estimateHeight(item);
  }
  return out;
}

export function StreamApp({ items, projects, voices, generatedAt, demoX = false }: { items: StreamItem[]; projects: StreamProjectPick[]; voices: StreamVoice[]; generatedAt: number; demoX?: boolean }) {
  const t = useTranslations("stream");
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState<Tab>("foryou");
  const [snapshot, setSnapshot] = useState<Snapshot>({ affinity: { kinds: {}, tags: {} }, seen: new Set(), seed: 0, signals: 0, version: 0 });
  // Page size grows per view; switching tab or re-ranking starts over.
  const [paging, setPaging] = useState({ key: "", count: PAGE });
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [showTop, setShowTop] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const columns = useColumnCount(feedRef);

  const hidden = useStreamStore((state) => state.hidden);
  const following = useStreamStore((state) => state.following);
  const storedLayout = useStreamStore((state) => state.layout);
  const signals = useStreamStore(signalCount);
  const setLayout = useStreamStore((state) => state.setLayout);
  const layout: StreamLayout = storedLayout ?? "list";

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  // Persisted viewer state loads after the first paint so SSR markup matches.
  useEffect(() => {
    void Promise.resolve(useStreamStore.persist.rehydrate()).then(() => {
      setSnapshot(takeSnapshot);
      setHydrated(true);
      const state = useStreamStore.getState();
      if (!state.layout && window.matchMedia("(max-width: 639px)").matches) state.setLayout("masonry");
    });
  }, []);

  // ?item=<id> deep links into the detail view; Back closes it.
  useEffect(() => {
    const sync = () => setOpenId(new URLSearchParams(window.location.search).get(ITEM_PARAM));
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 1200);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const ranked = useMemo(
    () =>
      rankStream(items, {
        affinity: snapshot.affinity,
        hidden: new Set(),
        seen: snapshot.seen,
        now: generatedAt,
        seed: String(snapshot.seed),
      }),
    [items, snapshot, generatedAt],
  );

  const visible = useMemo(() => {
    const hiddenSet = new Set(hidden);
    let list = ranked.filter((item) => !hiddenSet.has(item.id));
    if (tab === "following") list = list.filter((item) => following[item.author.id]);
    return list;
  }, [ranked, hidden, tab, following]);

  const viewKey = `${tab}|${snapshot.version}`;
  const limit = paging.key === viewKey ? paging.count : PAGE;
  const page = visible.slice(0, limit);
  const hasMore = limit < visible.length;

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setPaging((value) => ({ key: viewKey, count: (value.key === viewKey ? value.count : PAGE) + PAGE }));
    }, { rootMargin: "800px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, page.length, viewKey]);

  const notify = useCallback((message: string, action?: Toast["action"]) => {
    const id = Date.now();
    setToast({ id, message, action });
    window.setTimeout(() => setToast((current) => (current?.id === id ? null : current)), 3500);
  }, []);

  const refresh = useCallback(() => {
    useStreamStore.getState().refresh();
    setSnapshot(takeSnapshot);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const absoluteUrl = (item: StreamItem) => new URL(item.href, window.location.origin).href;

  const handlers: StreamCardHandlers = useMemo(() => ({
    onOpen: (item) => {
      const state = useStreamStore.getState();
      state.markViewed(item);
      state.signal(item, "open");
      const url = new URL(window.location.href);
      const wasOpen = url.searchParams.has(ITEM_PARAM);
      url.searchParams.set(ITEM_PARAM, item.id);
      if (wasOpen) window.history.replaceState(window.history.state, "", url);
      else window.history.pushState({ streamItem: true }, "", url);
      setOpenId(item.id);
    },
    onShare: (item) => {
      const url = absoluteUrl(item);
      if (navigator.share) {
        void navigator.share({ title: item.title, url }).catch(() => {});
        return;
      }
      void navigator.clipboard?.writeText(url).then(() => notify(t("linkCopied")));
    },
    onCopyLink: (item) => {
      void navigator.clipboard?.writeText(absoluteUrl(item)).then(() => notify(t("linkCopied")));
    },
    onHide: (item) => {
      useStreamStore.getState().hide(item);
      notify(t("hidden"), { label: t("undo"), run: () => useStreamStore.getState().unhide(item.id) });
    },
  }), [notify, t]);

  const closeDetail = useCallback(() => {
    if ((window.history.state as { streamItem?: boolean } | null)?.streamItem) {
      window.history.back();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete(ITEM_PARAM);
    window.history.replaceState(null, "", url);
    setOpenId(null);
  }, []);

  const onFollowed = useCallback((name: string) => notify(t("followedToast", { name })), [notify, t]);

  const openItem = openId ? byId.get(openId) ?? null : null;
  const retune = hydrated && tab === "foryou" && Math.abs(signals - snapshot.signals) >= RETUNE_AFTER;

  const suggestions = useMemo(
    () => [...new Map(items.map((item) => [item.author.id, item])).values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 5),
    [items],
  );

  const controls = (
    <div className="flex items-center gap-1">
      <ToggleGroup type="single" value={layout} onValueChange={(value) => { if (value === "list" || value === "masonry") setLayout(value); }}>
        <ToggleGroupItem value="list" aria-label={t("layoutList")} title={t("layoutList")}><LayoutList className="size-3.5" /></ToggleGroupItem>
        <ToggleGroupItem value="masonry" aria-label={t("layoutMasonry")} title={t("layoutMasonry")}><LayoutGrid className="size-3.5" /></ToggleGroupItem>
      </ToggleGroup>
      <Button type="button" variant="ghost" size="icon" aria-label={t("refresh")} title={t("refresh")} onClick={refresh} className="size-8">
        <RefreshCw className="size-3.5" />
      </Button>
    </div>
  );

  const tabs: { id: Tab; label: string }[] = [
    { id: "foryou", label: t("tabForYou") },
    { id: "following", label: t("tabFollowing") },
  ];

  return (
    <main className="stream-layout mx-auto flex w-full max-w-6xl flex-1 justify-center gap-6 pb-24 min-[900px]:px-4 min-[900px]:pb-10">
      <div className="stream-timeline w-full min-w-0 max-w-[680px] border-border min-[900px]:border-x">
        {/* Sticky header: tabs and layout switch. Sits under the 57px mobile bar below 900px;
            on phones the title row folds away and the controls ride along the tab row. */}
        <div className="sticky top-[57px] z-30 border-b border-border bg-background/90 backdrop-blur min-[900px]:top-0">
          <h1 className="sr-only">{t("heading")}</h1>
          <div className="hidden items-center justify-between gap-2 px-4 pt-2 sm:flex">
            <p aria-hidden className="flex items-center gap-2 text-lg font-black tracking-tight">
              {t("heading")}
              <span className="rounded bg-amber-400/20 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-300">{t("prototype")}</span>
            </p>
            {controls}
          </div>
          <div className="mt-0 flex items-center sm:mt-1">
            <div role="tablist" aria-label={t("channels")} className="flex flex-1">
              {tabs.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  onClick={() => setTab(entry.id)}
                  className={cn("relative flex-1 py-2.5 text-sm transition-colors hover:bg-white/[0.03]", tab === entry.id ? "font-bold text-foreground" : "text-muted-foreground")}
                >
                  {entry.label}
                  {tab === entry.id ? <motion.span layoutId="stream-tab" className="absolute inset-x-1/3 bottom-0 h-[3px] rounded-full bg-orange-400" /> : null}
                </button>
              ))}
            </div>
            <div className="pe-2 sm:hidden">{controls}</div>
          </div>
          <AnimatePresence>
            {retune ? (
              <motion.div initial={{ y: -12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -12, opacity: 0 }} className="pointer-events-none absolute inset-x-0 top-full flex justify-center">
                <button type="button" onClick={refresh} className="pointer-events-auto mt-2 inline-flex h-8 items-center gap-1.5 rounded-full bg-orange-500 px-3.5 text-xs font-semibold text-white shadow-lg hover:bg-orange-400">
                  <ArrowUp className="size-3.5" aria-hidden />
                  {t("retuned")}
                </button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {demoX ? <p className="border-b border-border bg-background px-4 py-2 text-xs text-muted-foreground">{t("demoX")}</p> : null}

        <div ref={feedRef}>
          {page.length === 0 ? (
            tab === "following" ? (
              <div className="px-4 py-8">
                <h2 className="text-base font-bold text-foreground">{t("followingEmptyTitle")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t("followingEmptyBody")}</p>
                <ul className="mt-4 flex flex-col divide-y divide-border rounded-xl border border-border">
                  {suggestions.map((item) => (
                    <li key={item.id} className="flex items-center gap-2 px-3 py-2">
                      <button type="button" onClick={() => handlers.onOpen(item)} className="min-w-0 flex-1 text-start">
                        <span className="block truncate text-sm font-semibold text-foreground">{item.author.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{item.summary}</span>
                      </button>
                      <FollowButton authorId={item.author.id} name={item.author.name} onFollowed={onFollowed} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="px-4 py-12 text-center text-sm text-muted-foreground">{t("feedEmpty")}</p>
            )
          ) : layout === "list" ? (
            <div key={viewKey}>
              {page.map((item) => (
                <StreamListCard key={item.id} item={item} now={generatedAt} handlers={handlers} />
              ))}
            </div>
          ) : (
            <div key={viewKey} className="flex gap-2 p-2 sm:gap-3 sm:p-3">
              {distribute(page, columns).map((column, index) => (
                <div key={index} className="flex min-w-0 flex-1 flex-col gap-2 sm:gap-3">
                  {column.map((item) => (
                    <StreamMasonryCard key={item.id} item={item} handlers={handlers} />
                  ))}
                </div>
              ))}
            </div>
          )}
          {hasMore ? (
            <div ref={sentinel} className="py-6 text-center text-xs text-muted-foreground">{t("loadingMore")}</div>
          ) : page.length > 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <p className="text-sm font-bold text-foreground">{t("endTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("endBody")}</p>
              <Button type="button" size="sm" shape="pill" onClick={refresh} className="mt-1">
                <RefreshCw className="size-3.5" />
                {t("refresh")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <aside className="stream-rail hidden w-80 shrink-0 xl:block">
        <div className="sticky top-4 pt-3">
          <StreamRail projects={projects} items={items} voices={voices} onOpen={handlers.onOpen} />
        </div>
      </aside>

      <StreamDetail item={openItem} pool={items} now={generatedAt} handlers={handlers} onClose={closeDetail} onFollowed={onFollowed} />

      <AnimatePresence>
        {showTop ? (
          <motion.button
            type="button"
            aria-label={t("backToTop")}
            title={t("backToTop")}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="fixed bottom-20 end-4 z-30 inline-flex size-10 items-center justify-center rounded-full border border-border bg-popover text-foreground shadow-lg min-[900px]:bottom-6"
          >
            <ArrowUp className="size-4" aria-hidden />
          </motion.button>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {toast ? (
          <motion.div
            key={toast.id}
            role="status"
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            className="fixed inset-x-0 bottom-20 z-[60] mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-3 rounded-full bg-foreground px-4 py-2 text-sm text-background shadow-lg min-[900px]:bottom-6"
          >
            <span>{toast.message}</span>
            {toast.action ? (
              <button type="button" onClick={() => { toast.action?.run(); setToast(null); }} className="font-semibold text-orange-300 hover:underline">
                {toast.action.label}
              </button>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Phone tab bar: the stream is home; score is the primary action. */}
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur min-[900px]:hidden">
        <button type="button" onClick={() => { setTab("foryou"); window.scrollTo({ top: 0, behavior: "smooth" }); }} className={cn("flex flex-col items-center gap-0.5 py-2 text-[10px]", tab === "foryou" ? "text-foreground" : "text-muted-foreground")}>
          <House className="size-5" aria-hidden />
          {t("navHome")}
        </button>
        <Link href="/discover" prefetch={false} className="flex flex-col items-center gap-0.5 py-2 text-[10px] text-muted-foreground">
          <Compass className="size-5" aria-hidden />
          {t("navDiscover")}
        </Link>
        <Link href="/" prefetch={false} aria-label={t("navScore")} className="flex items-center justify-center">
          <span className="inline-flex h-9 w-12 items-center justify-center rounded-xl bg-orange-500 text-white shadow">
            <Flame className="size-5" aria-hidden />
          </span>
        </Link>
        <Link href="/leaderboard" prefetch={false} className="flex flex-col items-center gap-0.5 py-2 text-[10px] text-muted-foreground">
          <Trophy className="size-5" aria-hidden />
          {t("navLeaderboard")}
        </Link>
        <button type="button" onClick={() => { setTab("following"); window.scrollTo({ top: 0 }); }} className={cn("flex flex-col items-center gap-0.5 py-2 text-[10px]", tab === "following" ? "text-foreground" : "text-muted-foreground")}>
          <Users className="size-5" aria-hidden />
          {t("tabFollowing")}
        </button>
      </nav>
    </main>
  );
}
