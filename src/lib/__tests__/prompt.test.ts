import { describe, expect, it } from "vitest";
import { buildRoastJudgeMessages, buildRoastMessages } from "../prompt";
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
    expect(sys.content).toContain("毒舌 GitHub 锐评写手");
  });

  it("selects the English system prompt for lang=en", () => {
    const [sys, user] = buildRoastMessages(scan, "en");
    expect(sys.content).toMatch(/savage GitHub report writer/i);
    expect(sys.content).not.toContain("毒舌 GitHub 锐评写手");
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

  it("builds a separate factual judge prompt that returns JSON only", () => {
    const [zhSys, zhUser] = buildRoastJudgeMessages(scan, "zh");
    expect(zhSys.content).toContain("GitHub 评分校准员");
    expect(zhSys.content).toContain("不要写报告，不要玩梗，不要毒舌");
    expect(zhSys.content).toContain('"delta":0');
    expect(zhSys.content).toContain("输出必须是纯 JSON");
    expect(zhUser.content).not.toContain('"judge_result"');

    const [enSys] = buildRoastJudgeMessages(scan, "en");
    expect(enSys.content).toContain("score calibration judge");
    expect(enSys.content).toContain("do not write the report, do not roast");
    expect(enSys.content).toContain("Output pure JSON only");
  });

  it("makes the report writer consume fixed judge_result instead of deciding delta", () => {
    const judge = {
      delta: -2,
      reason: "Docs-heavy contribution mix.",
      verdict: "needs human review",
      risk_notes: ["external PR quality is docs-heavy"],
      final_score: 45.7,
      tier: "NPC" as const,
      tier_label: "普通账号 · 特征平庸存疑",
    };
    const [sys, user] = buildRoastMessages(scan, "zh", judge);
    expect(sys.content).toContain("不是**重新决定 delta");
    expect(sys.content).toContain("必须逐字使用 judge_result.delta");
    expect(sys.content).toContain("judge_result 是唯一评分校准来源");
    expect(sys.content).toContain("不能因为想嘴臭而改分");
    const payload = JSON.parse(user.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(payload.judge_result).toMatchObject(judge);
  });

  it("requires the report body to translate internal fields into user-facing roast language", () => {
    const [zhSys] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("展示层脱敏");
    expect(zhSys.content).toContain("报告正文禁止出现内部字段名或调试词");
    expect(zhSys.content).toContain("禁止写 judge_result、delta、verdict");
    expect(zhSys.content).toContain("外部 PR 里将近六成");
    expect(zhSys.content).toContain("别只写审计结论");

    const [enSys] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("Presentation hygiene and roast strength");
    expect(enSys.content).toContain("Never expose internal field names");
    expect(enSys.content).toContain("never write judge_result, delta, or verdict");
    expect(enSys.content).toContain("do not merely list audit facts");
  });

  it("keeps the report footer as separated user-facing blocks", () => {
    const [zhSys] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("报告尾部必须分块输出");
    expect(zhSys.content).toContain("**评分校准**");
    expect(zhSys.content).toContain('简短写"无额外修正"');
    expect(zhSys.content).not.toContain("**人工复核**:");

    const [enSys] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("separated blocks with blank lines");
    expect(enSys.content).toContain("**Score calibration**");
    expect(enSys.content).toContain("No extra adjustment");
    expect(enSys.content).not.toContain("**Manual review**:");
  });

  it("pushes the writer toward sharper data-grounded roast copy", () => {
    const [zhSys] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("扎心度要求");
    expect(zhSys.content).toContain("先落事实，再补一刀");
    expect(zhSys.content).toContain("禁止温吞词");
    expect(zhSys.content).toContain("每段关键评价至少带一个具体数字");
    expect(zhSys.content).toContain("对中高分用户不要自动客气");

    const [enSys] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("Make It Sting");
    expect(enSys.content).toContain("fact first, jab second");
    expect(enSys.content).toContain("Ban bland phrasing");
    expect(enSys.content).toContain("Each key judgment needs at least one concrete number");
    expect(enSys.content).toContain("Do not automatically soften for high scores");
  });

  it("requires harsher direct callouts for NPC and trash tiers", () => {
    const [zhSys] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("NPC / 拉完了强制火力");
    expect(zhSys.content).toContain("GitHub 当谈资简历");
    expect(zhSys.content).toContain("开源人设包装");
    expect(zhSys.content).toContain("像是在作秀");
    expect(zhSys.content).toContain("至少命中 **两个证据点**");
    expect(zhSys.content).toContain("NPC/拉完了不得留情面");

    const [enSys] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("NPC / TRASH Mandatory Heat");
    expect(enSys.content).toContain("GitHub resume theater");
    expect(enSys.content).toContain("open-source persona packaging");
    expect(enSys.content).toContain("looks like performance");
    expect(enSys.content).toContain("connect at least **two evidence points**");
    expect(enSys.content).toContain("NPC/TRASH cannot be polite");
  });

  it("makes the top roast the main attack instead of the report summary", () => {
    const [zhSys] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("页面顶部卡片的主毒舌");
    expect(zhSys.content).toContain("必须承担最强攻击和传播梗");
    expect(zhSys.content).toContain("不能把火力留到正文“一句话结论”");
    expect(zhSys.content).toContain("每边 ≤180 字");
    expect(zhSys.content).toContain("正文一句话结论负责价值判断和补刀，不能比顶部更狠");

    const [enSys] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("top-card main roast");
    expect(enSys.content).toContain("must carry the strongest attack");
    expect(enSys.content).toContain("Do not save the sharpest hit for the report TL;DR");
    expect(enSys.content).toContain("Each side ≤180 chars");
    expect(enSys.content).toContain("must not outgun the top roast");
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
    const [zhSys] = buildRoastJudgeMessages(scan, "zh");
    const [, zhUser] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("recent_prs 只是最近 merged PR 样本");
    expect(zhSys.content).toContain("不代表全量 PR 分布");
    const zhPayload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(zhPayload.context_notes).toMatchObject({
      recent_prs_sample_size: 50,
      total_merged_pr_count: 74,
    });
    expect(zhPayload.context_notes.recent_prs_scope).toContain("不代表全量 PR 分布");
    expect(zhPayload.context_notes.no_sample_extrapolation).toContain("不要仅凭 recent_prs");

    const [enSys] = buildRoastJudgeMessages(scan, "en");
    const [, enUser] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("recent_prs is only a recent merged-PR sample");
    expect(enSys.content).toContain("not the full PR distribution");
    const enPayload = JSON.parse(enUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(enPayload.context_notes).toMatchObject({
      recent_prs_sample_size: 50,
      total_merged_pr_count: 74,
    });
    expect(enPayload.context_notes.recent_prs_scope).toContain("not the all-time PR distribution");
    expect(enPayload.context_notes.no_sample_extrapolation).toContain("Do not infer");
  });

  it("keeps impact coverage neutral and includes verified high-star PR samples", () => {
    const [zhSys] = buildRoastJudgeMessages(scan, "zh");
    const [, zhUser] = buildRoastMessages(scan, "zh");
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
