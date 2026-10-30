import type { FeedPost } from "@/lib/social-feed/contract";

export interface FeedReference {
  url: string;
  kind: "post" | "link";
  post?: FeedPost;
}

function xPostId(url: URL): string | undefined {
  if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) return;
  return /^\/(?:[\w]+|i\/web)\/status\/(\d+)\/?$/.exec(url.pathname)?.[1];
}

/** Short links have unknown destinations: never label them as verified quoted posts. */
export function feedReferences(post: FeedPost, text: string, posts: Record<string, FeedPost>) {
  if (post.origin !== "x") return { text, references: [] as FeedReference[] };
  const references = new Map<string, FeedReference>();
  const ownId = post.original_url ? xPostId(new URL(post.original_url)) : undefined;
  const trailingShortLinks = text.match(/(?:https?:\/\/t\.co\/[a-zA-Z0-9]+[\s.,!?;:，。！？；：)）\]]*)+$/)?.index;
  const body = text.replace(/https?:\/\/[^\s<>]+/g, (match, offset: number) => {
    const raw = match.replace(/[.,!?;:，。！？；：)）\]]+$/, "");
    let url: URL;
    try { url = new URL(raw); } catch { return match; }
    if (url.username || url.password) return match;
    const id = xPostId(url);
    const short = url.hostname === "t.co" && /^\/[a-zA-Z0-9]+$/.test(url.pathname);
    if (!id && (!short || trailingShortLinks === undefined || offset < trailingShortLinks)) return match;
    const punctuation = match.slice(raw.length);
    if (id && id === ownId) return punctuation;
    const key = id ?? raw;
    if (!references.has(key)) {
      const quoted = id ? Object.values(posts).find((candidate) => candidate.origin === "x" && candidate.original_url && xPostId(new URL(candidate.original_url)) === id) : undefined;
      references.set(key, { url: raw, kind: id ? "post" : "link", post: quoted?.status === "published" ? quoted : undefined });
    }
    return punctuation;
  }).trim();
  return { text: body, references: [...references.values()] };
}
