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
import { getFacetRankCached } from "@/lib/developers";
import { isProfileReadmeRepo } from "@/lib/github";
import { githubStandings, type GithubStandingRepo } from "@/lib/github-standing";
import { getPercentileCached, getRankCached } from "@/lib/rank";
import { getProfileCommonProjectsCached } from "@/lib/project-discovery";
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
import type { RiskAssessment, RiskSignal, ScanResult, SubScoreKey, SubScores } from "@/lib/types";
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

function isValidRiskAssessment(value: unknown): value is RiskAssessment {
  if (!value || typeof value !== "object") return false;
  const assessment = value as Record<string, unknown>;
  const coverage = assessment.coverage;
  return (
    (assessment.version === "v9" || assessment.version === "v10") &&
    (assessment.level === "none" || assessment.level === "review" || assessment.level === "high") &&
    isFiniteNumber(assessment.risk_score) &&
    isFiniteNumber(assessment.confidence) &&
    isFiniteNumber(assessment.applied_penalty) &&
    assessment.risk_score >= 0 &&
    assessment.risk_score <= 100 &&
    assessment.confidence >= 0 &&
    assessment.confidence <= 100 &&
    assessment.applied_penalty >= 0 &&
    assessment.applied_penalty <= (assessment.version === "v9" ? 40 : 25) &&
    isClose(assessment.risk_score, assessment.applied_penalty / (assessment.version === "v9" ? 40 : 25) * 100) &&
    Array.isArray(assessment.signals) &&
    coverage !== null &&
    typeof coverage === "object" &&
    isFiniteNumber((coverage as Record<string, unknown>).repo) &&
    isFiniteNumber((coverage as Record<string, unknown>).merged_pr) &&
    isFiniteNumber((coverage as Record<string, unknown>).all_pr)
  );
}

function isValidRiskSignal(value: unknown): value is RiskSignal {
  if (!value || typeof value !== "object") return false;
  const signal = value as Record<string, unknown>;
  return (
    typeof signal.flag === "string" &&
    (signal.family === "footprint" || signal.family === "contribution" || signal.family === "social") &&
    (signal.disposition === "note" || signal.disposition === "penalty") &&
    isFiniteNumber(signal.severity) &&
    isFiniteNumber(signal.confidence) &&
    isFiniteNumber(signal.penalty) &&
    typeof signal.detail === "string" &&
    signal.evidence !== null &&
    typeof signal.evidence === "object"
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
    scoring.total_penalty > (scoring.risk_assessment?.version === "v10" ? 25 : 40) ||
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
    scoring.risk_assessment?.version === "v10" ? 25 : 40,
  );
  if (!isClose(flagPenaltyTotal, scoring.total_penalty)) return null;

  const expectedFinal = Math.max(
    0,
    Math.min(100, roundHalfEven(scoring.base_score - scoring.total_penalty, 2)),
  );
  if (!isClose(expectedFinal, scoring.final_score) || !isClose(scoring.final_score, finalScore)) {
    return null;
  }

  const riskAssessment = scoring.risk_assessment;
  const riskNotes = scoring.risk_notes ?? [];
  if (
    riskAssessment &&
    (!isValidRiskAssessment(riskAssessment) ||
      !riskAssessment.signals.every(isValidRiskSignal) ||
      !riskNotes.every(isValidRiskSignal) ||
      riskAssessment.applied_penalty < 0 ||
      riskAssessment.applied_penalty > (riskAssessment.version === "v9" ? 40 : 25) ||
      !isClose(riskAssessment.applied_penalty, scoring.total_penalty))
  ) {
    return null;
  }

  const appliedPenalty = Math.max(0, roundHalfEven(scoring.base_score - finalScore, 2));
  return {
    base_score: scoring.base_score,
    total_penalty: scoring.total_penalty,
    applied_penalty: appliedPenalty,
    red_flags: scoring.red_flags,
    risk_assessment: riskAssessment ?? null,
    risk_notes: riskNotes,
    complete: true,
  };
}

function scoreBreakdownFromStoredDetail(detail: DbAccountDetail): ScoreBreakdown {
  const base = roundHalfEven(
    SCORE_SUB_KEYS.reduce((sum, key) => sum + detail.sub_scores[key], 0),
    1,
  );
  const applied = Math.max(0, roundHalfEven(base - detail.final_score, 2));
  return {
    base_score: base,
    total_penalty: detail.risk_assessment?.applied_penalty ?? applied,
    applied_penalty: applied,
    red_flags: detail.risk_assessment
      ? detail.risk_assessment.signals
          .filter((signal) => signal.penalty > 0)
          .map(({ flag, penalty, detail: explanation }) => ({ flag, penalty, detail: explanation }))
      : [],
    risk_assessment: detail.risk_assessment ?? null,
    risk_notes: detail.risk_notes ?? [],
    complete: Boolean(detail.risk_assessment),
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
 * query's ORDER BY AVG DESC, repo_key ASC) before merging. All candidates are
 * read together — one cache entry and one database round trip per profile.
 */
async function buildCommonProjects(
  username: string,
  candidates: string[],
): Promise<CommonProfileProject[]> {
  const seen = new Set<string>();
  const result: CommonProfileProject[] = [];
  const lists = await getProfileCommonProjectsCached(username, candidates, COMMON_PROJECT_LIMIT);
  for (const items of lists) {
    if (result.length >= COMMON_PROJECT_LIMIT) break;
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

/**
 * The repository the whole-GitHub standing ranks: the most-starred entry of
 * `top_repos` by raw stars. The `<login>/<login>` profile README is a profile
 * page, not a project; the scanner leaves it out of star totals too.
 * Co-built repositories keep their credited share for the label: the rank
 * itself describes the repository, like its star count does.
 */
function standingRepo(username: string, snapshot: ProfileSnapshotView): GithubStandingRepo | undefined {
  const loginLower = username.toLowerCase();
  let best: ProfileSnapshotView["top_repos"][number] | undefined;
  for (const repo of snapshot.top_repos) {
    if (isProfileReadmeRepo(repo, loginLower)) continue;
    if (!best || (repo.stars ?? 0) > (best.stars ?? 0)) best = repo;
  }
  if (!best) return undefined;
  return {
    name_with_owner: best.name_with_owner ?? `${best.owner_login ?? username}/${best.name}`,
    stars: Math.max(0, best.stars ?? 0),
    ...(best.attribution_share !== undefined ? { attribution_share: best.attribution_share } : {}),
  };
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
    getCurrentCanonicalQuickScan(detail.username).then((current) => {
      // If a current scan exists but fails verification, do not silently turn
      // it into an apparently valid breakdown from the score row. A stored-row
      // fallback is only appropriate when no current scan is available.
      if (current) {
        return scoreBreakdownFromScan(current.scan, detail.final_score, detail.sub_scores);
      }
      return scoreBreakdownFromStoredDetail(detail);
    }),
    getProfileSnapshot(detail.username),
    buildScorePercentile(detail.final_score),
    getSimilarAccounts(detail.username, detail.final_score, detail.sub_scores, SIMILAR_LIMIT),
    getUserMatchups(detail.username, BATTLES_LIMIT),
    // The facet board only ranks current-version scores; a legacy fallback row
    // has no position there (mirrors the Go facet-rank score gate).
    detail.legacy_read_fallback
      ? Promise.resolve(null)
      : getFacetRankCached(detail.username, detail.final_score),
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
    ...(snapshot
      ? {
          github_standing: githubStandings(snapshot.metrics, standingRepo(detail.username, snapshot)),
        }
      : {}),
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

/** What the embeddable cards render (`/api/card/*`, mini, material). */
export type ProfileCardPresentation = Pick<
  ProfilePresentation,
  "detail" | "snapshot" | "rank" | "percentile" | "delta"
>;

/**
 * The card subset of {@link buildProfilePresentation}, without the discovery
 * reads cards never show (similar accounts, common projects, battles, facet
 * rank, repo-link check, scan breakdown). Card URLs are a crawler / camo long
 * tail whose cache-busting params miss the CDN, so every miss used to pay a
 * whole profile build — including the per-profile common-projects cache write.
 */
export async function buildProfileCardPresentation(
  username: string,
): Promise<ProfileCardPresentation | null> {
  const handle = normalizeUsername(username);
  if (!handle) return null;
  const detail = await getAccountDetail(handle);
  if (!detail) return null;
  const [snapshot, { rank, percentile }, delta] = await Promise.all([
    getProfileSnapshot(detail.username),
    buildScorePercentile(detail.final_score),
    weeklyScoreDelta(detail),
  ]);
  return { detail: toPresentationDetail(detail), snapshot, rank, percentile, delta };
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
