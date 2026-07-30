import { describe, expect, it } from "vitest";
import {
  parseProjectAnalysisArtifacts,
  normalizeGitHubRepository,
  LEGACY_PROJECT_ANALYSIS_SCHEMA_VERSION,
  PROJECT_ANALYSIS_SCHEMA_VERSION,
} from "../project-analysis-contract";

const evidence = {
  schema_version: PROJECT_ANALYSIS_SCHEMA_VERSION,
  analysis_id: "analysis-1",
  repo_key: "owner/useful-tool",
  resolved_commit_sha: "a".repeat(40),
  entries: [
    {
      id: "readme-contract",
      kind: "source",
      summary: "README defines one-command conversion.",
      outcome: "pass",
      path: "README.md",
    },
  ],
};

const analysis = {
  schema_version: PROJECT_ANALYSIS_SCHEMA_VERSION,
  analysis_id: "analysis-1",
  repository: {
    repo_key: "owner/useful-tool",
    canonical_url: "https://github.com/owner/useful-tool",
    requested_ref: null,
    resolved_commit_sha: "a".repeat(40),
  },
  rubric_version: "project-value-v1",
  agent_version: "project-evaluator-v2",
  skill_version: "ghfind-project-evaluator-v3",
  project: {
    name: "useful-tool",
    summary: "Converts one format into another.",
    target_users: ["developers"],
    pain_statement: "Manual conversion is repetitive.",
    project_type: "micro_tool",
    lifecycle: "feature_complete",
    product_tags: [
      {
        slug: "one-command-conversion",
        labels: { zh: "一键转换", en: "One-command conversion" },
        evidence_ids: ["readme-contract"],
      },
      {
        slug: "developer-cli",
        labels: { zh: "开发者 CLI", en: "Developer CLI" },
        evidence_ids: ["readme-contract"],
      },
      {
        slug: "automation-friendly",
        labels: { zh: "自动化友好", en: "Automation-friendly" },
        evidence_ids: ["readme-contract"],
      },
    ],
  },
  scores: {
    pain: {
      score: 21,
      max_score: 25,
      rationale: "The problem is frequent and concrete.",
      evidence_ids: ["readme-contract"],
    },
    effectiveness: {
      score: 27,
      max_score: 30,
      rationale: "The command produces the promised result.",
      evidence_ids: ["readme-contract"],
    },
    experience: {
      score: 25,
      max_score: 30,
      rationale: "The primary command is documented.",
      evidence_ids: ["readme-contract"],
    },
    value_density: {
      score: 14,
      max_score: 15,
      rationale: "Small surface with clear value.",
      evidence_ids: ["readme-contract"],
    },
    product_score: 87,
  },
  confidence: 74,
  verification_level: "source_inspected",
  unknowns: ["Runtime execution was not allowed."],
  risks: [],
  community_strength: {
    score: 38,
    rationale: "A small but credible contributor group supports the project.",
    evidence_ids: ["readme-contract"],
  },
  exposure: {
    band: "low",
    stars: 42,
    dependents: null,
    downloads: null,
    rationale: "Low stars for a complete tool.",
    evidence_ids: ["readme-contract"],
  },
  analyzed_at: "2026-07-15T00:00:00.000Z",
};

describe("project analysis contract", () => {
  it("normalizes supported GitHub repository inputs", () => {
    expect(normalizeGitHubRepository("owner/Useful-Tool")).toEqual({
      repoKey: "owner/useful-tool",
      nameWithOwner: "owner/Useful-Tool",
      canonicalUrl: "https://github.com/owner/Useful-Tool",
    });
    expect(
      normalizeGitHubRepository("https://github.com/owner/Useful-Tool.git"),
    ).toEqual({
      repoKey: "owner/useful-tool",
      nameWithOwner: "owner/Useful-Tool",
      canonicalUrl: "https://github.com/owner/Useful-Tool",
    });
  });

  it("rejects non-GitHub and nested URLs", () => {
    expect(() => normalizeGitHubRepository("https://example.com/owner/repo")).toThrow();
    expect(() => normalizeGitHubRepository("https://github.com/owner/repo/issues")).toThrow();
  });

  it("validates identity, dimension totals, and evidence references", () => {
    const parsed = parseProjectAnalysisArtifacts({
      analysisRaw: JSON.stringify(analysis),
      evidenceRaw: JSON.stringify(evidence),
      reportMarkdown: "# Useful Tool\n\nA useful project.",
      expectedAnalysisId: "analysis-1",
      expectedRepoKey: "owner/useful-tool",
    });

    expect(parsed.analysis.scores.product_score).toBe(87);
    expect(parsed.evidence.entries).toHaveLength(1);
  });

  it("keeps legacy v1 artifacts readable with an empty product-tag fallback", () => {
    const { product_tags: _productTags, ...legacyProject } = analysis.project;
    const parsed = parseProjectAnalysisArtifacts({
      analysisRaw: JSON.stringify({
        ...analysis,
        schema_version: LEGACY_PROJECT_ANALYSIS_SCHEMA_VERSION,
        agent_version: "project-evaluator-v1",
        skill_version: "ghfind-project-evaluator-v1",
        project: legacyProject,
      }),
      evidenceRaw: JSON.stringify({
        ...evidence,
        schema_version: LEGACY_PROJECT_ANALYSIS_SCHEMA_VERSION,
      }),
      reportMarkdown: "# Legacy report",
      expectedAnalysisId: "analysis-1",
      expectedRepoKey: "owner/useful-tool",
    });

    expect(parsed.analysis.project.product_tags).toEqual([]);
  });

  it("rejects internal classifications and generic product tags", () => {
    expect(() =>
      parseProjectAnalysisArtifacts({
        analysisRaw: JSON.stringify({
          ...analysis,
          project: {
            ...analysis.project,
            product_tags: [
              ...analysis.project.product_tags.slice(0, 2),
              {
                slug: "micro-tool",
                labels: { zh: "工具", en: "Tool" },
                evidence_ids: ["readme-contract"],
              },
            ],
          },
        }),
        evidenceRaw: JSON.stringify(evidence),
        reportMarkdown: "# Report",
        expectedAnalysisId: "analysis-1",
        expectedRepoKey: "owner/useful-tool",
      }),
    ).toThrow(/internal classification|generic/i);
  });

  it("normalizes known artifact naming drift at the ingestion boundary", () => {
    const parsed = parseProjectAnalysisArtifacts({
      analysisRaw: JSON.stringify({
        ...analysis,
        project: { ...analysis.project, project_type: "micro-tool" },
        risks: [
          {
            severity: "medium",
            category: "compatibility",
            title: "Platform support is narrow",
            description: "Only one operating system is documented.",
            evidence_ids: ["readme-contract"],
          },
        ],
      }),
      evidenceRaw: JSON.stringify(evidence),
      reportMarkdown: "# Report",
      expectedAnalysisId: "analysis-1",
      expectedRepoKey: "owner/useful-tool",
    });

    expect(parsed.analysis.project.project_type).toBe("micro_tool");
    expect(parsed.analysis.risks[0]?.summary).toBe(
      "Only one operating system is documented.",
    );
  });

  it("still rejects unknown project types and risks without usable text", () => {
    expect(() =>
      parseProjectAnalysisArtifacts({
        analysisRaw: JSON.stringify({
          ...analysis,
          project: { ...analysis.project, project_type: "tiny_project" },
        }),
        evidenceRaw: JSON.stringify(evidence),
        reportMarkdown: "# Report",
        expectedAnalysisId: "analysis-1",
        expectedRepoKey: "owner/useful-tool",
      }),
    ).toThrow();

    expect(() =>
      parseProjectAnalysisArtifacts({
        analysisRaw: JSON.stringify({
          ...analysis,
          risks: [
            {
              severity: "low",
              category: "other",
              evidence_ids: ["readme-contract"],
            },
          ],
        }),
        evidenceRaw: JSON.stringify(evidence),
        reportMarkdown: "# Report",
        expectedAnalysisId: "analysis-1",
        expectedRepoKey: "owner/useful-tool",
      }),
    ).toThrow();
  });

  it("rejects score drift and missing evidence", () => {
    expect(() =>
      parseProjectAnalysisArtifacts({
        analysisRaw: JSON.stringify({
          ...analysis,
          scores: { ...analysis.scores, product_score: 88 },
        }),
        evidenceRaw: JSON.stringify(evidence),
        reportMarkdown: "# Report",
        expectedAnalysisId: "analysis-1",
        expectedRepoKey: "owner/useful-tool",
      }),
    ).toThrow(/sum/i);

    expect(() =>
      parseProjectAnalysisArtifacts({
        analysisRaw: JSON.stringify({
          ...analysis,
          scores: {
            ...analysis.scores,
            pain: { ...analysis.scores.pain, evidence_ids: ["missing"] },
          },
        }),
        evidenceRaw: JSON.stringify(evidence),
        reportMarkdown: "# Report",
        expectedAnalysisId: "analysis-1",
        expectedRepoKey: "owner/useful-tool",
      }),
    ).toThrow(/missing evidence/i);
  });
});

export { analysis as validProjectAnalysis, evidence as validRuntimeEvidence };
