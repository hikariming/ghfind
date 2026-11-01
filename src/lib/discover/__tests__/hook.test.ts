import { describe, expect, it } from "vitest";
import { ownsRepo } from "../covers";
import { discoverHook } from "../hook";

describe("discoverHook", () => {
  it("drops the template lead and keeps the concrete claim", () => {
    expect(discoverHook({
      name: "pakku",
      summary: "pakku.js 是一个面向 B站的浏览器扩展，用四种相似度算法合并刷屏弹幕。",
    })).toBe("面向 B站的浏览器扩展，用四种相似度算法合并刷屏弹幕。");
  });

  it("prefers a pain statement that is not a template", () => {
    expect(discoverHook({
      name: "fixture-repo",
      summary: "fixture-repo 是一个工具。",
      pain: "登录节点上的缓存把磁盘写满。",
    })).toBe("登录节点上的缓存把磁盘写满。");
  });

  it("rejects 这是一个 / X是一个Y templates", () => {
    expect(discoverHook({
      name: "box",
      summary: "这是一个沙盒项目，给不可信 Agent 跑命令。",
    })).toBe("给不可信 Agent 跑命令。");
    expect(discoverHook({
      name: "pakku.js",
      summary: "pakku.js 是一个 Neovim 插件",
      pain: "在 Neovim 里用 shell 命令过滤选区",
    })).toBe("在 Neovim 里用 shell 命令过滤选区");
  });

  it("ignores template-shaped pain and falls back to stripped summary", () => {
    expect(discoverHook({
      name: "rpc",
      summary: "rpc 是一个面向开发者的工具，把 JSON-RPC 代理成可插拔 Agent 协议。",
      pain: "rpc 是一个工具",
    })).toBe("面向开发者的工具，把 JSON-RPC 代理成可插拔 Agent 协议。");
  });
});

describe("cover ownership", () => {
  it("matches the GitHub login to the repo owner only", () => {
    expect(ownsRepo("Fixture-Owner", "fixture-owner/fixture-repo")).toBe(true);
    expect(ownsRepo("someone-else", "fixture-owner/fixture-repo")).toBe(false);
  });
});
