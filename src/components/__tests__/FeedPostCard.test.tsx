import type { AnchorHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FeedPostCard } from "@/components/feed/FeedPostCard";
import type { FeedPost } from "@/lib/social-feed/contract";

vi.mock("next-intl", () => ({
  useLocale: () => "ja",
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props} />,
}));

const base: FeedPost = {
  id: "pst_x_1", origin: "x", kind: "original", author: { id: "gha_1", github_login: "octocat", name: "Octocat", avatar_url: null },
  text: "Original body", source_lang: "en", translation: null, media: [], published_at: "2026-10-26T00:00:00Z", content_version: 2,
  conversation_id: "pst_x_1", parent_post_id: null, original_url: "https://x.com/octocat/status/1", status: "published",
  metrics: { origin: "ghfind", likes: 0, reposts: 0, direct_replies: 0, conversation_replies: 0, views: 0 }, viewer: null,
};
const noop = () => {};
function render(post: FeedPost): string {
  return renderToStaticMarkup(<FeedPostCard post={post} now={Date.parse("2026-10-26T01:00:00Z")} pending={false}
    onOpen={noop} onReply={noop} onAction={noop} onFollow={noop} onCopy={noop} />);
}

describe("FeedPostCard translation toggle", () => {
  it("shows the page-locale translation by default with an Original / Translated toggle", () => {
    const html = render({ ...base, translation: { locale: "ja", text: "翻訳された本文", source_lang: "en" } });
    expect(html).toContain("翻訳された本文");
    expect(html).not.toContain("Original body");
    expect(html).toContain('lang="ja"');
    expect(html).toContain("feed.showOriginal");
    expect(html).toContain("feed.showTranslated");
  });
  it("hides the toggle and shows the original without a translation for the page locale", () => {
    for (const translation of [null, { locale: "ko" as const, text: "번역", source_lang: "en" }]) {
      const html = render({ ...base, translation });
      expect(html).toContain("Original body");
      expect(html).not.toContain("feed.showOriginal");
    }
  });
});
