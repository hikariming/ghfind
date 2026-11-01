"use client";

import { useRef, useState } from "react";
import { ArrowLeft, Bookmark, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { FeedPage, FeedPost } from "@/lib/social-feed/contract";
import { setFeedLocale, type FeedAction, type FeedChannel } from "@/lib/social-feed/client";
import { createFeedStore, type FeedStore } from "@/lib/social-feed/client-store";
import type { StreamProjectPick, StreamVoice } from "@/lib/stream/types";
import { useMountEffect } from "@/lib/use-mount-effect";
import { cn } from "@/lib/utils";
import { LoginDialog } from "@/components/LoginDialog";
import { FeedComposer, FeedLogin } from "./FeedComposer";
import { FeedMessage, FeedPostCard } from "./FeedPostCard";
import { FeedRail } from "./FeedRail";
import { useFeedErrorMessage } from "./messages";

export interface FeedAppProps {
  initialPage: FeedPage | null;
  projects: StreamProjectPick[];
  voices: StreamVoice[];
  generatedAt: number;
  initialError?: string | null;
}
interface PostHandlers {
  onOpen: (id: string) => void;
  onReply: (id: string) => void;
  onAction: (id: string, action: FeedAction) => void;
  onFollow: (id: string, following: boolean) => void;
  onCopy: (id: string) => void;
}

export function FeedApp({ initialPage, projects, voices, generatedAt, initialError }: FeedAppProps) {
  const t = useTranslations("stream");
  // Idempotent and set before any mount effect fetches, so every read is localized.
  setFeedLocale(useLocale());
  const errorMessage = useFeedErrorMessage();
  const [store] = useState(() => createFeedStore(initialPage, initialError));
  const state = useStore(store);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const list = state.lists[state.channel];
  const currentPosts = list.ids.filter((id) => state.posts[id]).map((id) => ({ ...state.posts[id], ...list.activities[id] }));

  useMountEffect(() => {
    let active = true;
    // The first list read establishes the anonymous visitor cookie used by signed cursors.
    const ready = store.getState().start();
    const sync = () => {
      void ready.then(() => {
        if (active) void store.getState().openPost(new URL(window.location.href).searchParams.get("post"));
      });
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => { active = false; window.removeEventListener("popstate", sync); };
  });

  const openPost = (id: string) => {
    setBookmarksOpen(false);
    const url = new URL(window.location.href);
    if (url.searchParams.get("post") !== id) {
      url.searchParams.set("post", id);
      window.history.pushState({ ...window.history.state, feedPost: true }, "", url);
    }
    void state.openPost(id);
  };
  const closePost = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("post");
    window.history.replaceState(window.history.state, "", url);
    void state.openPost(null);
  };
  const requireLogin = () => {
    if (state.me && (state.me.user || state.me.account)) return false;
    state.setLoginOpen(true);
    return true;
  };
  const handlers: PostHandlers = {
    onReply: (id) => { if (!requireLogin()) openPost(id); },
    onOpen: openPost,
    onAction: (id, action) => { if (requireLogin()) return; setCopyNotice(null); void state.mutate(id, action); },
    onFollow: (id, following) => { if (requireLogin()) return; setCopyNotice(null); void state.follow(id, following); },
    onCopy: (id) => {
      const url = new URL(window.location.href);
      url.searchParams.set("post", id);
      void Promise.resolve().then(() => navigator.clipboard.writeText(url.href)).then(() => setCopyNotice(t("linkCopied"))).catch(() => setCopyNotice(t("feed.copyFailed")));
    },
  };
  const card = (post: FeedPost) => <FeedPostCard key={`${post.id}:${post.view_token ?? ""}`} post={post} posts={state.posts} now={generatedAt} pending={Boolean(state.pending[post.id] || state.pending[`author:${post.author.id}`])} {...handlers} />;
  const channels: { id: FeedChannel; label: string }[] = [{ id: "recommended", label: t("tabForYou") }, { id: "following", label: t("tabFollowing") }];
  const retry = <Button variant="outline" size="sm" onClick={() => void state.loadList(state.channel)}>{t("feed.retry")}</Button>;

  return <main className="stream-layout mx-auto flex w-full max-w-6xl flex-1 justify-center gap-6 pb-24 min-[900px]:px-4 min-[900px]:pb-10">
    <section className="stream-timeline min-w-0 w-full max-w-[600px] border-border min-[900px]:border-x">
      <header className="sticky top-[57px] z-30 border-b border-border bg-background/95 backdrop-blur min-[900px]:top-0">
        <div className="flex items-center justify-between px-4 pt-2"><h1 className="text-lg font-bold">{t("heading")}</h1><div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-9" aria-label={t("feed.myBookmarks")} title={t("feed.myBookmarks")} onClick={() => { if (requireLogin()) return; setBookmarksOpen(true); void state.loadList("bookmarks"); }}><Bookmark className="size-4" /></Button>
          <Button variant="ghost" size="icon" className="size-9" disabled={list.loading} aria-label={t("refresh")} title={t("refresh")} onClick={() => void state.loadList(state.channel)}><RefreshCw className={cn("size-4", list.loading && "animate-spin motion-reduce:animate-none")} /></Button>
        </div></div>
        <div role="tablist" aria-label={t("channels")} className="flex">{channels.map((channel) => <button key={channel.id} id={`feed-tab-${channel.id}`} role="tab" aria-selected={state.channel === channel.id} aria-controls="feed-timeline" type="button" className={cn("relative min-h-12 flex-1 px-3 py-3 text-sm hover:bg-foreground/[0.025]", state.channel === channel.id ? "font-bold text-foreground" : "text-muted-foreground")} onClick={() => void state.setChannel(channel.id)}>{channel.label}{state.channel === channel.id ? <span aria-hidden className="absolute bottom-0 left-1/2 h-[3px] w-14 -translate-x-1/2 rounded-full bg-orange-500" /> : null}</button>)}</div>
      </header>
      <FeedComposer store={store} />
      {state.notice || copyNotice ? <div role={state.notice ? "alert" : "status"} className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm"><p>{state.notice ? errorMessage(state.notice) : copyNotice}</p><Button variant="ghost" size="icon" className="size-7" aria-label={t("close")} onClick={() => { state.clearNotice(); setCopyNotice(null); }}><X className="size-3.5" /></Button></div> : null}
      <div id="feed-timeline" role="tabpanel" aria-labelledby={`feed-tab-${state.channel}`} aria-busy={list.loading}>
        {currentPosts.map(card)}
        {list.error ? <FeedMessage action={list.error === "login_required" ? <FeedLogin store={store} /> : retry}>{errorMessage(list.error)}</FeedMessage> : null}
        {list.loading && !currentPosts.length ? <FeedMessage><span className="inline-flex items-center gap-2" role="status"><LoaderCircle className="size-4 animate-spin" />{t("loadingMore")}</span></FeedMessage> : null}
        {list.loaded && !list.error && !list.loading && !currentPosts.length ? <FeedMessage>{t(state.channel === "following" ? "feed.followingEmpty" : "feed.empty")}</FeedMessage> : null}
        {list.cursor ? <div className="p-4 text-center"><Button variant="outline" size="sm" disabled={list.loading} onClick={() => void state.loadList(state.channel, true)}>{t(list.loading ? "loadingMore" : "feed.loadMore")}</Button></div> : null}
        {list.loaded && !list.cursor && !list.error && currentPosts.length ? <p className="px-4 py-8 text-center text-xs text-muted-foreground">{t("feed.end")}</p> : null}
      </div>
    </section>
    <aside className="stream-rail hidden w-[350px] shrink-0 pt-3 min-[1280px]:block"><div className="sticky top-3"><FeedRail projects={projects} voices={voices} posts={currentPosts} /></div></aside>
    <Dialog open={Boolean(state.selectedId)} onOpenChange={(open) => { if (!open) closePost(); }}>
      <DialogContent style={{ borderRadius: 0, boxShadow: "none" }} className="inset-y-0 left-1/2 flex h-[100dvh] w-full max-w-[600px] -translate-x-1/2 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-x border-y-0 bg-background p-0">
        <header className="flex h-[53px] shrink-0 items-center gap-7 px-3"><DialogClose asChild><Button variant="ghost" size="icon" className="size-9 rounded-full" aria-label={t("close")}><ArrowLeft className="size-5" /></Button></DialogClose><DialogTitle className="text-xl font-bold">{t("postTitle")}</DialogTitle></header>
        <DialogDescription className="sr-only">{t("feed.conversationDescription")}</DialogDescription>
        {state.selectedId ? <FeedThread key={state.selectedId} id={state.selectedId} store={store} now={generatedAt} handlers={handlers} copyNotice={copyNotice} /> : null}
      </DialogContent>
    </Dialog>
    <Dialog open={bookmarksOpen} onOpenChange={setBookmarksOpen}>
      <DialogContent className="flex max-h-[90dvh] w-[min(calc(100vw-1rem),600px)] flex-col gap-0 overflow-hidden rounded-xl bg-background p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-2"><DialogTitle className="text-base">{t("feed.myBookmarks")}</DialogTitle><DialogClose asChild><Button variant="ghost" size="icon" aria-label={t("close")}><X className="size-4" /></Button></DialogClose></div>
        <DialogDescription className="sr-only">{t("feed.privateBookmarks")}</DialogDescription>
        <div className="overflow-y-auto">
          {state.notice || copyNotice ? <p role={state.notice ? "alert" : "status"} className="border-b border-border px-4 py-2 text-sm">{state.notice ? errorMessage(state.notice) : copyNotice}</p> : null}
          {state.lists.bookmarks.ids.map((id) => state.posts[id]).filter((post) => post?.viewer?.bookmarked).map(card)}
          {state.lists.bookmarks.error ? <FeedMessage action={state.lists.bookmarks.error === "login_required" ? <FeedLogin store={store} /> : <Button variant="outline" size="sm" onClick={() => void state.loadList("bookmarks")}>{t("feed.retry")}</Button>}>{errorMessage(state.lists.bookmarks.error)}</FeedMessage> : null}
          {state.lists.bookmarks.loading ? <FeedMessage>{t("loadingMore")}</FeedMessage> : null}
          {state.lists.bookmarks.loaded && !state.lists.bookmarks.error && !state.lists.bookmarks.ids.some((id) => state.posts[id]?.viewer?.bookmarked) ? <FeedMessage>{t("savedEmpty")}</FeedMessage> : null}
          {state.lists.bookmarks.cursor ? <div className="p-4 text-center"><Button variant="outline" size="sm" disabled={state.lists.bookmarks.loading} onClick={() => void state.loadList("bookmarks", true)}>{t("feed.loadMore")}</Button></div> : null}
        </div>
      </DialogContent>
    </Dialog>
    <LoginDialog me={state.me ?? { user: null, scored: false, oauth: false }} onRetry={state.refreshSession} showTrigger={false} open={state.loginOpen} onOpenChange={state.setLoginOpen} nearComposer />
  </main>;
}

function FeedThread({ id, store, now, handlers, copyNotice }: { id: string; store: FeedStore; now: number; handlers: PostHandlers; copyNotice: string | null }) {
  const state = useStore(store);
  const t = useTranslations("stream");
  const errorMessage = useFeedErrorMessage();
  const [showAncestors, setShowAncestors] = useState(false);
  const target = useRef<HTMLDivElement | null>(null);
  const thread = state.threads[id];
  const post = state.posts[id];
  const ancestors = thread?.ancestors ?? [];
  const visibleAncestors = showAncestors ? ancestors : ancestors.slice(-2);
  const card = (item: FeedPost, focused = false, connected = false) => <FeedPostCard key={`${item.id}:${item.view_token ?? ""}`} post={item} posts={state.posts} now={now} focused={focused} connected={connected} pending={Boolean(state.pending[item.id] || state.pending[`author:${item.author.id}`])} {...handlers} />;
  return <div className="min-h-0 overflow-y-auto overscroll-contain" ref={target}>
    {copyNotice ? <p role="status" className="border-b border-border px-4 py-2 text-sm">{copyNotice}</p> : null}
    {state.notice ? <div role="alert" className="border-b border-border px-4 py-2 text-sm">{errorMessage(state.notice)}{state.notice === "login_required" ? <div className="mt-2"><FeedLogin store={store} /></div> : null}</div> : null}
    {ancestors.length > 2 && !showAncestors ? <div className="px-3 py-2"><Button variant="ghost" size="sm" onClick={() => setShowAncestors(true)}><ArrowLeft className="size-3.5" />{t("feed.earlierReplies")}</Button></div> : null}
    {visibleAncestors.map((ancestorId) => state.posts[ancestorId]).filter(Boolean).map((ancestor) => card(ancestor, false, true))}
    {post ? card(post, true) : null}
    {thread?.error ? <FeedMessage action={<Button variant="outline" size="sm" onClick={() => void state.openPost(id)}>{t("feed.retry")}</Button>}>{errorMessage(thread.error)}</FeedMessage> : null}
    {post?.status === "published" ? <FeedComposer store={store} parentId={id} /> : null}
    {thread?.ids.map((replyId) => state.posts[replyId]).filter(Boolean).map((reply) => card(reply))}
    {thread?.loading ? <FeedMessage>{t("loadingMore")}</FeedMessage> : null}
    {thread?.loaded && !thread.loading && !thread.error && !thread.ids.length ? <FeedMessage>{t("feed.noReplies")}</FeedMessage> : null}
    {thread?.cursor ? <div className="p-4 text-center"><Button variant="outline" size="sm" disabled={thread.loading} onClick={() => void state.loadReplies(id)}>{t("feed.loadMore")}</Button></div> : null}
  </div>;
}
