import { describe, expect, it } from "vitest";
import type { FeedPost } from "@/lib/social-feed/contract";
import { feedReferences } from "./references";

const post = { origin: "x", original_url: "https://x.com/author/status/123" } as FeedPost;
describe("feed reference presentation", () => {
  it("keeps unrelated links and native posts unchanged", () => {
    const text = "Article https://example.com and https://x.com/other/status/456";
    expect(feedReferences({ ...post, origin: "ghfind" }, text, {}).text).toBe(text);
    expect(feedReferences(post, "https://example.com", {}).references).toEqual([]);
  });
  it("deduplicates quoted posts and removes only the redundant self link", () => {
    const result = feedReferences(post, "Hello https://x.com/author/status/123 https://twitter.com/other/status/456 https://x.com/other/status/456", {});
    expect(result.text).toBe("Hello");
    expect(result.references).toEqual([{ url: "https://twitter.com/other/status/456", kind: "post", post: undefined }]);
  });
  it("does not assume short links refer to tweets, and retains punctuation", () => {
    const result = feedReferences(post, "Hello https://t.co/abc。", {});
    expect(result.text).toBe("Hello 。");
    expect(result.references[0].kind).toBe("link");
    expect(result.references[0].url).toBe("https://t.co/abc");
  });
  it("only previews published X posts, never hidden content", () => {
    const quote = { ...post, original_url: "https://x.com/other/status/456", status: "published" } as FeedPost;
    expect(feedReferences(post, quote.original_url!, { quote }).references[0].post).toBe(quote);
    expect(feedReferences(post, quote.original_url!, { quote: { ...quote, status: "hidden" } }).references[0].post).toBeUndefined();
  });
  it("preserves inline short links and their surrounding context", () => {
    const text = "Compare https://t.co/aaa with https://t.co/bbb here";
    expect(feedReferences(post, text, {}).text).toBe(text);
    expect(feedReferences(post, text, {}).references).toEqual([]);
  });
  it("leaves lookalike domains and credential URLs in the body", () => {
    const text = "https://x.com.evil.test/other/status/456 https://user@t.co/abc";
    expect(feedReferences(post, text, {}).text).toBe(text);
  });
});
