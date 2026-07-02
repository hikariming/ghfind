import { describe, expect, it } from "vitest";
import {
  omniboxRoute,
  omniboxSuggestions,
  parseOmnibox,
  shouldAutoLockPkIntent,
} from "../omnibox";

describe("parseOmnibox — PK (P0)", () => {
  it("splits `a vs b` into a canonical, dictionary-ordered pk intent", () => {
    expect(parseOmnibox("torvalds vs linus")).toEqual({
      kind: "pk",
      a: "linus",
      b: "torvalds",
    });
  });

  it("accepts pk / 大战 / 对线 separators", () => {
    expect(parseOmnibox("nihui pk yyx990803").kind).toBe("pk");
    expect(parseOmnibox("nihui 大战 yyx990803").kind).toBe("pk");
    expect(parseOmnibox("nihui对线yyx990803").kind).toBe("pk"); // CJK sep needs no spaces
  });

  it("is case-insensitive on the separator", () => {
    expect(parseOmnibox("a-user VS b-user").kind).toBe("pk");
  });

  it("does NOT split words that merely contain the separator letters", () => {
    expect(parseOmnibox("vscode").kind).toBe("user"); // no surrounding spaces
    expect(parseOmnibox("versus").kind).toBe("user");
    expect(parseOmnibox("pkzip").kind).toBe("user");
  });

  it("yields pk-half when only the left handle is present/valid", () => {
    expect(parseOmnibox("torvalds vs ")).toEqual({ kind: "pk-half", a: "torvalds" });
    expect(parseOmnibox("torvalds vs !!!")).toEqual({ kind: "pk-half", a: "torvalds" });
  });
});

describe("parseOmnibox — language/org (P1/P2, explicit prefix only)", () => {
  it("routes explicit lang: / 语言: to a canonical language", () => {
    expect(parseOmnibox("lang:rust")).toEqual({ kind: "language", value: "Rust" });
    expect(parseOmnibox("语言：ts")).toEqual({ kind: "language", value: "TypeScript" });
  });

  it("routes explicit org: to a canonical login", () => {
    expect(parseOmnibox("org:字节跳动")).toEqual({ kind: "org", value: "bytedance" });
    expect(parseOmnibox("org:HuggingFace")).toEqual({ kind: "org", value: "huggingface" });
  });

  it("does NOT let a bare alias hijack a valid username on Enter", () => {
    expect(parseOmnibox("rust")).toEqual({ kind: "user", username: "rust" });
    expect(parseOmnibox("typescript").kind).toBe("user");
  });
});

describe("parseOmnibox — repo (P3)", () => {
  it("parses owner/name into a repo intent", () => {
    expect(parseOmnibox("langgenius/dify")).toEqual({
      kind: "repo",
      owner: "langgenius",
      name: "dify",
    });
  });

  it("keeps dotted repo names", () => {
    expect(parseOmnibox("vercel/next.js")).toEqual({
      kind: "repo",
      owner: "vercel",
      name: "next.js",
    });
  });
});

describe("parseOmnibox — user (P5) & freetext (P6)", () => {
  it("normalizes @handles and profile URLs to a user intent", () => {
    expect(parseOmnibox("@torvalds")).toEqual({ kind: "user", username: "torvalds" });
    expect(parseOmnibox("https://github.com/torvalds")).toEqual({
      kind: "user",
      username: "torvalds",
    });
  });

  it("falls back to freetext for unparseable input", () => {
    expect(parseOmnibox("做图像处理的大佬")).toEqual({
      kind: "freetext",
      query: "做图像处理的大佬",
    });
    expect(parseOmnibox("")).toEqual({ kind: "freetext", query: "" });
  });
});

describe("omniboxRoute", () => {
  it("maps navigable intents to paths and keeps in-place intents null", () => {
    expect(omniboxRoute({ kind: "pk", a: "linus", b: "torvalds" })).toBe(
      "/vs/linus/torvalds",
    );
    expect(omniboxRoute({ kind: "language", value: "C++" })).toBe(
      "/developers/language/C%2B%2B",
    );
    expect(omniboxRoute({ kind: "org", value: "bytedance" })).toBe(
      "/developers/org/bytedance",
    );
    expect(omniboxRoute({ kind: "repo", owner: "vercel", name: "next.js" })).toBe(
      "/developers/repo/vercel/next.js",
    );
    expect(omniboxRoute({ kind: "user", username: "torvalds" })).toBeNull();
    expect(omniboxRoute({ kind: "pk-half", a: "torvalds" })).toBeNull();
  });
});

describe("omniboxSuggestions", () => {
  it("advertises PK for a bare valid handle and exposes language discovery", () => {
    const s = omniboxSuggestions("rust");
    expect(s.some((x) => x.intent.kind === "user" && x.group === "direct")).toBe(true);
    expect(s.some((x) => x.intent.kind === "pk-half")).toBe(true);
    expect(
      s.some((x) => x.intent.kind === "language" && x.group === "discover"),
    ).toBe(true);
  });

  it("surfaces a company bucket for a bare org alias", () => {
    const s = omniboxSuggestions("字节跳动");
    expect(
      s.some((x) => x.intent.kind === "org" && x.route === "/developers/org/bytedance"),
    ).toBe(true);
  });

  it("returns nothing for empty input", () => {
    expect(omniboxSuggestions("   ")).toEqual([]);
  });
});

describe("shouldAutoLockPkIntent", () => {
  it("does not relock a restored half-PK string while the user backspaces it", () => {
    expect(shouldAutoLockPkIntent(parseOmnibox("torvalds vs"), true)).toBe(false);
    expect(shouldAutoLockPkIntent(parseOmnibox("torvalds vs"), false)).toBe(true);
  });

  it("still auto-locks a complete pasted PK while half-lock suppression is active", () => {
    expect(shouldAutoLockPkIntent(parseOmnibox("torvalds vs linus"), true)).toBe(true);
  });
});
