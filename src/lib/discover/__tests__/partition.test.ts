import { describe, expect, it } from "vitest";
import {
  cardMatchesPartition,
  filterCardsByPartition,
} from "../partition";
import type { DiscoverCard } from "../types";

function card(partial: Partial<DiscoverCard> & Pick<DiscoverCard, "repoKey" | "name">): DiscoverCard {
  return {
    ownerLogin: "owner",
    summary: "",
    hook: "",
    audience: null,
    coverUrl: null,
    language: null,
    tags: [],
    productScore: 50,
    confidence: 50,
    communityStrength: null,
    canonicalUrl: `https://github.com/${partial.repoKey}`,
    analysisId: null,
    impressionToken: null,
    source: "public",
    verificationLevel: "built",
    ...partial,
  };
}

describe("cardMatchesPartition", () => {
  it("matches all for every card", () => {
    expect(cardMatchesPartition(card({ repoKey: "a/b", name: "b" }), "all")).toBe(true);
  });

  it("maps product_tags slug and zh/en labels to agent", () => {
    expect(
      cardMatchesPartition(
        card({
          repoKey: "o/agent-kit",
          name: "agent-kit",
          tags: [{ id: "artifact:ai-agent", label: "AI Agent" }],
        }),
        "agent",
      ),
    ).toBe(true);
    expect(
      cardMatchesPartition(
        card({
          repoKey: "o/zh-agent",
          name: "zh-agent",
          tags: [{ id: "use_case:workflow", label: "智能体" }],
        }),
        "agent",
      ),
    ).toBe(true);
  });

  it("falls back to hook/summary keywords for skill and sandbox", () => {
    expect(
      cardMatchesPartition(
        card({
          repoKey: "o/pakku",
          name: "pakku",
          hook: "在 Neovim 里用 shell 命令过滤选区",
          summary: "Neovim 插件",
          tags: [{ id: "artifact:plugin", label: "插件" }],
        }),
        "skill",
      ),
    ).toBe(true);
    expect(
      cardMatchesPartition(
        card({
          repoKey: "o/box",
          name: "box",
          hook: "给不可信 Agent 跑命令的隔离沙盒",
          summary: "sandbox runtime",
        }),
        "sandbox",
      ),
    ).toBe(true);
  });

  it("maps microservice via label or text", () => {
    expect(
      cardMatchesPartition(
        card({
          repoKey: "o/svc",
          name: "svc",
          tags: [{ id: "artifact:microservice", label: "微服务" }],
        }),
        "microservice",
      ),
    ).toBe(true);
    expect(
      cardMatchesPartition(
        card({
          repoKey: "o/rpc",
          name: "rpc",
          hook: "把 JSON-RPC 代理成可插拔微服务网关",
        }),
        "microservice",
      ),
    ).toBe(true);
  });

  it("does not match unrelated cards", () => {
    expect(
      cardMatchesPartition(
        card({
          repoKey: "o/cli",
          name: "cli",
          hook: "生成本地 fixture",
          tags: [{ id: "domain:cli", label: "命令行" }],
        }),
        "agent",
      ),
    ).toBe(false);
  });
});

describe("filterCardsByPartition", () => {
  it("filters the grid/swipe list without changing scoring", () => {
    const items = [
      card({
        repoKey: "o/agent",
        name: "agent",
        tags: [{ id: "artifact:agent", label: "Agent" }],
      }),
      card({
        repoKey: "o/sandbox",
        name: "sandbox",
        hook: "隔离沙盒跑不可信命令",
      }),
      card({
        repoKey: "o/other",
        name: "other",
        hook: "普通 CLI",
      }),
    ];
    expect(filterCardsByPartition(items, "all")).toHaveLength(3);
    expect(filterCardsByPartition(items, "agent").map((c) => c.repoKey)).toEqual(["o/agent"]);
    expect(filterCardsByPartition(items, "sandbox").map((c) => c.repoKey)).toEqual(["o/sandbox"]);
  });
});
