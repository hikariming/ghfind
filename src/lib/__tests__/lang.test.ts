import { describe, expect, it, vi } from "vitest";
import {
  bypassGeneratedCaches,
  ROAST_CACHE_VERSION,
  SCORE_CACHE_VERSION,
} from "../cache-version";
import { normLang } from "../lang";
import { roastKey, scanKey } from "../redis";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "../scan-run-types";

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
  it("namespaces factual scan keys only by collection version", () => {
    expect(scanKey("SampleUser")).toBe(
      `scan:${PUBLIC_SCAN_COLLECTION_VERSION}:sampleuser`,
    );
  });

  it("namespaces reports by roast, score, collection, language, and username", () => {
    expect(roastKey("SampleUser", "en")).toBe(
      `roast:${ROAST_CACHE_VERSION}:${SCORE_CACHE_VERSION}:${PUBLIC_SCAN_COLLECTION_VERSION}:en:sampleuser`,
    );
    expect(roastKey("SampleUser", "zh")).toBe(
      `roast:${ROAST_CACHE_VERSION}:${SCORE_CACHE_VERSION}:${PUBLIC_SCAN_COLLECTION_VERSION}:zh:sampleuser`,
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
