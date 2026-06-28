import { describe, expect, it } from "vitest";
import { buildRoastMessages } from "../prompt";
import type { ScanResult } from "../types";

const scan = {
  metrics: {
    username: "sample-user",
    merged_pr_count: 74,
    recent_merged_pr_sample: 50,
    impact_pr_count: 10,
    unverified_impact_pr_count: 7,
  },
  top_repos: [],
  recent_prs: [],
  verified_impact_prs: [
    {
      title: "refactor: use current_user in console controllers",
      repo: "popular-ai/backend",
      repo_stars: 146000,
      churn: 207,
      changed_files: 14,
      trivial: false,
      files: ["api/controllers/console/wraps.py", "api/tests/unit_tests/controllers/console/test_wraps.py"],
    },
  ],
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
    expect(user.content).toContain("sample-user");
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

  it("asks for PR status breakdown instead of vague acceptance-rate copy", () => {
    const [zh] = buildRoastMessages(scan, "zh");
    expect(zh.content).not.toContain("通过率");
    expect(zh.content).toContain("维护者关闭未合并");
    expect(zh.content).toContain("作者主动关闭外部 PR");
    expect(zh.content).toContain("作者主动关闭自有仓库 PR");

    const [en] = buildRoastMessages(scan, "en");
    expect(en.content).not.toContain("acceptance rate");
    expect(en.content).toContain("maintainer-closed unmerged");
    expect(en.content).toContain("author-closed external PRs");
    expect(en.content).toContain("author-closed own-repo PRs");
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

  it("keeps impact coverage neutral and includes verified high-star PR samples", () => {
    const [zhSys, zhUser] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("不是负面指标");
    expect(zhSys.content).toContain("verified_impact_prs");

    const payload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(payload.metrics.unverified_impact_pr_count).toBeUndefined();
    expect(payload.metrics.impact_prs_outside_quality_sample).toBe(7);
    expect(payload.context_notes.impact_prs_outside_quality_sample).toContain("不是负面指标");
    expect(payload.verified_impact_prs[0]).toMatchObject({
      repo: "popular-ai/backend",
      repo_stars: 146000,
      changed_files: 14,
    });
    expect(payload.verified_impact_prs[0].files).toContain("api/controllers/console/wraps.py");
  });

  it("requires human review for low-trust docs-heavy impact", () => {
    const lowTrust = {
      ...scan,
      metrics: {
        ...scan.metrics,
        impact_quality_cap: 4,
        recent_external_doc_like_pr_ratio: 0.59,
        top_starred_original_repo_quality_score: 0.14,
      },
    } as unknown as ScanResult;

    const [, zhUser] = buildRoastMessages(lowTrust, "zh");
    const zhPayload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(zhPayload.context_notes.required_verdict).toContain("需人工复核");

    const [, enUser] = buildRoastMessages(lowTrust, "en");
    const enPayload = JSON.parse(enUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(enPayload.context_notes.required_verdict).toContain("needs human review");
  });
});
