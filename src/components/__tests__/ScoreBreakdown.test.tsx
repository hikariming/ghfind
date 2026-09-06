import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScoreBreakdown, ScoreBreakdownSummary } from "@/components/ScoreBreakdown";

const copy = {
  base: "六维基础分",
  adjustment: "风险调整",
  inferredAdjustment: "未解释分差",
  final: "最终得分",
  heading: "评分构成",
  note: "风险规则在六维分数相加后独立应用。",
  riskHeading: "风险调整明细 · 共 2 项",
  unavailable: "未保存具体扣分明细",
  capNote: "累计扣分受限",
  more: "查看更多",
  riskNoPenalty: "这些提示没有影响最终得分。",
  riskNotesHeading: "查看 1 条未计分提示",
};

describe("ScoreBreakdown", () => {
  it("shows a visible base-minus-adjustment formula and each triggered risk", () => {
    const breakdown = {
      base_score: 80.7,
      total_penalty: 20,
      applied_penalty: 20,
      complete: true,
      red_flags: [
        { flag: "mostly_forks", penalty: 10, detail: "83% of repositories are forks." },
        { flag: "no_original_work", penalty: 10, detail: "No non-empty original repositories." },
      ],
    };
    const html = renderToStaticMarkup(
      <>
        <ScoreBreakdownSummary breakdown={breakdown} copy={copy} />
        <ScoreBreakdown
          breakdown={breakdown}
          finalScore={60.7}
          copy={copy}
          flagLabel={(flag) => flag === "mostly_forks" ? "几乎全部仓库为 Fork" : "没有非空原创仓库"}
        />
      </>,
    );

    expect(html).toContain("六维基础分");
    expect(html).toContain("80.70");
    expect(html).toContain("−20.00");
    expect(html).toContain("60.70");
    expect(html).toContain("风险调整");
    expect(html).toContain("几乎全部仓库为 Fork");
    expect(html).toContain("没有非空原创仓库");
    expect(html).toContain("83% of repositories are forks.");
    expect(html).toContain("No non-empty original repositories.");
    expect(html).toContain('href="#score-breakdown"');
  });

  it("stays hidden when no risk adjustment was applied", () => {
    const breakdown = {
      base_score: 88,
      total_penalty: 0,
      applied_penalty: 0,
      complete: true,
      red_flags: [],
    };
    const html = renderToStaticMarkup(
      <>
        <ScoreBreakdownSummary breakdown={breakdown} copy={copy} />
        <ScoreBreakdown
          breakdown={breakdown}
          finalScore={88}
          copy={copy}
          flagLabel={(flag) => flag}
        />
      </>,
    );

    expect(html).toBe("");
  });

  it("shows structured v10 evidence for penalties and zero-penalty notes", () => {
    const signal = {
      flag: "trivial_pr_farming",
      family: "contribution" as const,
      disposition: "penalty" as const,
      severity: 0.8,
      confidence: 0.75,
      penalty: 3,
      detail: "External PR evidence.",
      evidence: {
        observed: { external_trivial_pr_count: 24, smoothed_rate: 0.58 },
        sample_size: 40,
        threshold: { minimum_sample: 20, smoothed_rate: 0.5 },
        coverage: { repo: 1, merged_pr: 1, all_pr: 1 },
        window: "up to 200 repositories",
      },
    };
    const note = { ...signal, flag: "mostly_forks", disposition: "note" as const, penalty: 0 };
    const html = renderToStaticMarkup(
      <ScoreBreakdown
        breakdown={{
          base_score: 80,
          total_penalty: 3,
          applied_penalty: 3,
          complete: true,
          red_flags: [{ flag: "trivial_pr_farming", penalty: 3, detail: "External PR evidence." }],
          risk_assessment: {
            version: "v10",
            risk_score: 12,
            level: "none",
            confidence: 75,
            applied_penalty: 3,
            signals: [signal],
            coverage: { repo: 1, merged_pr: 1, all_pr: 1 },
          },
          risk_notes: [note],
        }}
        finalScore={77}
        copy={copy}
        flagLabel={(flag) => flag === "trivial_pr_farming" ? "大量低实质 PR" : "仓库以 Fork 为主"}
      />,
    );

    expect(html).toContain("风险调整");
    expect(html).toContain("大量低实质 PR");
    expect(html).toContain("External PR evidence.");
    expect(html).toContain("查看 1 条未计分提示");
    expect(html).not.toContain("external_trivial_pr_count");
    expect(html).not.toContain("minimum_sample");
    expect(html).not.toContain("signal confidence");
    expect(html).not.toContain("up to 200 repositories");
    expect(html).not.toContain("mostly_forks");
  });

  it("does not invent risk reasons when only an inferred adjustment is available", () => {
    const html = renderToStaticMarkup(
      <ScoreBreakdown
        breakdown={{
          base_score: 71,
          total_penalty: 11,
          applied_penalty: 11,
          complete: false,
          red_flags: [],
        }}
        finalScore={60}
        copy={copy}
        flagLabel={(flag) => flag}
      />,
    );

    expect(html).toContain("未保存具体扣分明细");
    expect(html).toContain("未解释分差");
    expect(html).not.toContain("风险调整");
    expect(html).not.toContain("风险调整明细 · 共 2 项");
  });
});
