import { describe, expect, it } from "vitest";
import { BADGE_COLOR, TIER_EN, TIER_ZH, buildBadge, estimateTextWidth, renderBadge } from "../badge";
import { realmForScore } from "../realm";
import type { Tier } from "../types";

const TIERS: Tier[] = ["夯", "顶级", "人上人", "NPC", "拉完了"];

describe("estimateTextWidth", () => {
  it("counts CJK wider than ASCII", () => {
    expect(estimateTextWidth("合体")).toBeGreaterThan(estimateTextWidth("ab"));
  });
  it("is positive for non-empty strings", () => {
    expect(estimateTextWidth("Lv.83 Body Integration")).toBeGreaterThan(0);
  });
});

describe("renderBadge", () => {
  it("produces a valid, self-contained SVG with no scripts/external refs", () => {
    const svg = renderBadge({ label: "GitHub Roast", value: "Lv.83 Body Integration", color: "#A97CF5" });
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
  it("bridges stored tier keys to realm display words", () => {
    expect(TIER_ZH["人上人"]).toBe("炼虚");
    expect(TIER_EN.NPC).toBe("Core Form.");
    // Legacy BADGE_COLOR map may still exist for non-score surfaces; buildBadge uses realm fg.
    expect(BADGE_COLOR["人上人"]).toBeTruthy();
  });

  it("renders Lv + English realm word and the realm color by default", () => {
    const svg = buildBadge({ score: 83.3, tier: "顶级" });
    const realm = realmForScore(83.3);
    expect(svg).toContain("Lv.83");
    expect(svg).not.toContain("83.30");
    expect(svg).toContain(realm.nameEnShort);
    expect(svg).toContain(realm.colors.fg);
  });

  it("uses the Chinese realm word when lang=zh", () => {
    const svg = buildBadge({ score: 70, tier: "顶级", lang: "zh" });
    expect(svg).toContain("炼虚");
    expect(svg).not.toContain("顶级");
    expect(svg).not.toContain("ELITE");
  });

  it("falls back to a neutral unrated badge when there is no score", () => {
    expect(buildBadge({ score: null, tier: null })).toContain("unrated");
    expect(buildBadge({ score: null, tier: null, lang: "zh" })).toContain("未评分");
    expect(buildBadge({ score: null, tier: null })).not.toContain(realmForScore(90).colors.fg);
  });
});
