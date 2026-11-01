import type { AnchorHTMLAttributes, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscoverApp } from "@/components/discover/DiscoverApp";
import { useDiscoverStore } from "@/lib/discover/store";
import type { DiscoverCard } from "@/lib/discover/types";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/me-client", () => ({
  fetchMe: () => Promise.resolve({ user: null }),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props} />
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/toggle-group", () => ({
  ToggleGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ToggleGroupItem: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>{children}</button>
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

describe("DiscoverApp SSR", () => {
  beforeEach(() => {
    useDiscoverStore.setState({
      items: [],
      ready: false,
      loading: false,
      partition: "all",
      mode: "grid",
      banner: "signed_out",
      exhausted: false,
      index: 0,
      history: [],
      cursor: null,
      offset: 0,
      source: "public",
      publicBoard: "treasure",
    });
  });

  it("paints initialCards into the grid before hydrate (store still empty)", () => {
    const markup = renderToStaticMarkup(
      <DiscoverApp locale="zh" initialCards={[card]} initialBoard="treasure" initialOffset={1} />,
    );
    expect(markup).toContain("fixture-repo");
    expect(markup).toContain("discover-grid");
    expect(markup).not.toMatch(/>empty</);
  });
});

describe("discover store ready flag", () => {
  it("hydrate marks ready and seeds items from initial", async () => {
    useDiscoverStore.setState({ ready: false, items: [] });
    await useDiscoverStore.getState().hydrate({
      locale: "zh",
      githubLogin: null,
      initial: [card],
      board: "treasure",
      nextOffset: 1,
    });
    const state = useDiscoverStore.getState();
    expect(state.ready).toBe(true);
    expect(state.items).toEqual([card]);
    expect(state.loading).toBe(false);
  });
});
