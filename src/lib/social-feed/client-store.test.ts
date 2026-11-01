import { afterEach, describe, expect, it, vi } from "vitest";
import { feedClient, FeedRequestError } from "./client";
import { createFeedStore } from "./client-store";
import type { FeedPage, FeedPost } from "./contract";

function post(id = "p1"): FeedPost {
  return {
    id, origin: "ghfind", kind: "original", author: { id: "author1", github_login: "developer", name: "Developer", avatar_url: null },
    text: "A real post", source_lang: null, translation: null, media: [], published_at: "2026-10-26T00:00:00Z", content_version: 1, conversation_id: id, parent_post_id: null, original_url: null, status: "published",
    metrics: { origin: "ghfind", likes: 0, reposts: 0, direct_replies: 0, conversation_replies: 0, views: 0 },
    viewer: { reaction: null, bookmarked: false, reposted: false, following_author: false, can_reply: true, can_delete: false },
  };
}
function page(items: FeedPost[]): FeedPage { return { items, next_cursor: null, algorithm_version: "chronological-v1" }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
afterEach(() => vi.restoreAllMocks());

describe("feed client persistence and navigation", () => {
  it("keeps repost attribution per channel when details refresh the canonical post", async () => {
    const item = post();
    const reposter = { ...item.author, id: "reposter", name: "Republisher" };
    const store = createFeedStore(page([{ ...item, reposted_by: reposter, reposted_at: item.published_at }]));
    vi.spyOn(feedClient, "list").mockResolvedValue(page([item]));
    vi.spyOn(feedClient, "post").mockResolvedValue(item);
    vi.spyOn(feedClient, "ancestors").mockResolvedValue({ items: [] });
    vi.spyOn(feedClient, "replies").mockResolvedValue(page([]));
    await store.getState().loadList("following");
    await store.getState().openPost(item.id);
    expect(store.getState().lists.recommended.activities[item.id].reposted_by).toEqual(reposter);
    expect(store.getState().lists.following.activities[item.id].reposted_by).toBeUndefined();
    expect(store.getState().posts[item.id].reposted_by).toBeUndefined();
  });

  it("does not undo a confirmed like when an older feed read finishes later", async () => {
    const item = post();
    const store = createFeedStore(page([item]));
    const read = deferred<FeedPage>();
    vi.spyOn(feedClient, "list").mockReturnValue(read.promise);
    const liked: FeedPost = { ...item, metrics: { ...item.metrics, likes: 1 }, viewer: { ...item.viewer!, reaction: "like" } };
    vi.spyOn(feedClient, "mutate").mockResolvedValue(liked);
    const loading = store.getState().loadList("recommended");
    await store.getState().mutate(item.id, "like");
    read.resolve(page([item]));
    await loading;
    expect(store.getState().posts[item.id].viewer?.reaction).toBe("like");
    expect(store.getState().posts[item.id].metrics.likes).toBe(1);
  });

  it("keeps the new thread selected when publishing to an earlier thread finishes", async () => {
    const item = post();
    const store = createFeedStore(page([item]));
    const publishing = deferred<FeedPost>();
    vi.spyOn(feedClient, "publish").mockReturnValue(publishing.promise);
    vi.spyOn(feedClient, "post").mockImplementation(async (id) => post(id));
    vi.spyOn(feedClient, "ancestors").mockResolvedValue({ items: [] });
    vi.spyOn(feedClient, "replies").mockResolvedValue(page([]));
    await store.getState().openPost("p1");
    const pending = store.getState().publish("reply", "request-key", "p1");
    await store.getState().openPost("p2");
    publishing.resolve({ ...post("reply"), kind: "reply", parent_post_id: "p1", conversation_id: "p1" });
    await pending;
    expect(store.getState().selectedId).toBe("p2");
    expect(store.getState().posts.reply.parent_post_id).toBe("p1");
  });

  it("rejects stale detail responses after a newer refresh", async () => {
    const item = post();
    const store = createFeedStore(page([item]));
    const oldRead = deferred<FeedPost>();
    vi.spyOn(feedClient, "post").mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce({ ...item, text: "new version", content_version: 2 });
    vi.spyOn(feedClient, "ancestors").mockResolvedValue({ items: [] });
    vi.spyOn(feedClient, "replies").mockResolvedValue(page([]));
    const old = store.getState().openPost(item.id);
    await store.getState().openPost(item.id);
    oldRead.resolve(item);
    await old;
    expect(store.getState().posts[item.id].text).toBe("new version");
  });

  it("keeps a successful new post visible when an older page request completes", async () => {
    const store = createFeedStore(page([post()]));
    const read = deferred<FeedPage>();
    vi.spyOn(feedClient, "list").mockReturnValue(read.promise);
    vi.spyOn(feedClient, "publish").mockResolvedValue(post("new"));
    const loading = store.getState().loadList("recommended");
    await store.getState().publish("new post", "unique-request");
    read.resolve(page([post()]));
    await loading;
    expect(store.getState().lists.recommended.ids).toEqual(["new", "p1"]);
  });

  it("retains a confirmed reply when refreshing its conversation fails", async () => {
    const store = createFeedStore(page([post()]));
    vi.spyOn(feedClient, "post").mockResolvedValue(post());
    vi.spyOn(feedClient, "ancestors").mockResolvedValue({ items: [] });
    vi.spyOn(feedClient, "replies").mockResolvedValue(page([]));
    await store.getState().openPost("p1");
    vi.mocked(feedClient.post).mockRejectedValue(new FeedRequestError("network_error", 0));
    vi.spyOn(feedClient, "publish").mockResolvedValue({ ...post("reply"), kind: "reply", parent_post_id: "p1" });
    await store.getState().publish("reply", "unique-request", "p1");
    expect(store.getState().threads.p1.ids).toContain("reply");
    expect(store.getState().threads.p1.error).toBe("network_error");
  });

  it("protects refreshed parent counters from an earlier list response after replying", async () => {
    const original = post();
    const store = createFeedStore(page([original]));
    const stale = deferred<FeedPage>();
    vi.spyOn(feedClient, "list").mockReturnValue(stale.promise);
    vi.spyOn(feedClient, "publish").mockResolvedValue({ ...post("reply"), kind: "reply", parent_post_id: "p1", conversation_id: "p1" });
    vi.spyOn(feedClient, "post").mockResolvedValue({ ...original, metrics: { ...original.metrics, direct_replies: 1, conversation_replies: 1 } });
    vi.spyOn(feedClient, "ancestors").mockResolvedValue({ items: [] });
    vi.spyOn(feedClient, "replies").mockResolvedValue(page([]));
    const reading = store.getState().loadList("recommended");
    await store.getState().publish("reply", "unique-request", "p1");
    stale.resolve(page([original]));
    await reading;
    expect(store.getState().posts.p1.metrics.direct_replies).toBe(1);
  });

  it("does not invent a like on failure and releases the pending action lock", async () => {
    const item = post();
    const store = createFeedStore(page([item]));
    vi.spyOn(feedClient, "mutate").mockRejectedValue(new FeedRequestError("authentication_required", 401));
    await store.getState().mutate(item.id, "like");
    expect(store.getState().posts[item.id].metrics.likes).toBe(0);
    expect(store.getState().posts[item.id].viewer?.reaction).toBeNull();
    expect(store.getState().notice).toBeNull();
    expect(store.getState().loginOpen).toBe(true);
    expect(store.getState().pending[item.id]).toBe(false);
  });
});
