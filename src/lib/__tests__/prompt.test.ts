import { describe, expect, it } from "vitest";
import { buildRoastMessages } from "../prompt";
import type { ScanResult } from "../types";

const scan = {
  metrics: {
    username: "octocat",
    merged_pr_count: 74,
    recent_merged_pr_sample: 50,
    impact_pr_count: 10,
  },
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

  it("marks recent_prs as a sample in both the prompt and payload", () => {
    const [zhSys, zhUser] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("recent_prs 只是最近 merged PR 样本");
    expect(zhSys.content).toContain("不能从 recent_prs 推断");
    const zhPayload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(zhPayload.context_notes).toMatchObject({
      recent_prs_sample_size: 50,
      total_merged_pr_count: 74,
    });
    expect(zhPayload.context_notes.recent_prs_scope).toContain("不代表全量 PR 分布");
    expect(zhPayload.context_notes.no_sample_extrapolation).toContain("不要仅凭 recent_prs");

    const [enSys, enUser] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("recent_prs is only a recent merged-PR sample");
    expect(enSys.content).toContain("never infer");
    const enPayload = JSON.parse(enUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(enPayload.context_notes).toMatchObject({
      recent_prs_sample_size: 50,
      total_merged_pr_count: 74,
    });
    expect(enPayload.context_notes.recent_prs_scope).toContain("not the all-time PR distribution");
    expect(enPayload.context_notes.no_sample_extrapolation).toContain("Do not infer");
  });
});
