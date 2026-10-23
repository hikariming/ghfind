import { describe, expect, it } from "vitest";
import type { ProjectAnalysisArtifact, RuntimeEvidenceArtifact } from "../project-analysis-contract";
import {
  parseProjectAnalysisArtifacts,
  normalizeGitHubRepository,
  isDiscoverTemplateProse,
  LEGACY_PROJECT_ANALYSIS_SCHEMA_VERSION,
	PREVIOUS_PROJECT_ANALYSIS_SCHEMA_VERSION,
  PROJECT_ANALYSIS_SCHEMA_VERSION,
  PROJECT_SKILL_VERSION,
  PREVIOUS_PROJECT_SKILL_VERSION,
  isAcceptedArtifactSkillVersion,
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
} satisfies RuntimeEvidenceArtifact;

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
  agent_version: "project-evaluator-v3",
  skill_version: "ghfind-project-evaluator-v5",
  project: {
    name: "useful-tool",
    summary: "Converts one format into another.",
    discover_hook: "Stop hand-converting the same payload every release.",
    target_users: ["developers"],
    pain_statement: "Manual conversion is repetitive.",
    project_type: "micro_tool",
    lifecycle: "feature_complete",
    product_tags: [
      {
        namespace: "use_case",
        slug: "one-command-conversion",
        labels: { zh: "一键转换", en: "One-command conversion" },
        evidence_ids: ["readme-contract"],
      },
      {
        namespace: "artifact",
        slug: "developer-cli",
        labels: { zh: "开发者 CLI", en: "Developer CLI" },
        evidence_ids: ["readme-contract"],
      },
      {
        namespace: "audience",
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
} satisfies ProjectAnalysisArtifact;

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

	it("keeps v2 product tags readable while reserving namespace governance for v3", () => {
	  const parsed = parseProjectAnalysisArtifacts({
		analysisRaw: JSON.stringify({
		  ...analysis,
		  schema_version: PREVIOUS_PROJECT_ANALYSIS_SCHEMA_VERSION,
		  agent_version: "project-evaluator-v2",
		  skill_version: "ghfind-project-evaluator-v3",
		  project: {
			...analysis.project,
			product_tags: analysis.project.product_tags.map(({ namespace: _namespace, ...tag }) => tag),
		  },
		}),
		evidenceRaw: JSON.stringify({ ...evidence, schema_version: PREVIOUS_PROJECT_ANALYSIS_SCHEMA_VERSION }),
		reportMarkdown: "# V2 report",
		expectedAnalysisId: "analysis-1",
		expectedRepoKey: "owner/useful-tool",
	  });
	  expect(parsed.analysis.schema_version).toBe(PREVIOUS_PROJECT_ANALYSIS_SCHEMA_VERSION);
	  expect(parsed.analysis.project.product_tags[0]).not.toHaveProperty("namespace");
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
                namespace: "use_case",
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

describe("Discover copy contract", () => {
  it("flags template leads", () => {
    expect(isDiscoverTemplateProse("useful-tool 是一个转换工具", "useful-tool")).toBe(true);
    expect(isDiscoverTemplateProse("Stop hand-converting the same payload every release.")).toBe(false);
  });

  it("requires discover_hook for skill v5", () => {
    const bad = structuredClone(analysis);
    bad.skill_version = PROJECT_SKILL_VERSION;
    const { discover_hook: _omit, ...projectSansHook } = bad.project;
    expect(() =>
      parseProjectAnalysisArtifacts({
        analysisRaw: JSON.stringify({ ...bad, project: projectSansHook }),
        evidenceRaw: JSON.stringify(evidence),
        reportMarkdown: "# ok",
        expectedAnalysisId: "analysis-1",
        expectedRepoKey: "owner/useful-tool",
      }),
    ).toThrow(/discover_hook/);
  });
});

describe("skill v6 contract", () => {
  const v6 = () => {
    const next = structuredClone(analysis) as Record<string, unknown> & typeof analysis;
    next.skill_version = PROJECT_SKILL_VERSION;
    Object.assign(next.project, {
      discover_hook: "批量转换文件不用再写一次性脚本，一条命令出结果",
      discover_partition: "none",
      time_to_first_value: "minutes",
    });
    return next;
  };
  const parse = (value: unknown) =>
    parseProjectAnalysisArtifacts({
      analysisRaw: JSON.stringify(value),
      evidenceRaw: JSON.stringify(evidence),
      reportMarkdown: "# ok",
      expectedAnalysisId: "analysis-1",
      expectedRepoKey: "owner/useful-tool",
    });

  it("records v6 for new runs and keeps v6 fields through parsing", () => {
    expect(PROJECT_SKILL_VERSION).toBe("ghfind-project-evaluator-v6");
    const parsed = parse(v6());
    expect(parsed.analysis.project.discover_partition).toBe("none");
    expect(parsed.analysis.project.time_to_first_value).toBe("minutes");
  });

  it("requires partition and time_to_first_value on v6 only", () => {
    const missing = v6();
    delete (missing.project as Record<string, unknown>).time_to_first_value;
    expect(() => parse(missing)).toThrow(/time_to_first_value/);
    const noPartition = v6();
    delete (noPartition.project as Record<string, unknown>).discover_partition;
    expect(() => parse(noPartition)).toThrow(/discover_partition/);
    // v5 artifacts without v6 fields stay valid (no backfill needed).
    expect(() => parse({ ...analysis, skill_version: PREVIOUS_PROJECT_SKILL_VERSION })).not.toThrow();
  });

  it("enforces exactly one matching canonical partition tag", () => {
    const agent = v6();
    (agent.project as Record<string, unknown>).discover_partition = "agent";
    expect(() => parse(agent)).toThrow(/use_case:ai-agent/);
    agent.project.product_tags[0] = { ...agent.project.product_tags[0], namespace: "use_case", slug: "ai-agent" };
    expect(() => parse(agent)).not.toThrow();
    const conflict = v6();
    conflict.project.product_tags[0] = { ...conflict.project.product_tags[0], namespace: "artifact", slug: "sandbox" };
    expect(() => parse(conflict)).toThrow(/none conflicts/);
  });

  it("lints the v6 hook (length, template lead, marketing, truncation)", () => {
    for (const hook of [
      "这是一个把文件批量转换成另一种格式的命令行工具",
      "强大的转换工具，一条命令出结果",
      "批量转换文件不用再写一次性脚本……",
      "转".repeat(65),
    ]) {
      const bad = v6();
      bad.project.discover_hook = hook;
      expect(() => parse(bad), hook).toThrow(/discover_hook/);
    }
  });

  it("accepts an older snapshot's artifact on a v6 run but never an unknown version", () => {
    expect(isAcceptedArtifactSkillVersion("ghfind-project-evaluator-v4", PROJECT_SKILL_VERSION)).toBe(true);
    expect(isAcceptedArtifactSkillVersion(PREVIOUS_PROJECT_SKILL_VERSION, PROJECT_SKILL_VERSION)).toBe(true);
    expect(isAcceptedArtifactSkillVersion("ghfind-project-evaluator-v3", PROJECT_SKILL_VERSION)).toBe(false);
    expect(isAcceptedArtifactSkillVersion("ghfind-project-evaluator-v99", PROJECT_SKILL_VERSION)).toBe(false);
    expect(isAcceptedArtifactSkillVersion("ghfind-project-evaluator-v3", "ghfind-project-evaluator-v3")).toBe(true);
  });
});

export { analysis as validProjectAnalysis, evidence as validRuntimeEvidence };
