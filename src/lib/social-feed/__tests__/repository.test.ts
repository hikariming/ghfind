import { createClient, type Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepository, nativePublicationHash } from "../repository";
import type { FeedActor, NativePostInput, PublicationEvidence, SocialFeedRepository, XPostInput } from "../contract";

const migration = ["0016_social_posts.sql", "0017_social_post_translations.sql"]
  .map((name) => readFileSync(new URL(`../../../../migrations-feed/${name}`, import.meta.url), "utf8")).join("\n");
const alice: FeedActor = { user_id: "github:11", github_user_id: "11", github_login: "alice", name: "Alice", avatar_url: null };
const bob: FeedActor = { user_id: "github:22", github_user_id: "22", github_login: "bob", name: "Bob", avatar_url: null };
const carol: FeedActor = { user_id: "github:33", github_user_id: "33", github_login: "carol", name: "Carol", avatar_url: null };
const publication: PublicationEvidence = { score: 60, score_record_id: "score-11", score_version: "v11", policy_version: "social-feed-v1" };
const viewer = (actor: FeedActor) => ({ user_id: actor.user_id, can_reply: true });
function native(actor = alice, text = "Original post", parentPostId?: string): NativePostInput {
  return { actor, publication, input: { text }, idempotency_key: crypto.randomUUID(), parent_post_id: parentPostId };
}
function mirrored(): XPostInput {
  return { author: alice, publication, text: "X content", published_at: "2026-10-01T00:00:00.000Z", source: {
    post_id: "100001", author_id: "555", url: "https://x.com/alice_x/status/100001", display_name: "Alice on X", avatar_url: null,
    evidence_url: "https://x.com/alice_x", evidence_method: "editorial_review", evidence_checked_at: "2026-10-01T00:00:00.000Z",
  } };
}
let client: Client;
let repository: SocialFeedRepository;
beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await client.executeMultiple(migration);
  repository = createRepository(client);
});
afterEach(() => { client.close(); vi.useRealTimers(); });
async function count(table: string): Promise<number> {
  return Number((await client.execute(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);
}

describe("social post storage", () => {
  it("reads only ghfind follows and verified X account links for author cards", async () => {
    await repository.ingestXPost(mirrored());
    await repository.upsertAuthor(bob);
    await repository.setFollow("gha_22", alice, true);
    await repository.setFollow("gha_11", bob, true);
    expect(await repository.getAuthorSummary("gha_11", bob.user_id)).toMatchObject({ following: 1, followers: 1, follows_you: true, x_url: "https://x.com/i/user/555", x_handle: "alice_x" });
    expect(await repository.getAuthorSummary("gha_22")).toMatchObject({ following: 1, followers: 1, follows_you: false, x_url: null });
    await repository.setFollow("gha_11", bob, false);
    expect(await repository.getAuthorSummary("gha_11")).toMatchObject({ followers: 0 });
    expect(await repository.getAuthorSummary("gha_unknown")).toBeNull();
  });
  it("exposes verified publication scores without presenting curated placeholders as ratings", async () => {
    const local = await repository.createNativePost({ ...native(), publication: { ...publication, score: 69 } });
    expect(local.author.publication_score).toBe(69);
    expect((await repository.getPost(local.id))?.author.publication_score).toBe(69);
    const imported = mirrored();
    const mirror = await repository.ingestXPost({ ...imported, publication: { ...publication, score_version: "unscored" } });
    expect(mirror.author.publication_score).toBeNull();
    const reply = await repository.createNativePost(native(bob, "Reply", mirror.id));
    expect(reply.author.publication_score).toBe(60);
  });
  it("keeps native and mirrored source identities separate, including replies to mirrors", async () => {
    const local = await repository.createNativePost(native());
    const mirror = await repository.ingestXPost(mirrored());
    const reply = await repository.createNativePost(native(bob, "A local reply", mirror.id));
    expect(local).toMatchObject({ origin: "ghfind", original_url: null, conversation_id: local.id, author: { github_login: "alice", name: "Alice" } });
    expect(mirror).toMatchObject({ origin: "x", original_url: "https://x.com/alice_x/status/100001", author: { github_login: "alice", name: "Alice on X" } });
    expect(reply).toMatchObject({ origin: "ghfind", original_url: null, conversation_id: mirror.id, parent_post_id: mirror.id });
    expect((await repository.getPost(local.id))?.viewer).toBeNull();
    await expect(repository.deleteNativePost(mirror.id, alice)).rejects.toMatchObject({ code: "not_post_author" });
  });
  it("atomically deduplicates concurrent creates, detects conflicting payloads, and replays after score loss", async () => {
    const command = native();
    const results = await Promise.all(Array.from({ length: 12 }, () => repository.createNativePost(command)));
    expect(new Set(results.map((post) => post.id)).size).toBe(1);
    expect(await count("social_feed_posts")).toBe(1);
    expect(await count("social_feed_events")).toBe(1);
    const replay = await repository.createNativePost({ ...command, publication: { ...publication, score: 0 } });
    expect(replay.id).toBe(results[0].id);
    await expect(repository.createNativePost({ ...command, input: { text: "different" } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const hash = await nativePublicationHash(command.input);
    expect(await repository.findPublication(bob.user_id, command.idempotency_key, hash)).toBeNull();
  });
  it("requires valid publication evidence and rejects client source fields", async () => {
    await expect(repository.createNativePost({ ...native(), publication: { ...publication, score: 59.96 } })).rejects.toMatchObject({ code: "score_below_threshold" });
    await expect(repository.createNativePost({ ...native(), input: { text: "spoof", origin: "x" } as never })).rejects.toMatchObject({ code: "invalid_post_fields" });
    expect(await count("social_feed_posts")).toBe(0);
  });
  it("preserves unlimited reply ancestry and deletion placeholders while rejecting replies to a deleted root", async () => {
    const root = await repository.createNativePost(native());
    const a = await repository.createNativePost(native(bob, "first", root.id));
    const b = await repository.createNativePost(native(alice, "second", a.id));
    const c = await repository.createNativePost(native(carol, "third", b.id));
    expect((await repository.listAncestors(c.id)).map((post) => post.id)).toEqual([root.id, a.id, b.id]);
    await repository.deleteNativePost(a.id, bob);
    expect((await repository.listAncestors(c.id))[1]).toMatchObject({ id: a.id, status: "deleted", text: "", media: [] });
    expect((await repository.listReplies(a.id)).items[0].id).toBe(b.id);
    await repository.deleteNativePost(root.id, alice);
    expect((await repository.getPost(c.id, viewer(carol)))?.viewer?.can_reply).toBe(false);
    await expect(repository.createNativePost(native(carol, "blocked", c.id))).rejects.toMatchObject({ code: "invalid_reply_target" });
    expect(await count("social_feed_posts")).toBe(4);
  });
  it("database guards prevent cross-conversation and immutable source edits", async () => {
    const root = await repository.createNativePost(native());
    const other = await repository.createNativePost(native(bob));
    await expect(client.execute({ sql: "UPDATE social_feed_posts SET conversation_id=? WHERE id=?", args: [other.id, root.id] })).rejects.toThrow("immutable_post_identity");
    await expect(client.execute({ sql: "UPDATE social_feed_posts SET origin='x' WHERE id=?", args: [root.id] })).rejects.toThrow("immutable_post_identity");
  });
  it("reaction changes are atomic, mutually exclusive, idempotent, and privacy scoped", async () => {
    const post = await repository.createNativePost(native());
    await Promise.all(Array.from({ length: 20 }, () => repository.setReaction(post.id, bob, "like")));
    expect((await repository.getPost(post.id))?.metrics.likes).toBe(1);
    await repository.setReaction(post.id, bob, "dislike");
    expect((await repository.getPost(post.id, viewer(bob)))?.viewer?.reaction).toBe("dislike");
    expect((await repository.getPost(post.id, viewer(alice)))?.viewer?.reaction).toBeNull();
    expect((await repository.getPost(post.id))?.metrics.likes).toBe(0);
    await repository.setReaction(post.id, bob, null);
    expect(await count("social_feed_reactions")).toBe(0);
    const events = await client.execute("SELECT COUNT(*) AS n FROM social_feed_events WHERE event_type='reaction_changed'");
    expect(Number(events.rows[0].n)).toBe(3);
  });
  it("bookmarks stay private and following delivers reposts with the original source", async () => {
    const mirror = await repository.ingestXPost(mirrored());
    await repository.setBookmark(mirror.id, bob, true);
    expect((await repository.getPost(mirror.id, viewer(alice)))?.viewer?.bookmarked).toBe(false);
    expect((await repository.listPosts({ channel: "bookmarks", viewer: viewer(bob) })).items.map((post) => post.id)).toEqual([mirror.id]);
    await expect(repository.listPosts({ channel: "bookmarks" })).rejects.toMatchObject({ code: "authentication_required" });
    await repository.upsertAuthor(bob);
    await repository.setFollow("gha_22", carol, true);
    await repository.setRepost(mirror.id, bob, true);
    const following = await repository.listPosts({ channel: "following", viewer: viewer(carol) });
    expect(following.items).toHaveLength(1);
    expect(following.items[0]).toMatchObject({ id: mirror.id, origin: "x", reposted_by: { github_login: "bob" }, original_url: mirror.original_url });
    await repository.setRepost(mirror.id, bob, false);
    expect((await repository.listPosts({ channel: "following", viewer: viewer(carol) })).items).toHaveLength(0);
  });
  it("views deduplicate actor/post/day and event retries, including concurrent delivery", async () => {
    const post = await repository.createNativePost(native());
    const date = new Date().toISOString().slice(0, 10);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => repository.recordQualifiedView({ post_id: post.id, actor_key: "anonymous:one", event_id: `evt_${index}`, view_date: date })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repository.getPost(post.id))?.metrics.views).toBe(1);
    await repository.recordQualifiedView({ post_id: post.id, actor_key: "anonymous:two", event_id: "evt_two", view_date: date });
    expect((await repository.getPost(post.id))?.metrics.views).toBe(2);
    await expect(repository.recordQualifiedView({ post_id: post.id, actor_key: "anonymous:three", event_id: "evt_three", view_date: "2000-01-01" })).rejects.toMatchObject({ code: "invalid_view" });
  });
  it("uses atomic quota limits under concurrent requests", async () => {
    const at = new Date("2026-10-26T00:00:00Z");
    const allowed = await Promise.all(Array.from({ length: 24 }, () => repository.consumeQuota(alice.user_id, "publish", at)));
    expect(allowed.filter(Boolean)).toHaveLength(10);
    expect(await repository.consumeQuota(alice.user_id, "publish", new Date(at.getTime() + 60_000))).toBe(true);
  });
  it("replays X versions to one local identity without losing interactions", async () => {
    const input = mirrored();
    const first = await repository.ingestXPost(input);
    await repository.setReaction(first.id, bob, "like");
    const edited = await repository.ingestXPost({ ...input, text: "Edited X content", source: { ...input.source, post_id: "100002", url: "https://x.com/alice_x/status/100002", edit_history_post_ids: ["100001", "100002"] } });
    expect(edited).toMatchObject({ id: first.id, content_version: 2, metrics: { likes: 1 } });
    expect(await count("social_feed_posts")).toBe(1);
    expect(await count("social_feed_x_versions")).toBe(2);
    const stale = await repository.ingestXPost(input);
    expect(stale).toMatchObject({ id: first.id, text: "Edited X content", content_version: 2, original_url: edited.original_url });
    expect(await count("social_feed_post_versions")).toBe(2);
    await expect(repository.ingestXPost({ ...input, author: bob })).rejects.toMatchObject({ code: "source_conflict" });
    await expect(repository.ingestXPost({ ...input, source: { ...input.source, url: "https://x.com/alice_x/status/999" } })).rejects.toMatchObject({ code: "invalid_x_source" });
  });
  it("stores curated X posts without a talent score and shows them on the public timeline", async () => {
    const curated: PublicationEvidence = { score: 60, score_record_id: "x-curated:alice", score_version: "unscored", policy_version: "social-feed-x-curated-v1" };
    const mirror = await repository.ingestXPost({ ...mirrored(), publication: curated });
    const page = await repository.listPosts({ channel: "recommended" });
    expect(page.items.map((item) => item.id)).toEqual([mirror.id]);
    expect(page.items[0]).toMatchObject({ origin: "x", author: { github_login: "alice", name: "Alice on X" } });
  });
  it("persists one verified GitHub binding per X account and rejects cross-post impersonation", async () => {
    const first = mirrored();
    await repository.ingestXPost(first);
    await expect(repository.ingestXPost({ ...first, author: bob, source: { ...first.source, post_id: "100003", url: "https://x.com/alice_x/status/100003" } }))
      .rejects.toMatchObject({ code: "source_conflict" });
    expect(await count("social_feed_posts")).toBe(1);
    expect(await count("social_feed_x_accounts")).toBe(1);
    const row = (await client.execute("SELECT author_id,evidence_method FROM social_feed_x_accounts")).rows[0];
    expect(row).toMatchObject({ author_id: "gha_11", evidence_method: "editorial_review" });
  });
  it("never lets a concurrent old-version ingest replace a newer X edit", async () => {
    const first = mirrored();
    await repository.ingestXPost(first);
    const edited = { ...first, text: "Newer content", source: { ...first.source, post_id: "100002", url: "https://x.com/alice_x/status/100002", edit_history_post_ids: ["100001", "100002"] } };
    await Promise.all([repository.ingestXPost(edited), repository.ingestXPost(first), repository.ingestXPost(edited)]);
    const current = await repository.getPost("pst_x_100001");
    expect(current).toMatchObject({ text: "Newer content", content_version: 2 });
  });
  it("only imports X thread continuations by the same X account and GitHub author", async () => {
    const input = mirrored();
    const root = await repository.ingestXPost(input);
    const continuation = { ...input, parent_post_id: root.id, source: { ...input.source, post_id: "100003", url: "https://x.com/alice_x/status/100003" } };
    const child = await repository.ingestXPost(continuation);
    expect(child).toMatchObject({ origin: "x", kind: "reply", parent_post_id: root.id, conversation_id: root.id });
    const local = await repository.createNativePost(native());
    await expect(repository.ingestXPost({ ...continuation, parent_post_id: local.id, source: { ...input.source, post_id: "100004", url: "https://x.com/alice_x/status/100004" } }))
      .rejects.toMatchObject({ code: "invalid_reply_target" });
    await expect(repository.ingestXPost({ ...continuation, author: bob, source: { ...input.source, author_id: "777", post_id: "100005", url: "https://x.com/bob_x/status/100005" } }))
      .rejects.toMatchObject({ code: "invalid_reply_target" });
    await expect(repository.ingestXPost({ ...continuation, source: { ...input.source, author_id: "888", post_id: "100006", url: "https://x.com/alice_other/status/100006" } }))
      .rejects.toMatchObject({ code: "invalid_reply_target" });
    expect(await count("social_feed_posts")).toBe(3);
  });
  it("checks image ownership atomically and limits public asset access to live posts", async () => {
    await repository.registerMedia({ id: "img1", owner_user_id: alice.user_id, url: "/api/feed/media/img1", storage_key: "feed/img1", mime_type: "image/png", size_bytes: 120 });
    expect(await repository.canReadMedia("img1")).toBe(false);
    expect(await repository.canReadMedia("img1", alice.user_id)).toBe(true);
    await expect(repository.createNativePost({ ...native(bob), input: { text: "stolen", media_ids: ["img1"] } })).rejects.toMatchObject({ code: "invalid_media" });
    expect(await count("social_feed_posts")).toBe(0);
    const post = await repository.createNativePost({ ...native(), input: { text: "", media_ids: ["img1"] } });
    expect(post.media[0].id).toBe("img1");
    expect(await repository.canReadMedia("img1")).toBe(true);
    await repository.deleteNativePost(post.id, alice);
    expect(await repository.canReadMedia("img1")).toBe(false);
  });
  it("keyset pagination excludes newer arrivals and cannot cross user/channel scopes", async () => {
    for (let index = 0; index < 5; index++) await repository.createNativePost(native(alice, `Post ${index}`));
    const first = await repository.listPosts({ channel: "recommended", limit: 2 });
    const next = await repository.listPosts({ channel: "recommended", limit: 2, cursor: first.next_cursor! });
    expect(new Set([...first.items, ...next.items].map((post) => post.id)).size).toBe(4);
    await repository.createNativePost(native(alice, "After page one"));
    const last = await repository.listPosts({ channel: "recommended", limit: 2, cursor: next.next_cursor! });
    expect(last.items).toHaveLength(1);
    expect(last.next_cursor).toBeNull();
    await expect(repository.listPosts({ channel: "following", viewer: viewer(bob), cursor: first.next_cursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
  });
  it("freezes timeline activities so an undone repost cannot replay its original on later pages", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const old = await repository.createNativePost(native(alice, "Older original"));
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    const newer = await repository.createNativePost(native(alice, "Newer original"));
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
    await repository.setRepost(old.id, bob, true);
    const first = await repository.listPosts({ channel: "recommended", limit: 1 });
    expect(first.items[0].id).toBe(old.id);
    await repository.setRepost(old.id, bob, false);
    const rest = await repository.listPosts({ channel: "recommended", cursor: first.next_cursor!, limit: 10 });
    expect(rest.items.map((post) => post.id)).toEqual([newer.id]);
    expect(rest.next_cursor).toBeNull();
  });
  it("keeps same-millisecond new posts out of an existing delivery snapshot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
    for (let index = 0; index < 3; index++) await repository.createNativePost(native(alice, `Before ${index}`));
    const first = await repository.listPosts({ channel: "recommended", limit: 1 });
    const arrival = await repository.createNativePost(native(alice, "Same millisecond arrival"));
    const rest = await repository.listPosts({ channel: "recommended", cursor: first.next_cursor!, limit: 10 });
    expect(rest.items).toHaveLength(2);
    expect(rest.items.some((post) => post.id === arrival.id)).toBe(false);
  });
  it("rechecks live visibility and expires sessions while cleaning old snapshots in bounded batches", async () => {
    const posts = await Promise.all([repository.createNativePost(native(alice, "A")), repository.createNativePost(native(alice, "B")), repository.createNativePost(native(alice, "C"))]);
    const first = await repository.listPosts({ channel: "recommended", limit: 1 });
    const unseen = posts.filter((post) => post.id !== first.items[0].id);
    await repository.deleteNativePost(unseen[0].id, alice);
    const rest = await repository.listPosts({ channel: "recommended", cursor: first.next_cursor!, limit: 10 });
    expect(rest.items.map((post) => post.id)).toEqual([unseen[1].id]);
    await client.execute("UPDATE social_feed_sessions SET expires_at='2000-01-01T00:00:00.000Z'");
    await expect(repository.listPosts({ channel: "recommended", cursor: first.next_cursor! })).rejects.toMatchObject({ code: "cursor_expired" });
    await repository.listPosts({ channel: "recommended" });
    expect(await count("social_feed_sessions")).toBe(1);
    expect(await count("social_feed_session_items")).toBe(2);
  });

  it("hydrates deep ancestry in bounded database queries", async () => {
    let parent = await repository.createNativePost(native());
    for (let depth = 0; depth < 105; depth++) parent = await repository.createNativePost(native(alice, `depth ${depth}`, parent.id));
    const queries = vi.spyOn(client, "execute");
    const ancestors = await repository.listAncestors(parent.id);
    expect(ancestors).toHaveLength(105);
    for (const call of queries.mock.calls) {
      const statement: unknown = call[0];
      if (typeof statement === "object" && statement !== null && "args" in statement && Array.isArray(statement.args)) {
        expect(statement.args.length).toBeLessThanOrEqual(100);
      }
    }
    queries.mockRestore();
  });

});

describe("social post translations", () => {
  const edit = (input: XPostInput, text: string): XPostInput => ({ ...input, text,
    source: { ...input.source, post_id: "100002", url: "https://x.com/alice_x/status/100002", edit_history_post_ids: ["100001", "100002"] } });
  it("migration adds nullable source_lang and a locale-restricted, version-keyed translation table", async () => {
    const columns = (await client.execute("PRAGMA table_info(social_feed_posts)")).rows;
    expect(columns.find((column) => column.name === "source_lang")).toMatchObject({ notnull: 0, dflt_value: null });
    const keys = (await client.execute("PRAGMA table_info(social_feed_post_translations)")).rows
      .filter((column) => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((column) => column.name);
    expect(keys).toEqual(["post_id", "content_version", "locale"]);
    const post = await repository.ingestXPost(mirrored());
    await expect(client.execute({ sql: "INSERT INTO social_feed_post_translations(post_id,content_version,locale,text,updated_at) VALUES(?,1,'fr','Bonjour','t')", args: [post.id] }))
      .rejects.toThrow(/CHECK/);
    await expect(client.execute({ sql: "INSERT INTO social_feed_post_translations(post_id,content_version,locale,text,updated_at) VALUES(?,9,'ja','x','t')", args: [post.id] }))
      .rejects.toThrow(/FOREIGN KEY/);
  });
  it("falls back to the original text when the page locale has no translation", async () => {
    const post = await repository.ingestXPost({ ...mirrored(), source_lang: "en", translations: { zh: { text: "X 内容", model: "deepseek-chat", provider: "deepseek" } } });
    expect(post).toMatchObject({ text: "X content", source_lang: "en", translation: null });
    const ja = (await repository.listPosts({ channel: "recommended", locale: "ja" })).items[0];
    expect(ja).toMatchObject({ text: "X content", translation: null });
    const zh = (await repository.listPosts({ channel: "recommended", locale: "zh" })).items[0];
    expect(zh).toMatchObject({ text: "X content", source_lang: "en", translation: { locale: "zh", text: "X 内容", source_lang: "en" } });
    expect((await repository.getPost(post.id, null, "zh"))?.translation?.text).toBe("X 内容");
  });
  it("omits the translation when the source language is the page locale", async () => {
    const post = await repository.ingestXPost({ ...mirrored(), source_lang: "zh-Hans" });
    await repository.upsertPostTranslations({ post_id: post.id, translations: [{ locale: "zh", text: "重复" }, { locale: "en", text: "English copy" }] });
    expect((await repository.getPost(post.id, null, "zh"))).toMatchObject({ source_lang: "zh-hans", translation: null });
    expect((await repository.getPost(post.id, null, "en"))?.translation).toMatchObject({ locale: "en", text: "English copy", source_lang: "zh-hans" });
  });
  it("upserts one or many locales against the current content_version and records provenance", async () => {
    const post = await repository.ingestXPost(mirrored());
    expect(await repository.upsertPostTranslations({ post_id: post.id, translations: [{ locale: "ja", text: "旧訳" }] }))
      .toEqual({ post_id: post.id, content_version: 1, locales: ["ja"] });
    const result = await repository.upsertPostTranslations({ post_id: post.id, content_version: 1, translations: [
      { locale: "ja", text: "X の内容", source_lang: "en", model: "deepseek-chat", provider: "deepseek" },
      { locale: "ko", text: "X 콘텐츠", source_lang: "en", model: "deepseek-chat", provider: "deepseek" },
    ] });
    expect(result.locales).toEqual(["ja", "ko"]);
    expect(await count("social_feed_post_translations")).toBe(2);
    const row = (await client.execute("SELECT * FROM social_feed_post_translations WHERE locale='ja'")).rows[0];
    expect(row).toMatchObject({ content_version: 1, text: "X の内容", source_lang: "en", model: "deepseek-chat", provider: "deepseek" });
  });
  it("validates locales and rejects the whole write", async () => {
    const post = await repository.ingestXPost(mirrored());
    await expect(repository.upsertPostTranslations({ post_id: post.id, translations: [{ locale: "ja", text: "ok" }, { locale: "fr" as never, text: "Bonjour" }] }))
      .rejects.toMatchObject({ code: "invalid_locale" });
    await expect(repository.upsertPostTranslations({ post_id: post.id, translations: [{ locale: "ja", text: "a" }, { locale: "ja", text: "b" }] }))
      .rejects.toMatchObject({ code: "duplicate_locale" });
    await expect(repository.upsertPostTranslations({ post_id: post.id, translations: [{ locale: "ja", text: " " }] })).rejects.toMatchObject({ code: "invalid_translation" });
    await expect(repository.upsertPostTranslations({ post_id: post.id, translations: [] })).rejects.toMatchObject({ code: "invalid_translation" });
    await expect(repository.upsertPostTranslations({ post_id: "missing", translations: [{ locale: "ja", text: "x" }] })).rejects.toMatchObject({ code: "post_not_found" });
    await expect(repository.ingestXPost({ ...mirrored(), source: { ...mirrored().source, post_id: "100009", url: "https://x.com/alice_x/status/100009" },
      translations: { de: { text: "Hallo" } } as never })).rejects.toMatchObject({ code: "invalid_locale" });
    await expect(repository.ingestXPost({ ...mirrored(), source_lang: "not a tag" })).rejects.toMatchObject({ code: "invalid_source_lang" });
    expect(await count("social_feed_post_translations")).toBe(0);
    expect(await count("social_feed_posts")).toBe(1);
  });
  it("stops serving translations of an older content_version after an edit and rejects stale writes", async () => {
    const input = { ...mirrored(), source_lang: "en", translations: { zh: { text: "旧内容" } } };
    const first = await repository.ingestXPost(input);
    expect((await repository.getPost(first.id, null, "zh"))?.translation?.text).toBe("旧内容");
    const edited = await repository.ingestXPost(edit({ ...mirrored(), source_lang: "en" }, "Edited X content"));
    expect(edited.content_version).toBe(2);
    expect(await repository.getPost(first.id, null, "zh")).toMatchObject({ text: "Edited X content", translation: null });
    // Stale rows stay as history but are never joined.
    expect(await count("social_feed_post_translations")).toBe(1);
    await expect(repository.upsertPostTranslations({ post_id: first.id, content_version: 1, translations: [{ locale: "zh", text: "迟到的旧译文" }] }))
      .rejects.toMatchObject({ code: "stale_content_version" });
    // An out-of-order replay of the old version cannot attach its translations to the new text.
    await repository.ingestXPost({ ...input, translations: { zh: { text: "旧内容 2" }, ja: { text: "古い" } } });
    expect(await repository.getPost(first.id, null, "ja")).toMatchObject({ content_version: 2, translation: null });
    await repository.upsertPostTranslations({ post_id: first.id, content_version: 2, translations: [{ locale: "zh", text: "编辑后的内容" }] });
    expect((await repository.getPost(first.id, null, "zh"))?.translation).toMatchObject({ locale: "zh", text: "编辑后的内容" });
    const versions = (await client.execute({ sql: "SELECT content_version,text FROM social_feed_post_translations WHERE post_id=? AND locale='zh' ORDER BY content_version", args: [first.id] })).rows;
    expect(versions.map((row) => [row.content_version, row.text])).toEqual([[1, "旧内容"], [2, "编辑后的内容"]]);
  });
  it("writes a post and its translations together and keeps native posts translation-free", async () => {
    const post = await repository.ingestXPost({ ...mirrored(), source_lang: "en", translations: { ja: { text: "X の内容" }, ar: { text: "محتوى X" } } });
    expect(await count("social_feed_post_translations")).toBe(2);
    expect((await repository.getPost(post.id, null, "ar"))?.translation?.text).toBe("محتوى X");
    const local = await repository.createNativePost(native());
    expect(await repository.getPost(local.id, null, "ja")).toMatchObject({ source_lang: null, translation: null });
  });
});
