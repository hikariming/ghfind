import { describe, expect, it } from "vitest";
import { buildRoastMessages } from "../prompt";
import type { ScanResult } from "../types";

const scan = {
  metrics: { username: "octocat" },
  top_repos: [],
  recent_prs: [],
  flood_pr_titles: [],
  scoring: {
    sub_scores: {},
    final_score: 95.2,
    tier: "夯",
    tier_label: "封神 · 殿堂级标杆",
  },
} as unknown as ScanResult;

describe("buildRoastMessages", () => {
  it("defaults to the Chinese system prompt", () => {
    const [sys] = buildRoastMessages(scan);
    expect(sys.role).toBe("system");
    expect(sys.content).toContain("毒舌 GitHub 评分官");
  });

  it("selects the English system prompt for lang=en", () => {
    const [sys, user] = buildRoastMessages(scan, "en");
    expect(sys.content).toMatch(/Savage GitHub Rater/i);
    expect(sys.content).not.toContain("毒舌 GitHub 评分官");
    // user preamble is English, payload is still the scan JSON
    expect(user.content).toMatch(/scoring data/i);
    expect(user.content).toContain("octocat");
    expect(user.content).toContain('"tier": "GOD"');
    expect(user.content).toContain('"tier_label": "Legendary · Hall of Fame"');
    expect(user.content).not.toContain("封神");
  });

  it("keeps the @@ADJUST@@ / @@TAGS@@ / @@ROAST@@ control lines and bilingual fields in both languages", () => {
    for (const lang of ["zh", "en"] as const) {
      const [sys] = buildRoastMessages(scan, lang);
      expect(sys.content).toContain("@@ADJUST");
      expect(sys.content).toContain("@@TAGS");
      expect(sys.content).toContain("@@ROAST");
      expect(sys.content).toContain("zh=");
      expect(sys.content).toContain("en=");
    }
  });

  it("no longer asks for an inline 🔥 roast line in the report body", () => {
    for (const lang of ["zh", "en"] as const) {
      const [sys] = buildRoastMessages(scan, lang);
      // The one-liner moved to the @@ROAST@@ control line; the body must not
      // re-emit a 🔥 marker that splitReport would pick up.
      expect(sys.content).not.toContain("🔥");
    }
  });
});
