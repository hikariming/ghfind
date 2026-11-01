import { createStore } from "zustand/vanilla";
import { fetchMe, type Me } from "@/lib/me-client";
import type { FeedAuthor, FeedPage, FeedPost, PublishingCapabilities } from "./contract";
import { feedClient, FeedRequestError, type FeedAction, type FeedChannel } from "./client";

export interface FeedActivity {
  reposted_by?: FeedAuthor;
  reposted_at?: string;
}
export interface FeedListState {
  activities: Record<string, FeedActivity>;
  ids: string[];
  cursor: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}
export interface FeedThreadState extends FeedListState {
  ancestors: string[];
}
interface FeedState {
  posts: Record<string, FeedPost>;
  lists: Record<FeedChannel | "bookmarks", FeedListState>;
  threads: Record<string, FeedThreadState>;
  channel: FeedChannel;
  selectedId: string | null;
  me: Me | null;
  capabilities: PublishingCapabilities | null;
  capabilitiesError: boolean;
  pending: Record<string, boolean>;
  notice: string | null;
  loginOpen: boolean;
  setLoginOpen: (open: boolean) => void;
  start: () => Promise<void>;
  refreshSession: () => Promise<void>;
  setChannel: (channel: FeedChannel) => Promise<void>;
  loadList: (channel: FeedChannel | "bookmarks", more?: boolean) => Promise<void>;
  openPost: (id: string | null) => Promise<void>;
  loadThread: (id: string) => Promise<void>;
  loadReplies: (id: string) => Promise<void>;
  publish: (text: string, key: string, parentId?: string, mediaIds?: string[]) => Promise<FeedPost>;
  mutate: (id: string, action: FeedAction) => Promise<void>;
  follow: (authorId: string, following: boolean) => Promise<void>;
  clearNotice: () => void;
}

export function feedError(error: unknown): string {
  if (!(error instanceof FeedRequestError)) return "request_failed";
  if (error.status === 401) return "login_required";
  if (error.status === 403 && ["score_required", "score_outdated", "score_below_minimum", "github_required"].includes(error.code)) return "publishing_denied";
  if (error.status === 404 || error.status === 410) return "post_unavailable";
  if (error.status === 429) return "rate_limited";
  return error.code;
}

function emptyList(): FeedListState {
  return { activities: {}, ids: [], cursor: null, loading: false, loaded: false, error: null };
}
function mergePosts(previous: Record<string, FeedPost>, posts: FeedPost[]): Record<string, FeedPost> {
  const next = { ...previous };
  for (const post of posts) {
    // Activity belongs to a channel entry, not to the canonical post cache.
    const { reposted_by: _author, reposted_at: _time, ...canonical } = post;
    next[post.id] = canonical;
  }
  return next;
}
function pageActivities(posts: FeedPost[]): Record<string, FeedActivity> {
  return Object.fromEntries(posts.map((post) => [post.id, post.reposted_by ? { reposted_by: post.reposted_by, reposted_at: post.reposted_at } : {}]));
}
function appendIds(ids: string[], posts: FeedPost[]): string[] {
  return [...new Set([...ids, ...posts.map((post) => post.id)])];
}

export function createFeedStore(initialPage: FeedPage | null, initialError?: string | null) {
  let starting: Promise<void> | undefined;
  const requests: Record<string, number> = {};
  let mutationRevision = 0;
  const postRevisions: Record<string, number> = {};
  const publicationRevisions: Record<string, number> = {};
  const markUpdated = (id: string) => { postRevisions[id] = ++mutationRevision; };
  const mergeRead = (previous: Record<string, FeedPost>, posts: FeedPost[], revision: number) => mergePosts(previous, posts.filter((post) => (postRevisions[post.id] ?? 0) <= revision));
  return createStore<FeedState>()((set, get) => ({
    posts: mergePosts({}, initialPage?.items ?? []),
    lists: {
      recommended: { ...emptyList(), activities: pageActivities(initialPage?.items ?? []), ids: initialPage?.items.map((post) => post.id) ?? [], cursor: initialPage?.next_cursor ?? null, loaded: Boolean(initialPage), error: initialError ? "request_failed" : null },
      following: emptyList(),
      bookmarks: emptyList(),
    },
    threads: {},
    channel: "recommended",
    selectedId: null,
    me: null,
    capabilities: null,
    capabilitiesError: false,
    pending: {},
    notice: null,
    loginOpen: false,
    setLoginOpen: (loginOpen) => set({ loginOpen, notice: null }),
    clearNotice: () => set({ notice: null }),
    start: () => {
      starting ??= Promise.all([get().refreshSession(), get().loadList("recommended")]).then(() => undefined);
      return starting;
    },
    refreshSession: async () => {
      set({ capabilitiesError: false });
      await Promise.all([
        fetchMe({ refresh: true }).then((me) => set({ me })),
        feedClient.capabilities().then((capabilities) => set({ capabilities })).catch(() => set({ capabilities: null, capabilitiesError: true })),
      ]);
    },
    setChannel: async (channel) => {
      set({ channel });
      if (!get().lists[channel].loaded) await get().loadList(channel);
    },
    loadList: async (channel, more = false) => {
      const previous = get().lists[channel];
      const readRevision = mutationRevision;
      if (more && (previous.loading || !previous.cursor)) return;
      const requestId = (requests[channel] ?? 0) + 1;
      requests[channel] = requestId;
      set((state) => ({ lists: { ...state.lists, [channel]: { ...previous, loading: true, error: null } } }));
      try {
        const cursor = more ? previous.cursor : null;
        const page = channel === "bookmarks" ? await feedClient.bookmarks(cursor) : await feedClient.list(channel, cursor);
        if (requests[channel] !== requestId) return;
        set((state) => ({
          posts: mergeRead(state.posts, page.items, readRevision),
          lists: { ...state.lists, [channel]: { activities: { ...(more ? previous.activities : {}), ...pageActivities(page.items) }, ids: appendIds(more ? previous.ids : channel === "recommended" ? state.lists.recommended.ids.filter((id) => (publicationRevisions[id] ?? 0) > readRevision) : [], page.items), cursor: page.next_cursor, loading: false, loaded: true, error: null } },
        }));
      } catch (error) {
        if (requests[channel] === requestId) set((state) => ({ lists: { ...state.lists, [channel]: { ...state.lists[channel], loading: false, error: feedError(error) } } }));
      }
    },
    openPost: async (id) => {
      set({ selectedId: id });
      if (id) await get().loadThread(id);
    },
    loadThread: async (id) => {
      const requestKey = `thread:${id}`;
      const requestId = (requests[requestKey] ?? 0) + 1;
      requests[requestKey] = requestId;
      const readRevision = mutationRevision;
      set((state) => ({ threads: { ...state.threads, [id]: { ...(state.threads[id] ?? { ...emptyList(), ancestors: [] }), loading: true, error: null } } }));
      try {
        const [post, ancestors, replies] = await Promise.all([feedClient.post(id), feedClient.ancestors(id), feedClient.replies(id)]);
        if (requests[requestKey] !== requestId) return;
        set((state) => ({
          posts: mergeRead(state.posts, [post, ...ancestors.items, ...replies.items], readRevision),
          threads: { ...state.threads, [id]: { activities: {}, ids: replies.items.map((reply) => reply.id), ancestors: ancestors.items.map((ancestor) => ancestor.id), cursor: replies.next_cursor, loading: false, loaded: true, error: null } },
        }));
      } catch (error) {
        if (requests[requestKey] !== requestId) return;
        set((state) => ({ threads: { ...state.threads, [id]: { ...state.threads[id], loading: false, error: feedError(error) } } }));
      }
    },
    loadReplies: async (id) => {
      const previous = get().threads[id];
      if (!previous?.cursor || previous.loading) return;
      const requestKey = `thread:${id}`;
      const requestId = (requests[requestKey] ?? 0) + 1;
      requests[requestKey] = requestId;
      const readRevision = mutationRevision;
      set((state) => ({ threads: { ...state.threads, [id]: { ...previous, loading: true, error: null } } }));
      try {
        const page = await feedClient.replies(id, previous.cursor);
        if (requests[requestKey] !== requestId) return;
        set((state) => ({ posts: mergeRead(state.posts, page.items, readRevision), threads: { ...state.threads, [id]: { ...previous, ids: appendIds(previous.ids, page.items), cursor: page.next_cursor, loading: false } } }));
      } catch (error) {
        if (requests[requestKey] !== requestId) return;
        set((state) => ({ threads: { ...state.threads, [id]: { ...previous, loading: false, error: feedError(error) } } }));
      }
    },
    publish: async (text, key, parentId, mediaIds) => {
      const post = await feedClient.publish(text, key, parentId, mediaIds);
      markUpdated(post.id);
      if (parentId) {
        for (const affectedId of new Set([parentId, post.conversation_id])) markUpdated(affectedId);
      }
      publicationRevisions[post.id] = mutationRevision;
      set((state) => ({
        posts: mergePosts(state.posts, [post]),
        threads: parentId && state.threads[parentId] ? { ...state.threads, [parentId]: { ...state.threads[parentId], ids: [post.id, ...state.threads[parentId].ids.filter((id) => id !== post.id)] } } : state.threads,
        lists: parentId ? state.lists : { ...state.lists, recommended: { ...state.lists.recommended, ids: [post.id, ...state.lists.recommended.ids.filter((id) => id !== post.id)] } },
      }));
      if (parentId) {
        // Read back the parent counters and chronological replies after persistence.
        await get().loadThread(parentId);
      }
      return post;
    },
    mutate: async (id, action) => {
      if (get().pending[id]) return;
      const post = get().posts[id];
      if (!post) return;
      set((state) => ({ pending: { ...state.pending, [id]: true }, notice: null }));
      try {
        const updated = await feedClient.mutate(post, action);
        markUpdated(updated.id);
        set((state) => ({ posts: mergePosts(state.posts, [updated]) }));
      } catch (error) { const code = feedError(error); set(code === "login_required" ? { loginOpen: true, notice: null } : { notice: code }); }
      finally { set((state) => ({ pending: { ...state.pending, [id]: false } })); }
    },
    follow: async (authorId, following) => {
      const key = `author:${authorId}`;
      if (get().pending[key]) return;
      set((state) => ({ pending: { ...state.pending, [key]: true }, notice: null }));
      try {
        const result = await feedClient.follow(authorId, following);
        for (const post of Object.values(get().posts)) if (post.author.id === authorId) markUpdated(post.id);
        set((state) => ({ posts: Object.fromEntries(Object.entries(state.posts).map(([id, post]) => [id, post.author.id === authorId && post.viewer ? { ...post, viewer: { ...post.viewer, following_author: result.following } } : post])) }));
        await get().loadList("following");
      } catch (error) { const code = feedError(error); set(code === "login_required" ? { loginOpen: true, notice: null } : { notice: code }); }
      finally { set((state) => ({ pending: { ...state.pending, [key]: false } })); }
    },
  }));
}
export type FeedStore = ReturnType<typeof createFeedStore>;
