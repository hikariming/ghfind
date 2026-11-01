import { LOCALES } from "@ghfind/i18n";

/**
 * Curated X (Twitter) timeline for the /feed stream.
 *
 * The site does not crawl X. An operator agent pushes posts to
 * POST /api/internal/x-timeline; this module decides what is kept. Two ways
 * in for an account:
 *   1. the editorial allowlist (src/config/x-accounts.ts): researchers,
 *      builders/CEOs, tech media, chosen by hand;
 *   2. developers whose linked GitHub account scores >= X_MIN_DEV_SCORE on
 *      ghfind, so the site's own rating is the bar.
 * Posts then pass a technical-content gate. The goal is the opposite of an
 * engagement-farming timeline: few posts, from people who build, about the
 * work.
 */

export const X_CATEGORIES = ["researcher", "builder", "media", "developer"] as const;
export type XCategory = (typeof X_CATEGORIES)[number];

/** Minimum ghfind score for score-gated developer accounts. */
export const X_MIN_DEV_SCORE = 80;
/** Minimum agent-reported technical relevance (0–1). */
export const X_MIN_TECHNICAL = 0.6;
/** Posts kept per account inside the stored window (no single voice floods it). */
export const X_PER_ACCOUNT_CAP = 4;
/** Posts kept overall, newest first. */
export const X_WINDOW = 240;
/** Posts older than this drop out. */
export const X_MAX_AGE_MS = 21 * 86_400_000;

export type XAccount = {
  handle: string;
  name: string;
  category: XCategory;
  /** Linked GitHub login → ghfind profile, comments and score badge. */
  github: string | null;
  /** Linked talent-library id. */
  talentId: string | null;
  verified: boolean;
  avatarUrl: string | null;
  /** One line on why this account is in the timeline. */
  note: string | null;
  /** Resolved at ingest for linked GitHub accounts. */
  ghfind: { score: number; tier: string } | null;
  /** How it was admitted. */
  source: "editorial" | "score";
};

export type XPost = {
  id: string;
  handle: string;
  text: string;
  createdAt: string;
  url: string;
  /** Agents may send replies and reposts; the gate keeps only original posts. */
  kind: "post" | "quote" | "thread" | "reply" | "repost";
  metrics: { likes: number; reposts: number; replies: number; views: number | null };
  media: { url: string; alt: string | null } | null;
  /** Quoted post or link card, shown as a nested block. */
  quote: { author: string; text: string; url: string } | null;
  topics: string[];
  technical: number;
  lang: string | null;
  /** Agent-made translations by site locale, shown behind a "Show translation" toggle. */
  translations: Partial<Record<string, string>>;
};

export type XTimeline = {
  accounts: XAccount[];
  posts: XPost[];
  updatedAt: number;
};

export type XRejection = { id: string; reason: XRejectReason };
export type XRejectReason =
  | "invalid"
  | "unknown_account"
  | "not_original"
  | "low_technical"
  | "too_short"
  | "engagement_bait"
  | "too_old";

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const TRANSLATION_LOCALES = new Set<string>(LOCALES);
const POST_ID = /^\d{1,25}$/;
const MAX_TEXT = 1_200;

export function normalizeHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const handle = value.trim().replace(/^@/, "");
  return HANDLE.test(handle) ? handle.toLowerCase() : null;
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function httpsUrl(value: unknown, hosts?: RegExp): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (hosts && !hosts.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

const X_HOSTS = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i;
const MEDIA_HOSTS = /^pbs\.twimg\.com$/i;

/**
 * Engagement-bait and monetization filler: what makes technical readers
 * give up on X. Deliberately small and conservative; the agent's technical
 * score does most of the work.
 */
const BAIT = [
  /\b(like|rt|retweet|repost)\s*(and|&|\+)\s*(follow|retweet|rt|repost|comment)\b/i,
  /\bfollow (me|for more)\b/i,
  /\b(giveaway|airdrop|presale|whitelist|pump|100x|to the moon)\b/i,
  /\b(dm me|link in bio|comment ["']?\w+["']? (and|&) i'?ll)\b/i,
  /\bwhich one are you\b/i,
  /关注我|点赞转发|转发抽奖|私信我|评论区扣/,
];

export function isEngagementBait(text: string): boolean {
  if (BAIT.some((pattern) => pattern.test(text))) return true;
  const hashtags = text.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  return hashtags > 4;
}

/** Parse one agent-submitted post; null when the shape is unusable. */
export function parsePost(input: unknown): XPost | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id) : "";
  const handle = normalizeHandle(raw.handle);
  const text = str(raw.text, MAX_TEXT);
  const createdAt = typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt)) ? new Date(raw.createdAt).toISOString() : null;
  if (!POST_ID.test(id) || !handle || !text || !createdAt) return null;
  const kinds: XPost["kind"][] = ["post", "quote", "thread", "reply", "repost"];
  const kind = raw.kind == null ? "post" : kinds.find((value) => value === raw.kind);
  if (!kind) return null;
  const metrics = (raw.metrics ?? {}) as Record<string, unknown>;
  const media = (raw.media ?? null) as Record<string, unknown> | null;
  const quote = (raw.quote ?? null) as Record<string, unknown> | null;
  const mediaUrl = media ? httpsUrl(media.url, MEDIA_HOSTS) : null;
  const quoteUrl = quote ? httpsUrl(quote.url) : null;
  const quoteText = quote ? str(quote.text, 400) : null;
  return {
    id,
    handle,
    text,
    createdAt,
    url: httpsUrl(raw.url, X_HOSTS) ?? `https://x.com/${handle}/status/${id}`,
    kind,
    metrics: {
      likes: count(metrics.likes),
      reposts: count(metrics.reposts),
      replies: count(metrics.replies),
      views: metrics.views == null ? null : count(metrics.views),
    },
    media: mediaUrl ? { url: mediaUrl, alt: media ? str(media.alt, 300) : null } : null,
    quote: quoteUrl && quoteText ? { author: str(quote?.author, 60) ?? "", text: quoteText, url: quoteUrl } : null,
    topics: Array.isArray(raw.topics) ? raw.topics.map((topic) => str(topic, 40)).filter((topic): topic is string => Boolean(topic)).slice(0, 6) : [],
    technical: typeof raw.technical === "number" ? Math.min(1, Math.max(0, raw.technical)) : 0,
    lang: str(raw.lang, 8),
    translations: parseTranslations(raw.translations),
  };
}

function parseTranslations(value: unknown): XPost["translations"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: XPost["translations"] = {};
  for (const [locale, text] of Object.entries(value as Record<string, unknown>)) {
    const clean = str(text, MAX_TEXT);
    if (TRANSLATION_LOCALES.has(locale) && clean) out[locale] = clean;
  }
  return out;
}

/** Translation to offer a reader, or null when the post is already in their language. */
export function translationFor(post: { lang: string | null; translations: XPost["translations"] }, locale: string): string | null {
  const lang = post.lang?.toLowerCase().split("-")[0] ?? null;
  if (lang === locale) return null;
  return post.translations[locale] ?? null;
}

/** Why a parsed post may not enter the timeline, or null when it may. */
export function gatePost(post: XPost, accounts: ReadonlyMap<string, XAccount>, now: number): XRejectReason | null {
  if (!accounts.has(post.handle)) return "unknown_account";
  if (post.kind === "reply" || post.kind === "repost") return "not_original";
  if (now - Date.parse(post.createdAt) > X_MAX_AGE_MS) return "too_old";
  if (post.technical < X_MIN_TECHNICAL || post.topics.length === 0) return "low_technical";
  const plain = post.text.replace(/https?:\/\/\S+/g, "").trim();
  if (plain.length < 40 && !post.media && !post.quote) return "too_short";
  if (isEngagementBait(post.text)) return "engagement_bait";
  return null;
}

/**
 * Merge accepted posts into the stored window: newest wins on id, near-
 * identical text from one account is dropped, at most X_PER_ACCOUNT_CAP
 * per account, X_WINDOW overall, nothing older than X_MAX_AGE_MS.
 */
export function mergePosts(existing: XPost[], incoming: XPost[], now: number): XPost[] {
  const byId = new Map<string, XPost>();
  for (const post of [...existing, ...incoming]) byId.set(post.id, post);
  const sorted = [...byId.values()]
    .filter((post) => now - Date.parse(post.createdAt) <= X_MAX_AGE_MS)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const perAccount = new Map<string, number>();
  const seenText = new Set<string>();
  const out: XPost[] = [];
  for (const post of sorted) {
    const fingerprint = `${post.handle}:${post.text.toLowerCase().replace(/\W+/g, "").slice(0, 120)}`;
    if (seenText.has(fingerprint)) continue;
    const used = perAccount.get(post.handle) ?? 0;
    if (used >= X_PER_ACCOUNT_CAP) continue;
    seenText.add(fingerprint);
    perAccount.set(post.handle, used + 1);
    out.push(post);
    if (out.length >= X_WINDOW) break;
  }
  return out;
}

/** Engagement rate on X, squashed to 0–1 (reposts and replies weigh more than likes). */
export function xHeat(post: XPost): number {
  const { likes, reposts, replies } = post.metrics;
  const weighted = likes + 3 * reposts + 2 * replies;
  return Math.min(1, Math.log10(1 + weighted) / 4.5);
}
