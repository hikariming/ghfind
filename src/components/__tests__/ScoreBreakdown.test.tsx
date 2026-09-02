import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScoreBreakdown, ScoreBreakdownSummary } from "@/components/ScoreBreakdown";

const copy = {
  base: "六维基础分",
  adjustment: "风险调整",
  final: "最终得分",
  heading: "评分构成",
  note: "风险规则在六维分数相加后独立应用。",
  riskHeading: "风险调整明细 · 共 2 项",
  unavailable: "未保存具体扣分明细",
  capNote: "累计扣分受限",
  more: "查看更多",
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
    expect(html).not.toContain("风险调整明细 · 共 2 项");
  });
});
