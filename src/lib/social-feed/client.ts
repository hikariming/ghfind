import type { FeedAuthorSummary, FeedMedia, FeedPage, FeedPost, PublishingCapabilities } from "./contract";

export type FeedChannel = "recommended" | "following";
export type FeedAction = "like" | "dislike" | "bookmark" | "repost" | "delete";

export class FeedRequestError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "FeedRequestError";
  }
}

let feedLocale: string | null = null;
/** Page locale sent with every call so returned posts carry their body translation. */
export function setFeedLocale(locale: string | null): void { feedLocale = locale; }

async function request<T>(path: string, method = "GET", body?: unknown, idempotencyKey?: string): Promise<T> {
  const localized = feedLocale ? `${path}${path.includes("?") ? "&" : "?"}locale=${encodeURIComponent(feedLocale)}` : path;
  let response: Response;
  try {
    response = await fetch(`/api/feed${localized}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        ...(body === undefined || body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
  } catch {
    throw new FeedRequestError("network_error", 0);
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const code = value && typeof value.code === "string" ? value.code : value && typeof value.error === "string" ? value.error : "request_failed";
    throw new FeedRequestError(code, response.status);
  }
  return value as T;
}

function pageQuery(cursor: string | null, channel?: FeedChannel): string {
  const query = new URLSearchParams();
  if (cursor) query.set("cursor", cursor);
  if (channel) query.set("channel", channel);
  return query.size ? `?${query}` : "";
}

export const feedClient = {
  upload: (file: File, altText: string) => {
    const data = new FormData();
    data.set("file", file);
    if (altText.trim()) data.set("alt_text", altText.trim());
    return request<FeedMedia>("/media", "POST", data);
  },
  author: (id: string) => request<FeedAuthorSummary>(`/authors/${encodeURIComponent(id)}`),
  capabilities: () => request<PublishingCapabilities>("/publishing-capabilities"),
  list: (channel: FeedChannel, cursor: string | null = null) => request<FeedPage>(`/posts${pageQuery(cursor, channel)}`),
  bookmarks: (cursor: string | null = null) => request<FeedPage>(`/me/bookmarks${pageQuery(cursor)}`),
  post: (id: string) => request<FeedPost>(`/posts/${encodeURIComponent(id)}`),
  replies: (id: string, cursor: string | null = null) => request<FeedPage>(`/posts/${encodeURIComponent(id)}/replies${pageQuery(cursor)}`),
  ancestors: (id: string) => request<{ items: FeedPost[] }>(`/posts/${encodeURIComponent(id)}/ancestors`),
  publish: (text: string, idempotencyKey: string, parentId?: string, mediaIds: string[] = []) => request<FeedPost>(parentId ? `/posts/${encodeURIComponent(parentId)}/replies` : "/posts", "POST", { text, media_ids: mediaIds }, idempotencyKey),
  mutate: (post: FeedPost, action: FeedAction) => {
    const path = `/posts/${encodeURIComponent(post.id)}`;
    if (action === "delete") return request<FeedPost>(path, "DELETE");
    if (action === "like" || action === "dislike") {
      return request<FeedPost>(`${path}/reaction`, post.viewer?.reaction === action ? "DELETE" : "PUT", post.viewer?.reaction === action ? undefined : { value: action });
    }
    const active = action === "bookmark" ? post.viewer?.bookmarked : post.viewer?.reposted;
    return request<FeedPost>(`${path}/${action}`, active ? "DELETE" : "PUT");
  },
  follow: (authorId: string, following: boolean) => request<{ following: boolean }>(`/authors/${encodeURIComponent(authorId)}/follow`, following ? "DELETE" : "PUT"),
  view: (post: FeedPost, eventId: string) => request<{ recorded: boolean }>("/post-events", "POST", { event_id: eventId, post_id: post.id, view_token: post.view_token, event_type: "qualified_view" }),
};
