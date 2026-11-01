import { create } from "zustand";
import { fetchFeedPage, fetchInternalScorePage, fetchPublicPage, DiscoverClientError, commitFeedWrites } from "./client";
import { dedupeCards } from "./map";
import { mapSwipeAction, mapUndo } from "./events";
import type { ProjectBoard } from "@/lib/project-analysis-db";
import { filterCardsByPartition } from "./partition";
import type { DiscoverAction, DiscoverBanner, DiscoverCard, DiscoverHistoryEntry, DiscoverMode, DiscoverPage, DiscoverPartition, DiscoverSource } from "./types";

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
  partition: DiscoverPartition;
  /** False until hydrate runs; DiscoverApp falls back to initialCards for SSR. */
  ready: boolean;
  /** Internal discover-score-v1.1 ranking (allowlisted accounts only). */
  internalScore: boolean;
  hydrate: (input: {
    locale: string;
    githubLogin: string | null;
    initial: DiscoverCard[];
    mode?: DiscoverMode;
    board?: ProjectBoard;
    /** Offset into `board` only. Null means that board is exhausted. Omitted falls back to initial.length. */
    nextOffset?: number | null;
  }) => Promise<void>;
  /** Switch to the internal score ranking; no-op unless the server allows it. */
  enableInternalScore: () => Promise<boolean>;
  setMode: (mode: DiscoverMode) => void;
  setPartition: (partition: DiscoverPartition) => void;
  loadMore: () => Promise<void>;
  act: (action: DiscoverAction, visibleMs?: number) => Promise<boolean>;
  undo: () => Promise<void>;
};

function publicIsDone(board: ProjectBoard, nextOffset: number | null): boolean {
  return nextOffset == null && board === "all";
}

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
  partition: "all",
  ready: false,
  internalScore: false,
  async enableInternalScore() {
    let page: DiscoverPage | null = null;
    try {
      page = await fetchInternalScorePage(get().locale);
    } catch {
      page = null;
    }
    if (!page || page.items.length === 0) return false;
    set({
      items: page.items,
      cursor: null,
      offset: null,
      source: "public",
      publicBoard: "all",
      banner: null,
      loading: false,
      exhausted: true,
      index: 0,
      history: [],
      internalScore: true,
    });
    return true;
  },
  async hydrate({ locale, githubLogin, initial, mode, board, nextOffset }) {
    const boardName = board ?? "treasure";
    const offset = nextOffset === undefined ? initial.length : nextOffset;
    set({
      locale,
      githubLogin,
      mode: mode ?? "grid",
      items: initial,
      loading: true,
      ready: true,
      banner: githubLogin ? null : "signed_out",
      source: "public",
      cursor: null,
      offset,
      publicBoard: boardName,
      index: 0,
      history: [],
      exhausted: publicIsDone(boardName, offset),
    });
    if (!githubLogin) {
      set({ loading: false });
      return;
    }
    try {
      const { page, banner } = await loadPersonalized(locale);
      const useFeed = page.source === "feed" && page.items.length > 0;
      set({
        items: useFeed ? page.items : initial,
        cursor: useFeed ? page.nextCursor : null,
        offset: useFeed ? null : offset,
        source: useFeed ? "feed" : "public",
        publicBoard: boardName,
        banner,
        loading: false,
        exhausted: useFeed ? page.nextCursor == null : publicIsDone(boardName, offset),
      });
    } catch {
      set({ loading: false, banner: "feed_unavailable" });
    }
  },
  setMode(mode) {
    set({ mode });
  },
  setPartition(partition) {
    set({ partition, index: 0 });
  },
  async loadMore() {
    const state = get();
    if (state.loading || state.exhausted) return;
    set({ loading: true });
    try {
      if (state.source === "feed") {
        let rebuilt = false;
        let page: Awaited<ReturnType<typeof fetchFeedPage>>;
        try {
          page = await fetchFeedPage({ locale: state.locale, limit: 20, cursor: state.cursor });
        } catch (error) {
          if (error instanceof DiscoverClientError && (error.code === "feed_cursor_expired" || error.code === "invalid_cursor")) {
            rebuilt = true;
            page = await fetchFeedPage({ locale: state.locale, limit: 20 });
          } else {
            throw error;
          }
        }
        const startCursor = state.cursor;
        set((current) => {
          const seen = new Set(current.history.map((entry) => entry.card.repoKey));
          const staleStream = !rebuilt && startCursor != null && current.cursor == null;
          return {
            items: dedupeCards(current.items, page.items.filter((card) => !seen.has(card.repoKey))),
            cursor: staleStream ? null : page.nextCursor,
            loading: false,
            source: "feed",
            exhausted: staleStream ? false : page.nextCursor == null,
          };
        });
        return;
      }
      let board = state.publicBoard;
      let offset = state.offset ?? 0;
      if (state.offset == null) {
        const index = PUBLIC_BOARDS.indexOf(board);
        if (index < 0 || index >= PUBLIC_BOARDS.length - 1) {
          set({ loading: false, exhausted: true });
          return;
        }
        board = PUBLIC_BOARDS[index + 1];
        offset = 0;
      }
      const page = await fetchPublicPage({ locale: state.locale, limit: 20, offset, board });
      set((current) => {
        const seen = new Set(current.history.map((entry) => entry.card.repoKey));
        const boardIndex = PUBLIC_BOARDS.indexOf(board);
        const nextBoard = page.nextOffset == null && boardIndex >= 0 && boardIndex < PUBLIC_BOARDS.length - 1
          ? PUBLIC_BOARDS[boardIndex + 1]
          : board;
        return {
          items: dedupeCards(current.items, page.items.filter((card) => !seen.has(card.repoKey))),
          offset: page.nextOffset == null ? (nextBoard === board ? null : 0) : page.nextOffset,
          publicBoard: nextBoard,
          loading: false,
          exhausted: page.nextOffset == null && nextBoard === board,
        };
      });
    } catch {
      set({ loading: false });
    }
  },
  async act(action, visibleMs = 0) {
    const state = get();
    const visible = filterCardsByPartition(state.items, state.partition);
    const card = visible[state.index] ?? visible[0];
    if (!card) return false;
    const writes = mapSwipeAction(card, action, crypto.randomUUID(), visibleMs);
    if (writes.length > 0) {
      try {
        await commitFeedWrites(writes);
      } catch {
        return false;
      }
    }
    const saved = writes.some((write) => write.kind === "state");
    let removed = false;
    set((current) => {
      if (!current.items.some((item) => item.repoKey === card.repoKey)) return current;
      removed = true;
      return {
        items: current.items.filter((item) => item.repoKey !== card.repoKey),
        history: [...current.history, { card, action }],
        index: 0,
        cursor: saved ? null : current.cursor,
      };
    });
    if (!removed) return false;
    const next = get();
    if (next.items.length < 5 && !next.exhausted) void next.loadMore();
    return true;
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
    const invalidate = writes.some((write) => write.kind === "state");
    set((current) => {
      const head = current.history.at(-1);
      if (!head || head.card.repoKey !== last.card.repoKey || head.action !== last.action) return current;
      return {
        items: [last.card, ...current.items.filter((card) => card.repoKey !== last.card.repoKey)],
        history: current.history.slice(0, -1),
        index: 0,
        cursor: invalidate ? null : current.cursor,
      };
    });
  },
}));
