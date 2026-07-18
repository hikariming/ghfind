import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../HomeEventBanner.tsx", import.meta.url), "utf8");

describe("HomeEventBanner", () => {
  it("shows the requested Chinese campaign copy and links to the event page", () => {
    expect(source).toContain('zh: "🔥ADVX2026现场一决高下🔥"');
    expect(source).toContain('href="/advx"');
  });

  it("uses English campaign copy on other locales", () => {
    expect(source).toContain('default: "🔥 Face off live at ADVX 2026 🔥"');
    expect(source).toContain('locale === "zh" ? COPY.zh : COPY.default');
  });
});
