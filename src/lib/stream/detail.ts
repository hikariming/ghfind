import type { StreamMeter } from "./types";

/**
 * Lazily loaded detail for one stream item (GET /feed/item?id=…), for data the
 * list queries do not carry: full profiles, article bodies, job descriptions
 * and the item's real comment thread.
 */
export type StreamComment = {
  id: string;
  author: { name: string; avatarUrl: string | null; anonymous: boolean };
  text: string;
  createdAt: number;
};

export type StreamReactionCounts = Record<"like" | "poop" | "kick" | "fire" | "salute" | "clown", number>;

export type StreamDeveloperDetail = {
  kind: "developer";
  roast: string | null;
  meters: StreamMeter[];
  /** Share of scored developers this one beats, 0–100. */
  beat: number | null;
  rank: number | null;
  total: number | null;
  delta: number | null;
  bio: string | null;
  company: string | null;
  facts: { key: "followers" | "totalStars" | "mergedPrs" | "contributions" | "years"; value: number }[];
  topRepos: { name: string; stars: number; language: string | null; description: string | null }[];
  battles: { opponent: string; won: boolean | null; myScore: number; theirScore: number; verdict: string | null; views: number }[];
  similar: { username: string; name: string; avatarUrl: string | null; score: number; tier: string }[];
  reactions: StreamReactionCounts;
};

export type StreamArticleDetail = {
  kind: "article";
  toc: string[];
  excerpt: string[];
};

export type StreamCollectionDetail = {
  kind: "collection";
  excerpt: string[];
};

export type StreamJobDetail = {
  kind: "job";
  description: string[];
  website: string | null;
};

export type StreamItemDetail = {
  id: string;
  body: StreamDeveloperDetail | StreamArticleDetail | StreamCollectionDetail | StreamJobDetail | null;
  comments: StreamComment[];
};

/**
 * Plain paragraphs from markdown: drops headings, images, code fences,
 * tables, HTML and front matter; unwraps links and emphasis.
 */
export function markdownParagraphs(markdown: string, limit = 4, maxChars = 900): string[] {
  const out: string[] = [];
  let used = 0;
  const blocks = markdown
    .replace(/^---[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n{2,}/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block || /^(#|!\[|\||<|>?\s*\[!|-{3,}|\*{3,}|import |export )/.test(block)) continue;
    const text = block
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/^[>\-*+]\s+/gm, "")
      .replace(/^\d+\.\s+/gm, "")
      .replace(/(\*\*|__|\*|_|`)/g, "")
      .replace(/\s*\n\s*/g, " ")
      .trim();
    if (text.length < 20) continue;
    const room = maxChars - used;
    if (room <= 40) break;
    out.push(text.length > room ? `${text.slice(0, room).trimEnd()}…` : text);
    used += text.length;
    if (out.length >= limit) break;
  }
  return out;
}

/** `##`/`###` headings, for a table of contents. */
export function markdownHeadings(markdown: string, limit = 8): string[] {
  return [...markdown.matchAll(/^#{2,3}\s+(.+?)\s*#*$/gm)]
    .map((match) => match[1].replace(/[*_`]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim())
    .filter(Boolean)
    .slice(0, limit);
}
