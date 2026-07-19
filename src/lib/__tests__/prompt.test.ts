import { describe, expect, it } from "vitest";
import { buildRoastMessages } from "../prompt";
import type { ScanResult } from "../types";

const scan = {
  metrics: {
    username: "sample-user",
    merged_pr_count: 74,
    recent_merged_pr_sample: 50,
    impact_pr_count: 10,
    impact_commit_count: 5,
    impact_repo_count: 4,
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
    expect(sys.content).toContain("GitHub 毒舌锐评写手");
    expect(sys.content).toContain("分数、档位、六维分和质量风险都已由确定性评分引擎给出");
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
      expect(sys.content).toContain("@@ADJUST 0@@");
      expect(sys.content).toContain("@@TAGS");
      expect(sys.content).toContain("@@ROAST");
      expect(sys.content).toContain("zh=");
      expect(sys.content).toContain("en=");
    }
  });

  it("keeps deterministic-score guardrails inside the combined prompt", () => {
    const [zhSys, zhUser] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("分数来自评分引擎，不是你的判断");
    expect(zhSys.content).toContain("学校、公司、雇主、组织 membership 只是背景");
    expect(zhSys.content).toContain("不得重算、四舍五入到别的分、升降档");
    expect(zhUser.content).not.toContain('"judge_result"');

    const [enSys] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("The score comes from the scoring engine");
    expect(enSys.content).toContain("background context, not score evidence");
    expect(enSys.content).toContain("Do not recompute, round into another score, move tiers");
  });

  it("keeps the LLM out of scoring while preserving one-response report generation", () => {
    const [sys, user] = buildRoastMessages(scan, "zh");
    expect(sys.content).toContain("第一行必须严格写 `@@ADJUST 0@@`");
    expect(sys.content).toContain("不能改分、不能暗示模型另有裁决");
    expect(sys.content).toContain("标题最终分直接使用 scoring.final_score");
    const payload = JSON.parse(user.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(payload.judge_result).toBeUndefined();
    expect(payload.calibration_contract).toBeUndefined();
    expect(payload.score_contract).toContain("@@ADJUST 0@@");
  });

  it("keeps affiliations from becoming score evidence in writer context", () => {
    const [zhSys, zhUser] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("学校、公司、雇主、组织 membership 只是背景");
    expect(zhSys.content).toContain("不是分数背书");
    const zhPayload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(zhPayload.context_notes.affiliation_scope).toContain("不能作为夸奖或背书理由");
    expect(zhPayload.context_notes.affiliation_scope).toContain("README 文本");

    const [enSys, enUser] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("School, company, employer, or organization membership is background context");
    expect(enSys.content).toContain("not score evidence");
    const enPayload = JSON.parse(enUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(enPayload.context_notes.affiliation_scope).toContain("must not justify praise");
    expect(enPayload.context_notes.affiliation_scope).toContain("README text");
  });

  it("does not duplicate structured README summaries in the prompt payload", () => {
    const [, user] = buildRoastMessages(
      {
        ...scan,
        top_repos: [
          {
            name: "project",
            readme_excerpt: "Structured summary",
            readme: {
              features: {
                prompt_summary: "Structured summary",
              },
            },
          },
          {
            name: "legacy",
            readme_excerpt: "Legacy summary",
          },
        ],
      } as unknown as ScanResult,
      "zh",
    );
    const payload = JSON.parse(user.content.match(/```json\n([\s\S]*)\n```/)![1]);

    expect(payload.top_repos[0].readme.features.prompt_summary).toBe("Structured summary");
    expect(payload.top_repos[0].readme_excerpt).toBeUndefined();
    expect(payload.top_repos[1].readme_excerpt).toBe("Legacy summary");
  });

  it("requires the report body to translate internal fields into user-facing roast language", () => {
    const [zhSys] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("展示层脱敏");
    expect(zhSys.content).toContain("报告正文禁止出现内部字段名或调试词");
    expect(zhSys.content).toContain("不要写 judge_result、delta、verdict");
    expect(zhSys.content).toContain("被评分引擎压到/封顶/裁定");
    expect(zhSys.content).toContain("仓库证据必须使用完整");
    expect(zhSys.content).toContain("owner/small-repo 与 owner/flagship");
    expect(zhSys.content).toContain("外部 PR 里将近六成");
    expect(zhSys.content).toContain("别只写审计结论");

    const [enSys] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("Presentation hygiene and roast strength");
    expect(enSys.content).toContain("Never expose internal field names");
    expect(enSys.content).toContain("do not write judge_result, delta, verdict");
    expect(enSys.content).toContain("scoring engine capped/decided");
    expect(enSys.content).toContain("Repository evidence must use full");
    expect(enSys.content).toContain("do not merely list audit facts");
  });

  it("keeps the report footer user-facing without score-calibration boilerplate", () => {
    const [zhSys] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("报告尾部必须分块输出");
    expect(zhSys.content).toContain("不要把“风险标记 / 建议”挤在同一段里");
    expect(zhSys.content).not.toContain("**评分校准**");
    expect(zhSys.content).not.toContain("分数由确定性规则给出，本次不做额外修正");
    expect(zhSys.content).not.toContain("**人工复核**:");

    const [enSys] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("separated blocks with blank lines");
    expect(enSys.content).toContain("Red flags / Verdict");
    expect(enSys.content).not.toContain("**Score calibration**");
    expect(enSys.content).not.toContain("Score is determined by the deterministic rules");
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
    expect(zhSys.content).toContain("英文 ≤140 chars");
    expect(zhSys.content).toContain("正文一句话结论负责价值判断和补刀，不能比顶部更狠");

    const [enSys] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("top-card main roast");
    expect(enSys.content).toContain("must carry the strongest attack");
    expect(enSys.content).toContain("Do not save the sharpest hit for the report TL;DR");
    expect(enSys.content).toContain("English ≤140 chars");
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
    expect(zh.content).toContain("官方工作流已落地 PR");
    expect(zh.content).toContain("作者主动关闭外部 PR");
    expect(zh.content).toContain("作者主动关闭自有仓库 PR");

    const [en] = buildRoastMessages(scan, "en");
    expect(en.content).not.toContain("acceptance rate");
    expect(en.content).toContain("maintainer-closed unmerged");
    expect(en.content).toContain("workflow-landed PRs");
    expect(en.content).toContain("author-closed external PRs");
    expect(en.content).toContain("author-closed own-repo PRs");
  });

  it("keeps official workflow landings distinct from GitHub-native merges", () => {
    const workflowScan = {
      ...scan,
      metrics: {
        ...scan.metrics,
        workflow_landed_pr_count: 3,
        workflow_landed_impact_pr_count: 3,
      },
    } as ScanResult;
    const [, zhUser] = buildRoastMessages(workflowScan, "zh");
    const zhPayload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(zhPayload.context_notes.workflow_landed_pr_count).toBe(3);
    expect(zhPayload.context_notes.workflow_landing_scope).toContain("不得把官方工作流已落地 PR 写成 GitHub 合并");

    const [, enUser] = buildRoastMessages(workflowScan, "en");
    const enPayload = JSON.parse(enUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(enPayload.context_notes.workflow_landed_pr_count).toBe(3);
    expect(enPayload.context_notes.workflow_landing_scope).toContain("Never call workflow-landed PRs GitHub merges");
  });

  it("marks recent_prs as a sample in both the prompt and payload", () => {
    const [zhSys, zhUser] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("不要从 recent_prs 推断全量分布");
    const zhPayload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(zhPayload.context_notes).toMatchObject({
      recent_prs_sample_size: 50,
      total_merged_pr_count: 74,
    });
    expect(zhPayload.context_notes.recent_prs_scope).toContain("不代表全量 PR 分布");
    expect(zhPayload.context_notes.account_time_scope).toContain("自然年份数量");
    expect(zhPayload.context_notes.account_time_scope).toContain("不要把它直接和 account_age_years 比较");
    expect(zhPayload.context_notes.no_sample_extrapolation).toContain("不要仅凭 recent_prs");

    const [enSys, enUser] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("do not extrapolate all-time behavior from recent_prs");
    const enPayload = JSON.parse(enUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(enPayload.context_notes).toMatchObject({
      recent_prs_sample_size: 50,
      total_merged_pr_count: 74,
    });
    expect(enPayload.context_notes.recent_prs_scope).toContain("not the all-time PR distribution");
    expect(enPayload.context_notes.account_time_scope).toContain("calendar years with contributions");
    expect(enPayload.context_notes.account_time_scope).toContain("time-travel");
    expect(enPayload.context_notes.no_sample_extrapolation).toContain("Do not infer");
  });

  it("keeps impact coverage neutral and includes verified high-star PR samples", () => {
    const [zhSys, zhUser] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("不能把样本数写成");

    const payload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(payload.metrics.unverified_impact_pr_count).toBeUndefined();
    expect(payload.metrics.impact_prs_outside_quality_sample).toBe(7);
    expect(payload.context_notes.impact_prs_outside_quality_sample).toContain("不是负面指标");
    expect(payload.context_notes.verified_impact_sample_scope).toContain("不能把样本条数写成长期贡献总数");
    expect(payload.impact_summary).toMatchObject({
      popular_repo_pr_count: 10,
      popular_repo_commit_count: 5,
      popular_repo_count: 4,
      verified_file_sample_count: 1,
    });
    expect(payload.impact_summary.sample_rule).toContain("不是总贡献数");
    expect(payload.verified_impact_prs[0]).toMatchObject({
      repo: "popular-ai/backend",
      repo_stars: 146000,
      changed_files: 14,
    });
    expect(payload.verified_impact_prs[0].files).toContain("api/controllers/console/wraps.py");
  });

  it("tells the writer to use all-time impact totals instead of verified sample length", () => {
    const [zhSys, zhUser] = buildRoastMessages(scan, "zh");
    expect(zhSys.content).toContain("生态/维护影响力行必须先用 impact_summary 的长期总量");
    expect(zhSys.content).toContain("不能把样本数写成");
    expect(zhSys.content).toContain("长期贡献 N 个 PR + M 个 commit");
    const zhPayload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(zhPayload.impact_summary.total_rule).toContain("popular_repo_pr_count + popular_repo_commit_count");

    const [enSys, enUser] = buildRoastMessages(scan, "en");
    expect(enSys.content).toContain("impact_summary's all-time totals");
    expect(enSys.content).toContain("never write the sample length");
    expect(enSys.content).toContain("N PRs + M commits");
    const enPayload = JSON.parse(enUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(enPayload.impact_summary.sample_rule).toContain("not the total contribution count");
  });

  it("requires human review for low-trust docs-heavy impact", () => {
    const lowTrust = {
      ...scan,
      metrics: {
        ...scan.metrics,
        total_stars: 157,
        impact_quality_cap: 4,
        recent_external_doc_like_pr_ratio: 0.59,
        top_starred_original_repo_quality_score: 0.14,
      },
    } as unknown as ScanResult;

    const [, zhUser] = buildRoastMessages(lowTrust, "zh");
    const zhPayload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(zhPayload.context_notes.required_verdict).toContain("需人工复核");
    expect(zhPayload.risk_notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("文档/站点/示例/样式类工作"),
        expect.stringContaining("高星仓库生态影响"),
        expect.stringContaining("最高星原创"),
      ]),
    );

    const [, enUser] = buildRoastMessages(lowTrust, "en");
    const enPayload = JSON.parse(enUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(enPayload.context_notes.required_verdict).toContain("needs human review");
    expect(enPayload.risk_notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("docs/site/examples/style work"),
        expect.stringContaining("Popular-repo impact"),
        expect.stringContaining("top-starred original signal"),
      ]),
    );
  });

  it("builds display risks for docs-heavy social-profile accounts without relying on red_flags", () => {
    const docsHeavy = {
      ...scan,
      metrics: {
        ...scan.metrics,
        followers: 1040,
        total_stars: 157,
        max_stars: 83,
        merged_pr_count: 38,
        maintainer_closed_unmerged_pr_count: 8,
        recent_merged_pr_sample: 38,
        recent_external_pr_sample: 37,
        recent_external_doc_like_pr_ratio: 0.62,
        impact_quality_cap: 4,
        core_impact_pr_count: 1,
        doc_like_impact_pr_count: 4,
        top_starred_original_repo_quality_score: 0.39,
        top_starred_original_repo_quality_repo: "docs-heavy/profile",
        self_closed_external_pr_count: 22,
      },
      scoring: {
        ...scan.scoring,
        red_flags: [],
      },
    } as unknown as ScanResult;

    const [, zhUser] = buildRoastMessages(docsHeavy, "zh");
    const payload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(payload.scoring.red_flags).toEqual([]);
    expect(payload.risk_notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("约 62%"),
        expect.stringContaining("高星仓库生态影响"),
        expect.stringContaining("docs-heavy/profile"),
        expect.stringContaining("followers"),
        expect.stringContaining("22 个外部 PR 由作者主动关闭"),
      ]),
    );
  });

  it("does not turn small author-closed external PR volume into a display risk by itself", () => {
    const healthyExternal = {
      ...scan,
      metrics: {
        ...scan.metrics,
        merged_pr_count: 109,
        maintainer_closed_unmerged_pr_count: 0,
        self_closed_external_pr_count: 13,
        recent_merged_pr_sample: 50,
        recent_external_pr_sample: 50,
        recent_external_doc_like_pr_ratio: 0.08,
        impact_quality_cap: undefined,
        core_impact_pr_count: 5,
        doc_like_impact_pr_count: 0,
        top_starred_original_repo_quality_score: 0.8,
      },
      scoring: {
        ...scan.scoring,
        red_flags: [],
      },
    } as unknown as ScanResult;

    const [, zhUser] = buildRoastMessages(healthyExternal, "zh");
    const payload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(payload.risk_notes).toEqual([]);
  });

  it("marks high-core templated contributors as substantive rather than low-quality farming", () => {
    const strongCore = {
      ...scan,
      metrics: {
        ...scan.metrics,
        merged_pr_count: 1000,
        impact_pr_count: 600,
        impact_commit_count: 0,
        recent_merged_pr_sample: 30,
        recent_external_doc_like_pr_ratio: 0,
        core_impact_pr_count: 50,
        doc_like_impact_pr_count: 0,
        pr_rejection_rate: 0.08,
        pr_flood_suspect: true,
        top_repo_pr_target: "foundation/workflow",
        top_repo_pr_share: 0.6,
        templated_pr_ratio: 0.6,
      },
      scoring: {
        ...scan.scoring,
        red_flags: [
          {
            flag: "templated_pr_flooding",
            penalty: 5,
            detail:
              "近期 60% 的 PR 集中刷向 foundation/workflow，60% 标题高度模板化（30 个样本） — 模式化批量贡献风险，需结合 diff 质量人工复核。",
          },
        ],
      },
    } as unknown as ScanResult;

    const [, zhUser] = buildRoastMessages(strongCore, "zh");
    const zhPayload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(zhPayload.context_notes.strong_core_impact).toContain("实质高星贡献账号");
    expect(zhPayload.context_notes.strong_core_impact).toContain("不得定性为低质量刷量");
    expect(zhPayload.factual_guardrails).toEqual(
      expect.arrayContaining([
        expect.stringContaining("强核心事实"),
        expect.stringContaining("不得写成主要是测试/文档/模板工作"),
        expect.stringContaining("不得外推成 AI 使用"),
        expect.stringContaining("不得推断没有提交权限"),
      ]),
    );

    const [, enUser] = buildRoastMessages(strongCore, "en");
    const enPayload = JSON.parse(enUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(enPayload.context_notes.strong_core_impact).toContain("substantive popular-repo contributor");
    expect(enPayload.context_notes.strong_core_impact).toContain("low-quality farming");
    expect(enPayload.factual_guardrails).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Strong-core fact"),
        expect.stringContaining("mostly test/doc/template work"),
        expect.stringContaining("AI-use"),
        expect.stringContaining("missing commit access"),
      ]),
    );
  });

  it("surfaces signature work clusters even when the repo is not high-star impact", () => {
    const withSignatureWork = {
      ...scan,
      impact_repos: [
        { repo: "mega/popular", stars: 100_000, prs: 1, commits: 0 },
        { repo: "rust/tooling", stars: 15_000, prs: 9, commits: 0 },
      ],
      recent_prs: [
        {
          title: "fix(api): revoke bound deployment capabilities",
          repo: "org/control-plane",
          repo_stars: 40,
          churn: 200,
          changed_files: 5,
          trivial: false,
        },
        {
          title: "fix(cost): atomically persist usage ledger",
          repo: "org/control-plane",
          repo_stars: 40,
          churn: 140,
          changed_files: 4,
          trivial: false,
        },
        {
          title: "feat(api): persist bound capability run provenance",
          repo: "org/control-plane",
          repo_stars: 40,
          churn: 180,
          changed_files: 6,
          trivial: false,
        },
      ],
    } as unknown as ScanResult;

    const [, zhUser] = buildRoastMessages(withSignatureWork, "zh");
    const payload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(payload.signature_work.instruction).toContain("样本推导");
    expect(payload.signature_work.instruction).toContain("不得");
    expect(payload.signature_work.impact_repo_representatives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repo: "rust/tooling", prs: 9 }),
      ]),
    );
    expect(payload.signature_work.work_clusters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: "org/control-plane",
          recent_merged_prs_in_sample: 3,
          quality_keyword_hits: 3,
        }),
      ]),
    );
  });

  it("explains all-history low-star signature work with owner-ecosystem context", () => {
    const withAllHistorySignatureWork = {
      ...scan,
      signature_work: {
        source: "all_history_public_scan",
        impact_repo_representatives: [
          { repo: "org/main-platform", stars: 100_000, prs: 1, commits: 0 },
        ],
        work_clusters: [
          {
            repo: "org/control-plane",
            stars: 39,
            all_time_prs: 3,
            quality_keyword_hits: 3,
            examples: [
              "fix(api): revoke bound deployment capabilities",
              "fix(cost): atomically persist usage ledger",
              "feat(api): persist bound capability run provenance",
            ],
            org_context_repo: "org/main-platform",
            org_context_stars: 100_000,
            substantive_low_star_signal: true,
          },
        ],
      },
    } as unknown as ScanResult;

    const [zhSys, zhUser] = buildRoastMessages(withAllHistorySignatureWork, "zh");
    const payload = JSON.parse(zhUser.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(zhSys.content).toContain("低 star 仓库不是自动低价值");
    expect(payload.signature_work.instruction).toContain("全量历史");
    expect(payload.signature_work.instruction).toContain("至少点名一个");
    expect(payload.signature_work.instruction).toContain("生态/维护影响力行");
    expect(payload.signature_work.org_ecosystem_repositories).toEqual([
      expect.objectContaining({
        repo: "org/control-plane",
        org_context_repo: "org/main-platform",
        prs: 3,
      }),
    ]);
    expect(payload.signature_work.work_clusters[0].note).toContain("不能因为 star 低就当低价值");
    expect(payload.signature_work.work_clusters[0].note).toContain("org/main-platform");
    expect(payload.signature_work.work_clusters[0].note).toContain("不要因为这个仓库 star 少");
  });
});
