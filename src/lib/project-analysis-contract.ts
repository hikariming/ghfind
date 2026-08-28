import { z } from "zod";

export const LEGACY_PROJECT_ANALYSIS_SCHEMA_VERSION = "ghfind.project-analysis.v1";
export const PREVIOUS_PROJECT_ANALYSIS_SCHEMA_VERSION = "ghfind.project-analysis.v2";
export const PROJECT_ANALYSIS_SCHEMA_VERSION = "ghfind.project-analysis.v3";
export const PROJECT_RUBRIC_VERSION = "project-value-v1";
export const PROJECT_AGENT_VERSION = "project-evaluator-v3";
export const PROJECT_SKILL_VERSION = "ghfind-project-evaluator-v4";

export const projectAnalysisStatusSchema = z.enum([
  "queued",
  "creating_thread",
  "running",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export const projectAnalysisPhaseSchema = z.enum([
  "queued",
  "creating_thread",
  "classifying",
  "cloning",
  "inspecting",
  "installing",
  "building",
  "exercising",
  "evaluating",
  "writing_report",
  "persisting",
  "completed",
]);

export const projectAnalysisActivityKindSchema = z.enum([
  "started",
  "inspecting_source",
  "inspecting_docs",
  "inspecting_history",
  "checking_community",
  "evaluating",
  "writing",
  "validating",
  "saving",
  "completed",
  "failed",
]);

export const projectAnalysisActivitySchema = z.object({
  id: z.string().min(1),
  kind: projectAnalysisActivityKindSchema,
  occurredAt: z.string().datetime(),
});

export const projectTypeSchema = z.enum([
  "micro_tool",
  "sdk_library",
  "web_app",
  "desktop_app",
  "framework_platform",
  "database_infra",
  "template_scaffold",
  "enterprise_system",
]);

const PROJECT_TYPE_ALIASES: Readonly<Record<string, ProjectType>> = {
  "micro-tool": "micro_tool",
  "sdk-library": "sdk_library",
  "web-app": "web_app",
  "desktop-app": "desktop_app",
  "framework-platform": "framework_platform",
  "database-infra": "database_infra",
  "template-scaffold": "template_scaffold",
  "enterprise-system": "enterprise_system",
};

const projectTypeArtifactSchema = z.preprocess(
  (value) =>
    typeof value === "string" ? (PROJECT_TYPE_ALIASES[value] ?? value) : value,
  projectTypeSchema,
);

export const projectLifecycleSchema = z.enum([
  "active_evolution",
  "stable_maintenance",
  "feature_complete",
  "experimental",
  "abandoned",
]);

export const verificationLevelSchema = z.enum([
  "metadata_only",
  "source_inspected",
  "built",
  "core_flow_executed",
]);

export const exposureBandSchema = z.enum([
  "unknown",
  "low",
  "emerging",
  "established",
  "mainstream",
]);

const evidenceIdSchema = z.string().trim().min(1).max(100);

const productTagBaseSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  labels: z.object({
    zh: z.string().trim().min(1).max(20),
    en: z.string().trim().min(1).max(40),
  }),
  evidence_ids: z.array(evidenceIdSchema).min(1).max(10),
});

export const productTagNamespaceSchema = z.enum([
  "domain",
  "use_case",
  "audience",
  "artifact",
  "stack",
  "stage",
]);

// v1/v2 artifacts had product tags but no governed namespace. They remain
// readable, but the Feed treats them as inferred proposals rather than
// silently placing them in use_case recall.
export const legacyProductTagSchema = productTagBaseSchema;
export const productTagSchema = productTagBaseSchema.extend({
  namespace: productTagNamespaceSchema,
});

const legacyCompatibleProjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2_000),
  target_users: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  pain_statement: z.string().trim().min(1).max(2_000),
  project_type: projectTypeArtifactSchema,
  lifecycle: projectLifecycleSchema,
  product_tags: z.array(legacyProductTagSchema).max(5).default([]),
});

const currentProjectSchema = legacyCompatibleProjectSchema.extend({
	product_tags: z.array(productTagSchema).min(3).max(5),
});

function scoreDimensionSchema(maxScore: number) {
  return z.object({
    score: z.number().int().min(0).max(maxScore),
    max_score: z.literal(maxScore),
    rationale: z.string().trim().min(1).max(2_000),
    evidence_ids: z.array(evidenceIdSchema).min(1).max(30),
  });
}

const canonicalRiskSchema = z.object({
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  category: z.enum([
    "license",
    "security",
    "supply_chain",
    "maintenance",
    "compatibility",
    "privacy",
    "operations",
    "other",
  ]),
  summary: z.string().trim().min(1).max(2_000),
  evidence_ids: z.array(evidenceIdSchema).max(30),
});

const riskSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const risk = value as Record<string, unknown>;
  if (typeof risk.summary === "string") return value;
  const summary =
    typeof risk.description === "string"
      ? risk.description
      : typeof risk.title === "string"
        ? risk.title
        : undefined;
  return summary ? { ...risk, summary } : value;
}, canonicalRiskSchema);

const communityStrengthSchema = z.object({
  score: z.number().min(0).max(100),
  rationale: z.string().trim().min(1).max(2_000),
  evidence_ids: z.array(evidenceIdSchema).max(30),
});

const projectAnalysisCommonSchema = z.object({
  analysis_id: z.string().trim().min(1).max(100),
  repository: z.object({
    repo_key: z.string().trim().min(3).max(140),
    canonical_url: z.string().url().max(500),
    requested_ref: z.string().trim().min(1).max(200).nullable(),
    resolved_commit_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  }),
  rubric_version: z.string().trim().min(1).max(100),
  agent_version: z.string().trim().min(1).max(100),
  skill_version: z.string().trim().min(1).max(100),
  scores: z.object({
    pain: scoreDimensionSchema(25),
    effectiveness: scoreDimensionSchema(30),
    experience: scoreDimensionSchema(30),
    value_density: scoreDimensionSchema(15),
    product_score: z.number().int().min(0).max(100),
  }),
  confidence: z.number().min(0).max(100),
  verification_level: verificationLevelSchema,
  unknowns: z.array(z.string().trim().min(1).max(2_000)).max(50),
  risks: z.array(riskSchema).max(50),
  community_strength: communityStrengthSchema,
  exposure: z.object({
    band: exposureBandSchema,
    stars: z.number().int().nonnegative().nullable(),
    dependents: z.number().int().nonnegative().nullable(),
    downloads: z.number().int().nonnegative().nullable(),
    rationale: z.string().trim().min(1).max(2_000),
    evidence_ids: z.array(evidenceIdSchema).max(30),
  }),
  analyzed_at: z.string().datetime({ offset: true }),
});

const legacyProjectAnalysisArtifactSchema = projectAnalysisCommonSchema.extend({
  schema_version: z.union([
    z.literal(LEGACY_PROJECT_ANALYSIS_SCHEMA_VERSION),
    z.literal(PREVIOUS_PROJECT_ANALYSIS_SCHEMA_VERSION),
  ]),
  project: legacyCompatibleProjectSchema,
});

export const currentProjectAnalysisArtifactSchema = projectAnalysisCommonSchema.extend({
  schema_version: z.literal(PROJECT_ANALYSIS_SCHEMA_VERSION),
  project: currentProjectSchema,
});

export const projectAnalysisArtifactSchema = z.union([
  legacyProjectAnalysisArtifactSchema,
  currentProjectAnalysisArtifactSchema,
]);

export const runtimeEvidenceArtifactSchema = z.object({
  schema_version: z.union([
    z.literal(PROJECT_ANALYSIS_SCHEMA_VERSION),
    z.literal(PREVIOUS_PROJECT_ANALYSIS_SCHEMA_VERSION),
    z.literal(LEGACY_PROJECT_ANALYSIS_SCHEMA_VERSION),
  ]),
  analysis_id: z.string().trim().min(1).max(100),
  repo_key: z.string().trim().min(3).max(140),
  resolved_commit_sha: z.string().regex(/^[0-9a-f]{40}$/i),
  entries: z
    .array(
      z.object({
        id: evidenceIdSchema,
        kind: z.enum([
          "metadata",
          "source",
          "documentation",
          "command",
          "build",
          "test",
          "runtime",
          "external",
        ]),
        summary: z.string().trim().min(1).max(2_000),
        outcome: z.enum(["pass", "fail", "partial", "unknown"]),
        command: z.string().trim().min(1).max(2_000).optional(),
        path: z.string().trim().min(1).max(1_000).optional(),
        exit_code: z.number().int().optional(),
        excerpt: z.string().trim().min(1).max(4_000).optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const currentRuntimeEvidenceArtifactSchema = runtimeEvidenceArtifactSchema.extend({
  schema_version: z.literal(PROJECT_ANALYSIS_SCHEMA_VERSION),
});

export type ProjectAnalysisStatus = z.infer<typeof projectAnalysisStatusSchema>;
export type ProjectAnalysisPhase = z.infer<typeof projectAnalysisPhaseSchema>;
export type ProjectAnalysisActivity = z.infer<typeof projectAnalysisActivitySchema>;
export type ProjectAnalysisActivityKind = z.infer<
  typeof projectAnalysisActivityKindSchema
>;
export type ProjectAnalysisArtifact = z.infer<typeof projectAnalysisArtifactSchema>;
export type RuntimeEvidenceArtifact = z.infer<typeof runtimeEvidenceArtifactSchema>;
export type ProjectType = z.infer<typeof projectTypeSchema>;
export type ProjectLifecycle = z.infer<typeof projectLifecycleSchema>;
export type VerificationLevel = z.infer<typeof verificationLevelSchema>;
export type ExposureBand = z.infer<typeof exposureBandSchema>;

export interface NormalizedGitHubRepository {
  repoKey: string;
  nameWithOwner: string;
  canonicalUrl: string;
}

export interface ProjectAnalysisArtifactsInput {
  analysisRaw: string;
  evidenceRaw: string;
  reportMarkdown: string;
  expectedAnalysisId: string;
  expectedRepoKey: string;
}

export interface ParsedProjectAnalysisArtifacts {
  analysis: ProjectAnalysisArtifact;
  evidence: RuntimeEvidenceArtifact;
  reportMarkdown: string;
}

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;

export function normalizeGitHubRepository(raw: string): NormalizedGitHubRepository {
  const input = raw.trim();
  if (!input || input.length > 500) throw new Error("invalid_repository");

  let path: string;
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (
      !["github.com", "www.github.com"].includes(url.hostname.toLowerCase()) ||
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid_repository");
    }
    path = url.pathname;
  } else {
    path = input;
  }

  const segments = path.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length !== 2) throw new Error("invalid_repository");
  const owner = segments[0] ?? "";
  const repository = (segments[1] ?? "").replace(/\.git$/i, "");
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(repository)) {
    throw new Error("invalid_repository");
  }

  const nameWithOwner = `${owner}/${repository}`;
  return {
    repoKey: nameWithOwner.toLowerCase(),
    nameWithOwner,
    canonicalUrl: `https://github.com/${nameWithOwner}`,
  };
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function assertEvidenceReferences(
  analysis: ProjectAnalysisArtifact,
  evidence: RuntimeEvidenceArtifact,
): void {
  const available = new Set(evidence.entries.map((entry) => entry.id));
  const referenced = [
    ...analysis.scores.pain.evidence_ids,
    ...analysis.scores.effectiveness.evidence_ids,
    ...analysis.scores.experience.evidence_ids,
    ...analysis.scores.value_density.evidence_ids,
    ...analysis.community_strength.evidence_ids,
    ...analysis.exposure.evidence_ids,
    ...analysis.risks.flatMap((risk) => risk.evidence_ids),
    ...analysis.project.product_tags.flatMap((tag) => tag.evidence_ids),
  ];
  const missing = [...new Set(referenced.filter((id) => !available.has(id)))];
  if (missing.length > 0) {
    throw new Error(`Missing evidence references: ${missing.join(", ")}`);
  }
}

const INTERNAL_PRODUCT_TAGS = new Set([
  "micro-tool",
  "sdk-library",
  "web-app",
  "desktop-app",
  "framework-platform",
  "database-infra",
  "template-scaffold",
  "enterprise-system",
  "active-evolution",
  "stable-maintenance",
  "feature-complete",
  "experimental",
  "abandoned",
  "metadata-only",
  "source-inspected",
  "built",
  "core-flow-executed",
]);

const GENERIC_PRODUCT_TAG_LABELS = new Set([
  "开源",
  "开源项目",
  "工具",
  "实用工具",
  "高质量",
  "open source",
  "open-source",
  "open-source project",
  "project",
  "tool",
  "useful tool",
  "high quality",
]);

function assertProductTags(analysis: ProjectAnalysisArtifact): void {
  if (analysis.schema_version === PROJECT_ANALYSIS_SCHEMA_VERSION) {
    if (analysis.project.product_tags.length < 3) {
      throw new Error("Current project analysis requires at least three product tags");
    }
  }

  const slugs = new Set<string>();
  const zhLabels = new Set<string>();
  const enLabels = new Set<string>();
  for (const tag of analysis.project.product_tags) {
	const namespace = "namespace" in tag ? tag.namespace : undefined;
	if (analysis.schema_version === PROJECT_ANALYSIS_SCHEMA_VERSION && !namespace) {
	  throw new Error(`Product tag namespace is required: ${tag.slug}`);
	}
	const identity = namespace ? `${namespace}:${tag.slug}` : tag.slug;
    if (slugs.has(identity)) throw new Error(`Duplicate product tag slug: ${identity}`);
    slugs.add(identity);
    if (INTERNAL_PRODUCT_TAGS.has(tag.slug)) {
      throw new Error(`Product tag exposes an internal classification: ${tag.slug}`);
    }
    for (const [label, seen] of [
      [tag.labels.zh, zhLabels],
      [tag.labels.en, enLabels],
    ] as const) {
      const normalized = label.trim().toLowerCase();
      if (seen.has(normalized)) throw new Error(`Duplicate product tag label: ${label}`);
      seen.add(normalized);
      if (GENERIC_PRODUCT_TAG_LABELS.has(normalized)) {
        throw new Error(`Product tag is too generic: ${label}`);
      }
    }
  }
}

export function parseProjectAnalysisArtifacts(
  input: ProjectAnalysisArtifactsInput,
): ParsedProjectAnalysisArtifacts {
  if (input.analysisRaw.length > 512_000) throw new Error("analysis artifact is too large");
  if (input.evidenceRaw.length > 1_500_000) throw new Error("evidence artifact is too large");
  if (!input.reportMarkdown.trim() || input.reportMarkdown.length > 500_000) {
    throw new Error("report artifact is empty or too large");
  }

  const analysis = projectAnalysisArtifactSchema.parse(
    parseJson(input.analysisRaw, "analysis artifact"),
  );
  const evidence = runtimeEvidenceArtifactSchema.parse(
    parseJson(input.evidenceRaw, "evidence artifact"),
  );
  const expectedRepoKey = input.expectedRepoKey.toLowerCase();
  if (
    analysis.analysis_id !== input.expectedAnalysisId ||
    evidence.analysis_id !== input.expectedAnalysisId
  ) {
    throw new Error("analysis identity mismatch");
  }
  if (
    analysis.repository.repo_key.toLowerCase() !== expectedRepoKey ||
    evidence.repo_key.toLowerCase() !== expectedRepoKey
  ) {
    throw new Error("repository identity mismatch");
  }
  if (analysis.repository.resolved_commit_sha !== evidence.resolved_commit_sha) {
    throw new Error("resolved commit mismatch");
  }
  if (analysis.schema_version !== evidence.schema_version) {
    throw new Error("artifact schema version mismatch");
  }

  const dimensionSum =
    analysis.scores.pain.score +
    analysis.scores.effectiveness.score +
    analysis.scores.experience.score +
    analysis.scores.value_density.score;
  if (dimensionSum !== analysis.scores.product_score) {
    throw new Error("Product score must equal the dimension sum");
  }
  assertProductTags(analysis);
  assertEvidenceReferences(analysis, evidence);

  return { analysis, evidence, reportMarkdown: input.reportMarkdown };
}
