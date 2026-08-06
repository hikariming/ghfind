import type { AnchorHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectAssessment } from "@/lib/project-analysis-db";
import { ProjectAssessmentCard } from "@/components/ProjectAssessmentCard";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props} />
  ),
}));

const assessment = {
  repoKey: "lathe-cli/lathe",
  latestAnalysisId: "analysis-1",
  productScore: 75,
  confidence: 79,
  communityStrength: 43,
  treasureEligible: true,
  classicEligible: false,
  analysis: {
    repository: {
      canonical_url: "https://github.com/lathe-cli/lathe",
    },
    project: {
      summary: "A CLI generator.",
      product_tags: [],
    },
  },
} as unknown as ProjectAssessment;

describe("ProjectAssessmentCard", () => {
  it("links the repository name to GitHub and keeps the report CTA internal", () => {
    const markup = renderToStaticMarkup(
      <ProjectAssessmentCard
        assessment={assessment}
        locale="zh"
        labels={{
          productScore: "产品价值",
          confidence: "置信度",
          communityStrength: "社区强度",
          viewReport: "查看完整评估",
          treasure: "宝藏项目",
          classic: "经典项目",
          unranked: "未上榜",
        }}
      />,
    );

    expect(markup).toContain(
      'href="https://github.com/lathe-cli/lathe" target="_blank" rel="noopener noreferrer"',
    );
    expect(markup).toContain('href="/projects/analyses/analysis-1"');
  });
});
