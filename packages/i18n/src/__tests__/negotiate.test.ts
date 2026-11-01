import { describe, expect, it } from "vitest";
import { decideLocale, localeAlternates, localePath, splitLocale, topSupportedLanguage } from "..";

describe("topSupportedLanguage", () => {
  it("keeps zh-first headers Chinese and maps other top languages", () => {
    expect(topSupportedLanguage("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
    expect(topSupportedLanguage("ja-JP,en;q=0.8")).toBe("ja");
    expect(topSupportedLanguage("en;q=0.5,ko;q=0.9")).toBe("ko");
  });

  it("returns null for missing or unsupported top languages", () => {
    expect(topSupportedLanguage(null)).toBeNull();
    expect(topSupportedLanguage("")).toBeNull();
    expect(topSupportedLanguage("fr-FR,en;q=0.8")).toBeNull();
  });
});

describe("decideLocale", () => {
  it("negotiates markdown only on home routes", () => {
    expect(decideLocale({ pathname: "/", mode: "agent" })).toEqual({ kind: "markdown" });
    expect(decideLocale({ pathname: "/en", accept: "text/markdown" })).toEqual({ kind: "markdown" });
    expect(decideLocale({ pathname: "/about", accept: "text/markdown" }).kind).toBe("render");
  });

  it("renders explicit /zh URLs as-is", () => {
    expect(decideLocale({ pathname: "/zh/about", acceptLanguage: "en" })).toEqual({
      kind: "render",
      locale: "zh",
      isHome: false,
      prefixed: true,
      explicitDefault: true,
    });
  });

  it("renders prefixed locales regardless of cookie", () => {
    expect(decideLocale({ pathname: "/ja/u/x", cookieLocale: "en" })).toMatchObject({
      kind: "render",
      locale: "ja",
      isHome: false,
      prefixed: true,
    });
    expect(decideLocale({ pathname: "/en" })).toMatchObject({ kind: "render", locale: "en", isHome: true });
  });

  it("keeps crawlers without Accept-Language on the zh root", () => {
    expect(decideLocale({ pathname: "/leaderboard" })).toEqual({
      kind: "render",
      locale: "zh",
      isHome: false,
      prefixed: false,
      explicitDefault: false,
    });
  });

  it("redirects root paths by cookie first, then Accept-Language", () => {
    expect(decideLocale({ pathname: "/", cookieLocale: "ko", acceptLanguage: "ja" })).toEqual({
      kind: "redirect",
      locale: "ko",
      location: "/ko",
    });
    expect(decideLocale({ pathname: "/u/x", acceptLanguage: "es-ES" })).toEqual({
      kind: "redirect",
      locale: "es",
      location: "/es/u/x",
    });
    expect(decideLocale({ pathname: "/u/x", cookieLocale: "zh", acceptLanguage: "es" }).kind).toBe("render");
  });
});

describe("paths", () => {
  it("prefixes non-default locales only", () => {
    expect(localePath("zh", "/")).toBe("/");
    expect(localePath("en", "/")).toBe("/en");
    expect(localePath("ja", "/u/x/")).toBe("/ja/u/x");
  });

  it("builds self-canonical alternates with x-default", () => {
    const a = localeAlternates("en", "/about");
    expect(a.canonical).toBe("/en/about");
    expect(a.languages["zh-CN"]).toBe("/about");
    expect(a.languages["pt-BR"]).toBe("/pt/about");
    expect(a.languages["x-default"]).toBe("/about");
  });

  it("splits locale prefixes", () => {
    expect(splitLocale("/en/u/x")).toEqual({ locale: "en", path: "/u/x" });
    expect(splitLocale("/en")).toEqual({ locale: "en", path: "/" });
    expect(splitLocale("/zh/about")).toEqual({ locale: "zh", path: "/about" });
    expect(splitLocale("/english")).toEqual({ locale: null, path: "/english" });
    expect(splitLocale("/u/x")).toEqual({ locale: null, path: "/u/x" });
  });
});
