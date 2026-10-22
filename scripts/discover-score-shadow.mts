/**
 * Shadow rescore for discover-score-v1 (Phase B). Read-only and offline.
 *
 * Reads assessment views that were already fetched (one JSON per file, the
 * shape GET /api/project-analyses/{id} returns) plus an optional local sample
 * file with reviewer partitions and v6 draft copy, and writes a side-by-side
 * comparison to --out. It never talks to a database, queue or API, so it
 * cannot overwrite live assessments.
 *
 *   pnpm tsx scripts/discover-score-shadow.mts --analyses <dir> --out <dir> [--sample <file>]
 *
 * Keep sample files (real repo keys) outside the repository.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  computeDiscoverScore,
  discoverScoreBand,
  lintDiscoverHookV6,
  type DiscoverScorePartition,
  type DiscoverScoreResult,
} from "../platform/shared/discover-score";
import { discoverHook } from "../src/lib/discover/hook";

type Assessment = {
  repoKey: string;
  productScore: number;
  painScore: number;
  effectivenessScore: number;
  experienceScore: number;
  valueDensityScore: number;
  communityStrength: number | null;
  confidence: number;
  verificationLevel: Parameters<typeof computeDiscoverScore>[0]["verificationLevel"];
  lifecycle: Parameters<typeof computeDiscoverScore>[0]["lifecycle"];
  exposureBand: Parameters<typeof computeDiscoverScore>[0]["exposureBand"];
  risks: Array<{ severity: Parameters<typeof computeDiscoverScore>[0]["risks"][number]["severity"]; category: string }>;
  analysis: {
    skill_version: string;
    project: {
      name: string;
      summary: string;
      pain_statement: string;
      discover_hook?: string;
      target_users: string[];
      product_tags: Array<{ namespace?: string; slug: string }>;
    };
  };
};

type SampleEntry = {
  id: string;
  repoKey: string;
  partition?: DiscoverScorePartition;
  keywordPartition?: string;
  hook?: string;
  audience?: string;
};

const CANONICAL: Record<string, DiscoverScorePartition> = {
  "use_case:ai-agent": "agent",
  "use_case:agent-skill": "skill",
  "artifact:microservice": "microservice",
  "artifact:sandbox": "sandbox",
};

export function partitionFromTags(tags: Assessment["analysis"]["project"]["product_tags"]): DiscoverScorePartition {
  for (const tag of tags) {
    const partition = tag.namespace ? CANONICAL[`${tag.namespace}:${tag.slug}`] : undefined;
    if (partition) return partition;
  }
  return "none";
}

export function shadowRow(assessment: Assessment, sample?: SampleEntry) {
  const partition = sample?.partition ?? partitionFromTags(assessment.analysis.project.product_tags);
  const result: DiscoverScoreResult = computeDiscoverScore({
    pain: assessment.painScore,
    effectiveness: assessment.effectivenessScore,
    experience: assessment.experienceScore,
    valueDensity: assessment.valueDensityScore,
    productScore: assessment.productScore,
    confidence: assessment.confidence,
    verificationLevel: assessment.verificationLevel,
    lifecycle: assessment.lifecycle,
    exposureBand: assessment.exposureBand,
    communityStrength: assessment.communityStrength,
    risks: assessment.risks.map((risk) => ({ severity: risk.severity, category: risk.category })),
    partition,
  });
  const project = assessment.analysis.project;
  const oldHook = discoverHook({
    name: project.name,
    summary: project.summary,
    pain: project.discover_hook ?? project.pain_statement,
  });
  return {
    id: sample?.id ?? null,
    repoKey: assessment.repoKey,
    skillVersion: assessment.analysis.skill_version,
    keywordPartition: sample?.keywordPartition ?? null,
    partition,
    old: {
      productScore: assessment.productScore,
      band: discoverScoreBand(assessment.productScore),
      hook: oldHook,
      hookIssues: lintDiscoverHookV6(oldHook, project.name),
      audience: project.target_users[0] ?? null,
    },
    next: {
      ...result,
      hook: sample?.hook ?? null,
      hookIssues: sample?.hook ? lintDiscoverHookV6(sample.hook, project.name) : null,
      audience: sample?.audience ?? null,
    },
  };
}

function main() {
  const { values } = parseArgs({
    options: { analyses: { type: "string" }, out: { type: "string" }, sample: { type: "string" } },
  });
  if (!values.analyses || !values.out) {
    throw new Error("usage: --analyses <dir> --out <dir> [--sample <file>]");
  }
  const byKey = new Map<string, Assessment>();
  for (const file of readdirSync(values.analyses).filter((name) => name.endsWith(".json"))) {
    const view = JSON.parse(readFileSync(join(values.analyses, file), "utf8")) as { assessment?: Assessment };
    if (view.assessment) byKey.set(view.assessment.repoKey.toLowerCase(), view.assessment);
  }
  const sample: SampleEntry[] = values.sample ? JSON.parse(readFileSync(values.sample, "utf8")) : [];
  const corpus = [...byKey.values()].map((assessment) => shadowRow(assessment));
  const sampled = sample.flatMap((entry) => {
    const assessment = byKey.get(entry.repoKey.toLowerCase());
    return assessment ? [shadowRow(assessment, entry)] : [];
  });
  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "corpus-shadow.json"), JSON.stringify(corpus, null, 2));
  writeFileSync(join(values.out, "sample-shadow.json"), JSON.stringify(sampled, null, 2));
  console.log(JSON.stringify({ corpus: corpus.length, sample: sampled.length, missing: sample.length - sampled.length }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
