import type { Client, InStatement, InValue } from "@libsql/client/web";
import type { Locale } from "@ghfind/i18n";
import { d1AsLibsqlClient, getFeedD1Binding } from "@/lib/d1-client";
import {
  FEED_DEFAULT_PAGE_SIZE,
  FEED_INGEST_AUTHOR_PER_MINUTE,
  FEED_INGEST_GLOBAL_PER_HOUR,
  FEED_INGEST_GLOBAL_PER_MINUTE,
  FEED_MAX_MEDIA,
  FEED_MAX_PAGE_SIZE,
  FEED_MAX_TEXT_LENGTH,
  FEED_MAX_X_TEXT_LENGTH,
  FEED_MINIMUM_SCORE,
  SocialFeedError,
  type FeedActor,
  type FeedAuthorSummary,
  type FeedAuthor,
  type FeedAuthorInput,
  type FeedListOptions,
  type FeedMedia,
  type FeedMediaAsset,
  type FeedPage,
  type FeedPageOptions,
  type FeedPost,
  type FeedQuotaOperation,
  type FeedReaction,
  type FeedTranslationInput,
  type FeedTranslationUpsert,
  type FeedViewer,
  type MediaRegistration,
  type NativePostInput,
  type PostInput,
  type PublicationEvidence,
  type QualifiedViewInput,
  type SocialFeedRepository,
  type XPostInput,
} from "./contract";
import { normalizeSourceLang, sameLanguage, validateTranslations } from "./translations";

type DbRow = Record<string, unknown>;
interface Cursor {
  version: 1;
  scope: string;
  time: string;
  id: string;
  as_of: string;
  session_id?: string;
  position?: number;
}
const TIMELINE_SNAPSHOT_LIMIT = 200;
const TIMELINE_SNAPSHOT_LIFETIME_MS = 30 * 60_000;
const nowIso = () => new Date().toISOString();
const nullableText = (value: unknown): string | null => value == null ? null : String(value);
const numberValue = (value: unknown): number => Number(value ?? 0);
const actorViewer = (actor: FeedActor): FeedViewer => ({ user_id: actor.user_id, can_reply: false });
const authorId = (githubId: string): string => `gha_${githubId}`;
/** Fallback author label for X posts whose author row is unavailable. */
const xHandle = (url: unknown): string | null => {
  const match = typeof url === "string" ? /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\//.exec(url) : null;
  return match && match[1] !== "i" ? match[1] : null;
};
const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(",");

function validateAuthor(author: FeedAuthorInput): void {
  if (!/^\d+$/.test(author.github_user_id) || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(author.github_login)) {
    throw new SocialFeedError("invalid_author", 400);
  }
  if (!author.name || author.name.length > 200) throw new SocialFeedError("invalid_author", 400);
}
function validateEvidence(evidence: PublicationEvidence): void {
  if (!Number.isFinite(evidence.score) || evidence.score < FEED_MINIMUM_SCORE || evidence.score > 100) {
    throw new SocialFeedError("score_below_threshold", 403);
  }
  if (!evidence.score_record_id || !evidence.score_version || !evidence.policy_version) {
    throw new SocialFeedError("score_required", 403);
  }
}
function validatePostInput(input: PostInput): void {
  if (Object.keys(input).some((key) => key !== "text" && key !== "media_ids")) {
    throw new SocialFeedError("invalid_post_fields", 400);
  }
  if (typeof input.text !== "string" || [...input.text].length > FEED_MAX_TEXT_LENGTH) {
    throw new SocialFeedError("invalid_text", 400);
  }
  const ids = input.media_ids ?? [];
  if (!Array.isArray(ids) || ids.length > FEED_MAX_MEDIA || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
    throw new SocialFeedError("invalid_media", 400);
  }
  if (!input.text.trim() && ids.length === 0) throw new SocialFeedError("empty_post", 400);
}
export async function nativePublicationHash(input: PostInput, parentPostId?: string): Promise<string> {
  validatePostInput(input);
  const payload = JSON.stringify({ text: input.text, media_ids: input.media_ids ?? [], parent_post_id: parentPostId ?? null });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
function translateDatabaseError(error: unknown): never {
  if (error instanceof SocialFeedError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  for (const [code, status] of [
    ["idempotency_conflict", 409], ["invalid_reply_target", 409], ["invalid_media", 400],
    ["source_conflict", 409], ["invalid_x_source", 400], ["immutable_post_identity", 409],
    ["post_not_available", 404],
  ] as const) {
    if (message.includes(code)) throw new SocialFeedError(code, status);
  }
  throw error;
}
function encodeCursor(cursor: Cursor): string { return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function decodeCursor(value: string | undefined, scope: string): Cursor | undefined {
  if (!value) return undefined;
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid");
    const decoded = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/"))) as Cursor;
    if (decoded.version !== 1 || decoded.scope !== scope || typeof decoded.id !== "string" ||
      typeof decoded.time !== "string" || typeof decoded.as_of !== "string" ||
      !Number.isFinite(Date.parse(decoded.time)) || !Number.isFinite(Date.parse(decoded.as_of)) ||
      (decoded.session_id !== undefined && (typeof decoded.session_id !== "string" || !Number.isInteger(decoded.position) || decoded.position! < 0))) throw new Error("invalid");
    return decoded;
  } catch { throw new SocialFeedError("invalid_cursor", 400); }
}
function pageSize(limit?: number): number {
  if (limit === undefined) return FEED_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > FEED_MAX_PAGE_SIZE) throw new SocialFeedError("invalid_limit", 400);
  return limit;
}

/** Binds each row to the post's current version; `guard` adds extra WHERE conditions on `p`. */
function translationStatements(postId: string, items: readonly FeedTranslationInput[], at: string, guard: string, guardArgs: InValue[]): InStatement[] {
  return items.map((item) => ({ sql: `INSERT INTO social_feed_post_translations(post_id,content_version,locale,text,source_lang,model,provider,updated_at)
    SELECT p.id,p.content_version,?,?,?,?,?,? FROM social_feed_posts p WHERE p.id=? ${guard}
    ON CONFLICT(post_id,content_version,locale) DO UPDATE SET text=excluded.text,source_lang=excluded.source_lang,
      model=excluded.model,provider=excluded.provider,updated_at=excluded.updated_at`,
  args: [item.locale, item.text, item.source_lang ?? null, item.model ?? null, item.provider ?? null, at, postId, ...guardArgs] }));
}

/** No schema creation here: production uses the dedicated Feed D1 migration stream. */
export function getSocialFeedRepository(): SocialFeedRepository {
  const binding = getFeedD1Binding();
  if (!binding) throw new SocialFeedError("feed_unavailable", 503);
  return createRepository(d1AsLibsqlClient(binding));
}

export function createRepository(client: Client): SocialFeedRepository {
  async function query(sql: string, args: InValue[] = []): Promise<DbRow[]> {
    const result = await client.execute({ sql, args });
    return result.rows as unknown as DbRow[];
  }
  async function batch(statements: InStatement[]): Promise<void> {
    try { await client.batch(statements, "write"); } catch (error) { translateDatabaseError(error); }
  }
  function authorStatement(author: FeedAuthorInput, at: string): InStatement {
    validateAuthor(author);
    return { sql: `INSERT INTO social_feed_authors(id,github_user_id,github_login,display_name,avatar_url,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(github_user_id) DO UPDATE SET
      github_login=excluded.github_login,display_name=excluded.display_name,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at`,
      args: [authorId(author.github_user_id), author.github_user_id, author.github_login, author.name, author.avatar_url, at] };
  }
  function actorStatements(actor: FeedActor, at: string): InStatement[] {
    if (!actor.user_id) throw new SocialFeedError("authentication_required", 401);
    return [authorStatement(actor, at), {
      sql: "INSERT INTO social_feed_accounts(user_id,author_id) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET author_id=excluded.author_id",
      args: [actor.user_id, authorId(actor.github_user_id)],
    }];
  }
  async function getAuthorSummary(id: string, viewerId?: string): Promise<FeedAuthorSummary | null> {
    const [row] = await query(`SELECT a.*,
      (SELECT x.x_user_id FROM social_feed_x_accounts x WHERE x.author_id=a.id ORDER BY x.updated_at DESC LIMIT 1) AS x_user_id,
      (SELECT p.source_url FROM social_feed_posts p JOIN social_feed_x_accounts x ON x.x_user_id=p.source_x_user_id WHERE x.x_user_id=(SELECT x2.x_user_id FROM social_feed_x_accounts x2 WHERE x2.author_id=a.id ORDER BY x2.updated_at DESC LIMIT 1) AND p.source_url IS NOT NULL ORDER BY p.published_at DESC LIMIT 1) AS x_post_url,
      (SELECT COUNT(*) FROM social_feed_follows f WHERE f.author_id=a.id) AS followers,
      (SELECT COUNT(*) FROM social_feed_follows f WHERE f.user_id='github:'||a.github_user_id) AS following,
      EXISTS(SELECT 1 FROM social_feed_follows f JOIN social_feed_accounts me ON me.author_id=f.author_id
        WHERE f.user_id='github:'||a.github_user_id AND me.user_id=?) AS follows_you
      FROM social_feed_authors a WHERE a.id=?`, [viewerId ?? null, id]);
    if (!row) return null;
    const xHandle = typeof row.x_post_url === "string" ? /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\/\d+\/?$/i.exec(row.x_post_url)?.[1] : undefined;
    return { author: { id: String(row.id), github_login: String(row.github_login), name: String(row.display_name), avatar_url: nullableText(row.avatar_url) },
      followers: Number(row.followers), following: Number(row.following), follows_you: Boolean(row.follows_you), x_handle: xHandle ?? null, x_url: row.x_user_id ? `https://x.com/i/user/${encodeURIComponent(String(row.x_user_id))}` : null, score: null };
  }
  async function upsertAuthor(author: FeedAuthorInput): Promise<FeedAuthor> {
    await batch([authorStatement(author, nowIso())]);
    return { id: authorId(author.github_user_id), github_login: author.github_login, name: author.name, avatar_url: author.avatar_url };
  }
  async function hydrate(ids: string[], viewer?: FeedViewer | null, locale?: Locale | null): Promise<FeedPost[]> {
    if (!ids.length) return [];
    if (ids.length > FEED_MAX_PAGE_SIZE) {
      // Long reply ancestry must not exceed D1's bound-parameter limit.
      const posts: FeedPost[] = [];
      for (let offset = 0; offset < ids.length; offset += FEED_MAX_PAGE_SIZE) {
        posts.push(...await hydrate(ids.slice(offset, offset + FEED_MAX_PAGE_SIZE), viewer, locale));
      }
      return posts;
    }
    const rows = await query(`SELECT p.*,a.github_login,a.display_name,a.avatar_url,
      root.status AS root_status,tr.locale AS translation_locale,tr.text AS translation_text,tr.source_lang AS translation_source_lang,
      (SELECT value FROM social_feed_reactions r WHERE r.post_id=p.id AND r.user_id=?) AS viewer_reaction,
      EXISTS(SELECT 1 FROM social_feed_bookmarks b WHERE b.post_id=p.id AND b.user_id=?) AS viewer_bookmarked,
      EXISTS(SELECT 1 FROM social_feed_reposts r WHERE r.post_id=p.id AND r.user_id=?) AS viewer_reposted,
      EXISTS(SELECT 1 FROM social_feed_follows f WHERE f.author_id=p.author_id AND f.user_id=?) AS viewer_following
      FROM social_feed_posts p LEFT JOIN social_feed_authors a ON a.id=p.author_id
      JOIN social_feed_posts root ON root.id=p.conversation_id
      LEFT JOIN social_feed_post_translations tr ON tr.post_id=p.id AND tr.content_version=p.content_version AND tr.locale=?
      WHERE p.id IN (${placeholders(ids.length)}) AND p.status<>'hidden' AND root.status<>'hidden'`,
    [viewer?.user_id ?? null, viewer?.user_id ?? null, viewer?.user_id ?? null, viewer?.user_id ?? null, locale ?? null, ...ids]);
    // Bounded GROUP BY aggregations (one query per table) instead of per-post COUNT subqueries.
    const metricsByPost = new Map<string, { likes: number; reposts: number; direct_replies: number; conversation_replies: number; views: number }>();
    const ensureMetrics = (id: string) => {
      const current = metricsByPost.get(id) ?? { likes: 0, reposts: 0, direct_replies: 0, conversation_replies: 0, views: 0 };
      metricsByPost.set(id, current);
      return current;
    };
    for (const row of await query(`SELECT post_id, COUNT(*) AS n FROM social_feed_reactions
      WHERE post_id IN (${placeholders(ids.length)}) AND value='like' GROUP BY post_id`, ids)) {
      ensureMetrics(String(row.post_id)).likes = numberValue(row.n);
    }
    for (const row of await query(`SELECT post_id, COUNT(*) AS n FROM social_feed_reposts
      WHERE post_id IN (${placeholders(ids.length)}) GROUP BY post_id`, ids)) {
      ensureMetrics(String(row.post_id)).reposts = numberValue(row.n);
    }
    for (const row of await query(`SELECT parent_post_id AS post_id, COUNT(*) AS n FROM social_feed_posts
      WHERE parent_post_id IN (${placeholders(ids.length)}) AND origin='ghfind' AND status='published' GROUP BY parent_post_id`, ids)) {
      ensureMetrics(String(row.post_id)).direct_replies = numberValue(row.n);
    }
    for (const row of await query(`SELECT post_id, COUNT(*) AS n FROM social_feed_views
      WHERE post_id IN (${placeholders(ids.length)}) GROUP BY post_id`, ids)) {
      ensureMetrics(String(row.post_id)).views = numberValue(row.n);
    }
    const conversationIds = [...new Set(rows.map((row) => String(row.conversation_id)))];
    if (conversationIds.length) {
      const repliesByConversation = new Map((await query(`SELECT conversation_id, COUNT(*) AS n FROM social_feed_posts
        WHERE conversation_id IN (${placeholders(conversationIds.length)}) AND kind='reply' AND origin='ghfind' AND status='published'
        GROUP BY conversation_id`, conversationIds)).map((row) => [String(row.conversation_id), numberValue(row.n)]));
      for (const row of rows) {
        ensureMetrics(String(row.id)).conversation_replies = repliesByConversation.get(String(row.conversation_id)) ?? 0;
      }
    }
    const mediaRows = await query(`SELECT pm.post_id,m.*,pm.position FROM social_feed_post_media pm
      JOIN social_feed_media_assets m ON m.id=pm.media_id WHERE pm.post_id IN (${placeholders(ids.length)}) AND m.status='ready'
      ORDER BY pm.position`, ids);
    const mediaByPost = new Map<string, FeedMedia[]>();
    for (const row of mediaRows) {
      const postId = String(row.post_id);
      const items = mediaByPost.get(postId) ?? [];
      items.push(mediaFromRow(row)); mediaByPost.set(postId, items);
    }
    const mapped = new Map<string, FeedPost>();
    for (const row of rows) {
      const status = String(row.status) as FeedPost["status"];
      const origin = String(row.origin) as FeedPost["origin"];
      const sourceLang = nullableText(row.source_lang);
      // Only the current version joins; a translation into the source language is never offered.
      const translated = status === "published" && locale && row.translation_locale === locale &&
        !sameLanguage(sourceLang ?? nullableText(row.translation_source_lang), locale) && row.translation_text !== row.text;
      const post: FeedPost = {
        id: String(row.id), origin, kind: String(row.kind) as FeedPost["kind"],
        author: { publication_score: row.publication_score_version !== "unscored" ? Number(row.publication_score) : null,
          id: String(row.author_id), github_login: String(row.github_login ?? xHandle(row.source_url) ?? row.author_id),
          name: String((origin === "x" ? row.source_name : null) ?? row.display_name ?? xHandle(row.source_url) ?? row.author_id),
          avatar_url: nullableText(origin === "x" ? (row.source_avatar_url ?? row.avatar_url) : row.avatar_url) },
        text: status === "published" ? String(row.text) : "", source_lang: sourceLang,
        translation: translated ? { locale, text: String(row.translation_text), source_lang: nullableText(row.translation_source_lang) ?? sourceLang } : null,
        media: status !== "published" ? [] : origin === "x" ? JSON.parse(String(row.x_media_json)) as FeedMedia[] : mediaByPost.get(String(row.id)) ?? [],
        published_at: String(row.published_at), content_version: numberValue(row.content_version),
        conversation_id: String(row.conversation_id), parent_post_id: nullableText(row.parent_post_id),
        original_url: origin === "x" ? nullableText(row.source_url) : null, status,
        metrics: { origin: "ghfind", ...(metricsByPost.get(String(row.id)) ?? { likes: 0, reposts: 0, direct_replies: 0, conversation_replies: 0, views: 0 }) },
        viewer: viewer ? { reaction: nullableText(row.viewer_reaction) as FeedReaction | null,
          bookmarked: Boolean(row.viewer_bookmarked), reposted: Boolean(row.viewer_reposted), following_author: Boolean(row.viewer_following),
          can_reply: viewer.can_reply && status === "published" && row.root_status === "published",
          can_delete: origin === "ghfind" && row.publisher_user_id === viewer.user_id && status !== "deleted" } : null,
      };
      mapped.set(post.id, post);
    }
    return ids.flatMap((id) => { const post = mapped.get(id); return post ? [post] : []; });
  }
  async function getPost(id: string, viewer?: FeedViewer | null, locale?: Locale | null): Promise<FeedPost | null> {
    return (await hydrate([id], viewer, locale))[0] ?? null;
  }
  async function requiredPost(id: string, viewer?: FeedViewer | null, locale?: Locale | null): Promise<FeedPost> {
    const post = await getPost(id, viewer, locale);
    if (!post) throw new SocialFeedError("post_not_found", 404);
    return post;
  }
  async function buildPage(rows: DbRow[], limit: number, scope: string, asOf: string, viewer?: FeedViewer | null, locale?: Locale | null): Promise<FeedPage> {
    const selected = rows.slice(0, limit);
    const items = await hydrate(selected.map((row) => String(row.post_id)), viewer, locale);
    const activityByPost = new Map(selected.map((row) => [String(row.post_id), row]));
    for (const post of items) {
      const row = activityByPost.get(post.id);
      if (row?.reposter_author_id) {
        post.reposted_by = { id: String(row.reposter_author_id), github_login: String(row.reposter_login),
          name: String(row.reposter_name), avatar_url: nullableText(row.reposter_avatar) };
        post.reposted_at = String(row.sort_time);
      }
    }
    const last = selected.at(-1);
    return { items, algorithm_version: "chronological-v1", next_cursor: rows.length > limit && last
      ? encodeCursor({ version: 1, scope, time: String(last.sort_time), id: String(last.sort_id), as_of: asOf }) : null };
  }
  async function timelinePage(sessionId: string, afterPosition: number, scope: string, channel: "recommended" | "following", limit: number, viewer?: FeedViewer | null, locale?: Locale | null): Promise<FeedPage> {
    const session = (await query("SELECT * FROM social_feed_sessions WHERE id=? AND scope=? AND expires_at>?", [sessionId, scope, nowIso()]))[0];
    if (!session) throw new SocialFeedError("cursor_expired", 410);
    const rows = await query(`SELECT item.*,a.github_login AS reposter_login,a.display_name AS reposter_name,a.avatar_url AS reposter_avatar
      FROM social_feed_session_items item JOIN social_feed_posts p ON p.id=item.post_id
      LEFT JOIN social_feed_authors a ON a.id=item.reposter_author_id
      WHERE item.session_id=? AND item.position>? AND p.status='published' AND (p.origin='ghfind' OR p.source_eligible=1)
        AND (item.reposter_author_id IS NULL OR EXISTS(
          SELECT 1 FROM social_feed_reposts r JOIN social_feed_accounts account ON account.user_id=r.user_id
          WHERE r.post_id=p.id AND account.author_id=item.reposter_author_id AND r.created_at=item.sort_time))
        ${channel === "following" ? "AND EXISTS(SELECT 1 FROM social_feed_follows f WHERE f.user_id=? AND f.author_id=COALESCE(item.reposter_author_id,p.author_id))" : ""}
      ORDER BY item.position LIMIT ?`, [sessionId, afterPosition, ...(channel === "following" ? [viewer!.user_id] : []), limit + 1]);
    const page = await buildPage(rows, limit, scope, String(session.created_at), viewer, locale);
    const last = rows.slice(0, limit).at(-1);
    page.next_cursor = rows.length > limit && last ? encodeCursor({ version: 1, scope, time: String(last.sort_time),
      id: String(last.sort_id), as_of: String(session.created_at), session_id: sessionId, position: numberValue(last.position) }) : null;
    return page;
  }
  async function createTimelineSnapshot(rows: DbRow[], scope: string, channel: "recommended" | "following", limit: number, viewer?: FeedViewer | null, locale?: Locale | null): Promise<FeedPage> {
    const id = crypto.randomUUID();
    const at = nowIso();
    const expiresAt = new Date(Date.parse(at) + TIMELINE_SNAPSHOT_LIFETIME_MS).toISOString();
    const snapshot = rows.slice(0, TIMELINE_SNAPSHOT_LIMIT).map((row) => [row.post_id, row.sort_time, row.sort_id, row.reposter_author_id]);
    // Cleanup is bounded per new session; each parent cascades at most TIMELINE_SNAPSHOT_LIMIT rows.
    // One JSON parameter avoids a large batch or D1's bound-parameter limit.
    await batch([
      { sql: "DELETE FROM social_feed_sessions WHERE id IN (SELECT id FROM social_feed_sessions WHERE expires_at<=? ORDER BY expires_at LIMIT 200)", args: [at] },
      { sql: "INSERT INTO social_feed_sessions(id,scope,created_at,expires_at) VALUES(?,?,?,?)", args: [id, scope, at, expiresAt] },
      { sql: `INSERT INTO social_feed_session_items(session_id,position,post_id,sort_time,sort_id,reposter_author_id)
        SELECT ?,CAST(key AS INTEGER),json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]') FROM json_each(?)`,
        args: [id, JSON.stringify(snapshot)] },
    ]);
    return timelinePage(id, -1, scope, channel, limit, viewer, locale);
  }
  async function listPosts(options: FeedListOptions): Promise<FeedPage> {
    const { channel, viewer, locale } = options;
    if (!["recommended", "following", "bookmarks"].includes(channel)) throw new SocialFeedError("invalid_channel", 400);
    if (channel !== "recommended" && !viewer) throw new SocialFeedError("authentication_required", 401);
    const limit = pageSize(options.limit);
    const scope = `${channel}:${viewer?.user_id ?? "public"}`;
    const cursor = decodeCursor(options.cursor, scope);
    const asOf = cursor?.as_of ?? nowIso();
    if (channel !== "bookmarks" && cursor) {
      if (!cursor.session_id || cursor.position === undefined) throw new SocialFeedError("invalid_cursor", 400);
      return timelinePage(cursor.session_id, cursor.position, scope, channel, limit, viewer, locale);
    }
    const after = cursor ? "AND (sort_time < ? OR (sort_time = ? AND sort_id < ?))" : "";
    const afterArgs: InValue[] = cursor ? [cursor.time, cursor.time, cursor.id] : [];
    if (channel === "bookmarks") {
      const rows = await query(`SELECT p.id AS post_id,b.created_at AS sort_time,p.id AS sort_id
        FROM social_feed_bookmarks b JOIN social_feed_posts p ON p.id=b.post_id
        JOIN social_feed_posts root ON root.id=p.conversation_id
        WHERE b.user_id=? AND p.status<>'hidden' AND root.status<>'hidden' AND b.created_at<=?
        ${after} ORDER BY sort_time DESC,sort_id DESC LIMIT ?`, [viewer!.user_id, asOf, ...afterArgs, limit + 1]);
      return buildPage(rows, limit, scope, asOf, viewer, locale);
    }
    const followingOriginal = channel === "following" ? "AND EXISTS(SELECT 1 FROM social_feed_follows f WHERE f.user_id=? AND f.author_id=p.author_id)" : "";
    const followingRepost = channel === "following" ? "AND EXISTS(SELECT 1 FROM social_feed_follows f WHERE f.user_id=? AND f.author_id=account.author_id)" : "";
    // Bound each branch with ORDER BY published_at/created_at + LIMIT before UNION/window.
    // Never materialize the full published/repost set then truncate.
    const windowLimit = TIMELINE_SNAPSHOT_LIMIT;
    const args: InValue[] = [asOf];
    if (channel === "following") args.push(viewer!.user_id);
    args.push(windowLimit);
    args.push(asOf);
    if (channel === "following") args.push(viewer!.user_id);
    args.push(windowLimit);
    const rows = await query(`WITH recent_originals AS (
      SELECT p.id AS post_id,p.published_at AS sort_time,'post:'||p.id AS sort_id,NULL AS reposter_author_id,
        NULL AS reposter_login,NULL AS reposter_name,NULL AS reposter_avatar
      FROM social_feed_posts p WHERE p.status='published' AND p.kind='original'
        AND (p.origin='ghfind' OR p.source_eligible=1) AND p.published_at<=? ${followingOriginal}
      ORDER BY p.published_at DESC,p.id DESC LIMIT ?
    ), recent_reposts AS (
      SELECT p.id AS post_id,r.created_at AS sort_time,'repost:'||r.user_id||':'||p.id AS sort_id,account.author_id AS reposter_author_id,
        a.github_login AS reposter_login,a.display_name AS reposter_name,a.avatar_url AS reposter_avatar
      FROM social_feed_reposts r JOIN social_feed_posts p ON p.id=r.post_id
      JOIN social_feed_accounts account ON account.user_id=r.user_id JOIN social_feed_authors a ON a.id=account.author_id
      WHERE p.status='published' AND p.kind='original' AND (p.origin='ghfind' OR p.source_eligible=1)
        AND r.created_at<=? ${followingRepost}
      ORDER BY r.created_at DESC,r.user_id DESC,p.id DESC LIMIT ?
    ), activities AS (
      SELECT * FROM recent_originals UNION ALL SELECT * FROM recent_reposts
    ), chosen AS (
      SELECT *,ROW_NUMBER() OVER(PARTITION BY post_id ORDER BY sort_time DESC,sort_id DESC) AS position FROM activities
    ) SELECT * FROM chosen WHERE position=1 ${after} ORDER BY sort_time DESC,sort_id DESC LIMIT ?`, [...args, ...afterArgs, TIMELINE_SNAPSHOT_LIMIT]);
    return createTimelineSnapshot(rows, scope, channel, limit, viewer, locale);
  }
  async function listReplies(parentId: string, options: FeedPageOptions = {}): Promise<FeedPage> {
    await requiredPost(parentId, options.viewer, options.locale);
    const limit = pageSize(options.limit);
    const scope = `replies:${parentId}:${options.viewer?.user_id ?? "public"}`;
    const cursor = decodeCursor(options.cursor, scope);
    const asOf = cursor?.as_of ?? nowIso();
    const rows = await query(`SELECT id AS post_id,published_at AS sort_time,id AS sort_id FROM social_feed_posts
      WHERE parent_post_id=? AND status<>'hidden' AND published_at<=?
      ${cursor ? "AND (published_at < ? OR (published_at = ? AND id < ?))" : ""}
      ORDER BY published_at DESC,id DESC LIMIT ?`, [parentId, asOf, ...(cursor ? [cursor.time, cursor.time, cursor.id] : []), limit + 1]);
    return buildPage(rows, limit, scope, asOf, options.viewer, options.locale);
  }
  async function listAncestors(id: string, viewer?: FeedViewer | null, locale?: Locale | null): Promise<FeedPost[]> {
    await requiredPost(id, viewer, locale);
    const rows = await query(`WITH RECURSIVE ancestors(id,parent_post_id,depth) AS (
      SELECT parent.id,parent.parent_post_id,1 FROM social_feed_posts p JOIN social_feed_posts parent ON parent.id=p.parent_post_id WHERE p.id=?
      UNION ALL SELECT parent.id,parent.parent_post_id,ancestors.depth+1 FROM social_feed_posts parent
        JOIN ancestors ON parent.id=ancestors.parent_post_id
    ) SELECT id FROM ancestors ORDER BY depth DESC`, [id]);
    return hydrate(rows.map((row) => String(row.id)), viewer, locale);
  }
  async function findPublication(userId: string, key: string, payloadHash: string, viewer?: FeedViewer | null): Promise<FeedPost | null> {
    const rows = await query("SELECT payload_hash,post_id FROM social_feed_commands WHERE user_id=? AND idempotency_key=?", [userId, key]);
    if (!rows[0]) return null;
    if (rows[0].payload_hash !== payloadHash) throw new SocialFeedError("idempotency_conflict", 409);
    // Successful replay is independent of today's publishing score and does not write again.
    const post = await getPost(String(rows[0].post_id), viewer);
    if (!post) throw new SocialFeedError("post_not_available", 410);
    return post;
  }
  async function createNativePost(command: NativePostInput): Promise<FeedPost> {
    const { actor, input, publication, parent_post_id: parentId, idempotency_key: key } = command;
    const payloadHash = await nativePublicationHash(input, parentId);
    if (!key || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) throw new SocialFeedError("invalid_idempotency_key", 400);
    if (!actor.user_id) throw new SocialFeedError("authentication_required", 401);
    const replay = await findPublication(actor.user_id, key, payloadHash, actorViewer(actor));
    if (replay) return replay;
    validateEvidence(publication);
    const id = `pst_${crypto.randomUUID()}`;
    const at = nowIso();
    const statements = actorStatements(actor, at);
    statements.push({ sql: `INSERT INTO social_feed_posts(
      id,author_id,publisher_user_id,origin,kind,conversation_id,parent_post_id,text,published_at,created_at,updated_at,
      publication_score,publication_score_record_id,publication_score_version,publication_policy_version)
      SELECT ?,?,?,'ghfind',?,${parentId ? "COALESCE((SELECT conversation_id FROM social_feed_posts WHERE id=?),'missing')" : "?"},?,?,?,?,?,?,?,?,?
      WHERE NOT EXISTS(SELECT 1 FROM social_feed_commands WHERE user_id=? AND idempotency_key=?)`,
      args: [id, authorId(actor.github_user_id), actor.user_id, parentId ? "reply" : "original", parentId ?? id, parentId ?? null,
        input.text, at, at, at, publication.score, publication.score_record_id, publication.score_version, publication.policy_version, actor.user_id, key] });
    for (const [position, mediaId] of (input.media_ids ?? []).entries()) {
      statements.push({ sql: "INSERT INTO social_feed_post_media(post_id,media_id,position) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM social_feed_posts WHERE id=?)", args: [id, mediaId, position, id] });
    }
    statements.push({ sql: `INSERT INTO social_feed_commands(user_id,idempotency_key,payload_hash,post_id,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id,idempotency_key) DO UPDATE SET payload_hash=excluded.payload_hash`, args: [actor.user_id, key, payloadHash, id, at] });
    await batch(statements);
    return (await findPublication(actor.user_id, key, payloadHash, { user_id: actor.user_id, can_reply: true }))!;
  }
  async function ingestXPost(input: XPostInput): Promise<FeedPost> {
    validateAuthor(input.author); validateEvidence(input.publication);
    if (Object.keys(input).some((key) => !["author", "publication", "source", "text", "media", "published_at", "parent_post_id", "source_lang", "translations"].includes(key))) {
      throw new SocialFeedError("invalid_x_fields", 400);
    }
    const source = input.source;
    if (!/^[1-9][0-9]{0,24}$/.test(source.post_id) || !/^[1-9][0-9]{0,24}$/.test(source.author_id)) throw new SocialFeedError("invalid_x_source", 400);
    let sourceUrl: URL;
    try { sourceUrl = new URL(source.url); } catch { throw new SocialFeedError("invalid_x_source", 400); }
    if (sourceUrl.protocol !== "https:" || !["x.com", "twitter.com", "www.x.com", "www.twitter.com"].includes(sourceUrl.hostname) ||
      !new RegExp(`^/(?:[A-Za-z0-9_]+/status|i/(?:web/)?status)/${source.post_id}/?$`).test(sourceUrl.pathname) || sourceUrl.username || sourceUrl.password) {
      throw new SocialFeedError("invalid_x_source", 400);
    }
    sourceUrl.search = ""; sourceUrl.hash = "";
    if (!source.display_name || source.display_name.length > 200 ||
      !["editorial_review", "reciprocal_links"].includes(source.evidence_method) ||
      !/^https:\/\//.test(source.evidence_url) || !Number.isFinite(Date.parse(source.evidence_checked_at))) {
      throw new SocialFeedError("invalid_identity_evidence", 400);
    }
    if (typeof input.text !== "string" || [...input.text].length > FEED_MAX_X_TEXT_LENGTH || !Number.isFinite(Date.parse(input.published_at))) {
      throw new SocialFeedError("invalid_text", 400);
    }
    const sourceLang = normalizeSourceLang(input.source_lang);
    const translationMap = input.translations ?? {};
    if (!translationMap || typeof translationMap !== "object" || Array.isArray(translationMap)) throw new SocialFeedError("invalid_translation", 400);
    const translations = validateTranslations(Object.entries(translationMap).map(([locale, value]) => ({ ...value, locale: locale as Locale })));
    const media = input.media ?? [];
    if (media.length > FEED_MAX_MEDIA || (!input.text.trim() && !media.length)) throw new SocialFeedError("invalid_media", 400);
    for (const item of media) {
      let url: URL;
      try { url = new URL(item.url); } catch { throw new SocialFeedError("invalid_media", 400); }
      if (item.type !== "image" || url.protocol !== "https:" || url.hostname !== "pbs.twimg.com") throw new SocialFeedError("invalid_media", 400);
    }
    const aliases = [...new Set([...(source.edit_history_post_ids ?? []), source.post_id])].sort((a, b) => a.length - b.length || a.localeCompare(b));
    if (aliases.length > 100 || aliases.some((id) => !/^[1-9][0-9]{0,24}$/.test(id))) throw new SocialFeedError("invalid_x_source", 400);
    const matches = await query(`SELECT DISTINCT p.* FROM social_feed_posts p JOIN social_feed_x_versions v ON v.post_id=p.id
      WHERE v.x_post_id IN (${placeholders(aliases.length)})`, aliases);
    if (matches.length > 1) throw new SocialFeedError("source_conflict", 409);
    const existing = matches[0];
    if (existing && (existing.author_id !== authorId(input.author.github_user_id) || existing.source_x_user_id !== source.author_id ||
      nullableText(existing.parent_post_id) !== (input.parent_post_id ?? null))) throw new SocialFeedError("source_conflict", 409);
    const id = existing ? String(existing.id) : `pst_x_${aliases[0]}`;
    const at = nowIso();
    const evidence = input.publication;
    const parentId = input.parent_post_id;
    const statements: InStatement[] = [authorStatement(input.author, at), {
      sql: `INSERT INTO social_feed_x_accounts(x_user_id,author_id,evidence_url,evidence_method,evidence_checked_at,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(x_user_id) DO UPDATE SET author_id=excluded.author_id,
          evidence_url=excluded.evidence_url,evidence_method=excluded.evidence_method,
          evidence_checked_at=excluded.evidence_checked_at,updated_at=excluded.updated_at`,
      args: [source.author_id, authorId(input.author.github_user_id), source.evidence_url, source.evidence_method,
        new Date(source.evidence_checked_at).toISOString(), at],
    }, {
      sql: `INSERT INTO social_feed_posts(id,author_id,origin,kind,conversation_id,parent_post_id,text,x_media_json,
        published_at,created_at,updated_at,source_x_post_id,source_x_user_id,source_url,source_name,source_avatar_url,
        source_evidence_url,source_evidence_method,source_evidence_checked_at,
        publication_score,publication_score_record_id,publication_score_version,publication_policy_version,source_lang)
        VALUES(?,?,'x',?,${parentId ? "COALESCE((SELECT conversation_id FROM social_feed_posts WHERE id=?),'missing')" : "?"},?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET text=excluded.text,x_media_json=excluded.x_media_json,
          content_version=social_feed_posts.content_version + CASE WHEN social_feed_posts.text<>excluded.text OR social_feed_posts.x_media_json<>excluded.x_media_json THEN 1 ELSE 0 END,
          source_x_post_id=excluded.source_x_post_id,source_url=excluded.source_url,source_name=excluded.source_name,
          source_avatar_url=excluded.source_avatar_url,source_evidence_url=excluded.source_evidence_url,
          source_evidence_method=excluded.source_evidence_method,source_evidence_checked_at=excluded.source_evidence_checked_at,
          publication_score=excluded.publication_score,publication_score_record_id=excluded.publication_score_record_id,
          publication_score_version=excluded.publication_score_version,publication_policy_version=excluded.publication_policy_version,
          source_lang=COALESCE(excluded.source_lang,social_feed_posts.source_lang),source_eligible=1,updated_at=excluded.updated_at
        WHERE length(excluded.source_x_post_id)>length(social_feed_posts.source_x_post_id)
          OR (length(excluded.source_x_post_id)=length(social_feed_posts.source_x_post_id)
            AND excluded.source_x_post_id>=social_feed_posts.source_x_post_id)`,
      args: [id, authorId(input.author.github_user_id), parentId ? "reply" : "original", parentId ?? id, parentId ?? null,
        input.text, JSON.stringify(media), new Date(input.published_at).toISOString(), at, at, source.post_id, source.author_id, sourceUrl.toString(),
        source.display_name, source.avatar_url, source.evidence_url, source.evidence_method, new Date(source.evidence_checked_at).toISOString(),
        evidence.score, evidence.score_record_id, evidence.score_version, evidence.policy_version, sourceLang],
    }];
    for (const alias of aliases) statements.push({ sql: `INSERT INTO social_feed_x_versions(x_post_id,post_id,observed_at)
      VALUES(?,?,?) ON CONFLICT(x_post_id) DO UPDATE SET post_id=excluded.post_id,observed_at=excluded.observed_at`, args: [alias, id, at] });
    // Same batch as the post: rows bind to the resulting version only while it still carries this text,
    // so an out-of-order older edit cannot attach its translations to newer content.
    statements.push(...translationStatements(id, translations, at, "AND p.text=?", [input.text]));
    await batch(statements);
    return requiredPost(id);
  }
  async function upsertPostTranslations(input: FeedTranslationUpsert): Promise<{ post_id: string; content_version: number; locales: Locale[] }> {
    if (!input || typeof input.post_id !== "string" || !input.post_id ||
      (input.content_version !== undefined && (!Number.isInteger(input.content_version) || input.content_version < 1))) {
      throw new SocialFeedError("invalid_translation", 400);
    }
    const translations = validateTranslations(input.translations);
    if (!translations.length) throw new SocialFeedError("invalid_translation", 400);
    const current = (await query("SELECT content_version FROM social_feed_posts WHERE id=?", [input.post_id]))[0];
    if (!current) throw new SocialFeedError("post_not_found", 404);
    const version = input.content_version ?? numberValue(current.content_version);
    // The version guard is re-checked inside the write, so a concurrent edit cannot be translated with old text.
    await batch(translationStatements(input.post_id, translations, nowIso(), "AND p.content_version=?", [version]));
    const after = (await query("SELECT COUNT(*) AS stored FROM social_feed_post_translations WHERE post_id=? AND content_version=? AND locale IN (" +
      placeholders(translations.length) + ")", [input.post_id, version, ...translations.map((item) => item.locale)]))[0];
    const latest = (await query("SELECT content_version FROM social_feed_posts WHERE id=?", [input.post_id]))[0];
    if (numberValue(latest?.content_version) !== version || numberValue(after?.stored) !== translations.length) {
      throw new SocialFeedError("stale_content_version", 409);
    }
    return { post_id: input.post_id, content_version: version, locales: translations.map((item) => item.locale) };
  }
  async function deleteNativePost(id: string, actor: FeedActor): Promise<FeedPost> {
    const post = await requiredPost(id, actorViewer(actor));
    const owner = await query("SELECT publisher_user_id FROM social_feed_posts WHERE id=? AND origin='ghfind'", [id]);
    if (owner[0]?.publisher_user_id !== actor.user_id) throw new SocialFeedError("not_post_author", 403);
    if (post.status !== "deleted") await batch([{ sql: "UPDATE social_feed_posts SET status='deleted',updated_at=? WHERE id=? AND origin='ghfind' AND publisher_user_id=? AND status<>'deleted'", args: [nowIso(), id, actor.user_id] }]);
    return requiredPost(id, actorViewer(actor));
  }
  async function setReaction(id: string, actor: FeedActor, value: FeedReaction | null): Promise<FeedPost> {
    if (value !== null && value !== "like" && value !== "dislike") throw new SocialFeedError("invalid_reaction", 400);
    const at = nowIso();
    const statements = actorStatements(actor, at);
    statements.push(value === null
      ? { sql: "DELETE FROM social_feed_reactions WHERE user_id=? AND post_id=?", args: [actor.user_id, id] }
      : { sql: `INSERT INTO social_feed_reactions(user_id,post_id,value,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id,post_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE social_feed_reactions.value<>excluded.value`, args: [actor.user_id, id, value, at, at] });
    await batch(statements);
    return requiredPost(id, actorViewer(actor));
  }
  async function setRelation(table: "bookmarks" | "reposts", id: string, actor: FeedActor, enabled: boolean): Promise<FeedPost> {
    const at = nowIso();
    const statements = actorStatements(actor, at);
    statements.push(enabled
      ? { sql: `INSERT INTO social_feed_${table}(user_id,post_id,created_at) VALUES(?,?,?) ON CONFLICT(user_id,post_id) DO NOTHING`, args: [actor.user_id, id, at] }
      : { sql: `DELETE FROM social_feed_${table} WHERE user_id=? AND post_id=?`, args: [actor.user_id, id] });
    await batch(statements);
    return requiredPost(id, actorViewer(actor));
  }
  async function setFollow(targetAuthorId: string, actor: FeedActor, enabled: boolean): Promise<void> {
    const target = await query("SELECT id FROM social_feed_authors WHERE id=?", [targetAuthorId]);
    if (!target[0]) throw new SocialFeedError("author_not_found", 404);
    if (targetAuthorId === authorId(actor.github_user_id)) throw new SocialFeedError("cannot_follow_self", 400);
    const at = nowIso();
    const statements = actorStatements(actor, at);
    statements.push(enabled
      ? { sql: "INSERT INTO social_feed_follows(user_id,author_id,created_at) VALUES(?,?,?) ON CONFLICT(user_id,author_id) DO NOTHING", args: [actor.user_id, targetAuthorId, at] }
      : { sql: "DELETE FROM social_feed_follows WHERE user_id=? AND author_id=?", args: [actor.user_id, targetAuthorId] });
    await batch(statements);
  }
  async function recordQualifiedView(input: QualifiedViewInput): Promise<boolean> {
    if (!input.actor_key || !input.event_id || !/^\d{4}-\d{2}-\d{2}$/.test(input.view_date) || input.view_date !== nowIso().slice(0, 10)) {
      throw new SocialFeedError("invalid_view", 400);
    }
    const result = await client.execute({ sql: `INSERT INTO social_feed_views(actor_key,post_id,view_date,event_id,created_at)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM social_feed_posts p JOIN social_feed_posts root ON root.id=p.conversation_id
        WHERE p.id=? AND p.status='published' AND root.status<>'hidden')
      ON CONFLICT DO NOTHING`, args: [input.actor_key, input.post_id, input.view_date, input.event_id, nowIso(), input.post_id] });
    return result.rowsAffected > 0;
  }
  async function consumeQuota(actorKey: string, operation: FeedQuotaOperation, now = new Date()): Promise<boolean> {
    const maximum = {
      publish: 10, interact: 120, view: 120, upload: 10,
      ingest: actorKey.startsWith("ingest:author:") ? FEED_INGEST_AUTHOR_PER_MINUTE : FEED_INGEST_GLOBAL_PER_MINUTE,
      ingest_hour: FEED_INGEST_GLOBAL_PER_HOUR,
    }[operation];
    if (!actorKey || !maximum || !Number.isFinite(now.getTime())) throw new SocialFeedError("invalid_quota", 400);
    const windowMs = operation === "ingest_hour" ? 3_600_000 : 60_000;
    const windowStart = Math.floor(now.getTime() / windowMs);
    const result = await client.execute({ sql: `INSERT INTO social_feed_quotas(actor_key,operation,window_start,request_count) VALUES(?,?,?,1)
      ON CONFLICT(actor_key,operation,window_start) DO UPDATE SET request_count=social_feed_quotas.request_count+1
      WHERE social_feed_quotas.request_count<? RETURNING request_count`, args: [actorKey, operation, windowStart, maximum] });
    return result.rows.length > 0;
  }
  function mediaFromRow(row: DbRow): FeedMedia {
    return { id: String(row.id), type: "image", url: String(row.url), alt_text: nullableText(row.alt_text),
      width: row.width == null ? null : numberValue(row.width), height: row.height == null ? null : numberValue(row.height) };
  }
  async function registerMedia(input: MediaRegistration): Promise<FeedMedia> {
    if (!input.id || !input.owner_user_id || !input.url || !input.storage_key ||
      !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(input.mime_type) ||
      !Number.isInteger(input.size_bytes) || input.size_bytes <= 0 || input.size_bytes > 10 * 1024 * 1024) {
      throw new SocialFeedError("invalid_media", 400);
    }
    await batch([{ sql: `INSERT INTO social_feed_media_assets(id,owner_user_id,url,storage_key,mime_type,size_bytes,width,height,alt_text,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,'ready',?)`, args: [input.id, input.owner_user_id, input.url, input.storage_key, input.mime_type,
      input.size_bytes, input.width ?? null, input.height ?? null, input.alt_text ?? null, nowIso()] }]);
    return { id: input.id, type: "image", url: input.url, alt_text: input.alt_text ?? null, width: input.width ?? null, height: input.height ?? null };
  }
  async function getMediaAsset(id: string): Promise<FeedMediaAsset | null> {
    const rows = await query("SELECT * FROM social_feed_media_assets WHERE id=?", [id]);
    const row = rows[0];
    if (!row) return null;
    return { id: String(row.id), owner_user_id: String(row.owner_user_id), url: String(row.url), storage_key: String(row.storage_key),
      mime_type: String(row.mime_type), size_bytes: numberValue(row.size_bytes), width: row.width == null ? null : numberValue(row.width),
      height: row.height == null ? null : numberValue(row.height), alt_text: nullableText(row.alt_text),
      status: String(row.status) as FeedMediaAsset["status"], created_at: String(row.created_at) };
  }
  async function canReadMedia(id: string, userId?: string): Promise<boolean> {
    const rows = await query(`SELECT 1 FROM social_feed_media_assets m WHERE m.id=? AND m.status='ready' AND (
      m.owner_user_id=? OR EXISTS(SELECT 1 FROM social_feed_post_media pm JOIN social_feed_posts p ON p.id=pm.post_id
        JOIN social_feed_posts root ON root.id=p.conversation_id
        WHERE pm.media_id=m.id AND p.status='published' AND root.status<>'hidden'))`, [id, userId ?? null]);
    return rows.length > 0;
  }
  async function setXAuthorEligibility(githubUserId: string, eligible: boolean): Promise<void> {
    await batch([{ sql: "UPDATE social_feed_posts SET source_eligible=? WHERE author_id=? AND origin='x'", args: [eligible ? 1 : 0, authorId(githubUserId)] }]);
  }
  return {
    getPost, listPosts, listReplies, listAncestors, createNativePost, findPublication, ingestXPost, upsertPostTranslations, deleteNativePost,
    setReaction, setBookmark: (id, actor, enabled) => setRelation("bookmarks", id, actor, enabled),
    setRepost: (id, actor, enabled) => setRelation("reposts", id, actor, enabled), setFollow, recordQualifiedView,
    consumeQuota, getAuthorSummary, upsertAuthor, registerMedia, getMediaAsset, canReadMedia, setXAuthorEligibility,
  };
}
