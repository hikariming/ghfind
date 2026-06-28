import { describe, expect, it, vi } from "vitest";
import {
  bypassGeneratedCaches,
  ROAST_CACHE_VERSION,
  SCORE_CACHE_VERSION,
} from "../cache-version";
import { normLang } from "../lang";
import { roastKey, scanKey } from "../redis";

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
  it("namespaces scan keys by score cache version", () => {
    expect(scanKey("SampleUser")).toBe(
      `scan:${SCORE_CACHE_VERSION}:sampleuser`,
    );
  });

  it("namespaces the cache key by language and lowercases the username", () => {
    expect(roastKey("SampleUser", "en")).toBe(
      `roast:${ROAST_CACHE_VERSION}:en:sampleuser`,
    );
    expect(roastKey("SampleUser", "zh")).toBe(
      `roast:${ROAST_CACHE_VERSION}:zh:sampleuser`,
    );
  });

  it("keeps en and zh keys distinct", () => {
    expect(roastKey("sample-user", "en")).not.toBe(roastKey("sample-user", "zh"));
  });
});

describe("bypassGeneratedCaches", () => {
  it("bypasses generated caches in development unless explicitly enabled", () => {
    try {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("ENABLE_DEV_GENERATED_CACHE", undefined);
      expect(bypassGeneratedCaches()).toBe(true);

      vi.stubEnv("ENABLE_DEV_GENERATED_CACHE", "1");
      expect(bypassGeneratedCaches()).toBe(false);

      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("ENABLE_DEV_GENERATED_CACHE", undefined);
      expect(bypassGeneratedCaches()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
