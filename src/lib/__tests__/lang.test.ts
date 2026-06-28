import { describe, expect, it } from "vitest";
import { normLang } from "../lang";
import { roastKey } from "../redis";

describe("normLang", () => {
  it("returns en only for the exact 'en' value", () => {
    expect(normLang("en")).toBe("en");
  });

  it("falls back to zh for anything else", () => {
    for (const v of ["zh", "EN", "fr", undefined, null, 1, {}]) {
      expect(normLang(v)).toBe("zh");
    }
  });
});

describe("roastKey", () => {
  it("namespaces the cache key by language and lowercases the username", () => {
    expect(roastKey("SampleUser", "en")).toBe("roast:v2:en:sampleuser");
    expect(roastKey("SampleUser", "zh")).toBe("roast:v2:zh:sampleuser");
  });

  it("keeps en and zh keys distinct", () => {
    expect(roastKey("sample-user", "en")).not.toBe(roastKey("sample-user", "zh"));
  });
});
