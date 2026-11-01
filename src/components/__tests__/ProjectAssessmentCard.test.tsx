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

const labels = {
  productScore: "产品价值", confidence: "置信度", communityStrength: "社区强度",
  viewReport: "查看完整评估", treasure: "宝藏项目", classic: "经典项目", unranked: "未上榜",
};

describe("compact assessment cards", () => {
  it("preserves links, full text, scores and accessible overflow tags", () => {
    const entry = {
      ...assessment,
      analysis: {
        ...assessment.analysis,
        project: {
          ...assessment.analysis.project,
          product_tags: ["构建工具", "自动化", "命令行", "工作流", "插件"].map((label, i) => ({
            namespace: "domain" as const, slug: `tag-${i}`, labels: { zh: label, en: `Tool ${i}` }, evidence_ids: [],
          })),
        },
      },
    };
    const markup = renderToStaticMarkup(<ProjectAssessmentCard assessment={entry} locale="zh" labels={labels} variant="compact" />);
    expect(markup).toContain('href="https://github.com/lathe-cli/lathe" target="_blank" rel="noopener noreferrer"');
    expect(markup).toContain('href="/projects/analyses/analysis-1"');
    expect(markup).toContain('title="lathe-cli/lathe"');
    expect(markup).toContain('title="A CLI generator."');
    expect(markup).toContain('aria-label="lathe-cli/lathe · 宝藏项目"');
    expect(markup).toContain('title="命令行 · 工作流 · 插件" aria-label="命令行 · 工作流 · 插件"');
    expect(markup).toContain('+3</span>');
    expect(markup).toContain('>75</span>');
    expect(markup).toContain('产品价值');
    expect(markup).toContain('置信度 79%');
    expect(markup).toContain('社区强度 43/100');
    expect(markup).not.toContain('min-h-[16.25rem]');
    expect(markup).not.toContain('mt-auto');
  });

  it("supports empty tags and preserves the fallback board classification", () => {
    const markup = renderToStaticMarkup(<ProjectAssessmentCard assessment={{ ...assessment, treasureEligible: false }} locale="en" labels={labels} variant="compact" />);
    expect(markup).not.toContain('+0');
    expect(markup).toContain('aria-label="lathe-cli/lathe · 未上榜"');
  });
});
