import { createHash } from "node:crypto";

import { SCORE_CACHE_VERSION } from "./cache-version";
import { PUBLIC_SCAN_COLLECTION_VERSION, type PublicScanSourceStatus } from "./scan-run-types";
import { score, spamBotScore } from "./score";
import type {
  ImpactRepo,
  RawMetrics,
  RecentPr,
  RoastLine,
  ScanResult,
  Scoring,
  SignatureWork,
  SubScores,
  Tags,
  Tier,
  TopRepo,
} from "./types";
import { normalizeUsername } from "./username";

export type ScoreMaterializationMode = "quick" | "durable";

export interface CanonicalScoreMaterializationInput {
  snapshot: string;
  snapshotHash: string;
  username: string;
  scoreVersion: string;
  collectionVersion: string;
  scannedAt: number;
  mode: ScoreMaterializationMode;
  sourceStatus?: PublicScanSourceStatus;
}

/** Structurally compatible with db.ScoreEntry without importing db.ts. */
export interface CanonicalScoreEntry {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  final_score: number;
  tier: Tier;
  tags: Tags;
  roast_line: RoastLine;
  bot_score: number;
  sub_scores: SubScores;
  scanned_at: number;
}

export interface CanonicalScoreProvenance {
  scoreVersion: typeof SCORE_CACHE_VERSION;
  collectionVersion: typeof PUBLIC_SCAN_COLLECTION_VERSION;
  snapshotHash: string;
  mode: ScoreMaterializationMode;
}

export interface CanonicalScoreMaterialization {
  scoreEntry: CanonicalScoreEntry;
  provenance: CanonicalScoreProvenance;
  /** Parsed factual snapshot with its untrusted embedded score replaced. */
  scan: ScanResult;
}

const REQUIRED_NUMBER_METRICS = [
  "account_age_years",
  "followers",
  "following",
  "public_repos",
  "fetched_repo_count",
  "original_repo_count",
  "nonempty_original_repo_count",
  "fork_repo_count",
  "empty_original_repo_count",
  "total_stars",
  "max_stars",
  "merged_pr_count",
  "total_pr_count",
  "issues_created",
  "last_year_contributions",
  "activity_type_count",
  "contribution_years_active",
  "recent_merged_pr_sample",
  "recent_trivial_pr_count",
  "external_trivial_pr_count",
  "max_impact_repo_stars",
  "impact_pr_count",
  "impact_depth_raw",
  "closed_unmerged_pr_count",
  "pr_rejection_rate",
  "recent_pr_sample",
  "top_repo_pr_share",
  "templated_pr_ratio",
] as const satisfies readonly (keyof RawMetrics)[];

const OPTIONAL_NUMBER_METRICS = [
  "top_repo_engagement_ratio",
  "attributed_original_repo_count",
  "attributed_original_repo_stars",
  "best_original_repo_quality_score",
  "top_starred_original_repo_quality_score",
  "workflow_landed_pr_count",
  "recent_doc_like_pr_count",
  "recent_doc_like_pr_ratio",
  "recent_external_pr_sample",
  "recent_external_doc_like_pr_count",
  "recent_external_doc_like_pr_ratio",
  "impact_prestige_score",
  "workflow_landed_impact_pr_count",
  "impact_quality_cap",
  "verified_impact_pr_count",
  "core_impact_pr_count",
  "doc_like_impact_pr_count",
  "unverified_impact_pr_count",
  "impact_repo_count",
  "impact_commit_count",
  "maintainer_closed_unmerged_pr_count",
  "self_closed_external_pr_count",
  "self_closed_own_repo_pr_count",
  "unknown_closed_unmerged_pr_count",
] as const satisfies readonly (keyof RawMetrics)[];

const REQUIRED_NULLABLE_STRING_METRICS = [
  "profile_url",
  "avatar_url",
  "name",
  "bio",
  "company",
  "created_at",
  "top_repo_pr_target",
] as const satisfies readonly (keyof RawMetrics)[];

const OPTIONAL_NULLABLE_STRING_METRICS = [
  "best_original_repo_quality_repo",
  "top_starred_original_repo_quality_repo",
] as const satisfies readonly (keyof RawMetrics)[];

const OPTIONAL_BOOLEAN_METRICS = [
  "commit_contribution_aggregation_unavailable",
  "merged_pr_contribution_aggregation_incomplete",
] as const satisfies readonly (keyof RawMetrics)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function optionalMatches(
  record: Record<string, unknown>,
  key: string,
  predicate: (value: unknown) => boolean,
): boolean {
  return record[key] === undefined || predicate(record[key]);
}

function hasValidMetrics(value: unknown): value is RawMetrics {
  if (!isRecord(value) || typeof value.username !== "string") return false;
  if (!REQUIRED_NUMBER_METRICS.every((key) => isFiniteNumber(value[key]))) return false;
  if (!REQUIRED_NULLABLE_STRING_METRICS.every((key) => isNullableString(value[key]))) return false;
  if (!isFiniteNumber(value.days_since_last_activity) && value.days_since_last_activity !== null) {
    return false;
  }
  if (typeof value.star_inflation_suspect !== "boolean" || typeof value.pr_flood_suspect !== "boolean") {
    return false;
  }
  if (!OPTIONAL_NUMBER_METRICS.every((key) => optionalMatches(value, key, isFiniteNumber))) {
    return false;
  }
  if (!OPTIONAL_NULLABLE_STRING_METRICS.every((key) => optionalMatches(value, key, isNullableString))) {
    return false;
  }
  if (!OPTIONAL_BOOLEAN_METRICS.every((key) => optionalMatches(value, key, (item) => typeof item === "boolean"))) {
    return false;
  }
  return optionalMatches(value, "attributed_original_repos", isStringArray);
}

function hasValidTopRepo(value: unknown): value is TopRepo {
  if (!isRecord(value)) return false;
  if (
    typeof value.name !== "string" ||
    !isFiniteNumber(value.stars) ||
    !isFiniteNumber(value.forks) ||
    !isFiniteNumber(value.open_issues) ||
    !isFiniteNumber(value.size) ||
    !isNullableString(value.language) ||
    !isNullableString(value.description) ||
    !isNullableString(value.pushed_at)
  ) {
    return false;
  }
  if (!optionalMatches(value, "owner_login", (item) => typeof item === "string")) return false;
  if (!optionalMatches(value, "name_with_owner", (item) => typeof item === "string")) return false;
  if (!optionalMatches(value, "readme_excerpt", isNullableString)) return false;
  if (!optionalMatches(value, "topics", isStringArray)) return false;
  if (!optionalMatches(value, "attributed_original", (item) => typeof item === "boolean")) return false;
  if (!optionalMatches(value, "attribution_evidence", isStringArray)) return false;
  if (
    !optionalMatches(
      value,
      "languages",
      (item) =>
        Array.isArray(item) &&
        item.every(
          (language) =>
            isRecord(language) &&
            typeof language.name === "string" &&
            isFiniteNumber(language.size),
        ),
    )
  ) {
    return false;
  }
  return optionalMatches(value, "readme", (item) => {
    if (!isRecord(item) || !isRecord(item.features)) return false;
    const features = item.features;
    const booleanFeatureKeys = [
      "has_install",
      "has_usage",
      "has_api",
      "has_demo",
      "has_features",
      "has_deploy",
      "has_test",
      "has_architecture",
      "has_screenshot",
    ];
    return (
      typeof item.path === "string" &&
      isNullableString(item.sha) &&
      isFiniteNumber(item.size) &&
      isNullableString(item.html_url) &&
      typeof item.truncated === "boolean" &&
      isFiniteNumber(features.length) &&
      isFiniteNumber(features.heading_count) &&
      booleanFeatureKeys.every((key) => typeof features[key] === "boolean") &&
      isFiniteNumber(features.placeholder_score) &&
      isFiniteNumber(features.content_depth_score) &&
      typeof features.prompt_summary === "string"
    );
  });
}

function hasValidRecentPr(value: unknown): value is RecentPr {
  return (
    isRecord(value) &&
    isNullableString(value.title) &&
    isNullableString(value.repo) &&
    isFiniteNumber(value.repo_stars) &&
    isFiniteNumber(value.churn) &&
    isFiniteNumber(value.changed_files) &&
    typeof value.trivial === "boolean" &&
    optionalMatches(value, "files", isStringArray)
  );
}

function hasValidImpactRepo(value: unknown): value is ImpactRepo {
  return (
    isRecord(value) &&
    typeof value.repo === "string" &&
    isFiniteNumber(value.stars) &&
    isFiniteNumber(value.commits) &&
    isFiniteNumber(value.prs)
  );
}

function hasValidSignatureWork(value: unknown): value is SignatureWork {
  if (!isRecord(value)) return false;
  if (value.source !== "all_history_public_scan" && value.source !== "recent_sample") return false;
  if (
    !Array.isArray(value.impact_repo_representatives) ||
    !value.impact_repo_representatives.every(hasValidImpactRepo) ||
    !Array.isArray(value.work_clusters)
  ) {
    return false;
  }
  return value.work_clusters.every(
    (cluster) =>
      isRecord(cluster) &&
      typeof cluster.repo === "string" &&
      isFiniteNumber(cluster.stars) &&
      isFiniteNumber(cluster.quality_keyword_hits) &&
      isStringArray(cluster.examples) &&
      optionalMatches(cluster, "all_time_prs", isFiniteNumber) &&
      optionalMatches(cluster, "recent_merged_prs_in_sample", isFiniteNumber) &&
      optionalMatches(cluster, "org_context_repo", (item) => typeof item === "string") &&
      optionalMatches(cluster, "org_context_stars", isFiniteNumber) &&
      optionalMatches(cluster, "substantive_low_star_signal", (item) => typeof item === "boolean"),
  );
}

function hasValidEmbeddedScoring(value: unknown): value is Scoring {
  if (!isRecord(value) || !isRecord(value.sub_scores) || !Array.isArray(value.red_flags)) {
    return false;
  }
  const subScores = value.sub_scores;
  const subScoreKeys = [
    "account_maturity",
    "original_project_quality",
    "contribution_quality",
    "ecosystem_impact",
    "community_influence",
    "activity_authenticity",
  ];
  const tiers = ["夯", "顶级", "人上人", "NPC", "拉完了"];
  return (
    subScoreKeys.every((key) => isFiniteNumber(subScores[key])) &&
    isFiniteNumber(value.base_score) &&
    value.red_flags.every(
      (flag) =>
        isRecord(flag) &&
        typeof flag.flag === "string" &&
        isFiniteNumber(flag.penalty) &&
        typeof flag.detail === "string",
    ) &&
    isFiniteNumber(value.total_penalty) &&
    isFiniteNumber(value.final_score) &&
    typeof value.tier === "string" &&
    tiers.includes(value.tier) &&
    typeof value.tier_label === "string"
  );
}

function hasValidScanResult(value: unknown): value is ScanResult {
  if (!isRecord(value) || !hasValidMetrics(value.metrics)) return false;
  if (!Array.isArray(value.top_repos) || !value.top_repos.every(hasValidTopRepo)) return false;
  if (!Array.isArray(value.recent_prs) || !value.recent_prs.every(hasValidRecentPr)) return false;
  if (!isStringArray(value.flood_pr_titles) || !hasValidEmbeddedScoring(value.scoring)) return false;
  if (!optionalMatches(value, "impact_repos", (item) => Array.isArray(item) && item.every(hasValidImpactRepo))) {
    return false;
  }
  if (!optionalMatches(value, "verified_impact_prs", (item) => Array.isArray(item) && item.every(hasValidRecentPr))) {
    return false;
  }
  if (!optionalMatches(value, "signature_work", hasValidSignatureWork)) return false;
  if (!optionalMatches(value, "pinned_repos", isStringArray)) return false;
  return optionalMatches(value, "organizations", isStringArray);
}

/**
 * Validate one immutable scan snapshot and derive its current deterministic score.
 * No caller-provided score, report, tag, or roast text is retained.
 */
export function materializeCanonicalScore(
  input: CanonicalScoreMaterializationInput,
): CanonicalScoreMaterialization | null {
  if (
    (input.mode !== "quick" && input.mode !== "durable") ||
    typeof input.snapshot !== "string" ||
    typeof input.snapshotHash !== "string" ||
    typeof input.username !== "string" ||
    input.scoreVersion !== SCORE_CACHE_VERSION ||
    input.collectionVersion !== PUBLIC_SCAN_COLLECTION_VERSION ||
    !Number.isSafeInteger(input.scannedAt) ||
    input.scannedAt <= 0 ||
    !/^[a-f0-9]{64}$/.test(input.snapshotHash) ||
    createHash("sha256").update(input.snapshot).digest("hex") !== input.snapshotHash
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.snapshot);
  } catch {
    return null;
  }
  if (!hasValidScanResult(parsed)) return null;

  const requestedUsername = normalizeUsername(input.username)?.toLowerCase();
  const snapshotUsername = normalizeUsername(parsed.metrics.username)?.toLowerCase();
  if (!requestedUsername || requestedUsername !== snapshotUsername) return null;
  const scoring = score(parsed.metrics);
  const scan: ScanResult = { ...parsed, scoring };
  return {
    scoreEntry: {
      username: requestedUsername,
      display_name: parsed.metrics.name,
      avatar_url: parsed.metrics.avatar_url,
      profile_url: parsed.metrics.profile_url,
      final_score: scoring.final_score,
      tier: scoring.tier,
      tags: { zh: [], en: [] },
      roast_line: { zh: "", en: "" },
      bot_score: spamBotScore(parsed.metrics),
      sub_scores: scoring.sub_scores,
      scanned_at: input.scannedAt,
    },
    provenance: {
      scoreVersion: SCORE_CACHE_VERSION,
      collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      snapshotHash: input.snapshotHash,
      mode: input.mode,
    },
    scan,
  };
}
