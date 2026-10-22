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
});

describe("cover ownership", () => {
  it("matches the GitHub login to the repo owner only", () => {
    expect(ownsRepo("Fixture-Owner", "fixture-owner/fixture-repo")).toBe(true);
    expect(ownsRepo("someone-else", "fixture-owner/fixture-repo")).toBe(false);
  });
});