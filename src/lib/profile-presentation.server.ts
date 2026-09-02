import "server-only";

/**
 * Local assembly of the public profile / versus presentation models, ported
 * from the Go backend's profile_api.go so SSR pages no longer fetch Railway.
 * The JSON shapes are a public contract (pages and card renderers consume
 * them); every field, fallback and limit mirrors the Go handlers.
 */
import {
  getAccountDetail,
  getCurrentCanonicalQuickScan,
  getDeveloperCommonProjects,
  getFacetRank,
  getMatchup,
  getProfileSnapshot,
  getSimilarAccounts,
  getTrendingMatchups,
  getUserMatchups,
  getWeeklyBaselines,
  filterExistingRepoKeys,
  resolveWeeklyDelta,
  type AccountDetail as DbAccountDetail,
  type ProjectListItem,
} from "@/lib/db";
import { getPercentileCached, getRankCached } from "@/lib/rank";
import { beatPercent } from "@/lib/percentile";
import { getCachedScan } from "@/lib/redis";
import { normalizeUsername } from "@/lib/username";
import type {
  AccountDetail,
  CommonProfileProject,
  ProfilePercentile,
  ProfilePresentation,
  ProfileSnapshotView,
  ScoreBreakdown,
  VsMatchup,
  VsPresentation,
} from "@/lib/profile-presentation";
import type { ScanResult, SubScoreKey, SubScores } from "@/lib/types";
import { roundHalfEven } from "@/lib/score";

const SIMILAR_LIMIT = 6;
const COMMON_PROJECT_CANDIDATES = 3;
const COMMON_PROJECT_LIMIT = 6;
const BATTLES_LIMIT = 8;
const TRENDING_MATCHUP_LIMIT = 40;

/** The persisted row's `score_version` is optional in the db model but part of
 *  the public presentation contract, so pin it to an explicit null. */
function toPresentationDetail(
  detail: DbAccountDetail,
  scoreBreakdown?: ScoreBreakdown | null,
): AccountDetail {
  return {
    ...detail,
    score_version: detail.score_version ?? null,
    ...(scoreBreakdown ? { score_breakdown: scoreBreakdown } : {}),
  };
}

const SCORE_TOLERANCE = 0.005;
const SCORE_SUB_KEYS: SubScoreKey[] = [
  "account_maturity",
  "original_project_quality",
  "contribution_quality",
  "ecosystem_impact",
  "community_influence",
  "activity_authenticity",
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isClose(left: number, right: number): boolean {
  return Math.abs(left - right) <= SCORE_TOLERANCE;
}

function isValidRedFlag(value: unknown): value is ScanResult["scoring"]["red_flags"][number] {
  if (!value || typeof value !== "object") return false;
  const flag = value as Record<string, unknown>;
  return (
    typeof flag.flag === "string" &&
    isFiniteNumber(flag.penalty) &&
    flag.penalty >= 0 &&
    typeof flag.detail === "string"
  );
}

function scoreBreakdownFromScan(
  scan: ScanResult | null,
  finalScore: number,
  detailSubScores: SubScores,
): ScoreBreakdown | null {
  const scoring = scan?.scoring;
  if (
    !scoring ||
    !isFiniteNumber(scoring.base_score) ||
    !isFiniteNumber(scoring.total_penalty) ||
    !isFiniteNumber(scoring.final_score) ||
    !Array.isArray(scoring.red_flags) ||
    !scoring.red_flags.every(isValidRedFlag) ||
    scoring.base_score < 0 ||
    scoring.base_score > 100 ||
    scoring.total_penalty < 0 ||
    scoring.total_penalty > 40 ||
    scoring.final_score < 0 ||
    scoring.final_score > 100
  ) {
    return null;
  }

  const subScores = scoring.sub_scores as Partial<Record<SubScoreKey, unknown>> | undefined;
  if (!subScores || !SCORE_SUB_KEYS.every((key) => isFiniteNumber(subScores[key]))) {
    return null;
  }
  if (!SCORE_SUB_KEYS.every((key) => isClose(subScores[key] as number, detailSubScores[key]))) {
    return null;
  }

  const baseFromDimensions = roundHalfEven(
    SCORE_SUB_KEYS.reduce((sum, key) => sum + (subScores[key] as number), 0),
    1,
  );
  if (!isClose(baseFromDimensions, scoring.base_score)) return null;

  const flagPenaltyTotal = Math.min(
    scoring.red_flags.reduce((sum, flag) => sum + flag.penalty, 0),
    40,
  );
  if (!isClose(flagPenaltyTotal, scoring.total_penalty)) return null;

  const expectedFinal = Math.max(
    0,
    Math.min(100, roundHalfEven(scoring.base_score - scoring.total_penalty, 2)),
  );
  if (!isClose(expectedFinal, scoring.final_score) || !isClose(scoring.final_score, finalScore)) {
    return null;
  }

  const appliedPenalty = Math.max(0, roundHalfEven(scoring.base_score - finalScore, 2));
  return {
    base_score: scoring.base_score,
    total_penalty: scoring.total_penalty,
    applied_penalty: appliedPenalty,
    red_flags: scoring.red_flags,
    complete: true,
  };
}

function toCommonProject(item: ProjectListItem): CommonProfileProject {
  return {
    repo: {
      repo_key: item.repo.repo_key,
      name_with_owner: item.repo.name_with_owner,
      language: item.repo.language,
    },
    avgScore: item.avgScore,
  };
}

/**
 * Common projects with the first few similar developers, deduped across
 * candidates. Each candidate batch is ordered by average member score (the Go
 * query's ORDER BY AVG DESC, repo_key ASC) before merging.
 */
async function buildCommonProjects(
  username: string,
  candidates: string[],
): Promise<CommonProfileProject[]> {
  const seen = new Set<string>();
  const result: CommonProfileProject[] = [];
  for (const candidate of candidates) {
    if (result.length >= COMMON_PROJECT_LIMIT) break;
    const items = await getDeveloperCommonProjects(username, candidate, COMMON_PROJECT_LIMIT);
    const batch = items
      .map(toCommonProject)
      .toSorted(
        (left, right) =>
          right.avgScore - left.avgScore ||
          (left.repo.repo_key < right.repo.repo_key ? -1 : left.repo.repo_key > right.repo.repo_key ? 1 : 0),
      );
    for (const item of batch) {
      if (!seen.has(item.repo.repo_key)) {
        seen.add(item.repo.repo_key);
        result.push(item);
      }
      if (result.length >= COMMON_PROJECT_LIMIT) break;
    }
  }
  return result;
}

/** Repo keys a snapshot references (featured + impact repos), for the
 *  internal-project-page link check. */
function snapshotRepoKeys(snapshot: ProfileSnapshotView | null): string[] {
  if (!snapshot) return [];
  const keys: string[] = [];
  for (const repo of snapshot.top_repos) {
    if (typeof repo.name_with_owner === "string") {
      keys.push(repo.name_with_owner);
    } else if (typeof repo.owner_login === "string" && repo.name) {
      keys.push(`${repo.owner_login}/${repo.name}`);
    }
  }
  for (const repo of snapshot.impact_repos) keys.push(repo.repo);
  return keys;
}

async function buildExistingRepoKeys(snapshot: ProfileSnapshotView | null): Promise<string[]> {
  const existing = await filterExistingRepoKeys(snapshotRepoKeys(snapshot));
  return existing ? [...existing].toSorted() : [];
}

/** Same shape as the Go ScorePercentile: `beat`/`rank` stay null when there is
 *  no one to compare against, while `total` still reports the board size. */
async function buildScorePercentile(finalScore: number): Promise<{
  rank: { rank: number; total: number; below: number } | null;
  percentile: ProfilePercentile | null;
}> {
  const [rank, pct] = await Promise.all([
    getRankCached(finalScore),
    getPercentileCached(finalScore),
  ]);
  return {
    rank,
    percentile: pct
      ? { beat: beatPercent(pct.below, pct.total), total: pct.total, rank: rank?.rank ?? null }
      : null,
  };
}

/** Weekly badge delta: snapshot-from-≥7d-ago baseline, else the prev-scan
 *  fallback. Legacy read-fallback rows have no canonical row to diff against. */
async function weeklyScoreDelta(detail: DbAccountDetail): Promise<number | null> {
  if (detail.legacy_read_fallback) return null;
  const baselines = await getWeeklyBaselines([detail.username]);
  return resolveWeeklyDelta({
    currentScore: detail.final_score,
    snapshotBaseline: baselines.get(detail.username.toLowerCase()) ?? null,
    prevScore: detail.prev_score,
    prevScannedAt: detail.prev_scanned_at,
  });
}

export async function buildProfilePresentation(
  username: string,
): Promise<ProfilePresentation | null> {
  const handle = normalizeUsername(username);
  if (!handle) return null;
  const detail = await getAccountDetail(handle);
  if (!detail) return null;
  const [scoreBreakdown, snapshot, { rank, percentile }, similar, battles, facetRank, delta] = await Promise.all([
    getCurrentCanonicalQuickScan(detail.username).then((current) =>
      scoreBreakdownFromScan(current?.scan ?? null, detail.final_score, detail.sub_scores),
    ),
    getProfileSnapshot(detail.username),
    buildScorePercentile(detail.final_score),
    getSimilarAccounts(detail.username, detail.final_score, detail.sub_scores, SIMILAR_LIMIT),
    getUserMatchups(detail.username, BATTLES_LIMIT),
    // The facet board only ranks current-version scores; a legacy fallback row
    // has no position there (mirrors the Go facet-rank score gate).
    detail.legacy_read_fallback
      ? Promise.resolve(null)
      : getFacetRank(detail.username, detail.final_score),
    weeklyScoreDelta(detail),
  ]);
  const [common_projects, existing_repo_keys] = await Promise.all([
    buildCommonProjects(
      detail.username,
      similar.slice(0, COMMON_PROJECT_CANDIDATES).map((entry) => entry.username),
    ),
    buildExistingRepoKeys(snapshot),
  ]);
  return {
    detail: toPresentationDetail(detail, scoreBreakdown),
    snapshot,
    rank,
    percentile,
    delta,
    similar,
    common_projects,
    battles,
    facetRank,
    existing_repo_keys,
  };
}

export async function buildVsPresentation(a: string, b: string): Promise<VsPresentation | null> {
  const handleA = normalizeUsername(a);
  const handleB = normalizeUsername(b);
  if (!handleA || !handleB) return null;
  const [left, right, matchup] = await Promise.all([
    getAccountDetail(handleA),
    getAccountDetail(handleB),
    getMatchup(handleA, handleB),
  ]);
  return {
    a: left ? toPresentationDetail(left) : null,
    b: right ? toPresentationDetail(right) : null,
    matchup,
  };
}

export function getTrendingVsMatchupsLocal(): Promise<VsMatchup[]> {
  return getTrendingMatchups(TRENDING_MATCHUP_LIMIT);
}

/** Cached-only quick scan (the transient profile shell); never starts a scan. */
export async function getLiveProfileScan(username: string): Promise<ScanResult | null> {
  const handle = normalizeUsername(username);
  if (!handle) return null;
  return getCachedScan(handle);
}
