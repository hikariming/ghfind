import type { AnchorHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DiscoverCardView } from "@/components/discover/DiscoverCard";
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
  tags: [
    { id: "a", label: "cli" },
    { id: "b", label: "tooling" },
    { id: "c", label: "extra" },
  ],
  productScore: 88,
  confidence: 72,
  communityStrength: 41,
  canonicalUrl: "https://github.com/fixture-owner/fixture-repo",
  analysisId: "analysis-fixture",
  impressionToken: null,
  source: "public",
  verificationLevel: "built",
};

describe("DiscoverCardView", () => {
  it("renders a compact card with repo, hook, score and report link", () => {
    const markup = renderToStaticMarkup(
      <DiscoverCardView
        card={card}
        labels={{ productScore: "产品价值", viewCard: "查看评估", audience: "给" }}
      />,
    );
    expect(markup).toContain("fixture-owner/");
    expect(markup).toContain("fixture-repo");
    expect(markup).toContain("用 shell 命令过滤选区。");
    expect(markup).toContain("line-clamp-3");
    expect(markup).not.toContain("aspect-[16/10]");
    expect(markup).toContain('href="https://github.com/fixture-owner/fixture-repo"');
    expect(markup).toContain('href="/projects/analyses/analysis-fixture"');
    expect(markup).toContain("插件作者");
  });
});
