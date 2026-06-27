import { describe, expect, it } from "vitest";
import { BADGE_COLOR, TIER_EN, buildBadge, estimateTextWidth, renderBadge } from "../badge";
import type { Tier } from "../types";

const TIERS: Tier[] = ["夯", "顶级", "人上人", "NPC", "拉完了"];

describe("estimateTextWidth", () => {
  it("counts CJK wider than ASCII", () => {
    expect(estimateTextWidth("顶级")).toBeGreaterThan(estimateTextWidth("ab"));
  });
  it("is positive for non-empty strings", () => {
    expect(estimateTextWidth("83.30 ELITE")).toBeGreaterThan(0);
  });
});

describe("renderBadge", () => {
  it("produces a valid, self-contained SVG with no scripts/external refs", () => {
    const svg = renderBadge({ label: "GitHub Roast", value: "83.30 ELITE", color: "#8B5CF6" });
    expect(svg).toMatch(/^<svg[\s>]/);
    expect(svg.trimEnd()).toMatch(/<\/svg>$/);
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("http://www.w3.org/1999/xlink");
    expect(svg).toContain('width="');
  });
  it("escapes XML-special characters in text", () => {
    const svg = renderBadge({ label: "a&b", value: "<x>", color: "#555" });
    expect(svg).toContain("a&amp;b");
    expect(svg).toContain("&lt;x&gt;");
  });
});

describe("buildBadge", () => {
  it("renders score + English tier word and the tier color by default", () => {
    for (const tier of TIERS) {
      const svg = buildBadge({ score: 83.3, tier });
      expect(svg).toContain("83.30");
      expect(svg).toContain(TIER_EN[tier]);
      expect(svg).toContain(BADGE_COLOR[tier]);
    }
  });

  it("uses the Chinese tier word when lang=zh", () => {
    const svg = buildBadge({ score: 70, tier: "顶级", lang: "zh" });
    expect(svg).toContain("顶级");
    expect(svg).not.toContain("ELITE");
  });

  it("falls back to a neutral unrated badge when there is no score", () => {
    expect(buildBadge({ score: null, tier: null })).toContain("unrated");
    expect(buildBadge({ score: null, tier: null, lang: "zh" })).toContain("未评分");
    // neutral gray, not a tier color
    expect(buildBadge({ score: null, tier: null })).not.toContain(BADGE_COLOR["顶级"]);
  });
});
