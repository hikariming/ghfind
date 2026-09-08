import {
  PROJECT_ANALYSIS_SCHEMA_VERSION,
  type ProjectAnalysisArtifact,
} from "../../../src/lib/project-analysis-contract";
// Synthetic fixture derived from the repository contract example; never real GitHub data.
export const syntheticTemplate = {
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
  skill_version: "ghfind-project-evaluator-v4",
  project: {
    name: "useful-tool",
    summary: "Converts one format into another.",
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
