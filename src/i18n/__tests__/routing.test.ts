import { describe, expect, it } from "vitest";
import { routing } from "../routing";

describe("routing", () => {
  it("supports all nine locales with zh as the default", () => {
    expect(routing.locales).toEqual([
      "zh",
      "en",
      "ja",
      "ko",
      "es",
      "pt",
      "id",
      "vi",
      "ar",
    ]);
    expect(routing.defaultLocale).toBe("zh");
  });

  it("uses an as-needed prefix so the root path stays Chinese (no /zh)", () => {
    expect(routing.localePrefix).toBe("as-needed");
  });

  it("disables automatic locale detection to protect existing URLs / SEO", () => {
    expect(routing.localeDetection).toBe(false);
  });
});
