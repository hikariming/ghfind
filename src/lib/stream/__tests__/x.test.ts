import { describe, expect, it } from "vitest";
import { linkXAccounts, xStreamItems } from "@/lib/pages/feed-x";
import { seedStreamItems, seedXTimeline } from "../seed";
import {
  X_MAX_AGE_MS,
  X_PER_ACCOUNT_CAP,
  gatePost,
  isEngagementBait,
  translationFor,
  mergePosts,
  parsePost,
  type XAccount,
  type XPost,
} from "../x";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const account = (handle: string): XAccount => ({
  handle, name: handle, category: "researcher", github: null, talentId: null, verified: true, avatarUrl: null, note: null, ghfind: null, source: "editorial",
});
const ACCOUNTS = new Map([["karpathy", account("karpathy")]]);

function raw(overrides: Record<string, unknown> = {}) {
  return {
    id: "1900000000000000001",
    handle: "@Karpathy",
    text: "Wrote up how tokenizer choices change code-model loss curves; plots and the training script inside.",
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    kind: "post",
    metrics: { likes: 1200, reposts: 200, replies: 40, views: 90000 },
    topics: ["LLM", "tokenizers"],
    technical: 0.9,
    ...overrides,
  };
}

function parsed(overrides: Record<string, unknown> = {}): XPost {
  const post = parsePost(raw(overrides));
  if (!post) throw new Error("fixture did not parse");
  return post;
}

describe("x timeline gates", () => {
  it("normalizes handles and keeps the X url on x.com", () => {
    const post = parsed({ url: "https://evil.example/status/1" });
    expect(post.handle).toBe("karpathy");
    expect(post.url).toBe("https://x.com/karpathy/status/1900000000000000001");
  });

  it("rejects malformed input and non-X media hosts", () => {
    expect(parsePost({ ...raw(), id: "abc" })).toBeNull();
    expect(parsePost({ ...raw(), kind: "space" })).toBeNull();
    expect(parsed({ media: { url: "https://evil.example/a.png" } }).media).toBeNull();
    expect(parsed({ media: { url: "https://pbs.twimg.com/media/a.jpg" } }).media?.url).toBe("https://pbs.twimg.com/media/a.jpg");
  });

  it("accepts an original, technical post from an admitted account", () => {
    expect(gatePost(parsed(), ACCOUNTS, NOW)).toBeNull();
  });

  it("refuses unknown accounts, replies, reposts and stale posts", () => {
    expect(gatePost(parsed({ handle: "someone" }), ACCOUNTS, NOW)).toBe("unknown_account");
    expect(gatePost(parsed({ kind: "reply" }), ACCOUNTS, NOW)).toBe("not_original");
    expect(gatePost(parsed({ kind: "repost" }), ACCOUNTS, NOW)).toBe("not_original");
    expect(gatePost(parsed({ createdAt: new Date(NOW - X_MAX_AGE_MS - 1).toISOString() }), ACCOUNTS, NOW)).toBe("too_old");
  });

  it("requires technical content with topics, and enough substance", () => {
    expect(gatePost(parsed({ technical: 0.3 }), ACCOUNTS, NOW)).toBe("low_technical");
    expect(gatePost(parsed({ topics: [] }), ACCOUNTS, NOW)).toBe("low_technical");
    expect(gatePost(parsed({ text: "gm builders" }), ACCOUNTS, NOW)).toBe("too_short");
  });

  it("filters engagement bait", () => {
    expect(isEngagementBait("Like and retweet to win a free GPU giveaway")).toBe(true);
    expect(isEngagementBait("关注我，评论区扣 1 领取资料")).toBe(true);
    expect(isEngagementBait("#ai #ml #llm #gpu #cuda all the tags")).toBe(true);
    expect(isEngagementBait("Benchmarks for three KV-cache eviction policies under load.")).toBe(false);
    expect(gatePost(parsed({ text: "Follow me for more threads on transformer internals and training tricks" }), ACCOUNTS, NOW)).toBe("engagement_bait");
  });

  it("caps posts per account, dedupes ids and near-identical text, newest first", () => {
    const posts = Array.from({ length: X_PER_ACCOUNT_CAP + 3 }, (_, index) =>
      parsed({ id: `19000000000000000${10 + index}`, text: `Post number ${index} about compilers, incremental parsing and caches.`, createdAt: new Date(NOW - index * 60_000).toISOString() }));
    const merged = mergePosts([posts[0]], [...posts, { ...posts[1], id: "1900000000000000999" }], NOW);
    expect(merged).toHaveLength(X_PER_ACCOUNT_CAP);
    expect(merged[0].id).toBe(posts[0].id);
    expect(new Set(merged.map((post) => post.id)).size).toBe(merged.length);
  });
});

describe("x post translations", () => {
  it("keeps only site locales and offers one only for other-language readers", () => {
    const post = parsed({ lang: "en", translations: { zh: "中文译文", ja: "日本語訳", xx: "nope", ko: "" } });
    expect(post.translations).toEqual({ zh: "中文译文", ja: "日本語訳" });
    expect(translationFor(post, "zh")).toBe("中文译文");
    expect(translationFor(post, "en")).toBeNull();
    expect(translationFor(post, "ko")).toBeNull();
    expect(translationFor({ lang: "en-US", translations: { en: "x" } }, "en")).toBeNull();
  });

  it("attaches the reader's translation to stream items", () => {
    const timeline = seedXTimeline(NOW);
    const ja = xStreamItems(timeline, "ja")[0];
    const en = xStreamItems(timeline, "en")[0];
    expect(ja.extra?.kind === "post" && ja.extra.translation).toMatch(/1B/);
    expect(en.extra?.kind === "post" && en.extra.translation).toBeNull();
  });
});

describe("x timeline in the stream", () => {
  it("links a post author to the same person's developer item", () => {
    const timeline = seedXTimeline(NOW);
    const posts = xStreamItems(timeline, "en");
    const linkedPost = posts.find((item) => item.author.x?.handle === "demo_maintainer");
    expect(linkedPost?.author.id).toBe("demo-maintainer");
    expect(linkedPost?.comments).toEqual({ kind: "profile", key: "demo-maintainer" });

    const developers = linkXAccounts(seedStreamItems("en", NOW), timeline).filter((item) => item.kind === "developer");
    expect(developers.find((item) => item.author.id === "demo-maintainer")?.author.x?.handle).toBe("demo_maintainer");
    expect(developers.find((item) => item.author.id === "sample-builder")?.author.x).toBeUndefined();
  });

  it("keeps the post text as written and links out to X", () => {
    const [first] = xStreamItems(seedXTimeline(NOW), "en");
    expect(first.summary).toBe(seedXTimeline(NOW).posts[0].text);
    expect(first.external).toBe(true);
    expect(first.href).toMatch(/^https:\/\/x\.com\//);
  });
});
