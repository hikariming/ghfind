import type { GoProjectListItem } from "@/lib/go-projects.server";
import type { ProjectAssessment } from "@/lib/project-analysis-db";

export const HOME_MOCK_PROJECTS: GoProjectListItem[] = [
  {
    repo: { repo_key: "demo/observatory", name_with_owner: "demo/observatory", owner_login: "demo", name: "observatory", description: "A small toolkit for making production systems easier to understand.", stars: 1280, forks: 96, language: "TypeScript", topics: ["observability", "developer-tools", "open-source"] },
    contributorCount: 8, avgScore: 78.4, eliteCount: 2, momentum: 8.7, qualityScore: 81,
    topContributors: [{ username: "demo-maintainer", display_name: null, avatar_url: null, final_score: 91, tier: "顶级" }],
  },
  {
    repo: { repo_key: "sample/flowkit", name_with_owner: "sample/flowkit", owner_login: "sample", name: "flowkit", description: "Composable workflows for teams shipping reliable software.", stars: 764, forks: 41, language: "Go", topics: ["workflow", "automation", "developer-tools"] },
    contributorCount: 5, avgScore: 72.1, eliteCount: 1, momentum: 7.9, qualityScore: 75,
    topContributors: [{ username: "sample-builder", display_name: null, avatar_url: null, final_score: 84, tier: "人上人" }],
  },
];

export const HOME_MOCK_ASSESSMENTS = [
  {
    repoKey: "demo/observatory", latestAnalysisId: "demo-observatory", productType: "tool", lifecycle: "active", productScore: 82, painScore: 21, effectivenessScore: 25, experienceScore: 24, valueDensityScore: 12, communityStrength: 76, confidence: 88, verificationLevel: "built", unknowns: [], risks: [], exposureBand: "emerging", stars: 1280, treasureEligible: true, classicEligible: false, resolvedCommitSha: "0000000000000000000000000000000000000001", analyzedAt: Date.now(), reportMarkdown: "Demo assessment", analysis: { repository: { repo_key: "demo/observatory", canonical_url: "https://github.com/demo/observatory" }, project: { summary: "让复杂系统更容易被理解和维护。", product_tags: [{ namespace: "domain", slug: "developer-tools", labels: { zh: "开发者工具", en: "Developer tools" }, evidence_ids: ["demo"] }, { namespace: "use_case", slug: "observability", labels: { zh: "可观测性", en: "Observability" }, evidence_ids: ["demo"] }, { namespace: "artifact", slug: "workflow", labels: { zh: "工作流", en: "Workflow" }, evidence_ids: ["demo"] }] } } },
] as unknown as ProjectAssessment[];
