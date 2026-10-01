import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import proxy from "../proxy";

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(path, "https://ghfind.com"), { headers });
}

const rewriteOf = (res: Response) => res.headers.get("x-middleware-rewrite");

describe("proxy locale routing", () => {
  it("rewrites bare paths to the zh tree and remembers zh", () => {
    const res = proxy(request("/leaderboard"));
    expect(new URL(rewriteOf(res)!).pathname).toBe("/zh/leaderboard");
    expect(res.headers.get("set-cookie")).toContain("NEXT_LOCALE=zh");
    expect(res.headers.get("link")).toBeTruthy();
    expect(res.headers.get("vary") ?? "").not.toMatch(/accept\b/i);
  });

  it("adds Vary: Accept on the zh home", () => {
    const res = proxy(request("/"));
    expect(new URL(rewriteOf(res)!).pathname).toBe("/zh");
    expect(res.headers.get("vary")).toMatch(/accept/i);
  });

  it("redirects root paths by cookie, then Accept-Language", () => {
    const byCookie = proxy(request("/u/x", { cookie: "NEXT_LOCALE=ko", "accept-language": "ja" }));
    expect(byCookie.status).toBe(307);
    expect(new URL(byCookie.headers.get("location")!).pathname).toBe("/ko/u/x");

    const byHeader = proxy(request("/", { "accept-language": "ja-JP,en;q=0.8" }));
    expect(new URL(byHeader.headers.get("location")!).pathname).toBe("/ja");
    expect(byHeader.headers.get("set-cookie")).toContain("NEXT_LOCALE=ja");
    expect(byHeader.headers.get("link")).toBeNull();
  });

  it("renders prefixed locales and remembers them", () => {
    const res = proxy(request("/en/about", { cookie: "NEXT_LOCALE=zh" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toContain("NEXT_LOCALE=en");
    expect(res.headers.get("link")).toBeTruthy();
  });

  it("serves explicit /zh URLs as-is", () => {
    const res = proxy(request("/zh/about", { "accept-language": "en" }));
    expect(rewriteOf(res)).toBeNull();
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toContain("NEXT_LOCALE=zh");
  });

  it("negotiates the markdown twin on home routes only", () => {
    const res = proxy(request("/en?mode=agent"));
    expect(new URL(rewriteOf(res)!).pathname).toBe("/index.md");
    expect(res.headers.get("vary")).toBe("Accept");

    const deep = proxy(request("/about", { accept: "text/markdown" }));
    expect(new URL(rewriteOf(deep)!).pathname).toBe("/zh/about");
  });

  it("marks non-production responses noindex", () => {
    const res = proxy(request("/about"));
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
