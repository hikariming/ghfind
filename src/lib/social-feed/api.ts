import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isLocale, type Locale } from "@ghfind/i18n";
import { OAUTH_SESSION_COOKIE, readGitHubSession } from "@/lib/oauth-session";
import { readBoundedBody } from "@/lib/feed-gateway";
import { SocialFeedError, FEED_MAX_MEDIA, type FeedActor, type FeedMedia, type FeedPage, type FeedPost, type FeedQuotaOperation, type FeedViewer, type QualifiedViewInput, type PostInput, type XPostInput, type FeedTranslationText } from "./contract";
import { getSocialFeedRepository, nativePublicationHash } from "./repository";
import { normalizeSourceLang, validateTranslations } from "./translations";
import { githubProfileXUrl } from "./github-profile";
import { publishingCapabilities, readDisplayScore, requirePublication, xIngestPublication } from "./eligibility";

const MAX_NATIVE_TEXT = 5_000;
const VISITOR_COOKIE = "ghfind_feed_visitor";
const VIEW_TOKEN_LIFETIME = 30 * 60_000;
const NATIVE_BODY_LIMIT = 64 * 1024;
interface RouteContext { params: Promise<{ id: string }> }
interface ViewClaims { actor_key: string; post_id: string; issued_at: number; expires_at: number }
interface VisitorClaims { id: string; expires_at: number }
interface ReadContext { actor: FeedActor | null; viewer: FeedViewer | null; actor_key: string | null; locale: Locale | null; cookie?: string }

function cookies(request: Request): Map<string, string> {
  return new Map((request.headers.get("cookie") ?? "").split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator > 0 ? [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]] : [];
  }));
}

/** The signed GitHub session, never a client-supplied login or score, identifies writers. */
export function feedActor(request: Request): FeedActor | null {
  const session = readGitHubSession(cookies(request).get(OAUTH_SESSION_COOKIE));
  if (!session) return null;
  return { user_id: `github:${session.github_id}`, github_user_id: String(session.github_id), github_login: session.login,
    name: session.login, avatar_url: session.avatar_url ?? null };
}

export function requireFeedActor(request: Request): FeedActor {
  const actor = feedActor(request);
  if (!actor) throw new SocialFeedError("authentication_required", 401);
  return actor;
}

/** A dedicated configured frontend origin also supports a local Vite API proxy. */
export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const allowed = new Set([new URL(request.url).origin]);
  const configured = process.env.SOCIAL_FEED_PUBLIC_ORIGIN;
  if (configured) {
    try { allowed.add(new URL(configured).origin); } catch { throw new SocialFeedError("feed_unavailable", 503); }
  }
  if (!origin || !allowed.has(origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new SocialFeedError("cross_origin_request", 403);
  }
}

/** Env kill switches: unset/empty/"0"/"false"/"off" are disabled (default off). */
function envFlagEnabled(name: string): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return false;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}
export function requireSocialFeedPublishEnabled(): void {
  if (!envFlagEnabled("SOCIAL_FEED_PUBLISH_ENABLED")) throw new SocialFeedError("feature_disabled", 503);
}
export function requireSocialFeedIngestEnabled(): void {
  if (!envFlagEnabled("SOCIAL_FEED_INGEST_ENABLED")) throw new SocialFeedError("feature_disabled", 503);
}

export function socialFeedJson(body: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "Vary": "Cookie" });
  if (cookie) headers.set("Set-Cookie", cookie);
  if (status === 429) headers.set("Retry-After", "60");
  return new Response(JSON.stringify(body), { status, headers });
}

export async function socialFeedRoute(work: () => Promise<Response>): Promise<Response> {
  try { return await work(); }
  catch (error) {
    if (error instanceof SocialFeedError) return socialFeedJson({ error: error.code }, error.status);
    // Neither imported content nor request/session values belong in failure logs.
    console.error("social_feed.request_failed");
    return socialFeedJson({ error: "feed_unavailable" }, 503);
  }
}

function signingSecret(): string | null {
  const secret = process.env.SOCIAL_FEED_SIGNING_SECRET ?? process.env.AUTH_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}
function sign(kind: "visitor" | "view" | "cursor", value: unknown): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`ghfind:social-feed:${kind}:${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}
function verify(kind: "visitor" | "view" | "cursor", value: string | undefined): unknown {
  const secret = signingSecret();
  if (!secret || !value || value.length > 2048) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const expected = createHmac("sha256", secret).update(`ghfind:social-feed:${kind}:${parts[0]}`).digest("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/.test(parts[1]) || !timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;
  try { return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { return null; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SocialFeedError("invalid_body", 400);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new SocialFeedError("unexpected_field", 400);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
/** Page locale for body translations; absent means original text only. */
export function requestLocale(request: Request): Locale | null {
  const value = new URL(request.url).searchParams.get("locale");
  if (value === null) return null;
  if (!isLocale(value)) throw new SocialFeedError("invalid_locale", 400);
  return value;
}
async function readContext(request: Request, createVisitor = true, includeCapabilities = true): Promise<ReadContext> {
  const locale = requestLocale(request);
  const actor = feedActor(request);
  if (actor) {
    let canReply = false;
    if (includeCapabilities) {
      try { canReply = (await publishingCapabilities(actor)).can_reply; }
      catch { /* Optional UI capability must never prevent reading or ordinary interactions. */ }
    }
    return { actor, viewer: { user_id: actor.user_id, can_reply: canReply }, actor_key: actor.user_id, locale };
  }
  const value = verify("visitor", cookies(request).get(VISITOR_COOKIE));
  if (isObject(value) && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id) &&
      typeof value.expires_at === "number" && value.expires_at > Date.now()) {
    return { actor: null, viewer: null, actor_key: `visitor:${value.id}`, locale };
  }
  if (!createVisitor) return { actor: null, viewer: null, actor_key: null, locale };
  const visitor: VisitorClaims = { id: randomUUID(), expires_at: Date.now() + 7 * 86_400_000 };
  const token = sign("visitor", visitor);
  if (!token) return { actor: null, viewer: null, actor_key: null, locale };
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return { actor: null, viewer: null, actor_key: `visitor:${visitor.id}`, locale,
    cookie: `${VISITOR_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}` };
}
function withView(post: FeedPost, context: ReadContext): FeedPost {
  if (post.status !== "published" || !context.actor_key) return post;
  const now = Date.now();
  const claims: ViewClaims = { actor_key: context.actor_key, post_id: post.id, issued_at: now, expires_at: now + VIEW_TOKEN_LIFETIME };
  const token = sign("view", claims);
  return token ? { ...post, view_token: token } : post;
}
function pageResponse(page: FeedPage, context: ReadContext, scope: string): Response {
  let cursor: string | null = null;
  if (page.next_cursor) {
    cursor = sign("cursor", { cursor: page.next_cursor, scope, actor_key: context.actor_key, expires_at: Date.now() + VIEW_TOKEN_LIFETIME });
    if (!cursor) throw new SocialFeedError("feed_signing_unavailable", 503);
  }
  return socialFeedJson({ ...page, next_cursor: cursor, items: page.items.map((post) => withView(post, context)) }, 200, context.cookie);
}

async function mutationResponse(request: Request, post: FeedPost, status = 200): Promise<Response> {
  const context = await readContext(request);
  const current = await getSocialFeedRepository().getPost(post.id, context.viewer, context.locale);
  if (!current) throw new SocialFeedError("post_not_found", 404);
  return socialFeedJson(withView(current, context), status, context.cookie);
}
async function body(request: Request, limit = NATIVE_BODY_LIMIT): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new SocialFeedError("invalid_content_type", 415);
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new SocialFeedError("body_too_large", 413);
  let bytes: Uint8Array;
  try { bytes = await readBoundedBody(request.body, limit); }
  catch { throw new SocialFeedError("invalid_body", 400); }
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch (error) { if (error instanceof SocialFeedError) throw error; throw new SocialFeedError("invalid_body", 400); }
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:-]{1,160}$/.test(value)) throw new SocialFeedError("invalid_id", 400);
  return value;
}
async function idFrom(context: RouteContext): Promise<string> { return identifier((await context.params).id); }
function postInput(value: Record<string, unknown>): PostInput {
  keys(value, ["text", "media_ids"]);
  if (typeof value.text !== "string" || [...value.text].length > MAX_NATIVE_TEXT || /[\u0000\u0008\u000b\u000c]/.test(value.text)) throw new SocialFeedError("invalid_text", 400);
  const media = value.media_ids ?? [];
  if (!Array.isArray(media) || media.length > FEED_MAX_MEDIA || media.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_:-]{1,160}$/.test(id)) || new Set(media).size !== media.length) throw new SocialFeedError("invalid_media", 400);
  if (!value.text.trim() && media.length === 0) throw new SocialFeedError("empty_post", 400);
  return { text: value.text, media_ids: media };
}
function idempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9_:-]{8,128}$/.test(key)) throw new SocialFeedError("idempotency_key_required", 400);
  return key;
}
export async function consumeFeedQuota(actorKey: string, operation: FeedQuotaOperation): Promise<void> {
  if (!(await getSocialFeedRepository().consumeQuota(actorKey, operation))) throw new SocialFeedError("rate_limited", 429);
}
function pagination(request: Request, context: ReadContext, scope: string): { cursor?: string; limit?: number } {
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) throw new SocialFeedError("invalid_pagination", 400);
  const rawCursor = params.get("cursor");
  if (!rawCursor) return { limit };
  const token = verify("cursor", rawCursor);
  if (!isObject(token) || token.actor_key !== context.actor_key || token.scope !== scope ||
      typeof token.cursor !== "string" || token.cursor.length > 2048 || typeof token.expires_at !== "number") {
    throw new SocialFeedError("invalid_cursor", 400);
  }
  if (token.expires_at <= Date.now()) throw new SocialFeedError("feed_cursor_expired", 410);
  return { cursor: token.cursor, limit };
}

export interface FeedReadContext {
  request_id: string;
  viewer: FeedViewer | null;
  locale?: Locale | null;
  channel: "recommended" | "following";
  cursor?: string;
  limit?: number;
}
/** Ranking may replace order later; content ownership, authorization and delivery checks stay here. */
export interface SocialFeedProvider {
  readPage(context: FeedReadContext): Promise<FeedPage>;
  recordQualifiedView(input: QualifiedViewInput): Promise<boolean>;
}
export const chronologicalFeedProvider: SocialFeedProvider = {
  readPage: (context) => getSocialFeedRepository().listPosts(context),
  recordQualifiedView: (input) => getSocialFeedRepository().recordQualifiedView(input),
};
export function createFeedReadHandler(provider: SocialFeedProvider): (request: Request) => Promise<Response> {
  return (request) => socialFeedRoute(async () => {
    const context = await readContext(request);
    const channel = new URL(request.url).searchParams.get("channel") ?? "recommended";
    if (channel !== "recommended" && channel !== "following") throw new SocialFeedError("invalid_channel", 400);
    if (channel === "following" && !context.actor) throw new SocialFeedError("authentication_required", 401);
    const page = await provider.readPage({ request_id: randomUUID(), channel, viewer: context.viewer, locale: context.locale, ...pagination(request, context, channel) });
    return pageResponse(page, context, channel);
  });
}
export const listPosts = createFeedReadHandler(chronologicalFeedProvider);

export function getPost(request: Request, params: RouteContext): Promise<Response> {
  return socialFeedRoute(async () => {
    const context = await readContext(request);
    const post = await getSocialFeedRepository().getPost(await idFrom(params), context.viewer, context.locale);
    if (!post) throw new SocialFeedError("post_not_found", 404);
    return socialFeedJson(withView(post, context), 200, context.cookie);
  });
}
export function listReplies(request: Request, params: RouteContext): Promise<Response> {
  return socialFeedRoute(async () => {
    const context = await readContext(request);
    const id = await idFrom(params);
    const scope = `replies:${id}`;
    return pageResponse(await getSocialFeedRepository().listReplies(id, { viewer: context.viewer, locale: context.locale, ...pagination(request, context, scope) }), context, scope);
  });
}
export function listAncestors(request: Request, params: RouteContext): Promise<Response> {
  return socialFeedRoute(async () => {
    const context = await readContext(request);
    const items = await getSocialFeedRepository().listAncestors(await idFrom(params), context.viewer, context.locale);
    return socialFeedJson({ items: items.map((post) => withView(post, context)) }, 200, context.cookie);
  });
}
export function getAuthorSummary(request: Request, params: RouteContext): Promise<Response> {
  return socialFeedRoute(async () => {
    const summary = await getSocialFeedRepository().getAuthorSummary(await idFrom(params), feedActor(request)?.user_id);
    if (!summary) throw new SocialFeedError("author_not_found", 404);
    // Display path: final_score only — no public_scan_runs.snapshot join (P0-7).
    const score = await readDisplayScore(summary.author.github_login);
    if (score && !score.hidden && Number.isFinite(score.final_score) && score.final_score >= 0 && score.final_score <= 100) {
      summary.score = score.final_score;
    }
    if (!summary.x_url) summary.x_url = await githubProfileXUrl(summary.author.id.replace(/^gha_/, ""));
    return socialFeedJson(summary);
  });
}
export function getCapabilities(request: Request): Promise<Response> {
  return socialFeedRoute(async () => socialFeedJson(await publishingCapabilities(feedActor(request))));
}
export function listBookmarks(request: Request): Promise<Response> {
  return socialFeedRoute(async () => {
    requireFeedActor(request);
    const context = await readContext(request);
    return pageResponse(await getSocialFeedRepository().listPosts({ channel: "bookmarks", viewer: context.viewer, locale: context.locale, ...pagination(request, context, "bookmarks") }), context, "bookmarks");
  });
}
export function createPost(request: Request, params?: RouteContext): Promise<Response> {
  return socialFeedRoute(async () => {
    requireSameOrigin(request);
    const actor = requireFeedActor(request);
    const input = postInput(await body(request));
    const key = idempotencyKey(request);
    const parent = params ? await idFrom(params) : undefined;
    const repository = getSocialFeedRepository();
    const payloadHash = await nativePublicationHash(input, parent);
    // A successful command remains successful even if its author later loses eligibility.
    const existing = await repository.findPublication(actor.user_id, key, payloadHash, { user_id: actor.user_id, can_reply: false });
    if (existing) return mutationResponse(request, existing);
    requireSocialFeedPublishEnabled();
    const publication = await requirePublication(actor);
    await consumeFeedQuota(actor.user_id, "publish");
    const post = await repository.createNativePost({ actor, publication, input, idempotency_key: key, parent_post_id: parent });
    return mutationResponse(request, post, 201);
  });
}
export function deletePost(request: Request, params: RouteContext): Promise<Response> {
  return socialFeedRoute(async () => {
    requireSameOrigin(request);
    const actor = requireFeedActor(request);
    await consumeFeedQuota(actor.user_id, "interact");
    return mutationResponse(request, await getSocialFeedRepository().deleteNativePost(await idFrom(params), actor));
  });
}
export function setReaction(request: Request, params: RouteContext): Promise<Response> {
  return socialFeedRoute(async () => {
    requireSameOrigin(request);
    const actor = requireFeedActor(request);
    let value: "like" | "dislike" | null = null;
    if (request.method === "PUT") {
      const input = await body(request);
      keys(input, ["value"]);
      if (input.value !== "like" && input.value !== "dislike") throw new SocialFeedError("invalid_reaction", 400);
      value = input.value;
    }
    await consumeFeedQuota(actor.user_id, "interact");
    return mutationResponse(request, await getSocialFeedRepository().setReaction(await idFrom(params), actor, value));
  });
}
export function setBookmark(request: Request, params: RouteContext): Promise<Response> {
  return socialFeedRoute(async () => {
    requireSameOrigin(request);
    const actor = requireFeedActor(request);
    await consumeFeedQuota(actor.user_id, "interact");
    return mutationResponse(request, await getSocialFeedRepository().setBookmark(await idFrom(params), actor, request.method === "PUT"));
  });
}
export function setRepost(request: Request, params: RouteContext): Promise<Response> {
  return socialFeedRoute(async () => {
    requireSameOrigin(request);
    const actor = requireFeedActor(request);
    await consumeFeedQuota(actor.user_id, "interact");
    return mutationResponse(request, await getSocialFeedRepository().setRepost(await idFrom(params), actor, request.method === "PUT"));
  });
}
export function setFollow(request: Request, params: RouteContext): Promise<Response> {
  return socialFeedRoute(async () => {
    requireSameOrigin(request);
    const actor = requireFeedActor(request);
    await consumeFeedQuota(actor.user_id, "interact");
    const enabled = request.method === "PUT";
    await getSocialFeedRepository().setFollow(await idFrom(params), actor, enabled);
    return socialFeedJson({ following: enabled });
  });
}
export function recordView(request: Request): Promise<Response> {
  return socialFeedRoute(async () => {
    requireSameOrigin(request);
    const context = await readContext(request, false, false);
    if (!context.actor_key) throw new SocialFeedError("invalid_view_token", 400);
    const input = await body(request);
    keys(input, ["event_id", "event_type", "post_id", "view_token"]);
    if (input.event_type !== "qualified_view" || typeof input.event_id !== "string" || !/^[a-f0-9-]{36}$/i.test(input.event_id)) throw new SocialFeedError("invalid_event", 400);
    const token = verify("view", typeof input.view_token === "string" ? input.view_token : undefined);
    const now = Date.now();
    if (!isObject(token) || token.actor_key !== context.actor_key || token.post_id !== input.post_id ||
        typeof token.issued_at !== "number" || typeof token.expires_at !== "number" ||
        token.expires_at <= now || now - token.issued_at < 2000 || now - token.issued_at > VIEW_TOKEN_LIFETIME) {
      throw new SocialFeedError("invalid_view_token", 400);
    }
    if (/bot|crawler|spider|headless/i.test(request.headers.get("user-agent") ?? "")) return socialFeedJson({ recorded: false });
    await consumeFeedQuota(context.actor_key, "view");
    const recorded = await chronologicalFeedProvider.recordQualifiedView({ post_id: identifier(input.post_id), actor_key: context.actor_key,
      event_id: input.event_id, view_date: new Date(now).toISOString().slice(0, 10) });
    return socialFeedJson({ recorded });
  });
}

function requiredText(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > max) throw new SocialFeedError("invalid_body", 400);
  return value;
}
function sourceId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,24}$/.test(value)) throw new SocialFeedError("invalid_source_id", 400);
  return value;
}
function httpsUrl(value: unknown, hosts?: readonly string[]): string {
  const text = requiredText(value, 2048);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || (hosts && !hosts.includes(url.hostname))) throw new Error();
    return url.href;
  } catch { throw new SocialFeedError("invalid_source_url", 400); }
}
function nullableAvatar(value: unknown): string | null {
  return value === null || value === undefined ? null : httpsUrl(value, ["pbs.twimg.com", "avatars.githubusercontent.com"]);
}
function ingestMedia(value: unknown): FeedMedia[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > FEED_MAX_MEDIA) throw new SocialFeedError("invalid_media", 400);
  return value.map((raw) => {
    const media = object(raw);
    keys(media, ["id", "type", "url", "alt_text", "width", "height"]);
    if (media.type !== "image") throw new SocialFeedError("invalid_media", 400);
    const dimension = (input: unknown): number | null => {
      if (input === null || input === undefined) return null;
      if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 30_000) throw new SocialFeedError("invalid_media", 400);
      return input;
    };
    return { id: identifier(media.id), type: "image", url: httpsUrl(media.url, ["pbs.twimg.com"]),
      alt_text: media.alt_text === null || media.alt_text === undefined ? null : requiredText(media.alt_text, 2000),
      width: dimension(media.width), height: dimension(media.height) };
  });
}
/** `{ "<locale>": { text, source_lang?, model?, provider? } }`; unknown locales are rejected, never dropped. */
function ingestTranslations(value: unknown): XPostInput["translations"] {
  if (value === undefined) return undefined;
  const map = object(value);
  const items = validateTranslations(Object.entries(map).map(([locale, raw]) => ({ ...object(raw), locale }) as never));
  return Object.fromEntries(items.map(({ locale, ...rest }) => [locale, rest])) as Partial<Record<Locale, FeedTranslationText>>;
}
export function ingestX(request: Request): Promise<Response> {
  return socialFeedRoute(async () => {
    requireSocialFeedIngestEnabled();
    const secret = process.env.SOCIAL_FEED_INGEST_SECRET;
    const presented = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!secret || secret.length < 32 || !presented || Buffer.byteLength(presented) !== Buffer.byteLength(secret) ||
        !timingSafeEqual(Buffer.from(presented), Buffer.from(secret))) throw new SocialFeedError("authentication_required", 401);
    const input = await body(request, 2 * 1024 * 1024);
    keys(input, ["author", "source", "text", "media", "published_at", "parent_post_id", "source_lang", "translations"]);
    const author = object(input.author);
    keys(author, ["github_user_id", "github_login", "name", "avatar_url"]);
    const login = requiredText(author.github_login, 39).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login)) throw new SocialFeedError("invalid_author", 400);
    const source = object(input.source);
    keys(source, ["post_id", "author_id", "url", "display_name", "avatar_url", "edit_history_post_ids", "evidence_url", "evidence_method", "evidence_checked_at"]);
    const postId = sourceId(source.post_id);
    const sourceUrl = httpsUrl(source.url, ["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
    if (!new RegExp(`^/(?:[A-Za-z0-9_]{1,15}|i/web)/status/${postId}$`).test(new URL(sourceUrl).pathname) || new URL(sourceUrl).search || new URL(sourceUrl).hash) throw new SocialFeedError("invalid_source_url", 400);
    if (source.evidence_method !== "editorial_review" && source.evidence_method !== "reciprocal_links") throw new SocialFeedError("identity_review_required", 400);
    const evidenceUrl = httpsUrl(source.evidence_url, ["github.com", "x.com", "www.x.com"]);
    const checked = requiredText(source.evidence_checked_at, 40);
    const checkedAt = Date.parse(checked);
    if (!Number.isFinite(checkedAt) || checkedAt > Date.now() + 60_000) throw new SocialFeedError("invalid_identity_evidence", 400);
    const published = requiredText(input.published_at, 40);
    if (!Number.isFinite(Date.parse(published)) || Date.parse(published) > Date.now() + 60_000) throw new SocialFeedError("invalid_published_at", 400);
    const history = source.edit_history_post_ids ?? [postId];
    if (!Array.isArray(history) || history.length > 20 || !history.includes(postId)) throw new SocialFeedError("invalid_edit_history", 400);
    const media = ingestMedia(input.media);
    if (typeof input.text !== "string" || [...input.text].length > 100_000 || (!input.text.trim() && media.length === 0)) {
      throw new SocialFeedError("invalid_text", 400);
    }
    const githubUserId = sourceId(author.github_user_id);
    await consumeFeedQuota("ingest:global", "ingest");
    await consumeFeedQuota("ingest:global", "ingest_hour");
    await consumeFeedQuota(`ingest:author:${githubUserId}`, "ingest");
    const publication = await xIngestPublication(login, githubUserId);
    const post: XPostInput = {
      author: { github_user_id: githubUserId, github_login: login, name: requiredText(author.name, 200), avatar_url: nullableAvatar(author.avatar_url) },
      publication,
      source: { post_id: postId, author_id: sourceId(source.author_id), url: sourceUrl,
        display_name: requiredText(source.display_name, 200), avatar_url: nullableAvatar(source.avatar_url), edit_history_post_ids: history.map(sourceId),
        evidence_url: evidenceUrl, evidence_method: source.evidence_method, evidence_checked_at: new Date(checkedAt).toISOString() },
      text: input.text, media, published_at: new Date(published).toISOString(),
      parent_post_id: input.parent_post_id === undefined ? undefined : identifier(input.parent_post_id),
      source_lang: normalizeSourceLang(input.source_lang),
      translations: ingestTranslations(input.translations),
    };
    return socialFeedJson(await getSocialFeedRepository().ingestXPost(post), 201);
  });
}
