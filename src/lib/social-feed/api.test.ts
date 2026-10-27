import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeSignedPayload } from "@/lib/oauth-session";
import { SocialFeedError, type FeedPost } from "./contract";

const mocks = vi.hoisted(() => ({
  repository: { getAuthorSummary: vi.fn(), getPost: vi.fn(), listPosts: vi.fn(), listReplies: vi.fn(), listAncestors: vi.fn(), createNativePost: vi.fn(), findPublication: vi.fn(), deleteNativePost: vi.fn(),
    setReaction: vi.fn(), setBookmark: vi.fn(), setRepost: vi.fn(), setFollow: vi.fn(), recordQualifiedView: vi.fn(), consumeQuota: vi.fn(), ingestXPost: vi.fn() },
  githubProfileXUrl: vi.fn(), readDisplayScore: vi.fn(), requirePublication: vi.fn(), publishingCapabilities: vi.fn(), xIngestPublication: vi.fn(),
}));
vi.mock("./github-profile", () => ({ githubProfileXUrl: mocks.githubProfileXUrl }));
vi.mock("./repository", () => ({ getSocialFeedRepository: () => mocks.repository, nativePublicationHash: async (input: unknown, parent?: string) => JSON.stringify({ input, parent }) }));
vi.mock("./eligibility", () => ({ readDisplayScore: mocks.readDisplayScore, requirePublication: mocks.requirePublication, publishingCapabilities: mocks.publishingCapabilities,
  xIngestPublication: mocks.xIngestPublication }));
import { getAuthorSummary, createPost, deletePost, getPost, ingestX, listPosts, recordView, setReaction } from "./api";
import * as postsRoute from "@/app/api/feed/posts/route";

const origin = "http://127.0.0.1:4321";
const post: FeedPost = { id: "p1", origin: "ghfind", kind: "original", author: { id: "a1", github_login: "octocat", name: "octocat", avatar_url: null }, text: "hello", source_lang: null, translation: null, media: [],
  published_at: "2026-10-25T00:00:00.000Z", content_version: 1, conversation_id: "p1", parent_post_id: null, original_url: null, status: "published",
  metrics: { origin: "ghfind", likes: 0, reposts: 0, direct_replies: 0, conversation_replies: 0, views: 0 }, viewer: null };
const params = { params: Promise.resolve({ id: "p1" }) };
function session(): string {
  return `ghfind_session=${encodeSignedPayload("session", { github_id: 7, login: "octocat", expires_at: Date.now() + 100000 })}`;
}
function request(method: string, value?: unknown, options: { signed?: boolean; origin?: string; path?: string; cookie?: string } = {}): Request {
  const headers = new Headers({ Origin: options.origin ?? origin, "Content-Type": "application/json", "Idempotency-Key": "test-command-0001" });
  if (options.signed) headers.set("Cookie", session());
  if (options.cookie) headers.set("Cookie", options.cookie);
  return new Request(`${origin}${options.path ?? "/api/feed/posts"}`, { method, headers, body: value === undefined ? undefined : JSON.stringify(value) });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("AUTH_SECRET", "social-feed-test-secret-long-enough-00000001");
  vi.stubEnv("SOCIAL_FEED_INGEST_SECRET", "social-feed-ingest-secret-long-enough-000001");
  vi.stubEnv("SOCIAL_FEED_PUBLISH_ENABLED", "1");
  vi.stubEnv("SOCIAL_FEED_INGEST_ENABLED", "1");
  mocks.publishingCapabilities.mockResolvedValue({ can_publish: true, can_reply: true, minimum_score: 60, reason: null });
  mocks.repository.listPosts.mockResolvedValue({ items: [post], next_cursor: null, algorithm_version: "chronological-v1" });
  mocks.repository.getPost.mockResolvedValue(post);
  mocks.repository.createNativePost.mockResolvedValue(post);
  mocks.repository.findPublication.mockResolvedValue(null);
  mocks.repository.setReaction.mockResolvedValue(post);
  mocks.repository.deleteNativePost.mockResolvedValue({ ...post, status: "deleted", text: "" });
  mocks.repository.consumeQuota.mockResolvedValue(true);
  mocks.repository.recordQualifiedView.mockResolvedValue(true);
  mocks.repository.ingestXPost.mockResolvedValue({ ...post, origin: "x" });
  mocks.requirePublication.mockResolvedValue({ score: 60, score_record_id: "saved-score", score_version: "v16", policy_version: "social-feed-v1" });
  mocks.xIngestPublication.mockResolvedValue({ score: 60, score_record_id: "saved-score", score_version: "v16", policy_version: "social-feed-v1" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("public and private feed boundaries", () => {
  it("allows anonymous reads without looking up the reader's score", async () => {
    const response = await listPosts(request("GET"));
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].id).toBe("p1");
    expect(mocks.requirePublication).not.toHaveBeenCalled();
    expect(mocks.xIngestPublication).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  it("shows every published X post the repository returns without author score checks", async () => {
    const mirrored = { ...post, id: "pst_x_1", origin: "x" as const, author: { ...post.author, id: "gha_404", github_login: "unscored" } };
    mocks.repository.listPosts.mockResolvedValue({ items: [mirrored, post], next_cursor: null, algorithm_version: "chronological-v1" });
    const response = await listPosts(request("GET"));
    expect((await response.json()).items.map((item: FeedPost) => item.id)).toEqual(["pst_x_1", "p1"]);
    expect(mocks.xIngestPublication).not.toHaveBeenCalled();
  });
  it("requires identity only for the private following feed", async () => {
    expect((await listPosts(request("GET", undefined, { path: "/api/feed/posts?channel=following" }))).status).toBe(401);
    expect((await listPosts(request("GET", undefined, { path: "/api/feed/posts?channel=following", signed: true }))).status).toBe(200);
    expect(mocks.requirePublication).not.toHaveBeenCalled();
  });
});

describe("publishing and interaction authorization", () => {
  it("ignores the framework's empty route params when publishing a root post", async () => {
    const frameworkHandler: (request: Request, context: { params: Promise<Record<string, string>> }) => Response | Promise<Response> = postsRoute.POST;
    const response = await frameworkHandler(request("POST", { text: "root" }, { signed: true }), { params: Promise.resolve({}) });
    expect(response.status).toBe(201);
    expect(mocks.repository.createNativePost.mock.calls[0][0].parent_post_id).toBeUndefined();
  });
  it("hydrates optional reply capabilities without turning a score outage into a reading gate", async () => {
    expect((await getPost(request("GET", undefined, { signed: true }), params)).status).toBe(200);
    expect(mocks.repository.getPost.mock.calls.at(-1)?.[1]).toEqual({ user_id: "github:7", can_reply: true });
    mocks.publishingCapabilities.mockRejectedValue(new Error("score storage unavailable"));
    expect((await getPost(request("GET", undefined, { signed: true }), params)).status).toBe(200);
    expect(mocks.repository.getPost.mock.calls.at(-1)?.[1]).toEqual({ user_id: "github:7", can_reply: false });
    expect((await setReaction(request("PUT", { value: "like" }, { signed: true }), params)).status).toBe(200);
  });
  it("rejects unauthenticated and cross-origin publications", async () => {
    expect((await createPost(request("POST", { text: "hello" }))).status).toBe(401);
    expect((await createPost(request("POST", { text: "hello" }, { signed: true, origin: "https://attacker.example" }))).status).toBe(403);
    expect(mocks.repository.createNativePost).not.toHaveBeenCalled();
  });
  it("rejects forged source/author/score and oversized Unicode text", async () => {
    for (const field of ["origin", "author_id", "score", "source", "conversation_id"]) {
      expect((await createPost(request("POST", { text: "hi", [field]: "forged" }, { signed: true }))).status).toBe(400);
    }
    expect((await createPost(request("POST", { text: "🙂".repeat(5001) }, { signed: true }))).status).toBe(400);
    expect((await createPost(request("POST", { text: "🙂".repeat(5000) }, { signed: true }))).status).toBe(201);
  });
  it("derives the stable author and checks eligibility for root posts and nested replies", async () => {
    expect((await createPost(request("POST", { text: "hello" }, { signed: true }))).status).toBe(201);
    expect(mocks.repository.createNativePost.mock.calls[0][0].actor.user_id).toBe("github:7");
    mocks.requirePublication.mockRejectedValue(new SocialFeedError("score_below_minimum", 403));
    expect((await createPost(request("POST", { text: "reply" }, { signed: true }), params)).status).toBe(403);
    expect(mocks.repository.createNativePost).toHaveBeenCalledTimes(1);
  });
  it("returns an earlier successful command even after the author's score drops", async () => {
    mocks.repository.findPublication.mockResolvedValue(post);
    mocks.requirePublication.mockRejectedValue(new SocialFeedError("score_below_minimum", 403));
    expect((await createPost(request("POST", { text: "hello" }, { signed: true }))).status).toBe(200);
    expect(mocks.requirePublication).not.toHaveBeenCalled();
    expect(mocks.repository.consumeQuota).not.toHaveBeenCalled();
  });
  it("does not apply publishing eligibility to ordinary reactions or deleting one's own post", async () => {
    mocks.requirePublication.mockRejectedValue(new SocialFeedError("score_below_minimum", 403));
    expect((await setReaction(request("PUT", { value: "like" }, { signed: true }), params)).status).toBe(200);
    expect((await deletePost(request("DELETE", undefined, { signed: true }), params)).status).toBe(200);
    expect(mocks.requirePublication).not.toHaveBeenCalled();
  });
});

describe("signed feed cursors", () => {
  it("binds pagination to its observer/channel, rejects tampering, and expires stale sessions", async () => {
    vi.useFakeTimers();
    mocks.repository.listPosts.mockResolvedValue({ items: [post], next_cursor: "repository-private-cursor", algorithm_version: "chronological-v1" });
    const first = await listPosts(request("GET"));
    const page = await first.json();
    const cookie = first.headers.get("set-cookie")?.split(";")[0];
    expect(page.next_cursor).not.toBe("repository-private-cursor");
    const path = `/api/feed/posts?cursor=${encodeURIComponent(page.next_cursor)}`;
    expect((await listPosts(request("GET", undefined, { path, cookie }))).status).toBe(200);
    expect(mocks.repository.listPosts.mock.calls.at(-1)?.[0].cursor).toBe("repository-private-cursor");
    expect((await listPosts(request("GET", undefined, { path }))).status).toBe(400);
    expect((await listPosts(request("GET", undefined, { path: `${path}&channel=following`, signed: true }))).status).toBe(400);
    expect((await listPosts(request("GET", undefined, { path: `${path}a`, cookie }))).status).toBe(400);
    vi.advanceTimersByTime(31 * 60_000);
    expect((await listPosts(request("GET", undefined, { path, cookie }))).status).toBe(410);
  });
});

describe("qualified view tokens", () => {
  it("binds views to delivered posts and observers, enforces elapsed time and rejects replay expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    const response = await getPost(request("GET"), params);
    const delivered = await response.json();
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    const event = { event_id: "12345678-1234-4234-8234-123456789abc", event_type: "qualified_view", post_id: "p1", view_token: delivered.view_token };
    expect((await recordView(request("POST", event, { cookie }))).status).toBe(400);
    vi.advanceTimersByTime(2100);
    expect((await recordView(request("POST", event, { cookie }))).status).toBe(200);
    expect(mocks.repository.recordQualifiedView.mock.calls[0][0].actor_key).toMatch(/^visitor:/);
    expect((await recordView(request("POST", { ...event, post_id: "forged" }, { cookie }))).status).toBe(400);
    expect((await recordView(request("POST", event))).status).toBe(400);
    vi.advanceTimersByTime(31 * 60_000);
    expect((await recordView(request("POST", event, { cookie }))).status).toBe(400);
  });
  it("records an unexpired view across UTC midnight on the server's receiving date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T23:59:59Z"));
    const response = await getPost(request("GET"), params);
    const delivered = await response.json();
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    vi.advanceTimersByTime(2100);
    const event = { event_id: "12345678-1234-4234-8234-123456789abc", event_type: "qualified_view", post_id: "p1", view_token: delivered.view_token };
    expect((await recordView(request("POST", event, { cookie }))).status).toBe(200);
    expect(mocks.repository.recordQualifiedView.mock.calls[0][0].view_date).toBe("2026-10-26");
  });
  it("does not accept a client assertion that a like occurred", async () => {
    expect((await recordView(request("POST", { event_type: "reaction_changed" }, { signed: true }))).status).toBe(400);
    expect(mocks.repository.recordQualifiedView).not.toHaveBeenCalled();
  });
});

describe("content-only X import", () => {
  const imported = () => ({ author: { github_user_id: "7", github_login: "octocat", name: "Octocat", avatar_url: null },
    source: { post_id: "1234567890123456789", author_id: "1234", url: "https://x.com/octocat/status/1234567890123456789", display_name: "X name", avatar_url: null,
      evidence_url: "https://github.com/octocat", evidence_method: "editorial_review", evidence_checked_at: "2026-10-25T00:00:00Z" },
    text: "The exact original post", published_at: "2026-10-25T00:00:00Z" });
  function machine(value: unknown): Request {
    const req = request("POST", value);
    req.headers.set("Authorization", `Bearer ${process.env.SOCIAL_FEED_INGEST_SECRET}`);
    return req;
  }
  it("requires dedicated authorization and rejects all X metrics rather than silently retaining them", async () => {
    expect((await ingestX(request("POST", imported()))).status).toBe(401);
    for (const field of ["metrics", "comments", "tags", "publication"]) {
      expect((await ingestX(machine({ ...imported(), [field]: {} }))).status).toBe(400);
    }
    expect(mocks.repository.ingestXPost).not.toHaveBeenCalled();
  });
  it("preserves media-only X posts and rejects completely empty imports", async () => {
    const media = { id: "x_image_1", type: "image", url: "https://pbs.twimg.com/media/example.jpg", alt_text: null, width: 200, height: 100 };
    expect((await ingestX(machine({ ...imported(), text: "", media: [media] }))).status).toBe(201);
    expect(mocks.repository.ingestXPost.mock.calls[0][0].text).toBe("");
    expect((await ingestX(machine({ ...imported(), text: "", media: [] }))).status).toBe(400);
  });
  it("requires string source IDs and matching original URLs, then uses server score evidence", async () => {
    const invalid = imported();
    expect((await ingestX(machine({ ...invalid, source: { ...invalid.source, post_id: 1234567890123456789 } }))).status).toBe(400);
    expect((await ingestX(machine({ ...invalid, source: { ...invalid.source, url: "https://x.com/octocat/status/999" } }))).status).toBe(400);
    expect((await ingestX(machine(imported()))).status).toBe(201);
    expect(mocks.repository.ingestXPost.mock.calls[0][0].publication.score_record_id).toBe("saved-score");
    expect(mocks.xIngestPublication).toHaveBeenCalledWith("octocat", "7");
  });
  it("accepts a translations map with the post and rejects unknown locales before writing", async () => {
    const translations = { zh: { text: "原帖", source_lang: "en", model: "deepseek-chat", provider: "deepseek" }, ja: { text: "元の投稿" } };
    expect((await ingestX(machine({ ...imported(), source_lang: "en-US", translations }))).status).toBe(201);
    expect(mocks.repository.ingestXPost.mock.calls[0][0]).toMatchObject({ source_lang: "en-us",
      translations: { zh: { text: "原帖", source_lang: "en", model: "deepseek-chat", provider: "deepseek" }, ja: { text: "元の投稿", source_lang: null } } });
    for (const bad of [{ fr: { text: "Bonjour" } }, { ja: { text: "x", score: 1 } }, { ja: "x" }, []]) {
      expect((await ingestX(machine({ ...imported(), translations: bad }))).status).toBe(400);
    }
    expect((await (await ingestX(machine({ ...imported(), translations: { "zh-TW": { text: "x" } } }))).json()).error).toBe("invalid_locale");
    expect(mocks.repository.ingestXPost).toHaveBeenCalledTimes(1);
  });
});

describe("localized reads", () => {
  it("passes the page locale to timeline and detail reads and returns original plus translation", async () => {
    const translated = { ...post, source_lang: "en", translation: { locale: "ja", text: "こんにちは", source_lang: "en" } };
    mocks.repository.listPosts.mockResolvedValue({ items: [translated], next_cursor: null, algorithm_version: "chronological-v1" });
    const response = await listPosts(request("GET", undefined, { path: "/api/feed/posts?locale=ja" }));
    expect(mocks.repository.listPosts.mock.calls[0][0]).toMatchObject({ channel: "recommended", locale: "ja" });
    expect((await response.json()).items[0]).toMatchObject({ text: "hello", translation: { locale: "ja", text: "こんにちは" } });
    await getPost(request("GET", undefined, { path: "/api/feed/posts/p1?locale=ar" }), params);
    expect(mocks.repository.getPost.mock.calls[0][2]).toBe("ar");
  });
  it("reads without a locale as original-only and rejects unknown locales", async () => {
    await listPosts(request("GET"));
    expect(mocks.repository.listPosts.mock.calls[0][0].locale).toBeNull();
    const response = await listPosts(request("GET", undefined, { path: "/api/feed/posts?locale=fr" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_locale");
  });
});


describe("author hover summary", () => {
  it("keeps bound X identities and only falls back for missing links", async () => {
    const summary = { author: { ...post.author, id: "gha_7" }, following: 0, followers: 0, follows_you: false, x_url: "https://x.com/i/user/123", score: null };
    mocks.repository.getAuthorSummary.mockResolvedValue(summary);
    await getAuthorSummary(request("GET"), params);
    expect(mocks.githubProfileXUrl).not.toHaveBeenCalled();
    mocks.repository.getAuthorSummary.mockResolvedValue({ ...summary, x_url: null });
    mocks.githubProfileXUrl.mockResolvedValue("https://x.com/example");
    expect(await (await getAuthorSummary(request("GET"), params)).json()).toMatchObject({ x_url: "https://x.com/example" });
    expect(mocks.githubProfileXUrl).toHaveBeenCalledWith("7");
  });
  it("shows saved final_score without joining scan snapshots; hides when score is hidden", async () => {
    const summary = { author: { ...post.author, id: "gha_7" }, following: 3, followers: 4, follows_you: false, x_url: null, score: null };
    mocks.repository.getAuthorSummary.mockImplementation(async () => ({ ...summary }));
    mocks.readDisplayScore.mockResolvedValue({ github_user_id: null, final_score: 69, hidden: 0 });
    expect(await (await getAuthorSummary(request("GET"), params)).json()).toMatchObject({ score: 69, following: 3, followers: 4 });
    mocks.readDisplayScore.mockResolvedValue({ github_user_id: null, final_score: 99, hidden: 1 });
    expect(await (await getAuthorSummary(request("GET"), params)).json()).toMatchObject({ score: null });
    expect(mocks.requirePublication).not.toHaveBeenCalled();
  });
});

describe("write kill switches", () => {
  it("returns 503 feature_disabled when publish is off (after idempotent miss)", async () => {
    vi.stubEnv("SOCIAL_FEED_PUBLISH_ENABLED", "0");
    const response = await createPost(request("POST", { text: "hello" }, { signed: true }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "feature_disabled" });
    expect(mocks.repository.createNativePost).not.toHaveBeenCalled();
  });
  it("returns 503 feature_disabled when ingest is off", async () => {
    vi.stubEnv("SOCIAL_FEED_INGEST_ENABLED", "0");
    const body = { author: { github_user_id: "7", github_login: "octocat", name: "Octocat", avatar_url: null },
      source: { post_id: "1234567890123456789", author_id: "1234", url: "https://x.com/octocat/status/1234567890123456789", display_name: "X name", avatar_url: null,
        evidence_url: "https://github.com/octocat", evidence_method: "editorial_review", evidence_checked_at: "2026-10-25T00:00:00Z" },
      text: "The exact original post", published_at: "2026-10-25T00:00:00Z" };
    const req = request("POST", body);
    req.headers.set("Authorization", `Bearer ${process.env.SOCIAL_FEED_INGEST_SECRET}`);
    const response = await ingestX(req);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "feature_disabled" });
    expect(mocks.repository.ingestXPost).not.toHaveBeenCalled();
  });
  it("consumes ingest quotas before writing an X post", async () => {
    const body = { author: { github_user_id: "7", github_login: "octocat", name: "Octocat", avatar_url: null },
      source: { post_id: "1234567890123456789", author_id: "1234", url: "https://x.com/octocat/status/1234567890123456789", display_name: "X name", avatar_url: null,
        evidence_url: "https://github.com/octocat", evidence_method: "editorial_review", evidence_checked_at: "2026-10-25T00:00:00Z" },
      text: "The exact original post", published_at: "2026-10-25T00:00:00Z" };
    const req = request("POST", body);
    req.headers.set("Authorization", `Bearer ${process.env.SOCIAL_FEED_INGEST_SECRET}`);
    expect((await ingestX(req)).status).toBe(201);
    expect(mocks.repository.consumeQuota.mock.calls.map((call: unknown[]) => call.slice(0, 2))).toEqual([
      ["ingest:global", "ingest"],
      ["ingest:global", "ingest_hour"],
      ["ingest:author:7", "ingest"],
    ]);
  });
});
