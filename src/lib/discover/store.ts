import { create } from "zustand";
import { fetchFeedPage, fetchPublicPage, DiscoverClientError, commitFeedWrites } from "./client";
import { dedupeCards } from "./map";
import { mapSwipeAction, mapUndo } from "./events";
import type { ProjectBoard } from "@/lib/project-analysis-db";
import type { DiscoverAction, DiscoverBanner, DiscoverCard, DiscoverHistoryEntry, DiscoverMode, DiscoverSource } from "./types";

const PUBLIC_BOARDS: ProjectBoard[] = ["treasure", "classic", "all"];

export type DiscoverStore = {
  mode: DiscoverMode;
  items: DiscoverCard[];
  cursor: string | null;
  offset: number | null;
  source: DiscoverSource;
  banner: DiscoverBanner;
  loading: boolean;
  exhausted: boolean;
  index: number;
  history: DiscoverHistoryEntry[];
  locale: string;
  githubLogin: string | null;
  publicBoard: ProjectBoard;
  hydrate: (input: { locale: string; githubLogin: string | null; initial: DiscoverCard[]; mode?: DiscoverMode; board?: ProjectBoard }) => Promise<void>;
  setMode: (mode: DiscoverMode) => void;
  loadMore: () => Promise<void>;
  act: (action: DiscoverAction, visibleMs?: number) => Promise<void>;
  undo: () => Promise<void>;
};

async function loadPersonalized(locale: string) {
  try {
    const page = await fetchFeedPage({ locale, limit: 20 });
    return { page, banner: null as DiscoverBanner };
  } catch (error) {
    if (error instanceof DiscoverClientError && (error.status === 401 || error.code === "authentication_required")) {
      const page = await fetchPublicPage({ locale, limit: 20, offset: 0 });
      return { page, banner: "signed_out" as DiscoverBanner };
    }
    if (error instanceof DiscoverClientError && error.status === 429) throw error;
    const page = await fetchPublicPage({ locale, limit: 20, offset: 0 });
    return { page, banner: "feed_unavailable" as DiscoverBanner };
  }
}

export const useDiscoverStore = create<DiscoverStore>((set, get) => ({
  mode: "grid",
  items: [],
  cursor: null,
  offset: 0,
  source: "public",
  banner: "signed_out",
  loading: false,
  exhausted: false,
  index: 0,
  history: [],
  locale: "zh",
  githubLogin: null,
  publicBoard: "treasure",
  async hydrate({ locale, githubLogin, initial, mode, board }) {
    set({
      locale,
      githubLogin,
      mode: mode ?? "grid",
      items: initial,
      loading: true,
      banner: githubLogin ? null : "signed_out",
      source: "public",
      cursor: null,
      offset: initial.length,
      publicBoard: board ?? "treasure",
      index: 0,
      history: [],
      exhausted: initial.length === 0,
    });
    if (!githubLogin) {
      set({ loading: false, exhausted: initial.length === 0 });
      return;
    }
    try {
      const { page, banner } = await loadPersonalized(locale);
      const useFeed = page.source === "feed" && page.items.length > 0;
      set({
        items: useFeed ? page.items : initial,
        cursor: useFeed ? page.nextCursor : null,
        offset: useFeed ? null : initial.length,
        source: useFeed ? "feed" : "public",
        banner,
        loading: false,
        exhausted: useFeed ? page.nextCursor == null : initial.length === 0,
      });
    } catch {
      set({ loading: false, banner: "feed_unavailable" });
    }
  },
  setMode(mode) {
    set({ mode });
  },
  async loadMore() {
    const state = get();
    if (state.loading || state.exhausted) return;
    set({ loading: true });
    try {
      if (state.source === "feed") {
        try {
          const page = await fetchFeedPage({ locale: state.locale, limit: 20, cursor: state.cursor });
          set({
            items: dedupeCards(state.items, page.items),
            cursor: page.nextCursor,
            loading: false,
            exhausted: page.nextCursor == null,
          });
        } catch (error) {
          if (error instanceof DiscoverClientError && (error.code === "feed_cursor_expired" || error.code === "invalid_cursor")) {
            const page = await fetchFeedPage({ locale: state.locale, limit: 20 });
            set({
              items: dedupeCards(state.items, page.items),
              cursor: page.nextCursor,
              loading: false,
              exhausted: page.nextCursor == null,
            });
            return;
          }
          throw error;
        }
      } else {
        const page = await fetchPublicPage({
          locale: state.locale,
          limit: 20,
          offset: state.offset ?? 0,
          board: state.publicBoard,
        });
        const boardIndex = PUBLIC_BOARDS.indexOf(state.publicBoard);
        const nextBoard = page.nextOffset == null && boardIndex >= 0 && boardIndex < PUBLIC_BOARDS.length - 1
          ? PUBLIC_BOARDS[boardIndex + 1]
          : state.publicBoard;
        set({
          items: dedupeCards(state.items, page.items),
          offset: page.nextOffset ?? 0,
          publicBoard: nextBoard,
          loading: false,
          exhausted: page.nextOffset == null && nextBoard === state.publicBoard,
        });
      }
    } catch {
      set({ loading: false });
    }
  },
  async act(action, visibleMs = 0) {
    const state = get();
    const card = state.items[state.index];
    if (!card) return;
    const writes = mapSwipeAction(card, action, crypto.randomUUID(), visibleMs);
    if (writes.length > 0) {
      try {
        await commitFeedWrites(writes);
      } catch {
        return;
      }
    }
    const saved = writes.some((write) => write.kind === "state");
    set({
      items: state.items.filter((_, i) => i !== state.index),
      history: [...state.history, { card, action }],
      index: 0,
      cursor: saved ? null : state.cursor,
    });
    const next = get();
    if (next.items.length < 5) void next.loadMore();
  },
  async undo() {
    const state = get();
    const last = state.history.at(-1);
    if (!last) return;
    const writes = mapUndo(last.card, last.action);
    if (writes.length > 0) {
      try {
        await commitFeedWrites(writes);
      } catch {
        return;
      }
    }
    set({
      items: [last.card, ...state.items.filter((card) => card.repoKey !== last.card.repoKey)],
      history: state.history.slice(0, -1),
      index: 0,
      cursor: writes.some((write) => write.kind === "state") ? null : state.cursor,
    });
  },
}));
