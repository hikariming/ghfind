import type { Locale } from "@ghfind/i18n";

/** Public post and repository contracts. X content never supplies ghfind interaction metrics. */
export const FEED_MINIMUM_SCORE = 60;
export const FEED_MAX_TEXT_LENGTH = 5_000;
export const FEED_MAX_X_TEXT_LENGTH = 100_000;
export const FEED_MAX_MEDIA = 4;
export const FEED_DEFAULT_PAGE_SIZE = 20;
export const FEED_MAX_PAGE_SIZE = 50;
export const FEED_PUBLICATION_POLICY_VERSION = "social-feed-v1";
export const FEED_X_CURATED_POLICY_VERSION = "social-feed-x-curated-v1";
export const FEED_MAX_TRANSLATION_LABEL_LENGTH = 100;
/** Hard caps for a single X-ingest request's translation payload. */
export const FEED_MAX_INGEST_TRANSLATIONS = 9;
export const FEED_MAX_INGEST_TRANSLATION_CHARS = 200_000;
/** Ingest quotas: global per-minute / per-hour and per-author per-minute. */
export const FEED_INGEST_GLOBAL_PER_MINUTE = 30;
export const FEED_INGEST_GLOBAL_PER_HOUR = 500;
export const FEED_INGEST_AUTHOR_PER_MINUTE = 10;

export type FeedOrigin = "x" | "ghfind";
export type FeedPostKind = "original" | "reply";
export type FeedPostStatus = "published" | "deleted" | "hidden";
export type FeedReaction = "like" | "dislike";
export type FeedChannel = "recommended" | "following" | "bookmarks";

export interface FeedMedia {
  id: string;
  type: "image";
  url: string;
  alt_text: string | null;
  width: number | null;
  height: number | null;
}
export interface FeedAuthorSummary {
  author: FeedAuthor;
  following: number;
  followers: number;
  follows_you: boolean;
  x_url: string | null;
  x_handle?: string | null;
  score: number | null;
}

export interface FeedAuthor {
  /** Verified score captured at publication; absent for unscored imported authors. */
  publication_score?: number | null;
  id: string;
  github_login: string;
  name: string;
  avatar_url: string | null;
}
export interface FeedMetrics {
  origin: "ghfind";
  likes: number;
  reposts: number;
  direct_replies: number;
  conversation_replies: number;
  views: number;
}
export interface FeedViewerState {
  reaction: FeedReaction | null;
  bookmarked: boolean;
  reposted: boolean;
  following_author: boolean;
  can_reply: boolean;
  can_delete: boolean;
}
/** Body text in the page locale for the post's current content_version. */
export interface FeedPostTranslation {
  locale: Locale;
  text: string;
  source_lang: string | null;
}
export interface FeedPost {
  id: string;
  origin: FeedOrigin;
  kind: FeedPostKind;
  author: FeedAuthor;
  /** Always the original body; `translation` is the page-locale variant when one applies. */
  text: string;
  source_lang: string | null;
  translation: FeedPostTranslation | null;
  media: FeedMedia[];
  published_at: string;
  content_version: number;
  conversation_id: string;
  parent_post_id: string | null;
  original_url: string | null;
  status: FeedPostStatus;
  metrics: FeedMetrics;
  viewer: FeedViewerState | null;
  view_token?: string;
  reposted_by?: FeedAuthor;
  reposted_at?: string;
}
export interface FeedPage {
  items: FeedPost[];
  next_cursor: string | null;
  algorithm_version: string;
}
export interface PublishingCapabilities {
  score?: number;
  can_publish: boolean;
  can_reply: boolean;
  minimum_score: 60;
  reason: string | null;
  policy_version?: string;
}
export interface PostInput {
  text: string;
  media_ids?: string[];
}
/** Only server-verified login data can construct this actor. */
export interface FeedActor {
  user_id: string;
  github_user_id: string;
  github_login: string;
  name: string;
  avatar_url: string | null;
}
export interface FeedViewer {
  user_id: string;
  can_reply: boolean;
}
export interface FeedAuthorInput {
  github_user_id: string;
  github_login: string;
  name: string;
  avatar_url: string | null;
}
export interface PublicationEvidence {
  score: number;
  score_record_id: string;
  score_version: string;
  policy_version: string;
}
export interface NativePostInput {
  actor: FeedActor;
  publication: PublicationEvidence;
  input: PostInput;
  idempotency_key: string;
  parent_post_id?: string;
}
export interface XSourceInput {
  post_id: string;
  author_id: string;
  url: string;
  display_name: string;
  avatar_url: string | null;
  edit_history_post_ids?: string[];
  evidence_url: string;
  evidence_method: "editorial_review" | "reciprocal_links";
  evidence_checked_at: string;
}
/** Internal ingest only. Author identity must already be verified by its caller; score is provenance only. */
export interface XPostInput {
  author: FeedAuthorInput;
  publication: PublicationEvidence;
  source: XSourceInput;
  text: string;
  media?: FeedMedia[];
  published_at: string;
  parent_post_id?: string;
  /** Detected language of `text` (lowercase BCP 47, e.g. "en", "zh-hans"). */
  source_lang?: string | null;
  /** Translations of exactly this `text`; dropped if a newer edit already won. */
  translations?: Partial<Record<Locale, FeedTranslationText>>;
}
export interface FeedTranslationText {
  text: string;
  source_lang?: string | null;
  model?: string | null;
  provider?: string | null;
}
export interface FeedTranslationInput extends FeedTranslationText {
  locale: Locale;
}
export interface FeedTranslationUpsert {
  post_id: string;
  /** Optimistic guard: rejects with stale_content_version unless it is still current. */
  content_version?: number;
  translations: FeedTranslationInput[];
}
export interface FeedListOptions {
  channel: FeedChannel;
  viewer?: FeedViewer | null;
  locale?: Locale | null;
  cursor?: string;
  limit?: number;
}
export interface FeedPageOptions {
  viewer?: FeedViewer | null;
  locale?: Locale | null;
  cursor?: string;
  limit?: number;
}
export interface QualifiedViewInput {
  post_id: string;
  actor_key: string;
  event_id: string;
  view_date: string;
}
export interface MediaRegistration {
  id: string;
  owner_user_id: string;
  url: string;
  mime_type: string;
  storage_key: string;
  size_bytes: number;
  alt_text?: string | null;
  width?: number | null;
  height?: number | null;
}
export interface FeedMediaAsset extends MediaRegistration {
  status: "ready" | "deleted";
  created_at: string;
}
export type FeedQuotaOperation = "publish" | "interact" | "view" | "upload" | "ingest" | "ingest_hour";
export interface SocialFeedRepository {
  getPost(id: string, viewer?: FeedViewer | null, locale?: Locale | null): Promise<FeedPost | null>;
  listPosts(options: FeedListOptions): Promise<FeedPage>;
  listReplies(parentId: string, options?: FeedPageOptions): Promise<FeedPage>;
  listAncestors(id: string, viewer?: FeedViewer | null, locale?: Locale | null): Promise<FeedPost[]>;
  createNativePost(input: NativePostInput): Promise<FeedPost>;
  findPublication(userId: string, key: string, payloadHash: string, viewer?: FeedViewer | null): Promise<FeedPost | null>;
  ingestXPost(input: XPostInput): Promise<FeedPost>;
  /** Returns the content_version the translations were stored under. */
  upsertPostTranslations(input: FeedTranslationUpsert): Promise<{ post_id: string; content_version: number; locales: Locale[] }>;
  deleteNativePost(id: string, actor: FeedActor): Promise<FeedPost>;
  setReaction(id: string, actor: FeedActor, value: FeedReaction | null): Promise<FeedPost>;
  setBookmark(id: string, actor: FeedActor, enabled: boolean): Promise<FeedPost>;
  setRepost(id: string, actor: FeedActor, enabled: boolean): Promise<FeedPost>;
  setFollow(authorId: string, actor: FeedActor, enabled: boolean): Promise<void>;
  recordQualifiedView(input: QualifiedViewInput): Promise<boolean>;
  consumeQuota(actorKey: string, operation: FeedQuotaOperation, now?: Date): Promise<boolean>;
  getAuthorSummary(id: string, viewerId?: string): Promise<FeedAuthorSummary | null>;
  upsertAuthor(author: FeedAuthorInput): Promise<FeedAuthor>;
  registerMedia(input: MediaRegistration): Promise<FeedMedia>;
  getMediaAsset(id: string): Promise<FeedMediaAsset | null>;
  canReadMedia(id: string, userId?: string): Promise<boolean>;
  setXAuthorEligibility(githubUserId: string, eligible: boolean): Promise<void>;
}
export class SocialFeedError extends Error {
  constructor(public readonly code: string, public readonly status: number, message = code) {
    super(message);
    this.name = "SocialFeedError";
  }
}
