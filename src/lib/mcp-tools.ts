/** Shared deterministic MCP tool implementations. */
import { getAccountDetail, getCurrentCanonicalQuickScan, searchScoredUsers } from "@/lib/db";
import { requestDevscoreJob } from "@/lib/devscore-jobs";
import { getPercentileCached, getRankCached } from "@/lib/rank";
import { getLeaderboardCached } from "@/lib/leaderboard";
import type { LeaderboardCacheView } from "@/lib/redis";
import type { LeaderboardWindow } from "@/lib/db";
import { getCachedScan } from "@/lib/redis";
import { scanStatusUrl } from "@/lib/scan-job-client";
import { SCORE_CACHE_VERSION } from "@/lib/cache-version";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "@/lib/scan-run-types";
import { normalizeUsername } from "@/lib/username";
import { beatPercent } from "@/lib/percentile";
import { TIER_KEY } from "@/lib/tier";
import { SITE_URL } from "@/lib/site";
import { roundHalfEven } from "@/lib/math";
import type { ScanResult, Tier } from "@/lib/types";

export type ToolError = { error: string; message: string };

async function percentileFor(finalScore: number) {
  const [rank, pct] = await Promise.all([
    getRankCached(finalScore),
    getPercentileCached(finalScore),
  ]);
  return pct
    ? { beat: beatPercent(pct.below, pct.total), total: pct.total, rank: rank?.rank ?? null }
    : null;
}

/**
 * The published devscore scan, or the pending job status for a first-time
 * account (the job is enqueued here; scoring takes minutes for large accounts).
 */
async function publishedScanOrPending(
  handle: string,
): Promise<{ scan: ScanResult } | { pending: Record<string, unknown> } | ToolError> {
  const scan = (await getCachedScan(handle)) ?? (await getCurrentCanonicalQuickScan(handle))?.scan;
  if (scan) return { scan };
  const status = await requestDevscoreJob(handle).catch(() => null);
  if (!status) return { error: "scan_failed", message: `could not score ${handle}` };
  if (status.state === "failed") {
    return { error: status.error ?? "scan_failed", message: `could not score ${handle}` };
  }
  return {
    pending: {
      status: "pending",
      username: handle,
      job: status,
      status_url: `${SITE_URL}${scanStatusUrl(handle)}`,
      retry_after_seconds: 30,
      note:
        "First-time scoring runs in the background and can take several minutes for large accounts. " +
        "Call this tool again later (or poll status_url) to get the score.",
    },
  };
}

function isCanonicalDetail(detail: NonNullable<Awaited<ReturnType<typeof getAccountDetail>>>): boolean {
  return (
    detail.score_version === SCORE_CACHE_VERSION &&
    detail.score_source_collection_version === PUBLIC_SCAN_COLLECTION_VERSION &&
    typeof detail.score_source_snapshot_hash === "string" &&
    /^[a-f0-9]{64}$/.test(detail.score_source_snapshot_hash)
  );
}

function persistedBaseScore(detail: NonNullable<Awaited<ReturnType<typeof getAccountDetail>>>): number {
  return roundHalfEven(Object.values(detail.sub_scores).reduce((sum, value) => sum + value, 0), 1);
}

function persistedRiskFlags(detail: NonNullable<Awaited<ReturnType<typeof getAccountDetail>>>) {
  return (detail.risk_assessment?.signals ?? [])
    .filter((signal) => signal.penalty > 0)
    .map(({ flag, penalty, detail: explanation }) => ({ flag, penalty, detail: explanation }));
}

/** Score for one account; a first-time account returns its pending background job instead. */
export async function scoreUser(
  rawUsername: string,
): Promise<Record<string, unknown> | ToolError> {
  const handle = normalizeUsername(rawUsername ?? "");
  if (!handle) {
    return { error: "invalid_username", message: "username must be a valid GitHub login" };
  }

  const detail = await getAccountDetail(handle);
  if (detail && isCanonicalDetail(detail)) {
    return {
      source: "indexed",
      coverage: "quick",
      stale: detail.score_version !== SCORE_CACHE_VERSION,
      username: detail.username,
      display_name: detail.display_name,
      final_score: detail.final_score,
      tier: detail.tier,
      tier_key: TIER_KEY[detail.tier],
      sub_scores: detail.sub_scores,
      base_score: persistedBaseScore(detail),
      total_penalty: detail.risk_assessment?.applied_penalty ?? 0,
      red_flags: persistedRiskFlags(detail),
      risk_assessment: detail.risk_assessment ?? null,
      risk_notes: detail.risk_notes ?? [],
      percentile: await percentileFor(detail.final_score),
      scanned_at: detail.scanned_at,
      profile: `${SITE_URL}/u/${detail.username}`,
    };
  }

  const outcome = await publishedScanOrPending(handle);
  if ("pending" in outcome) return outcome.pending;
  if ("scan" in outcome) {
    const scoring = outcome.scan.scoring;
    const metrics = outcome.scan.metrics;
    const tier = scoring.tier as Tier;
    return {
      source: "quick",
      coverage: "quick",
      username: metrics.username,
      display_name: metrics.name,
      final_score: scoring.final_score,
      tier,
      tier_key: TIER_KEY[tier],
      sub_scores: scoring.sub_scores,
      base_score: scoring.base_score,
      total_penalty: scoring.total_penalty,
      red_flags: scoring.red_flags,
      risk_assessment: scoring.risk_assessment,
      risk_notes: scoring.risk_notes,
      percentile: await percentileFor(scoring.final_score),
      profile: `${SITE_URL}/u/${metrics.username}`,
    };
  }
  if (detail?.legacy_read_fallback) {
    return {
      source: "legacy_v5_v5_v3",
      coverage: "legacy",
      stale: true,
      username: detail.username,
      display_name: detail.display_name,
      final_score: detail.final_score,
      tier: detail.tier,
      tier_key: TIER_KEY[detail.tier],
      sub_scores: detail.sub_scores,
      percentile: await percentileFor(detail.final_score),
      scanned_at: detail.scanned_at,
      profile: `${SITE_URL}/u/${detail.username}`,
    };
  }
  return outcome;
}

/** Full published scan payload for one account, or its pending job status. */
export async function scanUser(
  rawUsername: string,
): Promise<ScanResult | Record<string, unknown> | ToolError> {
  const handle = normalizeUsername(rawUsername ?? "");
  if (!handle) {
    return { error: "invalid_username", message: "username must be a valid GitHub login" };
  }
  const outcome = await publishedScanOrPending(handle);
  if ("scan" in outcome) return outcome.scan;
  if ("pending" in outcome) return outcome.pending;
  return outcome;
}

/** Head-to-head: two deterministic scores side by side (no LLM verdict). */
export async function compareUsers(
  rawA: string,
  rawB: string,
): Promise<Record<string, unknown> | ToolError> {
  const [a, b] = await Promise.all([scoreUser(rawA), scoreUser(rawB)]);
  if ("error" in a) return a;
  if ("error" in b) return b;
  if (a.status === "pending" || b.status === "pending") {
    return {
      status: "pending",
      a,
      b,
      note: "At least one account is still being scored in the background; call compare_users again later.",
    };
  }
  const sa = a.final_score as number;
  const sb = b.final_score as number;
  const gap = Math.abs(sa - sb);
  return {
    a,
    b,
    winner: gap === 0 ? null : sa > sb ? a.username : b.username,
    gap: Number(gap.toFixed(2)),
    note: "Deterministic comparison. For a savage bilingual verdict, POST /api/vs-verdict.",
  };
}

export async function getLeaderboard(
  view: LeaderboardCacheView = "trending",
  window: LeaderboardWindow = "all",
  limit = 50,
): Promise<Record<string, unknown>> {
  const { entries, cached } = await getLeaderboardCached(view, window);
  const page = entries.slice(0, Math.max(1, Math.min(limit, 100)));
  return { view, window, cached, count: page.length, total: entries.length, entries: page };
}

export async function searchUsers(q: string): Promise<Record<string, unknown>> {
  const query = (q ?? "").trim();
  if (query.length < 1) return { query, users: [] };
  const users = await searchScoredUsers(query, 6);
  return { query, users };
}
