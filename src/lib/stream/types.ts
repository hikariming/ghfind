/**
 * The /feed prototype: every ghfind content type (scored projects, scored
 * developers, talent, articles, collections, jobs) folded into one item shape
 * so a single ranked stream can interleave them.
 *
 * Only real numbers are shown: `counter` and `heat` come from the source data
 * (lookups, stars, community strength). Likes/saves/follows are the viewer's
 * own state (store.ts) and carry no public count until a server counter
 * exists. Rich detail is embedded (`extra`) when the list query already has
 * it, otherwise fetched on open from /feed/item (detail.ts).
 */
export type StreamKind = "project" | "developer" | "talent" | "article" | "collection" | "job" | "post";

/** "foryou" is the ranked mix; following/saved are viewer filters; the rest filter by kind. */
export type StreamChannel = "foryou" | "following" | "saved" | StreamKind;

export type StreamLayout = "list" | "masonry";

export type StreamAuthor = {
  /** Stable key used for follow state, e.g. a GitHub login or company id. */
  id: string;
  name: string;
  avatarUrl: string | null;
  /** Secondary line, e.g. "@login" or a company tagline. */
  handle: string | null;
  /** Linked curated X account, when this person posts on the X timeline. */
  x?: { handle: string; verified: boolean; category: string } | null;
};

export type StreamStat = { label: string; value: string };

export type StreamItem = {
  id: string;
  kind: StreamKind;
  title: string;
  /** One or two lines shown on the card. */
  summary: string;
  /** Longer body for the detail view (plain text, paragraphs split on \n\n). */
  body: string | null;
  author: StreamAuthor;
  coverUrl: string | null;
  tags: string[];
  /** 0–100 headline score (product score, developer score, talent score…). */
  score: number | null;
  /** Short label next to the score, e.g. a tier name. */
  scoreLabel: string | null;
  /** Compact facts for the detail view. */
  stats: StreamStat[];
  /** Internal path to the canonical page ("/u/foo", "/blog/x") or an external URL. */
  href: string;
  external: boolean;
  /** Real ISO timestamp, or null when the source has none (never invented). */
  publishedAt: string | null;
  /** Minutes, for articles/collections. */
  readingMinutes: number | null;
  sponsored: boolean;
  /** Editorial quality prior 0–1. */
  quality: number;
  /** Real popularity 0–1 within its kind (lookups, community strength…). */
  heat: number;
  /** One real public number for the card, e.g. how often a profile was looked up. */
  counter: StreamCounter | null;
  badge: StreamBadge | null;
  /** Where real comments live, if this item has a comment thread. */
  comments: StreamCommentTarget | null;
  extra: StreamExtra | null;
};

export type StreamCounter = { kind: "lookups" | "stars" | "items"; value: number };

export type StreamBadge = "hot" | "new" | "editor";

export type StreamCommentTarget = { kind: "blog" | "collection" | "profile"; key: string };

export type StreamMeter = { key: string; value: number; max: number };

/** Detail data the list queries already carry, so it ships with the item. */
export type StreamExtra =
  | { kind: "project"; meters: StreamMeter[]; audience: string | null; risks: string[]; repoKey: string; stars: number | null }
  | { kind: "talent"; projects: { name: string; url: string | null; description: string; relationship: "own" | "pr" }[]; sources: { title: string; url: string | null; publisher: string }[]; skills: string[] }
  | { kind: "collection"; picks: StreamPick[] }
  | {
      kind: "post";
      handle: string;
      verified: boolean;
      category: string;
      metrics: { likes: number; reposts: number; replies: number; views: number | null };
      media: { url: string; alt: string | null } | null;
      quote: { author: string; text: string; url: string } | null;
      /** Linked ghfind profile (GitHub login), for the score badge and thread. */
      github: string | null;
      /** Translation into the page locale, when the post is in another language. */
      translation: string | null;
    };

/** A curated X voice for the rail. */
export type StreamVoice = { handle: string; name: string; avatarUrl: string | null; category: string; verified: boolean; github: string | null; posts: number };

export type StreamPick = {
  kind: "repo" | "developer";
  id: string;
  blurb: string;
  /** Score for developers, average contributor score for repos. */
  score: number | null;
  tier: string | null;
  stars: number | null;
  href: string;
};

/** Real site-wide activity shown at the top of the stream. */
export type StreamPulse = {
  totalScored: number | null;
  trending: { username: string; name: string; avatarUrl: string | null; score: number; tier: string; lookups: number }[];
};

/** What the viewer has learned the stream about them (persisted locally). */
export type StreamAffinity = {
  kinds: Partial<Record<StreamKind, number>>;
  tags: Record<string, number>;
};

/** Independent sidebar recommendations; never mixed into the X timeline. */
export type StreamProjectPick = { repoKey: string; summary: string; href: string };
