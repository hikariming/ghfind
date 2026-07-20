/** Shared deterministic MCP tool implementations. */
import { getAccountDetail, searchScoredUsers } from "@/lib/db";
import { getPercentileCached, getRankCached } from "@/lib/rank";
import { getLeaderboardCached } from "@/lib/leaderboard";
import type { LeaderboardCacheView } from "@/lib/redis";
import type { LeaderboardWindow } from "@/lib/db";
import { coalesceScan, getCachedScan } from "@/lib/redis";
import { buildScanResult, scanErrorResponse } from "@/lib/scan-core";
import { SCORE_CACHE_VERSION } from "@/lib/cache-version";
import { normalizeUsername } from "@/lib/username";
import { beatPercent } from "@/lib/percentile";
import { TIER_KEY } from "@/lib/tier";
import { SITE_URL } from "@/lib/site";
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

async function quickScan(handle: string): Promise<ScanResult> {
  const cached = await getCachedScan(handle);
  return cached ?? coalesceScan(handle, () => buildScanResult(handle));
}

/** Deterministic score for one account, with no asynchronous collection state. */
export async function scoreUser(
  rawUsername: string,
): Promise<Record<string, unknown> | ToolError> {
  const handle = normalizeUsername(rawUsername ?? "");
  if (!handle) {
    return { error: "invalid_username", message: "username must be a valid GitHub login" };
  }

  const detail = await getAccountDetail(handle);
  if (detail) {
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
      percentile: await percentileFor(detail.final_score),
      scanned_at: detail.scanned_at,
      profile: `${SITE_URL}/u/${detail.username}`,
    };
  }

  try {
    const result = await quickScan(handle);
    const scoring = result.scoring;
    const metrics = result.metrics;
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
      red_flags: scoring.red_flags,
      percentile: await percentileFor(scoring.final_score),
      profile: `${SITE_URL}/u/${metrics.username}`,
    };
  } catch (error) {
    const { error: code } = scanErrorResponse(error);
    return { error: code, message: `could not score ${handle}` };
  }
}

/** Full bounded quick-scan payload for one account. */
export async function scanUser(
  rawUsername: string,
): Promise<ScanResult | ToolError> {
  const handle = normalizeUsername(rawUsername ?? "");
  if (!handle) {
    return { error: "invalid_username", message: "username must be a valid GitHub login" };
  }
  try {
    return await quickScan(handle);
  } catch (error) {
    const { error: code } = scanErrorResponse(error);
    return { error: code, message: `could not scan ${handle}` };
  }
}

/** Head-to-head: two deterministic scores side by side (no LLM verdict). */
export async function compareUsers(
  rawA: string,
  rawB: string,
): Promise<Record<string, unknown> | ToolError> {
  const [a, b] = await Promise.all([scoreUser(rawA), scoreUser(rawB)]);
  if ("error" in a) return a;
  if ("error" in b) return b;
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
