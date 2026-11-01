import type { AnchorHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DiscoverGrid } from "@/components/discover/DiscoverGrid";
import type { DiscoverCard } from "@/lib/discover/types";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props} />
  ),
}));

const card: DiscoverCard = {
  repoKey: "fixture-owner/fixture-repo",
  ownerLogin: "fixture-owner",
  name: "fixture-repo",
  summary: "fixture-repo 是一个面向测试的工具。",
  hook: "用 shell 命令过滤选区。",
  audience: "插件作者",
  coverUrl: null,
  language: "Go",
  tags: [{ id: "a", label: "cli" }],
  productScore: 88,
  confidence: 72,
  communityStrength: 41,
  canonicalUrl: "https://github.com/fixture-owner/fixture-repo",
  analysisId: "analysis-fixture",
  impressionToken: null,
  source: "public",
  verificationLevel: "built",
};

describe("DiscoverGrid", () => {
  it("uses content-width auto-fill grid instead of viewport sm two-columns", () => {
    const markup = renderToStaticMarkup(
      <DiscoverGrid
        items={[card]}
        loading={false}
        onLoadMore={() => {}}
        labels={{ productScore: "产品价值", viewCard: "查看评估", audience: "给" }}
      />,
    );
    expect(markup).toContain("discover-grid");
    expect(markup).not.toContain("sm:grid-cols-2");
    expect(markup).not.toContain("xl:grid-cols-3");
    expect(markup).toContain("fixture-repo");
  });
});
